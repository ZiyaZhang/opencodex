/** Source 1: the New Features bullets of the stable openai/codex release notes, one candidate per bullet.
 * Bug Fixes, Chores and the Changelog list are not read. CLI features come from this source; the RSS source filters them out.
 */
import { join } from 'node:path';
import { fingerprintOf, type Candidate, type Evidence } from '../../core/candidate.js';
import { writeJsonAtomic, type CandidateStore } from '../../core/store.js';
import { GitHubError, type GitHubClient, type PullRequest, type Release } from '../github.js';

/**
 * One bullet of the New Features section. `prs` holds its PR numbers, each once: the ones of its closing PR list first, in that order,
 * then any other reference in the text. `prs[0]` is the PR its candidate is keyed by, so two bullets whose closing lists start with the
 * same PR are one candidate, and the later write wins. That is rare: no release among the last 65 stable ones has two such bullets.
 */
export interface ReleaseFeature { text: string; prs: number[] }

/** One check looks at this many of the newest stable tags; release bodies are fetched only for the tags inside the window. */
const RECENT_STABLE_TAGS = 12;
const TITLE_LIMIT = 160;
/** What the evidence excerpt of a pull request holds besides its title: this many code points of its description (whole lines), and this many paths. */
const EXCERPT_BODY = 1_500;
const EXCERPT_FILES = 20;

/** A pull request reference in the closing PR list: `#50148`, or `[#50148](https://github.com/openai/codex/pull/50148)` (0.153.0). */
const PR_REF = String.raw`(?:#\d{1,9}|\[#\d{1,9}\]\([^)\s]*\))`;
/** The PR list that closes a bullet, `(#1, #2)`. Some older notes follow it with a period (0.123.0, 0.137.0). Whitespace is collapsed before this runs. */
const PR_LIST = new RegExp(String.raw`\s*\(${PR_REF}(?:,?\s*${PR_REF})*\)\s*\.?\s*$`);
const LIST_REF = /#(\d{1,9})(?!\d)/g;
/** A reference in running text: not part of a word or of an HTML entity (`&#8217;`). A six-digit run there is a colour (`#000000`), not a PR; inside the closing list it is a PR number, so six-digit PRs keep working. */
const TEXT_REF = /(?<![\w&])#(\d{3,7})(?!\w)/g;
/** The sections of release-please notes, matched on the start of a level-2 heading, case-insensitively. Notes with none of them are not in the shape this source reads. */
const KNOWN_SECTION = /^(New Features|Bug Fixes|Chores|Performance|Documentation|Changelog|Reverts|Miscellaneous)\b/i;
/** An opening or closing code fence: three or more backticks or tildes, indented by anything (a fence can sit under a bullet). */
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * The bullets of the `## New Features` section as one line each, and whether the notes have any of the usual sections at all (`recognized`).
 * An indented line directly under a bullet continues it, as wrapped text does. A blank line, a heading, or an un-indented line such as
 * `**Full Changelog**: …` ends the bullet, and that line is not read. A heading of level 1 or 2 ends the section, a deeper one does not.
 * Code fences are skipped whole, wherever they are: a `#` line in a shell sample is no heading, and a fence under a bullet is not part of its text.
 * Line endings are normalised first: the 0.158.0 notes ship with CRLF, and `.` in a pattern does not match `\r`.
 */
