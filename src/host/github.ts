/** The only module that talks to GitHub: the `gh` CLI when it is usable, anonymous REST through the proxy-aware network otherwise. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { publicNetwork } from './public-network.js';

export type GhRunner = (args: string[], signal?: AbortSignal) => Promise<string>;
export interface Release { tag: string; publishedAt: string; body: string; prerelease: boolean }
export interface PullRequest { number: number; title: string; body: string; url: string; additions: number; deletions: number; files: Array<{ path: string; additions: number; deletions: number }> }

/**
 * A GitHub request that failed. `path` is the request path (`repos/openai/codex/...`). `status` is the HTTP status when there was one, on gh as on REST
 * (gh's "release not found" and "Could not resolve to a PullRequest" count as 404). A request that never got an answer has no status; `cause` holds the original error.
 * Test `rateLimited` rather than for 403 and 429: GraphQL, which `gh pr view` and `gh release view` use, reports its primary rate limit as an HTTP 200 with an error body,
 * so gh prints no status for it. It is true when GitHub refused the request over a rate limit: on gh by the wording of its message whatever the status; on REST for a 429 or
 * a 403 that says so, sends retry-after or has no calls left. `rateLimitResetAt` is when REST says the limit lifts: retry-after seconds from now, else x-ratelimit-reset.
 */
export class GitHubError extends Error {
  readonly path: string;
  readonly status?: number;
  readonly rateLimited: boolean;
  readonly rateLimitResetAt?: Date;
  constructor(message: string, path: string, details: { status?: number; rateLimited?: boolean; rateLimitResetAt?: Date; cause?: unknown } = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'GitHubError';
    this.path = path;
    if (details.status !== undefined) this.status = details.status;
    this.rateLimited = details.rateLimited ?? details.rateLimitResetAt !== undefined; // a reset time only exists for a rate limit
    if (details.rateLimitResetAt !== undefined) this.rateLimitResetAt = details.rateLimitResetAt;
  }
}

const REPO = 'openai/codex';
const API = 'https://api.github.com';
const JSON_ACCEPT = 'application/vnd.github+json';
const DIFF_ACCEPT = 'application/vnd.github.diff';
const USER_AGENT = 'dsh-opencodex/0.3';
const PER_PAGE = 100;
/** GitHub lists at most 3000 files per pull request: 30 pages of 100. Pages are read until a short one, so ordinary pull requests cost one. */
const MAX_FILE_PAGES = 30;
/** The first page of the tags listing already holds the newest stable tags; five pages reach back to about rust-v0.135 (55 stable tags on 2026-10-15). */
const MAX_TAG_PAGES = 5;
const STABLE_TAG = /^rust-v(\d+)\.(\d+)\.(\d+)$/;
/** How GitHub words a rate limit: "API rate limit exceeded", "You have exceeded a secondary rate limit", "You have triggered an abuse detection mechanism". */
const RATE_LIMIT_TEXT = /rate limit|abuse detection/i;

/**
 * The environment gh runs in. The Host inherits the user's login-shell variables and some of them wreck machine-readable output: CLICOLOR_FORCE or
 * GH_FORCE_TTY make `gh api` and `--json` print ANSI-coloured JSON and colour `pr diff`, DEBUG=1 or GH_DEBUG put `* Request at ...` trace lines ahead of gh's
 * error line (GH_DEBUG=0 wins over DEBUG on gh 2.88), GH_HOST can point gh at another server, a pager or a prompt can stall a call.
 * Everything else (PATH, proxies, tokens) passes through.
 */
export function ghEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GH_PAGER: 'cat', CLICOLOR_FORCE: '0', NO_COLOR: '1', GH_FORCE_TTY: '', GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com', GH_DEBUG: '0' };
}

export const defaultGhRunner: GhRunner = async (args, signal) => {
  const { stdout } = await promisify(execFile)('gh', args, { signal, maxBuffer: 64 * 1024 * 1024, env: ghEnvironment() });
  return stdout;
};

type Raw = Record<string, unknown>;
const isRaw = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * True when `gh` cannot be used at all, as opposed to failing on one request: it is not installed (execFile reports `code: 'ENOENT'`),
 * or it is not signed in (every gh command then exits 4; "not logged into" is how `gh auth status` puts it).
 */
function isGhUnusable(error: unknown): boolean {
  if (!isRaw(error)) return false;
  const text = [error.stderr, error.message].filter((part): part is string => typeof part === 'string').join('\n');
  return error.code === 'ENOENT' || error.code === 4 || /not logged into/i.test(text);
}

