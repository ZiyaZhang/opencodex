/** The only module that talks to GitHub: the `gh` CLI first, anonymous REST through the proxy-aware network when `gh` is missing. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { publicNetwork } from './public-network.js';

export type GhRunner = (args: string[], signal?: AbortSignal) => Promise<string>;
export interface Release { tag: string; publishedAt: string; body: string; prerelease: boolean }
export interface PullRequest { number: number; title: string; body: string; url: string; additions: number; deletions: number; files: Array<{ path: string; additions: number; deletions: number }> }

const REPO = 'openai/codex';
const API = 'https://api.github.com';
const JSON_ACCEPT = 'application/vnd.github+json';
const DIFF_ACCEPT = 'application/vnd.github.diff';
const USER_AGENT = 'dsh-opencodex/0.3';
/** GitHub lists at most 3000 files per pull request: 30 pages of 100. Pages are read until a short one, so ordinary pull requests cost one. */
const MAX_FILE_PAGES = 30;
/** The tags listing is read in pages of this many tags, at most this many pages. The first page already holds the newest stable tags; five reach back to about rust-v0.135 (55 stable tags on 2026-10-15). */
const TAGS_PER_PAGE = 100;
const MAX_TAG_PAGES = 5;
const STABLE_TAG = /^rust-v(\d+)\.(\d+)\.(\d+)$/;

// The parts of the GitHub payloads this module reads.
interface ReleaseRaw { tag_name: string; prerelease: boolean; published_at: string; body: string | null }
interface ReleaseViewRaw { tagName: string; isPrerelease: boolean; publishedAt: string; body: string | null }
interface TreeRaw { truncated: boolean; tree: Array<{ path: string; type: string; sha: string }> }
interface ContentRaw { encoding?: string; content?: string; size?: number }
interface LineCounts { additions: number; deletions: number }
interface PullRequestRaw extends LineCounts { number: number; title: string; body: string | null; url?: string; html_url?: string; changedFiles?: number; files?: Array<LineCounts & { path: string }> }
interface PullFileRaw extends LineCounts { filename: string }

export const defaultGhRunner: GhRunner = async (args, signal) => {
  const { stdout } = await promisify(execFile)('gh', args, { signal, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GH_PAGER: 'cat' } });
  return stdout;
};

/**
 * True when `gh` cannot be used at all, as opposed to failing on one request: it is not installed (execFile reports `code: 'ENOENT'`),
 * or it is not signed in (every gh command then exits 4; "not logged into" is how `gh auth status` puts it).
 */
function isGhUnusable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, stderr, message } = error as { code?: unknown; stderr?: unknown; message?: unknown };
  const text = [stderr, message].filter((part): part is string => typeof part === 'string').join('\n');
  return code === 'ENOENT' || code === 4 || /not logged into/i.test(text);
}

const versionOf = (tag: string): number[] => STABLE_TAG.exec(tag)!.slice(1).map(Number);
/** Compares the three version numbers, not the text: rust-v0.10.0 is newer than rust-v0.9.0. */
function newestFirst(a: string, b: string): number {
  const x = versionOf(a), y = versionOf(b);
  return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]!;
}

function parseJson<T>(text: string, what: string): T {
  try { return JSON.parse(text) as T; }
  catch (error) { throw new Error(`GitHub returned invalid JSON for ${what}`, { cause: error }); }
}

/** GitHub error bodies carry a `message` (rate limit, not found, diff too large, ...); it is what tells a 403 from a 403. */
async function errorDetail(response: Response): Promise<string> {
  try {
    const { message } = await response.json() as { message?: unknown };
    return typeof message === 'string' && message ? `: ${message.slice(0, 200)}` : '';
  } catch { return ''; }
}

export class GitHubClient {
  private readonly gh?: GhRunner;
  private readonly fetchImpl?: typeof fetch;
  /** Set when the runner reports that `gh` is unusable (not installed, or not signed in): every later call skips it and uses REST. */
  private ghUnavailable = false;
  /** `gh: null` disables the CLI; `fetch` replaces the proxied network for the REST path (tests pass a stub, production leaves it unset). */
  constructor(options: { gh?: GhRunner | null; fetch?: typeof fetch } = {}) {
    this.gh = options.gh === null ? undefined : options.gh ?? defaultGhRunner;
    this.fetchImpl = options.fetch;
  }