function scanNewFeatures(body: string): { bullets: string[]; recognized: boolean } {
  const bullets: string[] = [];
  let inSection = false, recognized = false, open = false;
  let fence: { char: string; size: number } | undefined;
  for (const line of body.split(/\r\n|\r|\n/)) {
    const marker = FENCE.exec(line);
    const run = marker?.[1];
    if (fence) {
      if (run && run[0] === fence.char && run.length >= fence.size && marker![2]!.trim() === '') fence = undefined;
      continue;
    }
    if (run && !(run[0] === '`' && marker![2]!.includes('`'))) { // an info string with a backtick is inline code that starts the line
      fence = { char: run[0]!, size: run.length };
      open = open && /^\s/.test(line); // a fence under a bullet is skipped with it, an un-indented one ends the bullet
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (level <= 2) {
        const title = heading[2]!.trim();
        inSection = level === 2 && /^New Features\b/i.test(title);
        recognized ||= level === 2 && KNOWN_SECTION.test(title);
      }
      open = false;
      continue;
    }
    if (!inSection) continue;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) { bullets.push(bullet[1]!); open = true; }
    else if (open && /^\s+\S/.test(line)) bullets[bullets.length - 1] += ` ${line}`;
    else open = false;
  }
  return { bullets, recognized };
}

/**
 * One feature per bullet of the New Features section, in the order of the notes, and whether the notes have any of the usual sections at all.
 * `text` is the bullet without its closing PR list. A nested sub-bullet is a feature of its own when it carries its own PR number,
 * and a bullet without any PR number is dropped (it has no evidence to look at).
 */
export function parseReleaseNotes(body: string): { features: ReleaseFeature[]; recognized: boolean } {
  const { bullets, recognized } = scanNewFeatures(body);
  const features = bullets.flatMap((raw): ReleaseFeature[] => {
    const line = raw.replace(/\s+/g, ' ').trim();
    const list = PR_LIST.exec(line);
    const text = (list ? line.slice(0, list.index) : line).trim();
    const closing = list ? [...list[0].matchAll(LIST_REF)].map(m => Number(m[1])) : [];
    const inline = [...text.matchAll(TEXT_REF)].filter(m => m[1]!.length !== 6).map(m => Number(m[1]));
    const prs = [...new Set([...closing, ...inline].filter(n => n > 0))];
    return text && prs.length ? [{ text, prs }] : [];
  });
  return { features, recognized };
}

export const parseReleaseBody = (body: string): ReleaseFeature[] => parseReleaseNotes(body).features;

export const minor = (tag: string): string => tag.replace(/^rust-v/, '').split('.').slice(0, 2).join('.');
const stableVersion = (tag: string): number[] | undefined => /^rust-v(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1).map(Number);
/** True when both are stable tags and `a` is the higher version, compared as numbers: rust-v0.10.0 is newer than rust-v0.9.0. */
function isNewer(a: string, b: string): boolean {
  const x = stableVersion(a), y = stableVersion(b);
  return x !== undefined && y !== undefined && (x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!) > 0;
}

export interface StableWindow { from: string; to: string; releases: string[] }
/**
 * Tags come newest first. With a checkpoint present in the list, the window runs from it to the newest tag and
 * covers every stable release in between. Without one, it starts at the newest tag whose minor differs from the latest.
 * A checkpoint that is a newer version than the newest tag (tags were removed) has nothing after it: no window.
 */
export function stableWindow(tags: string[], lastSeen?: string): StableWindow | undefined {
  const to = tags[0];
  if (!to || to === lastSeen || (lastSeen !== undefined && isNewer(lastSeen, to))) return undefined;
  const fromIndex = lastSeen && tags.includes(lastSeen) ? tags.indexOf(lastSeen) : tags.findIndex(tag => minor(tag) !== minor(to));
  if (fromIndex <= 0) return undefined;
  return { from: tags[fromIndex]!, to, releases: tags.slice(0, fromIndex) };
}