/** An abort or a timeout, however it was raised. */
const isAbort = (error: unknown): boolean => isRaw(error) && (error.name === 'AbortError' || error.name === 'TimeoutError');

/** What went wrong, in a few words: the message of the root cause (undici hides it behind a bare "fetch failed"), else its code. */
function reasonOf(error: unknown): string {
  const inner = isRaw(error) && error.cause !== undefined && error.cause !== null ? error.cause : error;
  if (isRaw(inner)) {
    if (typeof inner.message === 'string' && inner.message) return inner.message;
    if (typeof inner.code === 'string' && inner.code) return inner.code;
  }
  return String(inner);
}

/** A request that failed before GitHub answered (the proxy could not be set up, proxy down, DNS, TLS, a dropped connection). An abort is not a network failure and passes through unchanged. */
function networkFailure(error: unknown, path: string, route: string, signal?: AbortSignal): unknown {
  if (signal?.aborted || isAbort(error)) return error;
  return new GitHubError(`GitHub request for ${path} failed (${route}): ${reasonOf(error)}`, path, { cause: error });
}

/**
 * The body of an error response. `detail` is GitHub's `message` as it goes into the error text (rate limit, not found, diff too large, ...: it is what tells a 403 from a 403).
 * `text` is what is searched for rate-limit wording: that message, or the start of a body that is no GitHub error, such as a proxy's page.
 */
async function errorBody(response: Response): Promise<{ detail: string; text: string }> {
  let raw: string;
  try { raw = await response.text(); } catch { return { detail: '', text: '' }; }
  try {
    const { message } = JSON.parse(raw) as { message?: unknown };
    if (typeof message === 'string' && message) return { detail: `: ${message.slice(0, 200)}`, text: message };
  } catch { /* no JSON object */ }
  return { detail: '', text: raw.slice(0, 2000) };
}

/**
 * The answer was an HTTP error. A 429 is a rate limit; a 403 is one when its message says so, retry-after comes with it, no calls are left, or the reset time is known
 * (GitHub's other 403s, permissions and blocked repositories, are not). The time to wait for is retry-after, seconds from now, else x-ratelimit-reset.
 */
async function httpFailure(response: Response, path: string): Promise<GitHubError> {
  const { status } = response;
  const { detail, text } = await errorBody(response);
  let rateLimited = false;
  let rateLimitResetAt: Date | undefined;
  if (status === 403 || status === 429) {
    const retryAfter = response.headers.get('retry-after');
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const seconds = retryAfter === null || retryAfter.trim() === '' ? Number.NaN : Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) rateLimitResetAt = new Date(Date.now() + seconds * 1000);
    else if (Number.isFinite(reset) && reset > 0 && (remaining === null || remaining === '0')) rateLimitResetAt = new Date(reset * 1000);
    rateLimited = status === 429 || retryAfter !== null || remaining === '0' || RATE_LIMIT_TEXT.test(text) || rateLimitResetAt !== undefined;
  }
  return new GitHubError(`GitHub HTTP ${status} for ${path}${detail}`, path, { status, rateLimited, rateLimitResetAt });
}

