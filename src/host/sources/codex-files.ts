/** Source 2: what changed in the watched files between two stable tags, as candidates.
 * GitHub's compare API lists at most 300 files of a window, alphabetically, so `codex-rs/features/`, `codex-rs/config.md` and `docs/` never come up.
 * This source takes the recursive tree of each tag instead, keeps the watched paths and compares blob shas; only the files whose sha differs are read.
 * It works out its own window from the tags and keeps its own checkpoint (`lastFilesTag`): the release source's checkpoint does not decide its window,
 * and a failure here does not lose it.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fingerprintOf, type Candidate, type Evidence, type EvidenceKind } from '../../core/candidate.js';
import { check } from '../../core/check.js';
import { writeJsonAtomic, type CandidateStore } from '../../core/store.js';
import { GitHubError, type GitHubClient } from '../github.js';
import { minor, stableWindow, type StableWindow } from './codex-releases.js';

// The feature-flag registry is the Rust source of the features crate. Its build files and test modules (`tests.rs`, `*_tests.rs`) say nothing about a new flag.
const FEATURE_SOURCE = /^codex-rs\/features\/src\/.+\.rs$/;
const TEST_MODULE = /(?:^|\/)(?:tests|[^/]+_tests)\.rs$/;
const SCHEMA_TYPE = /^codex-rs\/app-server-protocol\/schema\/typescript\//;
const DOC = /^docs\/[^/]+\.md$/;
const CONFIG_DOC = 'codex-rs/config.md';
export const WATCHED = (path: string): boolean => (FEATURE_SOURCE.test(path) && !TEST_MODULE.test(path)) || SCHEMA_TYPE.test(path) || DOC.test(path) || path === CONFIG_DOC;
export interface ChangedPath { path: string; status: 'added' | 'removed' | 'modified' }
export interface ChangedFile extends ChangedPath {
  /** Lines of the new version that the old version does not have. Empty for a removed file and for a file that could not be read. */
  added: string[];
  /** Why the content was not compared (a failed or refused request, the rate limit, or the fetch budget); `added` is then empty. Never set for a removed file, which is not read. */
  error?: string;
}
export interface FileGroup { key: string; title: string; kind: EvidenceKind; files: ChangedFile[]; excerpt: string }
/**
 * What one check of this source did: the window it covered (none when there was nothing new), the candidates it created and the existing ones it added to.
 * `gap` is true when the stored checkpoint could not start the window (its tag is gone, or it is no usable tag), so that the window starts at the previous minor
 * and the releases in between were not collected.
 */
export interface FilesCollection { window?: StableWindow; added: number; merged: number; gap: boolean }

/** The window is worked out from this many of the newest stable tags, as the release source does. */
const RECENT_STABLE_TAGS = 12;
const CHECKPOINT = 'lastFilesTag';
/**
 * Files whose content is read in one run unless the caller passes another `budget`. It counts files, not requests: an added file costs one request, a modified one two,
 * a removed one none. Through `gh` 60 is far below the authenticated limit; on the anonymous REST fallback (60 requests an hour) the host passes a smaller budget.
 */
const DEFAULT_BUDGET = 60;
const OVER_BUDGET = '超出本次读取上限';
const RATE_LIMITED = '已达 GitHub 速率限制';
const EXCERPT_LIMIT = 6_000, SUMMARY_LIMIT = 1_000, EVIDENCE_LIMIT = 2_000, ERROR_LIMIT = 200;
const LINE_BREAK = /\r\n|\r|\n/;

type Family = 'feature-flag' | 'config' | 'doc' | 'schema';
/** Only called for watched paths. */
const familyOf = (path: string): Family => FEATURE_SOURCE.test(path) ? 'feature-flag' : SCHEMA_TYPE.test(path) ? 'schema' : path === CONFIG_DOC ? 'config' : 'doc';
/** The order files are read in. A generator change touches hundreds of one-line type files, so the types come last: they must not use up the budget the flags and docs need. */
const PRIORITY: Record<Family, number> = { 'feature-flag': 0, config: 1, doc: 2, schema: 3 };
const byPriority = (a: ChangedPath, b: ChangedPath): number =>
  PRIORITY[familyOf(a.path)] - PRIORITY[familyOf(b.path)] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