export interface ReleaseCollection {
  window?: StableWindow;
  added: number;
  /** The checkpoint is older than the fetched tags; intermediate releases were not collected. */
  gap: boolean;
  /**
   * Pull requests of this run that ended without evidence, each counted once: lookups that failed, and, when `rateLimited`, the ones not asked for.
   * Their candidates carry a bare `#N` reference. A permanent failure (a 404 for an issue number or a deleted PR) never holds the checkpoint back and is not retried;
   * what the rate limit cut off is read again by the next run, which starts at the release it interrupted.
   */
  prLookupFailures: number;
  /** Tags of the window that have no release yet (a stable tag can exist before its release is published), newest first. They are not collected, and a newest tag among them is looked at again by the next run. */
  unreleased: string[];
  /**
   * Tags read in this run whose notes are empty or have none of the usual sections (`## New Features`, `## Bug Fixes`, `## Chores`, …), newest first: the notes changed
   * shape, so features may be going unseen. A patch release with only `## Bug Fixes` is normal and not listed. They hold nothing back.
   */
  unrecognized: string[];
  /** GitHub refused part of this run over a rate limit. The run ended there without throwing away what it did: the checkpoint is at the newest release that was finished, and the next run goes on from it. */
  rateLimited: boolean;
  /** When the rate limit lifts, if GitHub said. */
  rateLimitResetAt?: Date;
  /** The message of the first pull request lookup that failed, whatever the reason. */
  firstLookupError?: string;
}

/** At most `limit` code points, so an emoji is never cut in half. A longer text is cut to `limit - 1` code points and ends in `…`, the way the desktop source clips its messages. */
function clip(text: string, limit: number): string {
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : text;
}

/** Whole lines of `text` up to `limit` code points; when lines are left out the last line is `…`. A first line that alone is longer than the limit is cut inside. */
function clipLines(text: string, limit: number): string {
  const lines = text.trim().split(/\r\n|\r|\n/).map(line => line.trimEnd());
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = [...line].length + (kept.length > 0 ? 1 : 0); // the line and the newline before it
    if (used + cost > limit) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length === lines.length) return kept.join('\n');
  if (kept.length === 0) return clip(lines[0]!, limit);
  return `${kept.join('\n').trimEnd()}\n…`;
}

/**
 * Paths that are tests or snapshots: a `test` or `tests` directory, a `__tests__` directory, a Rust test module next to its code (`tests.rs`, `<name>_test.rs`,
 * `<name>_tests.rs`), a snapshot, a spec, a test file. The directory and module patterns start at the beginning of the path or at a `/`, so `contests.rs` and `latest/` are not tests.
 */
