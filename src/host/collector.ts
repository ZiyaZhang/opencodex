/**
 * One check: the four sources, then the DSH index, one after another. A source that fails becomes a line in `errors` and the
 * rest still run; an abort, whether a source reports it or it comes between two sources, ends the whole check and rejects.
 */
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { check } from '../core/check.js';
import type { Settings } from '../core/settings.js';
import { writeJsonAtomic, type CandidateStore } from '../core/store.js';
import { GitHubClient, GitHubError } from './github.js';
import { buildDshIndex, isDshIndex, type DshIndex } from './index/dsh-index.js';
import { collectFileChanges, type FilesCollection } from './sources/codex-files.js';
import { collectReleases, type ReleaseCollection, type StableWindow } from './sources/codex-releases.js';
import { collectDesktop, type DesktopCollection } from './sources/desktop-app.js';
import type { PlutilRunner } from './sources/plist.js';
import { collectRss } from './sources/rss.js';

/** A source result as it travels over JSON: the time a rate limit lifts, where the source has one, is an ISO string, not a Date. */
export type JsonSafe<T> = Omit<T, 'rateLimitResetAt'> & { rateLimitResetAt?: string };
/**
 * What one check did, safe to send as JSON as it is. A source that failed is told by the `<source>:` prefix of its line in `errors`
 * (`releases`, `files`, `desktop`, `rss` or `index`), and its field keeps the empty value it started with; notices about partial results
 * (a rate limit, unread files, a gap) carry the same prefixes. `index` is set when the check rebuilt `index/dsh-index.json`: a Host that
 * holds the index in memory must `loadIndex` again after such a check, or it goes on searching the old one.
 */
export interface CheckResult {
  releases: JsonSafe<ReleaseCollection>; files: JsonSafe<FilesCollection>; desktop: DesktopCollection; rss: number;
  index?: { entries: number; commit: string; builtAt: string }; errors: string[];
}
export interface CheckOptions {
  /** The OpenCodex data directory: `snapshots/` and `index/` live under it. */
  directory: string;
  store: CandidateStore;
  settings: Settings;
  /** GitHub access; gh with the anonymous REST fallback when not given. */
  github?: GitHubClient;
  signal: AbortSignal;
  /** Replaces the proxy-aware public network for the RSS feed only (tests); GitHub is reached through `github` alone. */
  fetcher?: typeof fetch;
  /** Replaces the plutil process of the desktop source (tests). */
  plutil?: PlutilRunner;
  /** Anchors the RSS parser's 120-day window (tests); now by default. */
  now?: Date;
}

/** Desktop snapshot versions kept on disk: about 2.5 MB each, and only the newest one is ever read. */
const DESKTOP_SNAPSHOTS_KEPT = 3;
/**
 * Watched files read per check. Through gh the authenticated limit is far away. Anonymous REST allows 60 requests an hour for everything,
 * the release source has used part of them by then, and a modified file costs two requests.
 */
const FILES_BUDGET = { gh: 60, rest: 10 } as const;
/** An `errors` line is cut to this many characters. */
const ERROR_LINE_LIMIT = 300;

const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * What went wrong, for an `errors` line: the message, and what its cause says when that adds something. undici says only "fetch failed" and keeps
 * the reason (`connect ECONNREFUSED …`, `UND_ERR_SOCKET`) in `cause`. A GitHubError already carries its reason, and its cause is the raw gh error,
 * whose message repeats the command line, so that one is never appended.
 */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof Error) || error instanceof GitHubError) return message;
  const { cause } = error;
  const why = typeof cause === 'string' ? cause
    : !isRecord(cause) ? ''
    : typeof cause.message === 'string' && cause.message.trim() ? cause.message
    : typeof cause.code === 'string' || typeof cause.code === 'number' ? String(cause.code) : '';
  return why.trim() && !message.includes(why.trim()) ? `${message} (${why.trim()})` : message;
}
/** One `errors` line: whitespace collapsed, at most 300 characters, never cut inside a character. */
function errorLine(text: string): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > ERROR_LINE_LIMIT ? `${chars.slice(0, ERROR_LINE_LIMIT - 1).join('')}…` : chars.join('');
}
/** `collection` with its rate-limit reset time, if any, as an ISO string. A reset time that is no valid Date (a garbled header) is left out. */
function jsonSafe<T extends object>(collection: T): JsonSafe<T> {
  const { rateLimitResetAt, ...rest } = collection as T & { rateLimitResetAt?: unknown };
  return (rateLimitResetAt instanceof Date && !Number.isNaN(rateLimitResetAt.getTime()) ? { ...rest, rateLimitResetAt: rateLimitResetAt.toISOString() } : rest) as JsonSafe<T>;
}
/** The release a rate limit cut into: the oldest release of the window after the checkpoint, tags without a release left aside. */
function cutRelease(window: StableWindow, checkpoint: string | undefined, unreleased: readonly string[]): string | undefined {
  const at = checkpoint === undefined ? -1 : window.releases.indexOf(checkpoint); // newest first
  return (at < 0 ? window.releases : window.releases.slice(0, at)).filter(tag => !unreleased.includes(tag)).at(-1);
}