/** `index.ts` and `v2/index.ts` only re-export the type files. They never reach a candidate, so they are listed in the snapshot but not read. */
const isIndex = (path: string): boolean => familyOf(path) === 'schema' && path.split('/').at(-1) === 'index.ts';

/** Paths in either tree whose blob sha differs, sorted by path. */
export function changedWatched(before: Map<string, string>, after: Map<string, string>): ChangedPath[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.flatMap(path => {
    const a = before.get(path), b = after.get(path);
    if (a === b) return [];
    return [{ path, status: a === undefined ? 'added' as const : b === undefined ? 'removed' as const : 'modified' as const }];
  });
}

/** Lines of `after` beyond the copies `before` already has, in order. Occurrences are counted: a moved line is not new, but one more copy of a line is. */
function newLines(before: string[], after: string[]): string[] {
  const unused = new Map<string, number>();
  for (const line of before) unused.set(line, (unused.get(line) ?? 0) + 1);
  return after.filter(line => {
    if (!line.trim()) return false;
    const left = unused.get(line) ?? 0;
    if (left === 0) return true;
    unused.set(line, left - 1);
    return false;
  });
}
/** Non-blank lines of `after` that `before` does not have, in order. Whole lines are compared, counted and not aligned (no longest common subsequence), and CRLF reads like LF. */
export const addedLines = (before: string, after: string): string[] => newLines(before.split(LINE_BREAK), after.split(LINE_BREAK));

const CLOSER: Record<string, string> = { '}': '{', ']': '[', ')': '(', '>': '<' };
/** Where the scan of a ts-rs file stands between two lines: the brackets still open, and whether a block comment is. */
interface Scan { open: string[]; comment: boolean }
/**
 * A line cut after each top-level `, ` or `; `, so that one field is one line whatever the length of the line it sits on: a type that grows from 185 to 210 characters
 * must not turn all its fields into new lines. Top level is directly inside the braces of the type, or of one variant of a union, with no other bracket open.
 * ts-rs breaks a type at its doc comments, and the field lines after a comment have no `{` of their own, so `scan` keeps the open brackets from line to line.
 * Nested objects, generics, tuples, strings and comments stay whole.
 */
function splitFields(line: string, scan: Scan): string[] {
  const pieces: string[] = [];
  let start = 0, inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (scan.comment) {
      if (ch === '*' && line[i + 1] === '/') { scan.comment = false; i++; }
    } else if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '/' && line[i + 1] === '*') { scan.comment = true; i++; }
    else if (ch === '"') inString = true;
    else if ('{[(<'.includes(ch)) scan.open.push(ch);
    else if (CLOSER[ch] !== undefined) { if (scan.open.at(-1) === CLOSER[ch]) scan.open.pop(); }
    else if ((ch === ',' || ch === ';') && line[i + 1] === ' ' && scan.open.length === 1 && scan.open[0] === '{') {
      pieces.push(line.slice(start, i + 1));
      start = i + 2;
    }
  }
  pieces.push(line.slice(start));
  return pieces;
}
/**
 * The lines compared for a ts-rs generated file: without the leading `//` header and the `import type` lines, which change when the generator or an unrelated type does,
 * and with every line cut into its fields. Blank lines are dropped.
 */
export function schemaLines(text: string): string[] {
  const lines: string[] = [];
  const scan: Scan = { open: [], comment: false };
  let header = true;
  for (const line of text.split(LINE_BREAK)) {
    if (header && (!line.trim() || line.startsWith('//'))) continue;
    header = false;
    if (line.trim() && !/^import type .*;\s*$/.test(line)) lines.push(...splitFields(line, scan).filter(piece => piece.trim()));
  }
  return lines;
}

/** At most `limit` characters; a longer text ends in an ellipsis, and the cut never falls between the halves of a surrogate pair. */
function cutText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - 1; // room for the ellipsis
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}
const more = (count: number): string => `…另有 ${count} 行`;
/**
 * The lines joined by newlines: whole lines from the top, then a line that counts the ones left out, all within `limit` characters. `omitted` is the number of lines
 * already left out before these. Only a first line that cannot fit by itself is cut.
 */