const TEST_PATH = [/(?:^|\/)tests?\//, /(?:^|\/)__tests__\//, /(?:^|\/)(?:tests|[^/]+_tests?)\.rs$/, /\.snap/, /\.spec\./, /\.test\./];
/** Paths by lines changed, most first, with the tests and snapshots after everything else: what a pull request does is in its source files. */
function rankedPaths(files: PullRequest['files']): string[] {
  return files
    .map((file, index) => ({ path: file.path, churn: file.additions + file.deletions, test: TEST_PATH.some(pattern => pattern.test(file.path)), index }))
    .sort((a, b) => Number(a.test) - Number(b.test) || b.churn - a.churn || a.index - b.index)
    .map(file => file.path);
}

/** A title or a line as a reader compares it: no heading marker, one space between words, case folded. */
const plain = (line: string): string => line.replace(/^#{1,6}\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * A pull request description as the excerpt shows it: without its HTML comments (the hints a template leaves for the author, which a reader never sees),
 * without a first line that only repeats the title, and with each run of blank lines folded into one. A comment that is never closed is left as it is.
 */
function tidyBody(body: string, title: string): string {
  const lines = body.replace(/<!--[\s\S]*?-->/g, '').split(/\r\n|\r|\n/).map(line => line.trimEnd());
  const first = lines.findIndex(line => line !== '');
  if (first >= 0 && plain(lines[first]!) === plain(title)) lines[first] = '';
  const tidy: string[] = [];
  for (const line of lines) if (line !== '' || tidy.at(-1)) tidy.push(line); // a blank line only right after a line with text
  return tidy.join('\n').trimEnd();
}

/** The title, the description cut at a whole line, and the ranked paths, one section each; a path list that is cut says how many files it left out. */
export function excerptOf(pr: PullRequest): string {
  const paths = rankedPaths(pr.files);
  const listed = paths.slice(0, EXCERPT_FILES);
  if (paths.length > EXCERPT_FILES) listed.push(`…另有 ${paths.length - EXCERPT_FILES} 个文件`);
  return [pr.title, clipLines(tidyBody(pr.body, pr.title), EXCERPT_BODY), listed.join('\n')].filter(section => section !== '').join('\n\n');
}

/** The evidence entries earlier runs stored that came from a real lookup (they have a URL), by reference. The most recently updated candidate wins. */
function storedEvidence(candidates: Candidate[]): Map<string, Evidence> {
  const byRef = new Map<string, Evidence>();
  for (const candidate of candidates) {
    for (const entry of candidate.evidence) if (entry.kind === 'pr' && entry.url !== undefined && !byRef.has(entry.ref)) byRef.set(entry.ref, entry);
  }
  return byRef;
}

const isRateLimited = (error: unknown): error is GitHubError => error instanceof GitHubError && error.rateLimited;

/**
 * The pull request evidence of one run. Evidence stored by earlier runs and answers of this run are reused, so a pull request is asked for at most once.
 * What is left is asked one at a time: a rate limit answers the first request that hits it, and the ones already in flight would only add to it.
 * Once GitHub reports a rate limit nothing more is asked in this run, and the pull requests still unknown keep a bare reference.
 */
class PullRequestEvidence {
  /** Set by the first rate-limit answer of the run, to a pull request lookup or to anything else. */
  rateLimit: { resetAt?: Date } | undefined;
  /** The message of the first lookup that failed. */
  firstError: string | undefined;
  private readonly found = new Map<number, Evidence>();
  private readonly bare = new Set<number>();
  constructor(private readonly github: Pick<GitHubClient, 'pullRequest'>, private readonly stored: ReadonlyMap<string, Evidence>, private readonly signal?: AbortSignal) {}

  /** How many pull requests ended the run without evidence: lookups that failed, and ones not made because of the rate limit. */
  get failures(): number { return this.bare.size; }

  /** One entry per pull request, in the order given. */
  async forBullet(numbers: number[]): Promise<Evidence[]> {
    const entries: Evidence[] = [];
    for (const n of numbers) {
      let entry = this.stored.get(`#${n}`) ?? this.found.get(n);
      if (!entry && !this.bare.has(n)) {
        if (this.rateLimit) this.bare.add(n); // GitHub has refused this run: not asked
        else entry = await this.ask(n);
      }
      entries.push(entry ?? { kind: 'pr', ref: `#${n}` });
    }
    return entries;
  }

  private async ask(n: number): Promise<Evidence | undefined> {
    try {
      const pr = await this.github.pullRequest(n, this.signal);
      const entry: Evidence = { kind: 'pr', ref: `#${n}`, url: pr.url, excerpt: excerptOf(pr) };
      this.found.set(n, entry);
      return entry;
    } catch (error) {
      if (this.signal?.aborted) throw error; // an abort ends the run; it is not a missing pull request
      this.bare.add(n);
      this.firstError ??= error instanceof Error ? error.message : String(error);
      if (isRateLimited(error)) this.rateLimit = { resetAt: error.rateLimitResetAt };
      return undefined;
    }
  }
}

/**
 * Stores the New Features of every stable release in the window as `codex-release` candidates and returns how many were new.
 * The checkpoint moves only after the window went through, to the newest release that was finished. A tag still without a release is skipped (`unreleased`).
 * A rate limit ends the run without throwing it away (`rateLimited`): the release it cut into is not finished, its candidates keep a bare reference for the
 * pull requests that were not asked for, no later release is read, and the next run starts at that release. Stored evidence is reused, so that run only asks
 * for what is still missing; a candidate that exists keeps its window, and `upsert` leaves alone what did not change.
 */
export async function collectReleases(store: CandidateStore, github: Pick<GitHubClient, 'stableTags' | 'release' | 'pullRequest'>, snapshotDir: string, signal?: AbortSignal): Promise<ReleaseCollection> {
  const nothing = (gap: boolean): ReleaseCollection => ({ added: 0, gap, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false });
  let tags: string[];
  try { tags = await github.stableTags(RECENT_STABLE_TAGS, signal); } catch (error) {
    if (isRateLimited(error)) return { ...nothing(false), rateLimited: true, ...(error.rateLimitResetAt && { rateLimitResetAt: error.rateLimitResetAt }) };
    throw error;
  }
  const lastSeen = await store.checkpoint('lastStableTag');
  // A checkpoint ahead of every fetched tag is not a gap; there is nothing after it to collect.
  const ahead = lastSeen !== undefined && tags.every(tag => isNewer(lastSeen, tag));
  const gap = lastSeen !== undefined && !ahead && !tags.includes(lastSeen);
  const window = stableWindow(tags, lastSeen);
  if (!window) return nothing(gap);

  const stored = await store.list({ source: 'codex-release' });
  const candidates = new Map(stored.map((candidate): [string, Candidate] => [candidate.fingerprint, candidate]));
  const evidence = new PullRequestEvidence(github, storedEvidence(stored), signal);
  const unreleased: string[] = [], unrecognized: string[] = [];
  let added = 0, finished: string | undefined;
  // Oldest release first, and within a release the last bullet first: the store lists the latest write first, so the newest release
  // ends up on top and the first bullet of the notes leads its release.
  for (const tag of [...window.releases].reverse()) {
    if (evidence.rateLimit) break; // nothing more is asked of GitHub in this run
    let release: Release | undefined;
    try { release = await github.release(tag, signal); } catch (error) {
      if (!isRateLimited(error)) throw error;
      evidence.rateLimit = { resetAt: error.rateLimitResetAt };
      break;
    }
    if (!release) { unreleased.unshift(tag); continue; } // tagged before its release was published: nothing to read yet
    if (release.prerelease) { finished = tag; continue; } // seen, not read: the tags endpoint has no prerelease flag, the release record is authoritative
    await writeJsonAtomic(join(snapshotDir, 'codex-releases', `${tag}.json`), release);
    const { features, recognized } = parseReleaseNotes(release.body);
    if (!recognized) unrecognized.unshift(tag);
    for (const feature of features.reverse()) {
      signal?.throwIfAborted();
      const key = `pr:${feature.prs[0]}`;
      // A candidate that exists keeps its window, so reading a release again changes nothing it did not have to.
      const existing = candidates.get(fingerprintOf('codex-release', key));
      const { candidate, created } = await store.upsert({
        source: 'codex-release', key, title: clip(feature.text, TITLE_LIMIT), summary: feature.text,
        evidence: await evidence.forBullet(feature.prs), window: existing?.window ?? { fromTag: window.from, toTag: tag },
      });
      candidates.set(candidate.fingerprint, candidate);
      if (created) added++;
    }
    if (!evidence.rateLimit) finished = tag;
  }
  // The checkpoint never moves back: a state that is ahead of the tags, or a newest tag that is still unreleased, leaves it where it is.
  const behind = finished !== undefined && lastSeen !== undefined && stableVersion(lastSeen) !== undefined && !isNewer(finished, lastSeen);
  if (finished && !behind) await store.setCheckpoint('lastStableTag', finished);
  return {
    window, added, gap, prLookupFailures: evidence.failures, unreleased, unrecognized, rateLimited: evidence.rateLimit !== undefined,
    ...(evidence.rateLimit?.resetAt && { rateLimitResetAt: evidence.rateLimit.resetAt }),
    ...(evidence.firstError !== undefined && { firstLookupError: evidence.firstError }),
  };
}
