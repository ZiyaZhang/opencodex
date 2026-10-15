/** Source 2: the watched files that differ between two stable tags, one candidate per group of files.
 * GitHub's compare API lists at most 300 files of a window, alphabetically, so `codex-rs/features/`, `codex-rs/config.md` and `docs/` never come up.
 * This source takes the recursive tree of each tag instead, keeps the watched paths and compares blob shas; only the files whose sha differs are read.
 */
import { join } from 'node:path';
import type { Evidence, EvidenceKind } from '../../core/candidate.js';
import { writeJsonAtomic, type CandidateStore } from '../../core/store.js';
import type { GitHubClient } from '../github.js';
import { minor, type StableWindow } from './codex-releases.js';

export const WATCHED = (path: string): boolean => /^codex-rs\/features\/|^codex-rs\/app-server-protocol\/schema\/typescript\/|^docs\/[^/]+\.md$|^codex-rs\/config\.md$/.test(path);
export interface ChangedPath { path: string; status: 'added' | 'removed' | 'modified' }
export interface ChangedFile extends ChangedPath {
  /** Lines of the new version that the old version does not have. Empty for a removed file and for a file that could not be read. */
  added: string[];
  /** Why the content was not compared (a failed or refused request, or the fetch budget); `added` is then empty. */
  error?: string;
}
export interface FileGroup { key: string; title: string; kind: EvidenceKind; files: ChangedFile[]; excerpt: string }

/**
 * Files whose content is read in one run. The budget counts files, not requests: an added or removed file costs one request, a modified one two.
 * Through `gh` that is far below the authenticated limit; on the anonymous REST fallback (60 requests an hour) a big window can still run dry,
 * and the files after that are recorded with the error of their failed request.
 */
const MAX_FETCHED_FILES = 60;
const OVER_BUDGET = 'skipped: over the per-run fetch budget';
const EXCERPT_LIMIT = 6_000, SUMMARY_LIMIT = 1_000, EVIDENCE_LIMIT = 2_000, ERROR_LIMIT = 200;
const LINE_BREAK = /\r\n|\r|\n/;

type Family = 'feature-flag' | 'schema' | 'config' | 'doc';
const FEATURES_DIR = 'codex-rs/features/', SCHEMA_DIR = 'codex-rs/app-server-protocol/schema/typescript/', CONFIG_DOC = 'codex-rs/config.md';
const familyOf = (path: string): Family =>
  path.startsWith(FEATURES_DIR) ? 'feature-flag' : path.startsWith(SCHEMA_DIR) ? 'schema' : path === CONFIG_DOC ? 'config' : 'doc';
/** The order files are read in: what says most about a new capability first. */
const PRIORITY: Record<Family, number> = { 'feature-flag': 0, schema: 1, config: 2, doc: 3 };
const byPriority = (a: ChangedPath, b: ChangedPath): number =>
  PRIORITY[familyOf(a.path)] - PRIORITY[familyOf(b.path)] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Paths in either tree whose blob sha differs, sorted by path. */
export function changedWatched(before: Map<string, string>, after: Map<string, string>): ChangedPath[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.flatMap(path => {
    const a = before.get(path), b = after.get(path);
    if (a === b) return [];
    return [{ path, status: a === undefined ? 'added' as const : b === undefined ? 'removed' as const : 'modified' as const }];
  });
}

/** Non-blank lines of `after` that `before` does not have, in order. Whole lines are compared as a set, not aligned (no longest common subsequence), and CRLF reads like LF. */
export function addedLines(before: string, after: string): string[] {
  const old = new Set(before.split(LINE_BREAK));
  return after.split(LINE_BREAK).filter(line => line.trim() && !old.has(line));
}

/** At most `limit` characters; a longer text ends in an ellipsis, and the cut never falls between the halves of a surrogate pair. */
function cutText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - 1; // room for the ellipsis
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}
/** The lines joined by newlines, whole lines from the top up to `limit` characters. Only a first line that is longer than the limit by itself is cut. */
function clipLines(lines: string[], limit: number): string {
  let length = 0, kept = 0;
  for (const line of lines) {
    const next = length + (kept > 0 ? 1 : 0) + line.length;
    if (next > limit) break;
    length = next;
    kept++;
  }
  return kept === 0 && lines.length > 0 ? cutText(lines[0]!, limit) : lines.slice(0, kept).join('\n');
}

function groupOf(path: string): Pick<FileGroup, 'key' | 'title' | 'kind'> {
  const family = familyOf(path);
  if (family === 'feature-flag') return { key: 'feature-flags', title: '功能开关注册表有变化', kind: 'feature-flag' };
  if (family === 'schema') {
    const type = path.split('/').at(-1)!.replace(/\.ts$/, '');
    return { key: `schema:${type}`, title: `协议类型有变化：${type}`, kind: 'schema' };
  }
  return { key: `doc:${path}`, title: `文档有变化：${path}`, kind: 'doc' };
}