/** A gh command that exited with an error. gh words its failures in two styles, "(HTTP 404)" and "HTTP 404:", and says "release not found" or "Could not resolve to a PullRequest" without a status. */
function ghFailure(error: unknown, path: string): GitHubError {
  const stderr = isRaw(error) && typeof error.stderr === 'string' ? error.stderr : '';
  const message = isRaw(error) && typeof error.message === 'string' ? error.message : String(error);
  const text = stderr.trim() ? stderr : message; // gh's own words; the message also repeats the command line, which carries caller-supplied tags and paths
  const code = /\bHTTP (\d{3})\b/.exec(text)?.[1];
  const status = code !== undefined ? Number(code) : /release not found|Could not resolve to a PullRequest/i.test(text) ? 404 : undefined;
  const line = (stderr.split('\n').map(l => l.trim()).find(Boolean) ?? message.split('\n')[0]!).slice(0, 300);
  // GraphQL's primary rate limit is an HTTP 200 whose body carries the error, so gh prints no status for it: the wording is what says so
  const rateLimited = status === 429 || RATE_LIMIT_TEXT.test(text);
  if (status === undefined) return new GitHubError(`GitHub request for ${path} failed (gh): ${line}`, path, { rateLimited, cause: error });
  const detail = line.replace(/^gh:\s*/, '').replace(/\s*\(HTTP \d{3}\)\s*$/, '');
  return new GitHubError(`GitHub HTTP ${status} for ${path}${detail ? `: ${detail}` : ''}`, path, { status, rateLimited, cause: error });
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

// Shape guards: a response that is not what GitHub documents fails with a plain Error that names the path. It is not a failed request, so it is no GitHubError.
const shapeError = (path: string, problem: string): Error => new Error(`Unexpected GitHub response for ${path}: ${problem}`);
function asRaw(value: unknown, path: string): Raw {
  if (!isRaw(value)) throw shapeError(path, 'not a JSON object');
  return value;
}
function stringAt(raw: Raw, key: string, path: string): string {
  const value = raw[key];
  if (typeof value !== 'string') throw shapeError(path, `"${key}" is not a string`);
  return value;
}
function numberAt(raw: Raw, key: string, path: string): number {
  const value = raw[key];
  if (typeof value !== 'number') throw shapeError(path, `"${key}" is not a number`);
  return value;
}
function booleanAt(raw: Raw, key: string, path: string): boolean {
  const value = raw[key];
  if (typeof value !== 'boolean') throw shapeError(path, `"${key}" is not a boolean`);
  return value;
}
function arrayAt(raw: Raw, key: string, path: string): unknown[] {
  const value = raw[key];
  if (!Array.isArray(value)) throw shapeError(path, `"${key}" is not an array`);
  return value;
}
/** A text field that GitHub leaves null (or out) when it is empty, such as a release or pull request body. */
function textAt(raw: Raw, key: string, path: string): string {
  const value = raw[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw shapeError(path, `"${key}" is not a string`);
  return value;
}

interface ReleaseKeys { tag: string; publishedAt: string; prerelease: string }
const GH_RELEASE: ReleaseKeys = { tag: 'tagName', publishedAt: 'publishedAt', prerelease: 'isPrerelease' };
const REST_RELEASE: ReleaseKeys = { tag: 'tag_name', publishedAt: 'published_at', prerelease: 'prerelease' };
function releaseOf(value: unknown, keys: ReleaseKeys, path: string): Release {
  const raw = asRaw(value, path);
  return { tag: stringAt(raw, keys.tag, path), publishedAt: stringAt(raw, keys.publishedAt, path), body: textAt(raw, 'body', path), prerelease: booleanAt(raw, keys.prerelease, path) };
}

type FileStat = PullRequest['files'][number];
/** A pull request as `gh pr view --json` or the REST pull endpoint gives it: `files` and `changedFiles` come from gh only; `html_url` (REST) wins over `url`, which on REST is the API address. */
function pullRequestOf(value: unknown, path: string) {
  const raw = asRaw(value, path);
  const files: FileStat[] | undefined = raw.files === undefined || raw.files === null ? undefined : arrayAt(raw, 'files', path).map(entry => {
    const file = asRaw(entry, path);
    return { path: stringAt(file, 'path', path), additions: numberAt(file, 'additions', path), deletions: numberAt(file, 'deletions', path) };
  });
  return {
    number: numberAt(raw, 'number', path), title: stringAt(raw, 'title', path), body: textAt(raw, 'body', path),
    url: [raw.html_url, raw.url].find((link): link is string => typeof link === 'string'),
    additions: numberAt(raw, 'additions', path), deletions: numberAt(raw, 'deletions', path),
    changedFiles: typeof raw.changedFiles === 'number' ? raw.changedFiles : undefined, files,
  };
}
/** One row of the REST `pulls/N/files` listing. */
function fileRowOf(value: unknown, path: string): FileStat {
  const raw = asRaw(value, path);
  return { path: stringAt(raw, 'filename', path), additions: numberAt(raw, 'additions', path), deletions: numberAt(raw, 'deletions', path) };
}

interface Rest { fetch: typeof fetch; route: string }

/**
 * Reads openai/codex through the `gh` CLI when it is usable and through anonymous REST otherwise.
 * Create one client per run: once gh turns out to be unusable (not installed, or not signed in) the client stays on REST for its whole lifetime.
 * A failed request throws `GitHubError`; a response of an unexpected shape throws a plain `Error` naming the path; an abort is rethrown as it came.
 */
export class GitHubClient {
  private readonly gh?: GhRunner;
  private readonly fetchImpl?: typeof fetch;
  /** Set when the runner reports that `gh` is unusable: every later call skips it and uses REST. */
  private ghUnavailable = false;
  private lastRoute?: 'gh' | 'rest';
  /** `gh: null` disables the CLI; `fetch` replaces the proxied network for the REST path (tests pass a stub, production leaves it unset). */
  constructor(options: { gh?: GhRunner | null; fetch?: typeof fetch } = {}) {
    this.gh = options.gh === null ? undefined : options.gh ?? defaultGhRunner;
    this.fetchImpl = options.fetch;
  }

  /** Which path served the most recent request: `gh`, `rest`, or `undefined` before the first one. */
  get route(): 'gh' | 'rest' | undefined { return this.lastRoute; }

  /**
   * Run `gh`. `undefined` means "use REST": the CLI is disabled, or turned out to be unusable (remembered). An abort stays an abort, whatever else went wrong with it,
   * and says nothing about gh. Every other gh failure is a real error: a `GitHubError` for `path`.
   */
  private async tryGh(args: string[], path: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!this.gh || this.ghUnavailable) return undefined;
    this.lastRoute = 'gh';
    try { return await this.gh(args, signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (isAbort(error)) throw error;
      if (isGhUnusable(error)) { this.ghUnavailable = true; return undefined; }
      throw ghFailure(error, path);
    }
  }
  /** Sets the REST network up for the request to `path` (`publicNetwork` can throw, e.g. on an invalid proxy setting: that is wrapped like a request failure) and tears it down after `use`. */
  private async withFetch<T>(path: string, signal: AbortSignal | undefined, use: (rest: Rest) => Promise<T>): Promise<T> {
    this.lastRoute = 'rest';
    let network: Rest & { close(): Promise<void> };
    try { network = this.fetchImpl ? { fetch: this.fetchImpl, route: 'custom fetch', close: async () => {} } : await publicNetwork(signal ?? new AbortController().signal); }
    catch (error) { throw networkFailure(error, path, 'proxy setup', signal); }
    try { return await use(network); } finally { await network.close(); }
  }
  private async restText(rest: Rest, path: string, accept: string, signal?: AbortSignal): Promise<string> {
    let response: Response;
    try { response = await rest.fetch(`${API}/${path}`, { headers: { Accept: accept, 'User-Agent': USER_AGENT }, signal }); }
    catch (error) { throw networkFailure(error, path, rest.route, signal); }
    if (!response.ok) throw await httpFailure(response, path);
    try { return await response.text(); }
    catch (error) { throw networkFailure(error, path, rest.route, signal); }
  }

  /** One JSON document: through `gh api` when gh is usable, otherwise through REST. */
  private async json<T>(path: string, signal?: AbortSignal): Promise<T> {
    const out = await this.tryGh(['api', '-H', `Accept: ${JSON_ACCEPT}`, '--', path], path, signal);
    if (out !== undefined) return parseJson<T>(out, path);
    return this.withFetch(path, signal, async rest => parseJson<T>(await this.restText(rest, path, JSON_ACCEPT, signal), path));
  }
  /**
   * Reads a JSON-array endpoint a page of 100 at a time (`path?per_page=100&page=N`, through `json`: gh and REST alike) and hands each page to `take`,
   * which says whether it has seen enough. Reading ends then, at the first page shorter than 100 (an empty one included), or after `maxPages`.
   */
  private async eachPage(path: string, maxPages: number, signal: AbortSignal | undefined, take: (items: unknown[]) => boolean): Promise<void> {
    for (let page = 1; page <= maxPages; page++) {
      const items = await this.json<unknown>(`${path}?per_page=${PER_PAGE}&page=${page}`, signal);
      if (!Array.isArray(items)) throw shapeError(path, `page ${page} is not a JSON array`);
      if (take(items) || items.length < PER_PAGE) return;
    }
  }

  /**
   * The newest stable `rust-vX.Y.Z` tags, newest first by version number; GitHub's own order is not trusted for the result.
   * Reads the tags listing one page of 100 at a time (about 1 s each): through `gh api` when gh is usable, anonymous REST otherwise.
   * GitHub lists tags in descending version order, so reading stops as soon as `limit` stable tags are in hand, at a short page, or after five pages;
   * if a page ever breaks that order the early stop is dropped and the pages are read up to the cap.
   * A tag has no prerelease flag, so a prerelease with a plain-looking tag can get through: `release(tag).prerelease` is the authority.
   */
  async stableTags(limit: number, signal?: AbortSignal): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`stableTags limit must be a positive integer, got ${limit}`);
    const path = `repos/${REPO}/tags`;
    const found = new Set<string>();
    let previous: string | undefined;
    let ordered = true;
    await this.eachPage(path, MAX_TAG_PAGES, signal, entries => {
      for (const entry of entries) {
        const name = stringAt(asRaw(entry, path), 'name', path);
        if (!STABLE_TAG.test(name) || found.has(name)) continue;
        if (previous !== undefined && newestFirst(name, previous) < 0) ordered = false; // a newer tag after an older one
        found.add(name);
        previous = name;
      }
      return ordered && found.size >= limit;
    });
    return [...found].sort(newestFirst).slice(0, limit);
  }
  /**
   * One release by tag, or `undefined` when the tag has no release (yet): a stable tag can exist before its release is published.
   * The REST answer lists every binary asset (about 300 KB), which is fine for the few tags of one check window.
   */
  async release(tag: string, signal?: AbortSignal): Promise<Release | undefined> {
    const path = `repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`;
    try {
      const viewed = await this.tryGh(['release', 'view', '--repo', REPO, '--json', 'tagName,body,publishedAt,isPrerelease', '--', tag], path, signal);
      if (viewed !== undefined) return releaseOf(parseJson<unknown>(viewed, `release view ${tag}`), GH_RELEASE, path);
      return releaseOf(await this.json<unknown>(path, signal), REST_RELEASE, path);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return undefined;
      throw error;
    }
  }
  async pullRequest(number: number, signal?: AbortSignal): Promise<PullRequest> {
    const path = `repos/${REPO}/pulls/${number}`;
    const viewed = await this.tryGh(['pr', 'view', '--repo', REPO, '--json', 'number,title,body,url,additions,deletions,changedFiles,files', '--', String(number)], path, signal);
    const r = pullRequestOf(viewed !== undefined ? parseJson<unknown>(viewed, `pr view ${number}`) : await this.json<unknown>(path, signal), path);
    let files = r.files;
    // `gh pr view` stops at 100 files (PR 49804: 100 of its 199) and the REST pull payload has none. The listing is alphabetical,
    // so a short one would silently lose docs/ and every other late path: complete it from the paged files endpoint.
    if (!files || files.length < (r.changedFiles ?? 0)) {
      const rows: unknown[] = [];
      await this.eachPage(`${path}/files`, MAX_FILE_PAGES, signal, items => { rows.push(...items); return false; });
      files = rows.map(row => fileRowOf(row, `${path}/files`));
    }
    return { number: r.number, title: r.title, body: r.body, url: r.url ?? `https://github.com/${REPO}/pull/${number}`, additions: r.additions, deletions: r.deletions, files };
  }
  async pullRequestDiff(number: number, signal?: AbortSignal): Promise<string> {
    const path = `repos/${REPO}/pulls/${number}`;
    const diff = await this.tryGh(['pr', 'diff', '--repo', REPO, '--', String(number)], path, signal);
    return diff ?? this.withFetch(path, signal, rest => this.restText(rest, path, DIFF_ACCEPT, signal));
  }
  /** Blob paths and shas at one tag, restricted by a path predicate. The recursive tree of this repo is far below GitHub's 100k-entry limit; a truncated answer is an error, never a partial result. */
  async treePaths(tag: string, keep: (path: string) => boolean, signal?: AbortSignal): Promise<Map<string, string>> {
    const path = `repos/${REPO}/git/trees/${encodeURIComponent(tag)}?recursive=1`;
    const raw = asRaw(await this.json<unknown>(path, signal), path);
    const tree = arrayAt(raw, 'tree', path);
    if (raw.truncated === true) throw new Error(`GitHub tree for ${tag} is truncated`);
    const blobs = new Map<string, string>();
    for (const item of tree) {
      const entry = asRaw(item, path);
      const entryPath = stringAt(entry, 'path', path);
      if (stringAt(entry, 'type', path) === 'blob' && keep(entryPath)) blobs.set(entryPath, stringAt(entry, 'sha', path));
    }
    return blobs;
  }
  /** One file's text at one tag. Files above 1 MB are refused: the contents API does not inline them. */
  async fileAt(tag: string, path: string, signal?: AbortSignal): Promise<string> {
    const request = `repos/${REPO}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(tag)}`;
    const raw = await this.json<unknown>(request, signal);
    const where = `${path}@${tag}`;
    if (Array.isArray(raw)) throw new Error(`${where} is a directory, not a file`);
    const file = asRaw(raw, request);
    if (file.encoding === 'none') throw new Error(`${where} is larger than the 1 MB the GitHub contents API returns${typeof file.size === 'number' && file.size ? ` (${file.size} bytes)` : ''}`);
    if (file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error(`Unexpected encoding ${file.encoding} for ${where}`);
    return Buffer.from(file.content, 'base64').toString('utf8');
  }
}