/** Checks in progress, by resolved data directory. */
const running = new Map<string, Promise<CheckResult>>();

/**
 * Runs one check of `options.directory`. There is one check at a time per data directory: a call made while a check of the same directory
 * (compared after `path.resolve`) is still running gets that check's promise, and its own options, `signal` included, are not used.
 */
export function runCheck(options: CheckOptions): Promise<CheckResult> {
  const key = resolve(options.directory);
  const current = running.get(key);
  if (current) return current;
  const started = collect(options).finally(() => running.delete(key));
  running.set(key, started);
  return started;
}

async function collect(options: CheckOptions): Promise<CheckResult> {
  const { directory, store, settings, signal } = options;
  signal.throwIfAborted();
  const github = options.github ?? new GitHubClient();
  const snapshots = join(directory, 'snapshots');
  await mkdir(snapshots, { recursive: true, mode: 0o700 });
  const result: CheckResult = {
    releases: { added: 0, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false },
    files: { added: 0, merged: 0, gap: false, unread: { overBudget: 0, rateLimited: 0, failed: 0 } },
    desktop: { version: '', changed: false, added: 0, keys: 0 }, rss: 0, errors: [],
  };
  const addError = (source: string, problem: string) => { result.errors.push(errorLine(`${source}: ${problem}`)); };
  /** Runs one source. A failure becomes a line in `errors` and the next source runs; an abort ends the check. */
  const attempt = async (source: string, work: () => Promise<void>): Promise<void> => {
    signal.throwIfAborted();
    try { await work(); } catch (error) {
      signal.throwIfAborted();
      addError(source, describe(error));
    }
  };
  const resetNote = (at: string | undefined) => (at ? `, resets at ${at}` : '');

  await attempt('releases', async () => {
    const lastSeen = await store.checkpoint('lastStableTag');
    const releases = await collectReleases(store, github, snapshots, signal);
    result.releases = jsonSafe(releases);
    // A partial result is not a failure of the source, but each of these loses or holds back something the user should know about.
    if (releases.gap) addError('releases', `last seen tag ${lastSeen} is not among the newest stable tags; the releases after it${releases.window ? ` up to and including ${releases.window.from}` : ''} were not collected`);
    if (releases.rateLimited) {
      // Without a window the limit refused the tag listing itself, and no release was touched.
      const cut = releases.window && (cutRelease(releases.window, await store.checkpoint('lastStableTag'), releases.unreleased) ?? 'the affected release');
      addError('releases', `GitHub rate limit hit${resetNote(result.releases.rateLimitResetAt)}${cut ? `; the checkpoint stopped before ${cut}` : ''}`);
    }
    // What a rate limit cut off is read again by the next run; a permanent failure (a 404) is not.
    if (releases.prLookupFailures) addError('releases', `${releases.prLookupFailures} PR lookups failed (${releases.firstLookupError ?? 'no detail'}); those candidates carry bare evidence${releases.rateLimited ? ' until the next run' : ''}`);
    if (releases.unrecognized.length) addError('releases', `release notes format not recognized for ${releases.unrecognized.join(', ')}`);
  });
  // Source 2 works out its own window from the tags and keeps its own checkpoint, so it runs whether or not source 1 got through.
  await attempt('files', async () => {
    const files = await collectFileChanges(store, github, snapshots, signal, { budget: github.route === 'rest' ? FILES_BUDGET.rest : FILES_BUDGET.gh });
    result.files = jsonSafe(files);
    if (files.gap) addError('files', `the stored tag could not be used as the window start${files.window ? `; the window restarted at ${files.window.from}` : ''}`);
    // An unread file still makes a candidate, but one that says nothing about what changed in it. The source holds its checkpoint while the rate limit cut reads short.
    const { overBudget, rateLimited, failed } = files.unread;
    const unread = overBudget + rateLimited + failed;
    if (unread > 0) addError('files', `${unread} changed files not read (${overBudget} over budget, ${rateLimited} rate limited, ${failed} failed)${rateLimited > 0 ? '; the window will be retried' : ''}`);
  });
  if (settings.desktopPlistPath) await attempt('desktop', async () => {
    const desktop = result.desktop = await collectDesktop(store, snapshots, settings.desktopPlistPath, settings.desktopLocale, options.plutil, signal);
    // Task 7 review: a missing locale bundle used to be silent; the i18n half of the source is dead without it.
    if (desktop.version && desktop.keys === 0) addError('desktop', `no ${settings.desktopLocale} locale bundle with codex keys in ${desktop.version}`);
    if (desktop.keysReset) addError('desktop', `key layout changed in ${desktop.version}; i18n baseline reset, no i18n candidates this run`);
    await pruneDesktopSnapshots(snapshots, DESKTOP_SNAPSHOTS_KEPT);
  });
  await attempt('rss', async () => { result.rss = await collectRss(store, signal, options.fetcher, options.now); });
  if (settings.dshMirrorPath) await attempt('index', async () => {
    const index = await refreshIndex(directory, store, settings.dshMirrorPath);
    result.index = { entries: index.entries.length, commit: index.commit, builtAt: index.builtAt };
  });
  signal.throwIfAborted(); // the index build takes no signal; an abort while it ran still ends the check
  return result;
}