function clipLines(lines: string[], limit: number, omitted = 0): string {
  const tail = (shown: number): string => (omitted + lines.length - shown > 0 ? more(omitted + lines.length - shown) : '');
  let length = 0, shown = 0;
  while (shown < lines.length) {
    const next = length + (shown > 0 ? 1 : 0) + lines[shown]!.length;
    if (next > limit) break;
    length = next;
    shown++;
  }
  // The count has to fit as well: give lines back until it does.
  while (shown > 0 && length + (tail(shown) ? 1 + tail(shown).length : 0) > limit) {
    shown--;
    length -= lines[shown]!.length + (shown > 0 ? 1 : 0);
  }
  if (shown > 0) return [...lines.slice(0, shown), ...(tail(shown) ? [tail(shown)] : [])].join('\n');
  if (lines.length === 0) return tail(0);
  const rest = tail(1);
  return rest ? `${cutText(lines[0]!, limit - rest.length - 1)}\n${rest}` : cutText(lines[0]!, limit);
}
/** Undoes `clipLines` for an excerpt read back from a stored candidate: the lines that were shown and the count that was left out. */
function parseExcerpt(excerpt = ''): { lines: string[]; omitted: number } {
  if (!excerpt) return { lines: [], omitted: 0 };
  const lines = excerpt.split('\n');
  const count = /^…另有 (\d+) 行$/.exec(lines.at(-1)!);
  return count ? { lines: lines.slice(0, -1), omitted: Number(count[1]) } : { lines, omitted: 0 };
}

/** What names a file in an excerpt line: its path under `schema/typescript/` without `.ts` for a protocol type (`v2/SessionSource`), its file name for anything else (`lib.rs`). */
function nameOf(path: string): string {
  return familyOf(path) === 'schema' ? path.replace(SCHEMA_TYPE, '').replace(/\.ts$/, '') : path.split('/').at(-1)!;
}
/*
 * Files whose content is not in hand, and what a candidate says about them:
 * - A removed file is never read, since its lines are gone. It shows as `（文件已删除）`; a read error does not apply to it.
 * - A file that could not be read (over 1 MB, a failed request, the rate limit, past the budget) shows as `（内容未读取：<reason>）`. The marker is a line of its excerpt, in the
 *   evidence and in the summary, so that the candidate is not an empty shell. Such a file still makes a candidate: "not read" is not "nothing new", and the change would be
 *   lost for good, because a window is collected once.
 * - A file that gained no line has nothing to report and is left out: a modified one (a reordering, blank lines, only removed lines, a generator header) and a new one without a non-blank line.
 */
const DELETED = '（文件已删除）';
const unread = (reason: string): string => `（内容未读取：${cutText(reason.replace(/\s+/g, ' ').trim(), ERROR_LIMIT)}）`;
/** The lines a file contributes to an excerpt: its added lines, or the reason it has none. */
function linesOf(file: ChangedFile): string[] {
  if (file.added.length > 0) return file.added;
  if (file.error) return [unread(file.error)];
  return file.status === 'removed' ? [DELETED] : [];
}
const hasNews = (file: ChangedFile): boolean => file.status === 'removed' || file.added.length > 0 || file.error !== undefined;

function groupOf(path: string): Pick<FileGroup, 'key' | 'kind'> {
  const family = familyOf(path);
  if (family === 'feature-flag') return { key: 'feature-flags', kind: 'feature-flag' };
  if (family === 'schema') return { key: 'schema', kind: 'schema' };
  return { key: `doc:${path}`, kind: 'doc' };
}
const versionNote = (version?: string): string => (version ? `（${version}）` : '');
/** `version` is the minor, or the full version of a candidate the user has already moved on from; `types` is how many type files the protocol candidate holds. */
function titleOf(group: Pick<FileGroup, 'kind' | 'files'>, version?: string, types = group.files.length): string {
  if (group.kind === 'feature-flag') return `功能开关注册表有变化${versionNote(version)}`;
  if (group.kind === 'schema') return `协议类型有变化${versionNote(version)}：${types} 个类型`;
  return `文档有变化${versionNote(version)}：${group.files[0]!.path}`; // a doc group is the one file it is named after
}