/** `<basename>: <line>` for each added line. A file with none says why instead (removed, or unread), so that its group is not an empty shell. */
function excerptLines(file: ChangedFile): string[] {
  const name = file.path.split('/').at(-1)!;
  if (file.added.length > 0) return file.added.map(line => `${name}: ${line}`);
  if (file.error) return [`${name}: （内容未读取：${cutText(file.error.replace(/\s+/g, ' ').trim(), ERROR_LIMIT)}）`];
  if (file.status === 'removed') return [`${name}: （文件已删除）`];
  return [];
}

/**
 * The watched files grouped into what becomes one candidate each, in the order the groups first appear:
 * everything under `codex-rs/features/` is one group (`feature-flags`), a protocol type is one group per file name (`schema:<Type>`), a doc is one group per path (`doc:<path>`).
 * The excerpt is the group's added lines (a file without any gives the reason instead), capped at 6,000 characters and cut at a whole line.
 */
export function groupWatchedFiles(files: ChangedFile[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const file of files) {
    if (!WATCHED(file.path)) continue;
    const head = groupOf(file.path);
    const group = groups.get(head.key) ?? { ...head, files: [], excerpt: '' };
    group.files.push(file);
    groups.set(head.key, group);
  }
  for (const group of groups.values()) group.excerpt = clipLines(group.files.flatMap(excerptLines), EXCERPT_LIMIT);
  return [...groups.values()];
}

/** False for a group whose files were all edited in place without gaining a line and were all read: nothing to report. A removal, an addition or an unread file is. */
const hasNews = (group: FileGroup): boolean => group.files.some(file => file.status !== 'modified' || file.added.length > 0 || file.error !== undefined);

/**
 * Both versions of one changed file (an added file only at `to`, a removed one only at `from`), compared line by line.
 * A file that cannot be read (over 1 MB, a failed request) is recorded with its error so that the rest of the run goes on; an abort ends the run.
 */
async function readChange(github: Pick<GitHubClient, 'fileAt'>, window: StableWindow, change: ChangedPath, signal?: AbortSignal): Promise<ChangedFile> {
  // An async wrapper, so that a call which throws instead of rejecting still leaves both reads for `Promise.all` to settle.
  const read = async (tag: string) => github.fileAt(tag, change.path, signal);
  try {
    const [before, after] = await Promise.all([change.status === 'added' ? '' : read(window.from), change.status === 'removed' ? '' : read(window.to)]);
    return { ...change, added: addedLines(before, after) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ...change, added: [], error: (error instanceof Error ? error.message : String(error)) || 'unknown error' };
  }
}

/**
 * Stores one `codex-files` candidate per group of watched files that changed from `window.from` to `window.to` and returns how many were new.
 * The fingerprint carries the minor version, so a patch release refreshes the candidate of its minor instead of adding a second one.
 * At most 60 files are read, feature flags first, then protocol types, `codex-rs/config.md` and docs (alphabetical within each); the rest are recorded unread.
 * The result is also saved as `<snapshotDir>/codex-files/<from>__<to>.json`, which keeps the added lines of every changed file, candidate or not.
 */
export async function collectFileChanges(store: CandidateStore, github: Pick<GitHubClient, 'treePaths' | 'fileAt'>, snapshotDir: string, window: StableWindow, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  const [before, after] = await Promise.all([github.treePaths(window.from, WATCHED, signal), github.treePaths(window.to, WATCHED, signal)]);
  const changes = changedWatched(before, after);
  const loaded = new Map<string, ChangedFile>();
  for (const [index, change] of [...changes].sort(byPriority).entries()) {
    signal?.throwIfAborted();
    loaded.set(change.path, index < MAX_FETCHED_FILES ? await readChange(github, window, change, signal) : { ...change, added: [], error: OVER_BUDGET });
  }
  const files = changes.map(change => loaded.get(change.path)!); // back in the order of the tree diff
  signal?.throwIfAborted();
  await writeJsonAtomic(join(snapshotDir, 'codex-files', `${window.from}__${window.to}.json`), { window, files });
  const url = `https://github.com/openai/codex/compare/${window.from}...${window.to}`;
  let added = 0;
  for (const group of groupWatchedFiles(files).filter(hasNews)) {
    const { created } = await store.upsert({
      source: 'codex-files', key: `${group.key}:${minor(window.to)}`, title: group.title,
      summary: clipLines(group.excerpt.split('\n'), SUMMARY_LIMIT),
      evidence: group.files.map((file): Evidence => ({ kind: group.kind, ref: file.path, url, excerpt: clipLines(file.added, EVIDENCE_LIMIT) })),
      window: { fromTag: window.from, toTag: window.to },
    });
    if (created) added++;
  }
  return added;
}