/** Natural order, so `26.1007.10_(10)` sorts after `26.1007.9_(9)`. */
const naturalOrder = new Intl.Collator('en', { numeric: true }).compare;

/**
 * Keeps the `keep` newest version directories under `snapshots/desktop` and deletes the others; plain files such as a Finder `.DS_Store` are
 * left alone. Newest is by mtime, ties by directory name in natural order: desktop-app.ts exports no build-number comparison to use instead.
 * The directory the `lastDesktopVersion` checkpoint names is the one the desktop source wrote last, so it is the newest in normal use;
 * it is not looked up by name, because desktop-app.ts does not export how it turns a version into a directory name either.
 */
export async function pruneDesktopSnapshots(snapshots: string, keep: number): Promise<void> {
  check(Number.isInteger(keep) && keep >= 1, `keep must be an integer >= 1, got ${keep}`);
  const dir = join(snapshots, 'desktop');
  let entries: Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return; throw error; }
  const dated = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async ({ name }) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })));
  dated.sort((a, b) => b.mtime - a.mtime || naturalOrder(b.name, a.name));
  for (const { name } of dated.slice(keep)) await rm(join(dir, name), { recursive: true, force: true });
}

const indexFile = (directory: string) => join(directory, 'index', 'dsh-index.json');

/**
 * Rebuilds `index/dsh-index.json` from the mirror and records the mirror commit as `indexCommit`. The previous index stays, and this throws to say why,
 * when the new one is empty, when it has fewer than half the entries of the previous one (a mirror cut short, or the wrong path), or when its commit
 * is unknown while the previous one's was known (the mirror is no git checkout any more, or it moved while it was read). `force` (a rebuild the user
 * asked for) skips the last two guards; an empty index is never written.
 */
export async function refreshIndex(directory: string, store: CandidateStore, mirror: string, options: { force?: boolean } = {}): Promise<DshIndex> {
  const index = await buildDshIndex(mirror);
  // A wrong or empty mirror path yields an empty index; never overwrite a good one with it.
  if (index.entries.length === 0) throw new Error(`DSH index is empty for ${mirror}; keeping the previous index`);
  const previous = options.force ? undefined : await loadIndex(directory);
  if (previous && index.entries.length * 2 < previous.entries.length) {
    throw new Error(`DSH index for ${mirror} has ${index.entries.length} entries, fewer than half of the previous ${previous.entries.length}; keeping the previous index`);
  }
  if (previous && index.commit === 'unknown' && previous.commit !== 'unknown') {
    throw new Error(`DSH mirror ${mirror} has no readable commit (no git checkout, or it moved while it was read); keeping the previous index of ${previous.commit.slice(0, 12)}`);
  }
  await writeJsonAtomic(indexFile(directory), index);
  await store.setCheckpoint('indexCommit', index.commit);
  return index;
}

/** The index `refreshIndex` wrote, or undefined when there is none yet or the file is unparsable or not an index of this shape (rebuild it then). Other read failures throw. */
export async function loadIndex(directory: string): Promise<DshIndex | undefined> {
  let value: unknown;
  try { value = JSON.parse(await readFile(indexFile(directory), 'utf8')); } catch (error) {
    if (error instanceof SyntaxError || isMissing(error)) return undefined;
    throw error;
  }
  return isDshIndex(value) ? value : undefined;
}
