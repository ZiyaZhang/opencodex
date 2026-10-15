/**
 * One check: the four sources, then the DSH index, one after another. A source that fails becomes a line in `errors` and the
 * rest still run; an abort, whether a source reports it or it comes between two sources, ends the whole check and rejects.
 */
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { check } from '../core/check.js';
import type { Settings } from '../core/settings.js';
import { writeJsonAtomic, type CandidateStore } from '../core/store.js';
import { GitHubClient } from './github.js';
import { buildDshIndex, isDshIndex, type DshIndex } from './index/dsh-index.js';
import { collectFileChanges, type FilesCollection } from './sources/codex-files.js';
import { collectReleases, type ReleaseCollection } from './sources/codex-releases.js';
import { collectDesktop, type DesktopCollection } from './sources/desktop-app.js';
import type { PlutilRunner } from './sources/plist.js';
import { collectRss } from './sources/rss.js';

export interface CheckResult { releases: ReleaseCollection; files: FilesCollection; desktop: DesktopCollection; rss: number; index?: { entries: number; commit: string }; errors: string[] }
export interface CheckOptions {
  /** The OpenCodex data directory: `snapshots/` and `index/` live under it. */
  directory: string;
  store: CandidateStore;
  settings: Settings;
  /** By default gh with the anonymous REST fallback; with only `fetcher` given, REST through it. */
  github?: GitHubClient;
  signal: AbortSignal;
  /** Replaces the proxy-aware public network for the RSS feed (tests). */
  fetcher?: typeof fetch;
  /** Replaces the plutil process of the desktop source (tests). */
  plutil?: PlutilRunner;
  /** Anchors the RSS parser's 120-day window (tests); now by default. */
  now?: Date;
}

/** Desktop snapshot versions kept on disk: about 2.5 MB each, and only the newest one is ever read. */
const DESKTOP_SNAPSHOTS_KEPT = 3;
/** Watched files read per check. Through gh the authenticated limit is far away; anonymous REST allows 60 requests an hour for everything. */
const FILES_BUDGET = { gh: 60, rest: 25 } as const;

const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');

export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  const { directory, store, settings, signal } = options;
  signal.throwIfAborted();
  const github = options.github ?? new GitHubClient(options.fetcher ? { gh: null, fetch: options.fetcher } : {});
  const snapshots = join(directory, 'snapshots');
  await mkdir(snapshots, { recursive: true, mode: 0o700 });
  const result: CheckResult = {
    releases: { added: 0, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false },
    files: { added: 0, merged: 0, gap: false }, desktop: { version: '', changed: false, added: 0, keys: 0 }, rss: 0, errors: [],
  };
  const addError = (source: string, problem: string) => { result.errors.push(`${source}: ${problem}`); };
  /** Runs one source. A failure becomes a line in `errors` and the next source runs; an abort ends the check. */
  const attempt = async (source: string, work: () => Promise<void>): Promise<void> => {
    signal.throwIfAborted();
    try { await work(); } catch (error) {
      signal.throwIfAborted();
      addError(source, error instanceof Error ? error.message : String(error));
    }
  };

  await attempt('releases', async () => {
    const lastSeen = await store.checkpoint('lastStableTag');
    const releases = result.releases = await collectReleases(store, github, snapshots, signal);
    // A partial result is not a failure of the source, but each of these loses or holds back something the user should know about.
    if (releases.gap) addError('releases', `last seen tag ${lastSeen} is not among the newest stable tags; the releases after it${releases.window ? ` up to and including ${releases.window.from}` : ''} were not collected`);
    // A reset time built from a garbled header can be an Invalid Date, whose toISOString throws.
    const resetAt = releases.rateLimitResetAt && !Number.isNaN(releases.rateLimitResetAt.getTime()) ? `, resets at ${releases.rateLimitResetAt.toISOString()}` : '';
    if (releases.rateLimited) addError('releases', `GitHub rate limit hit${resetAt}; the checkpoint stopped before the affected release`);
    if (releases.prLookupFailures) addError('releases', `${releases.prLookupFailures} PR lookups failed (${releases.firstLookupError ?? 'no detail'}); those candidates carry bare evidence until the next run`);
    if (releases.unrecognized.length) addError('releases', `release notes format not recognized for ${releases.unrecognized.join(', ')}`);
  });
  // Source 2 works out its own window from the tags and keeps its own checkpoint, so it runs whether or not source 1 got through.
  await attempt('files', async () => {
    const files = result.files = await collectFileChanges(store, github, snapshots, signal, { budget: github.route === 'rest' ? FILES_BUDGET.rest : FILES_BUDGET.gh });
    if (files.gap) addError('files', 'the stored tag no longer exists; the window restarted at the previous minor');
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
    result.index = { entries: index.entries.length, commit: index.commit };
  });
  signal.throwIfAborted(); // the index build takes no signal; an abort while it ran still ends the check
  return result;
}

/**
 * Keeps the `keep` newest version directories under `snapshots/desktop` (newest by mtime, ties by name) and deletes the others; plain files
 * such as a Finder `.DS_Store` are left alone. The directory the `lastDesktopVersion` checkpoint names is the one the desktop source wrote
 * last, so it is the newest in normal use. It is not looked up by name: desktop-app.ts does not export how it turns a version into a directory name.
 */
export async function pruneDesktopSnapshots(snapshots: string, keep: number): Promise<void> {
  check(Number.isInteger(keep) && keep >= 1, `keep must be an integer >= 1, got ${keep}`);
  const dir = join(snapshots, 'desktop');
  let entries: Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return; throw error; }
  const dated = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async ({ name }) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })));
  dated.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  for (const { name } of dated.slice(keep)) await rm(join(dir, name), { recursive: true, force: true });
}

const indexFile = (directory: string) => join(directory, 'index', 'dsh-index.json');

/** Rebuilds `index/dsh-index.json` from the mirror and records the mirror commit as `indexCommit`. A wrong or empty mirror throws and leaves the previous index as it was. */
export async function refreshIndex(directory: string, store: CandidateStore, mirror: string): Promise<DshIndex> {
  const index = await buildDshIndex(mirror);
  // A wrong or empty mirror path yields an empty index; never overwrite a good one with it.
  if (index.entries.length === 0) throw new Error(`DSH index is empty for ${mirror}; keeping the previous index`);
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
