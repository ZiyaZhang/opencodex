/**
 * The evidence directory an analyst session reads before it writes a gap report (`reports/<id>/evidence/`), and the helpers that gather
 * what goes into it: the DSH index hits of a candidate, per kind, and the per-file diffs of its source.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Candidate, Evidence, EvidenceKind } from '../../core/candidate.js';
import { check } from '../../core/check.js';
import { GitHubError, type GitHubClient } from '../github.js';
import { searchIndex, type DshIndex, type IndexEntry } from '../index/dsh-index.js';
import type { ChangedFile } from '../sources/codex-files.js';
import { minor } from '../sources/codex-releases.js';

/**
 * The changes of one file. `source` says where they come from: `#50148` for the diff of a pull request, `<from>__<to>` (two stable tags) for the windows
 * a codex-files line list spans.
 */
export interface DiffFile { path: string; diff: string; source?: string }
/** What `rankDiffFiles` keeps. A line list cut to fit is in `kept` with its first lines and in `cut` as it came. */
export interface RankedDiffs { kept: DiffFile[]; dropped: DiffFile[]; cut: DiffFile[] }
export interface DiffSources {
  github: Pick<GitHubClient, 'pullRequestDiff'>;
  /** The snapshot directory of the OpenCodex data directory; the codex-files snapshots are in its `codex-files/`. */
  snapshotDir: string;
  /**
   * Told, with the reason, about every diff the result lacks or holds only in part: a pull request that failed, answered without a diff or was not asked after a
   * rate limit; a snapshot that is missing or damaged; a file whose content is unknown.
   */
  onError?: (message: string) => void;
}
export interface EvidencePackInput {
  /** The candidate's report directory, `reports/<id>/`, as an absolute path; the pack is its `evidence/`. */
  directory: string;
  candidate: Candidate;
  diffs: DiffFile[];
  dshHits: IndexEntry[];
  /** Characters of diffs (or of line lists) to keep, a positive integer; 60,000 by default. */
  budget?: number;
  /** The root of the DSH mirror that the `dsh/` paths are relative to; INDEX.md names it when given. */
  mirror?: string;
  /** Evidence that could not be read, such as the `onError` messages of `diffsFor`. INDEX.md lists them under 没取到的内容: what was not read is unknown, not unchanged. */
  gaps?: string[];
}