  /** Run `gh`. `undefined` means "use REST": the CLI is disabled, or turned out to be unusable (remembered). Every other gh failure is a real error and propagates. */
  private async tryGh(args: string[], signal?: AbortSignal): Promise<string | undefined> {
    if (!this.gh || this.ghUnavailable) return undefined;
    try { return await this.gh(args, signal); }
    catch (error) {
      if (!isGhUnusable(error)) throw error;
      this.ghUnavailable = true;
      return undefined;
    }
  }
  private async withFetch<T>(signal: AbortSignal | undefined, use: (request: typeof fetch) => Promise<T>): Promise<T> {
    const network = this.fetchImpl ? { fetch: this.fetchImpl, close: async () => {} } : await publicNetwork(signal ?? new AbortController().signal);
    try { return await use(network.fetch); } finally { await network.close(); }
  }
  private async restText(request: typeof fetch, path: string, accept: string, signal?: AbortSignal): Promise<string> {
    const response = await request(`${API}/${path}`, { headers: { Accept: accept, 'User-Agent': USER_AGENT }, signal });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status} for ${path}${await errorDetail(response)}`);
    return response.text();
  }

  /** One JSON document: through gh when it is there, otherwise through REST. */
  private async json<T>(path: string, signal?: AbortSignal): Promise<T> {
    const out = await this.tryGh(['api', '-H', `Accept: ${JSON_ACCEPT}`, path], signal);
    if (out !== undefined) return parseJson<T>(out, path);
    return this.withFetch(signal, async request => parseJson<T>(await this.restText(request, path, JSON_ACCEPT, signal), path));
  }
  /**
   * At most `maxPages` pages of a JSON-array endpoint, one array per page.
   * gh: `--paginate --slurp` (needs gh >= 2.50) always fetches every page; the surplus is dropped here.
   * REST: one request per page, ending at the first page that is empty or shorter than `per_page`.
   */
  private async jsonPages<T>(path: string, maxPages: number, signal?: AbortSignal): Promise<T[][]> {
    const out = await this.tryGh(['api', '--paginate', '--slurp', '-H', `Accept: ${JSON_ACCEPT}`, path], signal);
    if (out !== undefined) return parseJson<T[][]>(out, path).slice(0, maxPages);
    const perPage = Number(new URLSearchParams(path.split('?')[1]).get('per_page')) || 30; // 30 is GitHub's default page size
    return this.withFetch(signal, async request => {
      const pages: T[][] = [];
      for (let page = 1; page <= maxPages; page++) {
        const pagePath = `${path}${path.includes('?') ? '&' : '?'}page=${page}`;
        const body = parseJson<unknown>(await this.restText(request, pagePath, JSON_ACCEPT, signal), pagePath);
        if (!Array.isArray(body)) throw new Error(`GitHub page ${page} of ${path} is not a JSON array`);
        pages.push(body as T[]);
        if (body.length < perPage) break;
      }
      return pages;
    });
  }

  /**
   * The newest stable `rust-vX.Y.Z` tags, newest first by version number; GitHub's own order is not trusted for the result.
   * Reads the tags listing one page of 100 at a time (about 1 s each): through `gh api` when gh is usable, anonymous REST otherwise.
   * GitHub lists tags in descending version order, so reading stops as soon as `limit` stable tags are in hand, at a short page, or after five pages.
   * A tag has no prerelease flag, so a prerelease with a plain-looking tag can get through: `release(tag).prerelease` is the authority.
   */
  async stableTags(limit: number, signal?: AbortSignal): Promise<string[]> {
    const found = new Set<string>();
    for (let page = 1; page <= MAX_TAG_PAGES; page++) {
      const tags = await this.json<Array<{ name: string }>>(`repos/${REPO}/tags?per_page=${TAGS_PER_PAGE}&page=${page}`, signal);
      if (!Array.isArray(tags)) throw new Error(`GitHub tags page ${page} is not a JSON array`);
      for (const { name } of tags) if (STABLE_TAG.test(name)) found.add(name);
      if (found.size >= limit || tags.length < TAGS_PER_PAGE) break;
    }
    return [...found].sort(newestFirst).slice(0, limit);
  }
  /** One release by tag. The REST answer lists every binary asset (about 300 KB), which is fine for the few tags of one check window. */
  async release(tag: string, signal?: AbortSignal): Promise<Release> {
    const viewed = await this.tryGh(['release', 'view', tag, '--repo', REPO, '--json', 'tagName,body,publishedAt,isPrerelease'], signal);
    if (viewed !== undefined) {
      const r = parseJson<ReleaseViewRaw>(viewed, `release view ${tag}`);
      return { tag: r.tagName, publishedAt: r.publishedAt, body: r.body ?? '', prerelease: r.isPrerelease };
    }
    const r = await this.json<ReleaseRaw>(`repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, signal);
    return { tag: r.tag_name, publishedAt: r.published_at, body: r.body ?? '', prerelease: r.prerelease };
  }
  async pullRequest(number: number, signal?: AbortSignal): Promise<PullRequest> {
    const viewed = await this.tryGh(['pr', 'view', String(number), '--repo', REPO, '--json', 'number,title,body,url,additions,deletions,changedFiles,files'], signal);
    const r = viewed !== undefined ? parseJson<PullRequestRaw>(viewed, `pr view ${number}`) : await this.json<PullRequestRaw>(`repos/${REPO}/pulls/${number}`, signal);
    let files = r.files?.map(f => ({ path: f.path, additions: f.additions, deletions: f.deletions }));
    // `gh pr view` stops at 100 files (PR 49804: 100 of its 199) and the REST pull payload has none. The listing is alphabetical,
    // so a short one would silently lose docs/ and every other late path: complete it from the paged files endpoint.
    if (!files || files.length < (r.changedFiles ?? 0)) {
      files = (await this.jsonPages<PullFileRaw>(`repos/${REPO}/pulls/${number}/files?per_page=100`, MAX_FILE_PAGES, signal)).flat().map(f => ({ path: f.filename, additions: f.additions, deletions: f.deletions }));
    }
    // `gh pr view` puts the page address in `url`, while the REST `url` is the API address: html_url must win when it exists.
    return { number: r.number, title: r.title, body: r.body ?? '', url: r.html_url ?? r.url ?? `https://github.com/${REPO}/pull/${number}`, additions: r.additions, deletions: r.deletions, files };
  }
  async pullRequestDiff(number: number, signal?: AbortSignal): Promise<string> {
    const diff = await this.tryGh(['pr', 'diff', String(number), '--repo', REPO], signal);
    return diff ?? this.withFetch(signal, request => this.restText(request, `repos/${REPO}/pulls/${number}`, DIFF_ACCEPT, signal));
  }
  /** Blob paths and shas at one tag, restricted by a path predicate. The recursive tree of this repo is far below GitHub's 100k-entry limit; a truncated answer is an error, never a partial result. */
  async treePaths(tag: string, keep: (path: string) => boolean, signal?: AbortSignal): Promise<Map<string, string>> {
    const raw = await this.json<TreeRaw>(`repos/${REPO}/git/trees/${encodeURIComponent(tag)}?recursive=1`, signal);
    if (raw.truncated) throw new Error(`GitHub tree for ${tag} is truncated`);
    return new Map(raw.tree.filter(e => e.type === 'blob' && keep(e.path)).map(e => [e.path, e.sha]));
  }
  /** One file's text at one tag. Files above 1 MB are refused: the contents API does not inline them. */
  async fileAt(tag: string, path: string, signal?: AbortSignal): Promise<string> {
    const raw = await this.json<ContentRaw | ContentRaw[]>(`repos/${REPO}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(tag)}`, signal);
    const where = `${path}@${tag}`;
    if (Array.isArray(raw)) throw new Error(`${where} is a directory, not a file`);
    if (raw.encoding === 'none') throw new Error(`${where} is larger than the 1 MB the GitHub contents API returns${raw.size ? ` (${raw.size} bytes)` : ''}`);
    if (raw.encoding !== 'base64' || typeof raw.content !== 'string') throw new Error(`Unexpected encoding ${raw.encoding} for ${where}`);
    return Buffer.from(raw.content, 'base64').toString('utf8');
  }
}