/**
 * The watched files that have something to report, grouped into what becomes one candidate each, in the order the groups first appear:
 * the feature-flag sources are one group (`feature-flags`), every protocol type of the window is one group (`schema`, without the `index.ts` re-exports), a doc is one group per path (`doc:<path>`).
 * The excerpt is the group's added lines as `<name>: <line>`, or the reason a file has none, cut at a whole line within 6,000 characters. `version` goes into the titles.
 */
export function groupWatchedFiles(files: ChangedFile[], version?: string): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const file of files) {
    if (!WATCHED(file.path) || isIndex(file.path) || !hasNews(file)) continue;
    const head = groupOf(file.path);
    const group = groups.get(head.key) ?? { ...head, title: '', files: [], excerpt: '' };
    group.files.push(file);
    groups.set(head.key, group);
  }
  for (const group of groups.values()) {
    group.title = titleOf(group, version);
    group.excerpt = clipLines(group.files.flatMap(file => linesOf(file).map(line => `${nameOf(file.path)}: ${line}`)), EXCERPT_LIMIT);
  }
  return [...groups.values()];
}

/** One file of a candidate in memory: the lines of its evidence entry, and how many more the stored excerpt had already left out. */
interface Entry { ref: string; url?: string; lines: string[]; omitted: number }
const entryOf = (evidence: Evidence): Entry => ({ ref: evidence.ref, url: evidence.url, ...parseExcerpt(evidence.excerpt) });
/** GitHub's own anchor for one file of a compare page. */
const compareUrl = (from: string, to: string, path: string): string =>
  `https://github.com/openai/codex/compare/${from}...${to}#diff-${createHash('sha256').update(path).digest('hex')}`;
/**
 * The entries of a candidate after another window: those only an earlier window found stay in front, this window's follow. A file both found keeps the older lines first and gains the
 * newer ones not yet in it (a read that failed adds its marker), and its link spans from the first window of the candidate to this one.
 */
function mergeEntries(old: Entry[], found: Entry[], from: string, to: string): Entry[] {
  const earlier = new Map(old.map(entry => [entry.ref, entry]));
  const refs = new Set(found.map(entry => entry.ref));
  return [
    ...old.filter(entry => !refs.has(entry.ref)),
    ...found.map(entry => {
      const before = earlier.get(entry.ref);
      if (!before) return entry;
      const present = new Set(before.lines);
      return { ref: entry.ref, url: compareUrl(from, to, entry.ref), lines: [...before.lines, ...entry.lines.filter(line => !present.has(line))], omitted: before.omitted };
    }),
  ];
}
/** The summary of a candidate is rebuilt from all its entries, not only from the newest window. */
function summaryOf(entries: Entry[]): string {
  const lines = entries.flatMap(entry => entry.lines.map(line => `${nameOf(entry.ref)}: ${line}`));
  return clipLines(lines, SUMMARY_LIMIT, entries.reduce((sum, entry) => sum + entry.omitted, 0));
}

/**
 * Where this window's findings of a group go. While the candidate of the minor is still `new` they are added to it; once the user has reported, started or ignored it they
 * go to a candidate of the full version, so that they are seen. `stored` is true when an earlier attempt at this very window (the checkpoint did not move) already put the group
 * into the candidate of the minor, whatever the user has done with it since, or into the one of the full version: it is then left as it is.
 */
async function targetFor(store: CandidateStore, groupKey: string, to: string): Promise<{ key: string; version: string; existing?: Candidate; stored: boolean }> {
  const minorKey = `${groupKey}:${minor(to)}`;
  const forMinor = await store.findByFingerprint(fingerprintOf('codex-files', minorKey));
  if (!forMinor || forMinor.status === 'new') return { key: minorKey, version: minor(to), existing: forMinor, stored: forMinor?.window?.toTag === to };
  const version = to.replace(/^rust-v/, '');
  const key = `${groupKey}:${version}`;
  const forFull = await store.findByFingerprint(fingerprintOf('codex-files', key));
  return { key, version, existing: forFull, stored: forMinor.window?.toTag === to || forFull?.window?.toTag === to };
}