/** Diff characters a pack holds unless the caller passes another budget: about 15k tokens. */
const DIFF_BUDGET = 60_000;
const QUERY_LIMIT = 2_000;
/** Characters of a path or ref that make a file name; a longer one keeps its end, where the file and type names are. */
const NAME_LIMIT = 80;
/** Evidence entries that get a file of their own; the rest share `sources/more-evidence.md`. i18n keys and chunks always share one file per kind. */
const EVIDENCE_FILES = 40;
/** INDEX.md: lines of one list, characters of one list line and of the title, characters of the whole file, room kept for the line that counts what a list leaves out. */
const LIST_LINES = 40, ITEM_LIMIT = 300, TITLE_LIMIT = 200, INDEX_LIMIT = 8_000, REST_ROOM = 48;
/** Index hits per kind, in the order the pack lists them. Searched per kind, so that the long notes cannot crowd out the package summaries. */
const HIT_LIMITS = [['package', 3], ['config', 2], ['note', 2]] as const;
const DIR_MODE = 0o700, FILE_MODE = 0o600;
const STABLE_TAG = /^rust-v(\d+)\.(\d+)\.(\d+)$/;
const DIFF_HEADER = 'diff --git ';
/** Separates a path from what is said about it on one line, as the report template separates its header fields: an ideographic space. */
const SEPARATOR = String.fromCharCode(0x3000);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
/** At most `limit` characters; a longer text ends in an ellipsis, and the cut never falls between the halves of a surrogate pair. */
function cutLine(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

// Query and index hits

/** `codex-rs/` and `codex.` prefixes of paths and keys. */
const CODEX_PREFIX = /(?<![A-Za-z\d])codex(?:-rs(?![A-Za-z\d])\/?|\.(?=[A-Za-z\d]))/gi;
/**
 * The text without the word `codex`, which the index weighs heavily (few entries hold it) and which only leads to DSH's own Codex adapters: the `codex-rs/` and
 * `codex.` prefixes go, and so does every `codex` the index would read as a word, alone or as a part of a CamelCase word (`CodexThread` keeps `Thread`).
 */
function withoutCodex(text: string): string {
  return text.replace(CODEX_PREFIX, '')
    .replace(/[A-Za-z\d]+/g, run => run.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ').filter(part => part.toLowerCase() !== 'codex').join(''));
}

/**
 * What the DSH index is searched with for a candidate: its title, its summary and the ref of every evidence entry but a pull request (file paths, i18n keys, chunk
 * names, RSS titles), joined by spaces and cut at a word boundary to at most 2,000 characters. Left out: `#123` references; everything outside printable ASCII
 * (Chinese titles and strings, full-width punctuation), which the English index cannot match; the word `codex` (see `withoutCodex`); a part equal to an earlier
 * one (a release title is its summary).
 */
export function queryForCandidate(candidate: Candidate): string {
  const parts = [candidate.title, candidate.summary, ...candidate.evidence.filter(entry => entry.kind !== 'pr').map(entry => entry.ref)];
  const words = parts.map(part => oneLine(withoutCodex(part.replace(/#\d+/g, ' ').replace(/[^\x21-\x7e]+/g, ' ')))).filter(Boolean);
  const query = [...new Set(words)].join(' ');
  if (query.length <= QUERY_LIMIT) return query;
  const end = query.lastIndexOf(' ', QUERY_LIMIT);
  return end > 0 ? query.slice(0, end) : query.slice(0, QUERY_LIMIT);
}

/**
 * The index entries a pack shows for a candidate: up to 3 package summaries, 2 config catalog entries and 2 notes, in that order, each kind searched on its own
 * with `queryForCandidate`. An entry the index holds twice (same kind and id) is listed once and the next hit of its kind takes the place.
 */
export function dshHitsFor(index: DshIndex, candidate: Candidate): IndexEntry[] {
  const query = queryForCandidate(candidate);
  return HIT_LIMITS.flatMap(([kind, limit]) => {
    const seen = new Set<string>();
    const distinct = searchIndex(index, query, index.entries.length, kind).filter(entry => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
    return distinct.slice(0, limit);
  });
}

// Ranking

/** Tests and their fixtures: test directories, Rust test modules (`tests.rs`, `foo_tests.rs`, `foo_test.rs`), spec files and insta snapshots. */
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|snapshots)\/|(?:^|\/)(?:tests|[^/]+_tests?)\.rs$|\.spec\.|\.test\.|\.snap(?:\.new)?$/;
/** 0 for tests, which are never read; 2 for Rust and TypeScript sources; 1 for anything else (docs, schemas, configuration). */
const weight = (path: string) => (TEST_FILE.test(path) ? 0 : /\.(rs|ts|tsx)$/.test(path) ? 2 : 1);
const isTest = (file: DiffFile) => weight(file.path) === 0;

/** The whole lines at the top of `text` that fit in `room` characters; empty when not even the first one does. */
function headLines(text: string, room: number): string {
  let end = 0;
  for (let at = text.indexOf('\n'); at !== -1 && at <= room; at = text.indexOf('\n', at + 1)) end = at;
  return text.slice(0, end);
}

/**
 * The diffs a pack holds: sources before other files, smaller before larger within each weight, as long as the total stays within `budget` characters; a file
 * that does not fit is passed over and the ones after it are still tried. Tests are never kept. A diff is kept whole or not at all, so one larger than the whole
 * budget is dropped, never cut. With `cutLines` the files are line lists (codex-files): one that does not fit keeps the whole lines at its top that do, and is
 * dropped only when not even its first line fits.
 */
export function rankDiffFiles(files: DiffFile[], budget: number, options: { cutLines?: boolean } = {}): RankedDiffs {
  const sorted = [...files].sort((a, b) => weight(b.path) - weight(a.path) || a.diff.length - b.diff.length);
  const kept: DiffFile[] = [], dropped: DiffFile[] = [], cut: DiffFile[] = [];
  let used = 0;
  for (const file of sorted) {
    if (isTest(file)) dropped.push(file);
    else if (used + file.diff.length <= budget) { kept.push(file); used += file.diff.length; }
    else {
      const head = options.cutLines ? headLines(file.diff, budget - used) : '';
      if (head) { kept.push({ ...file, diff: head }); cut.push(file); used += head.length; } else dropped.push(file);
    }
  }
  return { kept, dropped, cut };
}

// Diffs per source

/**
 * The per-file diffs of a candidate. A release candidate gets the diff of each of its pull requests, split into files and tagged `#<number>`; a codex-files candidate
 * gets the added lines of its own files (its evidence refs) from the snapshots of its windows, as `+` lines tagged with the windows they span; desktop and RSS
 * candidates have none. What cannot be read is left out and reported through `onError`; an abort is rethrown.
 */
export async function diffsFor(candidate: Candidate, deps: DiffSources, signal?: AbortSignal): Promise<DiffFile[]> {
  signal?.throwIfAborted();
  if (candidate.source === 'codex-release') return releaseDiffs(candidate, deps, signal);
  if (candidate.source === 'codex-files') return snapshotDiffs(candidate, deps);
  return [];
}

/** One pull request at a time, in evidence order, each once. A failed request costs only its own pull request; after a rate limit no more are asked. */
async function releaseDiffs(candidate: Candidate, { github, onError }: DiffSources, signal?: AbortSignal): Promise<DiffFile[]> {
  const files: DiffFile[] = [];
  let limited = false;
  for (const ref of new Set(candidate.evidence.filter(entry => entry.kind === 'pr').map(entry => entry.ref))) {
    const number = /^#(\d+)$/.exec(ref)?.[1];
    if (number === undefined) { onError?.(`no diff for ${ref}: not a pull request number`); continue; }
    if (limited) { onError?.(`no diff for #${number}: not asked after the GitHub rate limit`); continue; }
    signal?.throwIfAborted();
    try {
      const found = splitDiff(await github.pullRequestDiff(Number(number), signal));
      if (found.length === 0) onError?.(`no diff for #${number}: the response holds no "diff --git" header`);
      files.push(...found.map(file => ({ ...file, source: `#${number}` })));
    } catch (error) {
      if (signal?.aborted) throw error;
      limited = error instanceof GitHubError && error.rateLimited;
      onError?.(`no diff for #${number}: ${messageOf(error)}`);
    }
  }
  return files;
}

/** One file per `diff --git` section of a unified diff, with the section's whole text: header, extended header lines and hunks. Text before the first header belongs to no file. */
function splitDiff(diff: string): DiffFile[] {
  const starts: number[] = [];
  for (let at = 0; at < diff.length;) {
    if (diff.startsWith(DIFF_HEADER, at)) starts.push(at);
    const end = diff.indexOf('\n', at);
    if (end < 0) break;
    at = end + 1;
  }
  return starts.map((start, i) => {
    const section = diff.slice(start, starts[i + 1] ?? diff.length);
    return { path: newPath(section), diff: section };
  });
}

const QUOTED = String.raw`"(?:[^"\\]|\\.)*"`;
const WHOLE_QUOTED = new RegExp(`^${QUOTED}$`, 's');
const SECOND_NAME = new RegExp(`^(?:${QUOTED}|a/.*?) (${QUOTED}|b/.*)$`, 's');
const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
/** Git writes a path with unusual bytes as a C string, `"docs/\344\270\255.md"` with octal UTF-8 bytes; it is read back here. A bare path comes back as it is. */
function unquote(text: string): string {
  if (!WHOLE_QUOTED.test(text)) return text;
  const bytes: number[] = [];
  for (const [, octal, escaped, plain] of text.slice(1, -1).matchAll(/\\([0-7]{1,3})|\\(.)|([^\\]+)/gs)) {
    if (octal !== undefined) bytes.push(parseInt(octal, 8) & 0xff);
    else if (escaped !== undefined) bytes.push(ESCAPES[escaped] ?? escaped.charCodeAt(0));
    else bytes.push(...Buffer.from(plain ?? '', 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The path a `diff --git` section leaves behind. A rename or a copy names it in the extended header (`rename to <path>`). Otherwise the header names the file
 * twice, `a/<path> b/<path>`: a bare pair is split by length, so that a path with spaces or with a ` b/` of its own stays whole, and quoted names are read back.
 */
function newPath(section: string): string {
  const [header = '', ...rest] = section.split('\n', 16);
  for (const line of rest) {
    if (line.startsWith('@@') || line.startsWith('--- ')) break;
    const moved = /^(?:rename|copy) to (.+)$/.exec(line);
    if (moved) return unquote(moved[1]!);
  }
  const names = header.slice(DIFF_HEADER.length).replace(/\r$/, '');
  const half = (names.length - 5) / 2; // `a/` + path + ` b/` + path
  if (Number.isInteger(half) && half > 0 && names.startsWith('a/') && names.slice(half + 2, half + 5) === ' b/' && names.slice(2, half + 2) === names.slice(half + 5)) {
    return names.slice(half + 5);
  }
  const second = SECOND_NAME.exec(names)?.[1];
  return second === undefined ? names : unquote(second).replace(/^b\//, '');
}

interface Snapshot { name: string; fromTag: string; toTag: string; from: number[]; to: number[] }
type SnapshotEntry = Pick<ChangedFile, 'path' | 'added' | 'error'>;

const versionOf = (tag: string | undefined): number[] | undefined => (tag === undefined ? undefined : STABLE_TAG.exec(tag)?.slice(1).map(Number));
const byVersion = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
/** A snapshot is named `<from>__<to>.json` after the stable tags of its window; any other file in the directory is not one. */
function snapshotOf(name: string): Snapshot | undefined {
  const tags = /^(.+)__(.+)\.json$/.exec(name);
  const from = versionOf(tags?.[1]), to = versionOf(tags?.[2]);
  return tags && from && to ? { name, fromTag: tags[1]!, toTag: tags[2]!, from, to } : undefined;
}
/**
 * Which snapshots hold the windows merged into a candidate: those whose `to` tag lies after its `fromTag` and at or before its `toTag`, by version (a window ending
 * at `fromTag` came before the candidate). Without a tag window, the version that ends the fingerprint (`codex-files:<group>:<version>`) decides: a minor takes
 * every window ending in it, a full version (a candidate made after the one of its minor was moved on) the one window ending at it.
 */
function windowsOf(candidate: Candidate): { covers: (snapshot: Snapshot) => boolean; label: string } | undefined {
  const { fromTag, toTag } = candidate.window ?? {};
  const from = versionOf(fromTag), to = versionOf(toTag);
  if (from && to) return { covers: snapshot => byVersion(snapshot.to, from) > 0 && byVersion(snapshot.to, to) <= 0, label: `windows after ${fromTag} up to ${toTag}` };
  const version = /:(\d+\.\d+(?:\.\d+)?)$/.exec(candidate.fingerprint)?.[1];
  if (version === undefined) return undefined;
  if (version.split('.').length === 2) return { covers: snapshot => minor(snapshot.toTag) === version, label: `windows ending in ${version}` };
  return { covers: snapshot => snapshot.toTag === `rust-v${version}`, label: `window ending at rust-v${version}` };
}
const isSnapshotEntry = (value: unknown): value is SnapshotEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.path === 'string' && Array.isArray(entry.added) && entry.added.every(line => typeof line === 'string') && (entry.error === undefined || typeof entry.error === 'string');
};
/** The file list of one snapshot, or undefined (reported) when it cannot be read or does not hold one. */
async function readSnapshot(dir: string, name: string, onError?: (message: string) => void): Promise<SnapshotEntry[] | undefined> {
  try {
    const files = (JSON.parse(await readFile(join(dir, name), 'utf8')) as { files?: unknown } | null)?.files;
    if (Array.isArray(files) && files.every(isSnapshotEntry)) return files;
    onError?.(`damaged codex-files snapshot ${name}: no valid file list`);
  } catch (error) { onError?.(`damaged codex-files snapshot ${name}: ${messageOf(error)}`); }
  return undefined;
}

/**
 * The added lines of the candidate's own files across the snapshots of its windows, oldest window first, each line once per file, tagged `<from>__<to>` with the
 * windows that gave lines. An entry with an `error` was never read: it adds nothing and is reported as `unknown content: <path> in <window>: <reason>`, because
 * unread is not empty. A candidate no snapshot covers is reported too.
 */
async function snapshotDiffs(candidate: Candidate, { snapshotDir, onError }: DiffSources): Promise<DiffFile[]> {
  const none = (reason: string): DiffFile[] => { onError?.(`no added lines for ${candidate.id}: ${reason}`); return []; };
  const windows = windowsOf(candidate);
  if (!windows) return none('it has neither a tag window nor a version at the end of its fingerprint');
  const dir = join(snapshotDir, 'codex-files');
  let names: string[];
  try { names = await readdir(dir); } catch (error) { if (isMissing(error)) return none(`no snapshot directory ${dir}`); throw error; }
  const snapshots = names.map(snapshotOf).filter((snapshot): snapshot is Snapshot => snapshot !== undefined && windows.covers(snapshot))
    .sort((a, b) => byVersion(a.to, b.to) || byVersion(a.from, b.from));
  if (snapshots.length === 0) return none(`no snapshot of the ${windows.label}`);
  const own = new Set(candidate.evidence.map(entry => entry.ref));
  const found = new Map<string, { lines: Set<string>; from: string; to: string }>();
  for (const snapshot of snapshots) {
    for (const file of await readSnapshot(dir, snapshot.name, onError) ?? []) {
      if (!own.has(file.path)) continue; // another group's file of the same window
      if (file.error !== undefined) { onError?.(`unknown content: ${file.path} in ${snapshot.fromTag}__${snapshot.toTag}: ${file.error}`); continue; }
      if (file.added.length === 0) continue;
      const entry = found.get(file.path) ?? { lines: new Set<string>(), from: snapshot.fromTag, to: snapshot.toTag };
      for (const line of file.added) entry.lines.add(line);
      entry.to = snapshot.toTag;
      found.set(file.path, entry);
    }
  }
  return [...found].map(([path, entry]) => ({ path, diff: [...entry.lines].map(line => `+${line}`).join('\n'), source: `${entry.from}__${entry.to}` }));
}

// The pack

/**
 * A file name part: every run of characters other than letters, digits, `.`, `_` and `-` becomes one `-`. Past 80 characters it keeps the last 80, where the
 * file and type names are. It never starts with `.` (a hidden file) or `-`, and never ends with `-`.
 */
function slug(text: string): string {
  const flat = text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
  return (flat.length <= NAME_LIMIT ? flat : flat.slice(-NAME_LIMIT)).replace(/^[-.]+|-+$/g, '');
}
/** Hands out names that are unique within one directory: `base.ext`, then `base-2.ext`, `base-3.ext`. Case does not count, as on the default macOS file system. */
function namer(): (base: string, ext: string) => string {
  const taken = new Set<string>();
  return (base, ext) => {
    for (let n = 1; ; n++) {
      const name = `${base}${n > 1 ? `-${n}` : ''}${ext}`;
      if (!taken.has(name.toLowerCase())) { taken.add(name.toLowerCase()); return name; }
    }
  };
}
/** `diff-<source>-<path>` or `added-<source>-<path>`: `#50148` becomes `50148`, a window `0.161.9__0.161.11`. */
const changeName = (prefix: string, file: DiffFile) => [prefix, file.source ? slug(file.source.replace(/rust-v/g, '')) : '', slug(file.path)].filter(Boolean).join('-');
const lineCount = (text: string) => (text ? text.split('\n').length : 0);
/** The windows of a line list as INDEX.md and its file show them: `rust-v0.161.9 → rust-v0.161.11`. */
const windowText = (source: string | undefined) => (source ?? '').split('__').join(' → ');
const cutNote = (kept: DiffFile, whole: DiffFile) => `只放了前 ${lineCount(kept.diff)} 行，共 ${lineCount(whole.diff)} 行`;

/** What the excerpt of each evidence kind holds, as the sources write it. */
const EXCERPT_LABEL: Record<EvidenceKind, string> = {
  pr: 'PR 标题、正文摘要和改动文件清单，各段之间空一行：',
  file: '摘录：', 'feature-flag': '新增行：', schema: '新增行：', doc: '新增行：',
  chunk: '本版本的归档路径：', i18n: '文案：', rss: '公告原文：',
};
/** The link and excerpt of one evidence entry; when its file's added lines are in a `.txt` of their own, a pointer there instead of the same lines again. */
function evidenceBody(entry: Evidence, linesFile: string | undefined): string[] {
  const lines = entry.url ? [`链接：${entry.url}`, ''] : [];
  if (linesFile) return [...lines, `新增行在 ${linesFile}，这里不重复。`];
  if (entry.excerpt) return [...lines, EXCERPT_LABEL[entry.kind] ?? '摘录：', '', entry.excerpt];
  return [...lines, entry.kind === 'pr' ? '（没有取到这个 PR 的标题和文件，只有编号。）' : '（没有摘录。）'];
}
const evidenceText = (entry: Evidence, linesFile: string | undefined) => [`# ${entry.kind} ${oneLine(entry.ref)}`, '', ...evidenceBody(entry, linesFile), ''].join('\n');
function moreEvidenceText(entries: Evidence[], linesFiles: Map<string, string>): string {
  const sections = entries.flatMap(entry => ['', `## ${entry.kind} ${oneLine(entry.ref)}`, '', ...evidenceBody(entry, linesFiles.get(entry.ref))]);
  return ['# 其余证据', '', `前 ${EVIDENCE_FILES} 条证据各有一个文件，这里是其余 ${entries.length} 条。`, ...sections, ''].join('\n');
}
/** The key group of a desktop i18n candidate, from its fingerprint `desktop:i18n:<group>:<version>`. */
const i18nGroup = (candidate: Candidate) => /^desktop:i18n:(.+):[^:]+$/.exec(candidate.fingerprint)?.[1] ?? 'keys';
function i18nText(group: string, keys: Evidence[]): string {
  const lines = keys.map(entry => (entry.excerpt ? `${oneLine(entry.ref)}: ${oneLine(entry.excerpt)}` : oneLine(entry.ref)));
  return [`# i18n ${group}`, '', `${keys.length} 个新 key，每行 \`key: 文案\`；没取到文案的只有 key。`, '', ...lines, ''].join('\n');
}
function chunksText(chunks: Evidence[]): string {
  const sections = chunks.flatMap(entry => ['', `## ${oneLine(entry.ref)}`, '', entry.excerpt || '（没有摘录。）']);
  return ['# 桌面端新模块', '', '每个模块一节：标题是去掉哈希的模块名，下面是本版本归档里的实际路径。', ...sections, ''].join('\n');
}
function addedText(file: DiffFile, whole: DiffFile | undefined): string {
  const window = windowText(file.source);
  return [
    `# ${oneLine(file.path)}${SEPARATOR}${window ? `${window} ` : ''}新增的行`,
    `不是 diff：没有上下文，也没有删掉的行。${whole ? `${cutNote(file, whole)}。` : ''}`,
    '', file.diff, '',
  ].join('\n');
}

const KIND_LABEL: Record<IndexEntry['kind'], string> = { package: '包说明', config: '配置目录条目', note: 'agent note', doc: '文档' };
/** A note's directory says whether DSH has what it describes: `implemented/` notes record what was built, `proposed/` ones what is not built yet. */
function noteStatus(path: string): string {
  const status = /(?:^|\/)\.agents\/notes\/(implemented|proposed)\//.exec(path)?.[1];
  if (status === 'implemented') return '状态：implemented（DSH 已有）';
  if (status === 'proposed') return '状态：proposed（DSH 尚未实现）';
  return '状态：未知（不在 implemented/ 或 proposed/ 下）';
}
/** What a hit's file and its INDEX.md line add to the path: a note's status, a config entry's section (every config entry has the same path). */
const hitDetail = (hit: IndexEntry): string | undefined => (hit.kind === 'note' ? noteStatus(hit.path) : hit.kind === 'config' ? `条目：${hit.id}` : undefined);
function hitText(hit: IndexEntry): string {
  const detail = hitDetail(hit);
  return [`# ${oneLine(hit.title)}`, '', `类型：${KIND_LABEL[hit.kind] ?? hit.kind}`, `路径：${oneLine(hit.path)}（相对 DSH 镜像根目录）`, ...(detail ? [detail] : []), '', hit.text, ''].join('\n');
}

/** One list of INDEX.md: its heading, a line before the list, the list itself (cut to fit), a line after it that always shows, and the line that counts what is cut. */
interface Section { heading: string; intro?: string; items: string[]; tail?: string; rest: (count: number) => string }
/** Shares `total` characters among lists that need `needs`: smallest first, each gets what it needs up to an equal share of what is left, so that what a short list leaves goes to the long ones. */
function shares(needs: number[], total: number): number[] {
  const rooms = needs.map(() => 0);
  let left = Math.max(0, total), count = needs.length;
  for (const i of needs.map((_, i) => i).sort((a, b) => needs[a]! - needs[b]!)) {
    rooms[i] = Math.min(needs[i]!, Math.floor(left / count));
    left -= rooms[i]!;
    count--;
  }
  return rooms;
}
/** The lines of a list that fit in `room` characters, at most 40, followed by the line that counts the rest. */
function fit(items: string[], room: number, rest: (count: number) => string): string[] {
  const out: string[] = [];
  let used = 0;
  for (const item of items) {
    if (out.length === LIST_LINES || used + item.length + 1 > room) break;
    out.push(item);
    used += item.length + 1;
  }
  return out.length < items.length ? [...out, rest(items.length - out.length)] : out;
}
/** INDEX.md within 8,000 characters: the head and every section's frame in full, the lists sharing what is left (see `shares`), each cut by `fit`. */
function renderIndex(head: string[], sections: Section[]): string {
  const frame = (section: Section) => ['', section.heading, '', ...(section.intro ? [section.intro, ''] : []), ...(section.tail ? [section.tail] : [])];
  const fixed = [...head, ...sections.flatMap(frame)].join('\n').length + 1 + sections.length * REST_ROOM;
  const lists = sections.map(section => section.items.map(item => cutLine(item, ITEM_LIMIT)));
  const rooms = shares(lists.map(items => items.reduce((sum, item) => sum + item.length + 1, 0)), INDEX_LIMIT - fixed);
  const lines = [...head];
  sections.forEach((section, i) => {
    lines.push('', section.heading, '');
    if (section.intro) lines.push(section.intro, '');
    lines.push(...fit(lists[i]!, rooms[i]!, section.rest));
    if (section.tail) lines.push(section.tail);
  });
  return `${lines.join('\n')}\n`;
}

/** Writes every file of the pack into `dir`, which holds empty `sources/` and `dsh/`. */
async function writePack(dir: string, input: EvidencePackInput, budget: number): Promise<void> {
  const { candidate } = input;
  const write = (path: string, text: string) => writeFile(join(dir, path), text, { mode: FILE_MODE, flag: 'wx' });
  await write('candidate.json', `${JSON.stringify(candidate, null, 2)}\n`);

  // The changes are named first: the evidence of a file whose added lines have a .txt of their own points there instead of repeating them.
  const lists = candidate.source === 'codex-files';
  const { kept, dropped, cut } = rankDiffFiles(input.diffs, budget, { cutLines: lists });
  const whole = new Map(cut.map(file => [file.path, file]));
  const name = namer();
  const changes = kept.map(file => ({ file, path: `sources/${name(changeName(lists ? 'added' : 'diff', file), lists ? '.txt' : '.diff')}` }));
  const linesFiles = new Map<string, string>(lists ? changes.map(change => [change.file.path, change.path]) : []);

  const evidenceItems: string[] = [];
  const own = candidate.evidence.filter(entry => entry.kind !== 'i18n' && entry.kind !== 'chunk');
  for (const entry of own.slice(0, EVIDENCE_FILES)) {
    const path = `sources/${name(`${entry.kind}-${slug(entry.ref)}`, '.md')}`;
    await write(path, evidenceText(entry, linesFiles.get(entry.ref)));
    evidenceItems.push(`- ${path} ← ${entry.kind} ${oneLine(entry.ref)}`);
  }
  const more = own.slice(EVIDENCE_FILES);
  if (more.length) {
    const path = `sources/${name('more-evidence', '.md')}`;
    await write(path, moreEvidenceText(more, linesFiles));
    evidenceItems.push(`- ${path} ← 其余 ${more.length} 条证据`);
  }
  const keys = candidate.evidence.filter(entry => entry.kind === 'i18n');
  if (keys.length) {
    const group = i18nGroup(candidate);
    const path = `sources/${name(`i18n-${slug(group)}`, '.md')}`;
    await write(path, i18nText(group, keys));
    evidenceItems.push(`- ${path} ← ${keys.length} 个 i18n key`);
  }
  const chunks = candidate.evidence.filter(entry => entry.kind === 'chunk');
  if (chunks.length) {
    const path = `sources/${name('chunks', '.md')}`;
    await write(path, chunksText(chunks));
    evidenceItems.push(`- ${path} ← ${chunks.length} 个桌面端模块`);
  }

  const changeItems: string[] = [];
  for (const { file, path } of changes) {
    const full = whole.get(file.path);
    await write(path, lists ? addedText(file, full) : file.diff);
    const notes = [lists ? windowText(file.source) : file.source ?? '', full ? cutNote(file, full) : ''].filter(Boolean);
    changeItems.push(`- ${path} ← ${oneLine(file.path)}${notes.length ? `（${notes.join('，')}）` : ''}`);
  }

  const hitItems: string[] = [];
  for (const [i, hit] of input.dshHits.entries()) {
    const label = `${hit.path.replace(/\.md$/, '')}${hit.kind === 'config' ? `-${hit.id}` : ''}`;
    const path = `dsh/${String(i + 1).padStart(2, '0')}-${slug(label)}.md`;
    await write(path, hitText(hit));
    const detail = hitDetail(hit);
    hitItems.push(`- ${path} ← ${oneLine(hit.path)}${detail ? `${SEPARATOR}${detail}` : ''}`);
  }

  const tests = dropped.filter(isTest), others = dropped.filter(file => !isTest(file));
  const gaps = (input.gaps ?? []).map(gap => `- ${oneLine(gap)}`);
  const holds = [
    own.length ? `每条证据一个 \`.md\`${more.length ? `，第 ${EVIDENCE_FILES} 条以后的在 \`more-evidence.md\`` : ''}` : '',
    keys.length ? 'i18n key 和文案在一个 `i18n-<组>.md` 里' : '',
    chunks.length ? '桌面端模块在 `chunks.md` 里' : '',
    changes.length ? (lists ? '新增行清单每个文件一个 `.txt`' : '选读的 diff 每个文件一个 `.diff`') : '',
  ].filter(Boolean);
  const head = ['# 证据目录', '', `候选：${cutLine(oneLine(candidate.title), TITLE_LIMIT)}`, `来源：${candidate.source}`];
  if (input.mirror) head.push(`DSH 镜像根目录：${input.mirror}（只读）`);
  head.push(
    '', '本文件里的路径都相对 `evidence/` 目录。', '',
    '- `candidate.json`：候选的完整记录，含全部证据条目。',
    `- \`sources/\`：Codex 一侧的证据。${holds.length ? `${holds.join('；')}。` : '（没有文件）'}`,
    '- `dsh/`：DSH 官方镜像索引的命中摘要。文件里写的路径相对镜像根目录；note 的状态 implemented 表示 DSH 已有，proposed 表示 DSH 尚未实现。摘要没有行号，引用前到镜像里打开原文核对。',
  );
  if (dropped.length) head.push('- 未读文件：没有放进 `sources/` 的文件。');
  if (gaps.length) head.push('- 没取到的内容：取证据时失败的条目，内容未知。');

  const sections: Section[] = [{ heading: '## 证据（sources/）', items: evidenceItems.length ? evidenceItems : ['- （无）'], rest: m => `- 其余 ${m} 个（完整清单见 candidate.json）` }];
  if (input.diffs.length) {
    sections.push({ heading: lists ? '## 新增行（sources/，不是 diff）' : '## diff（sources/）', items: changeItems.length ? changeItems : ['- （无，见未读文件）'], rest: m => `- 其余 ${m} 个（都在 sources/ 目录里）` });
  }
  sections.push({ heading: '## dsh/（官方镜像索引命中，路径相对镜像根目录）', items: hitItems.length ? hitItems : ['- （索引没有命中）'], rest: m => `- 其余 ${m} 个（都在 dsh/ 目录里）` });
  if (dropped.length) {
    sections.push({
      heading: '## 未读文件',
      intro: others.length ? `下面的${lists ? '新增行清单' : ' diff '}放不进 ${budget} 字符的预算，没有放进来。` : undefined,
      items: others.map(file => `- ${oneLine(file.path)}${file.source ? `（${file.source}）` : ''}`),
      tail: tests.length ? `- 测试文件 ${tests.length} 个未读` : undefined,
      rest: m => `- 其余 ${m} 个未列出`,
    });
  }
  if (gaps.length) sections.push({ heading: '## 没取到的内容', intro: '这些内容没有取到：不知道它们改了什么，不等于没有改动。', items: gaps, rest: m => `- 其余 ${m} 条未列出` });
  await write('INDEX.md', renderIndex(head, sections));
}

/**
 * Writes `<directory>/evidence/` and returns its path. The pack is built in a sibling `evidence.<uuid>.tmp` and renamed into place after the earlier pack is
 * removed, so that a failure midway leaves the earlier pack (or none), never a partial one, and a rerun leaves no stale file.
 * - `candidate.json`: the candidate as stored.
 * - `sources/`: one `.md` per evidence entry, the first 40 of them (the rest in `more-evidence.md`), all i18n keys in one `i18n-<group>.md` and all chunks in
 *   `chunks.md`; one `.diff` per diff or one `added-*.txt` per codex-files line list that `rankDiffFiles` keeps within `budget`. Names that come out the same
 *   are told apart by `-2`, `-3`.
 * - `dsh/`: one file per index hit, numbered in the order given, with its path relative to the mirror root and, for a note, its status.
 * - `INDEX.md`: what each directory holds, the files above, the files left out under 未读文件 and the `gaps` under 没取到的内容, each list at most 40 lines, the
 *   whole file within 8,000 characters.
 * `directory` must be absolute and `budget` a positive integer. Directories are created 0700 and files 0600.
 */
export async function buildEvidencePack(input: EvidencePackInput): Promise<string> {
  check(isAbsolute(input.directory), `the evidence pack directory must be an absolute path, got ${JSON.stringify(input.directory)}`);
  const budget = input.budget ?? DIFF_BUDGET;
  check(Number.isInteger(budget) && budget > 0, `the evidence pack budget must be a positive integer, got ${budget}`);
  const root = join(input.directory, 'evidence');
  const temp = join(input.directory, `evidence.${randomUUID()}.tmp`);
  await mkdir(input.directory, { recursive: true, mode: DIR_MODE });
  try {
    for (const dir of [temp, join(temp, 'sources'), join(temp, 'dsh')]) await mkdir(dir, { mode: DIR_MODE });
    await writePack(temp, input, budget);
    await rm(root, { recursive: true, force: true });
    await rename(temp, root);
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return root;
}