/** A request the rate limit refused. Not every 403 is one: the contents API also answers 403 for a blob over 1 MB. */
const isRateLimit = (error: unknown): boolean => error instanceof GitHubError && error.rateLimited;

/**
 * Both versions of one added or modified file, compared line by line (an added file has no old version). A file that cannot be read is recorded with its error so that the
 * rest of the run goes on; an abort ends the run. `rateLimited` tells the caller to stop asking.
 */
async function readChange(github: Pick<GitHubClient, 'fileAt'>, window: StableWindow, change: ChangedPath, signal?: AbortSignal): Promise<{ file: ChangedFile; rateLimited: boolean }> {
  // An async wrapper, so that a call which throws instead of rejecting still leaves both reads for `Promise.all` to settle.
  const read = async (tag: string) => github.fileAt(tag, change.path, signal);
  try {
    const [before, after] = await Promise.all([change.status === 'added' ? '' : read(window.from), read(window.to)]);
    const added = familyOf(change.path) === 'schema' ? newLines(schemaLines(before), schemaLines(after)) : addedLines(before, after);
    return { file: { ...change, added }, rateLimited: false };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { file: { ...change, added: [], error: (error instanceof Error ? error.message : String(error)) || 'unknown error' }, rateLimited: isRateLimit(error) };
  }
}

const STABLE_TAG = /^rust-v(\d+)\.(\d+)\.(\d+)$/;
/** True when stable tag `a` is an older release than `b`. */
function isOlder(a: string, b: string): boolean {
  const x = STABLE_TAG.exec(a)?.slice(1).map(Number), y = STABLE_TAG.exec(b)?.slice(1).map(Number);
  return x !== undefined && y !== undefined && (x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!) < 0;
}

/**
 * The window to collect and the watched blobs at its two ends. Normally that is `stableWindow` of the newest tags and the checkpoint. A checkpoint that fell out of the newest
 * tags (a long absence) still starts the window: it is a stable tag, and two trees cover any range. Only when the tree of that tag cannot be fetched (404) is the window the previous
 * minor's instead; a checkpoint that cannot be a start at all (no stable tag, or not older than the newest one) is ignored in the same way. Both are a `gap`.
 */
async function planWindow(github: Pick<GitHubClient, 'stableTags' | 'treePaths'>, checkpoint: string | undefined, signal?: AbortSignal): Promise<{ window?: StableWindow; before: Map<string, string>; after: Map<string, string>; gap: boolean }> {
  const tags = await github.stableTags(RECENT_STABLE_TAGS, signal);
  const trees = async (window: StableWindow, gap: boolean) => {
    const [before, after] = await Promise.all([github.treePaths(window.from, WATCHED, signal), github.treePaths(window.to, WATCHED, signal)]);
    return { window, before, after, gap };
  };
  const none = (gap: boolean) => ({ before: new Map<string, string>(), after: new Map<string, string>(), gap });
  const newest = tags[0];
  if (newest === undefined || checkpoint === undefined || tags.includes(checkpoint)) { // the usual case: no checkpoint yet, or one among the newest tags
    const window = stableWindow(tags, checkpoint);
    return window ? trees(window, false) : none(false);
  }
  if (STABLE_TAG.test(checkpoint) && isOlder(checkpoint, newest)) {
    const window: StableWindow = { from: checkpoint, to: newest, releases: [...tags] };
    const [from, to] = await Promise.allSettled([github.treePaths(window.from, WATCHED, signal), github.treePaths(window.to, WATCHED, signal)]);
    if (to.status === 'rejected') throw to.reason;
    if (from.status === 'fulfilled') return { window, before: from.value, after: to.value, gap: false };
    if (!(from.reason instanceof GitHubError && from.reason.status === 404)) throw from.reason;
    const previous = stableWindow(tags); // the stored tag is gone
    return previous ? { window: previous, before: await github.treePaths(previous.from, WATCHED, signal), after: to.value, gap: true } : none(true);
  }
  const window = stableWindow(tags);
  return window ? trees(window, true) : none(true);
}

/**
 * Finds the window of stable releases this source has not covered yet (from `lastFilesTag`; see `planWindow`), and stores one `codex-files` candidate per group of watched files
 * that changed in it: the feature-flag sources, all protocol types together, and each doc on its own. `added` counts the candidates created, `merged` the existing ones added to,
 * `gap` says whether the window had to start at the previous minor because the stored tag could not start it.
 * The checkpoint moves only after the snapshot and every candidate are stored: a failed tag or tree request, or a failed store, throws and the next check retries the window
 * (a candidate the earlier attempt already stored is recognised by its `toTag` and left alone). A file that cannot be read is recorded and does not hold the checkpoint back.
 * The candidate is keyed by the minor version, so a patch release adds to the candidate of its minor while that is still `new`: its evidence is kept (matched by `ref`, the lines of a
 * file found by both windows are merged), `window.fromTag` stays at the first window's, and the summary is rebuilt from all of it. Once the user has moved the candidate on, the
 * findings go to a candidate of the full version instead.
 * At most `options.budget` files are read (default 60), flags first, then `codex-rs/config.md`, docs and protocol types (alphabetical within each). A removed file and an `index.ts`
 * are not read and take no slot; both are listed in the snapshot with no added lines. The rest are recorded unread, and so are all that follow a rate limit.
 * The result is also saved as `<snapshotDir>/codex-files/<from>__<to>.json`, which keeps the added lines of every changed file, candidate or not.
 */
export async function collectFileChanges(
  store: CandidateStore, github: Pick<GitHubClient, 'stableTags' | 'treePaths' | 'fileAt'>, snapshotDir: string, signal?: AbortSignal, options: { budget?: number } = {},
): Promise<FilesCollection> {
  const budget = options.budget ?? DEFAULT_BUDGET;
  check(Number.isInteger(budget) && budget >= 0, `budget must be a non-negative integer, got ${budget}`);
  signal?.throwIfAborted();
  const { window, before, after, gap } = await planWindow(github, await store.checkpoint(CHECKPOINT), signal);
  if (!window) return { added: 0, merged: 0, gap };
  const changes = changedWatched(before, after);
  const loaded = new Map<string, ChangedFile>();
  let slots = budget, limited = false;
  for (const change of [...changes].sort(byPriority)) {
    signal?.throwIfAborted();
    if (change.status === 'removed' || isIndex(change.path)) loaded.set(change.path, { ...change, added: [] }); // nothing to read, or nothing that reaches a candidate
    else if (slots === 0) loaded.set(change.path, { ...change, added: [], error: OVER_BUDGET });
    else {
      slots--;
      if (limited) loaded.set(change.path, { ...change, added: [], error: RATE_LIMITED });
      else {
        const reading = await readChange(github, window, change, signal);
        limited = reading.rateLimited;
        loaded.set(change.path, reading.file);
      }
    }
  }
  const files = changes.map(change => loaded.get(change.path)!); // back in the order of the tree diff
  signal?.throwIfAborted();
  await writeJsonAtomic(join(snapshotDir, 'codex-files', `${window.from}__${window.to}.json`), { window, files });

  let added = 0, merged = 0;
  for (const group of groupWatchedFiles(files)) {
    const { key, version, existing, stored } = await targetFor(store, group.key, window.to);
    // Merging a window again would count the lines its stored excerpt left out twice, and a candidate the user has moved on would get a copy.
    if (stored) continue;
    const from = existing?.window?.fromTag ?? window.from;
    const found = group.files.map((file): Entry => ({ ref: file.path, url: compareUrl(window.from, window.to, file.path), lines: linesOf(file), omitted: 0 }));
    const entries = existing ? mergeEntries(existing.evidence.map(entryOf), found, from, window.to) : found;
    const result = await store.upsert({
      source: 'codex-files', key, title: titleOf(group, version, entries.length), summary: summaryOf(entries),
      evidence: entries.map((entry): Evidence => ({ kind: group.kind, ref: entry.ref, url: entry.url, excerpt: clipLines(entry.lines, EVIDENCE_LIMIT, entry.omitted) })),
      window: { fromTag: from, toTag: window.to },
    });
    if (result.created) added++;
    else merged++; // the window's end differs from the one it had, so an existing candidate always changes
  }
  await store.setCheckpoint(CHECKPOINT, window.to);
  return { window, added, merged, gap };
}
