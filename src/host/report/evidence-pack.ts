/**
 * The evidence directory an analyst session reads before it writes a gap report (`reports/<id>/evidence/`), and the helpers that gather
 * what goes into it: the DSH index hits of a candidate, per kind, and the per-file diffs of its source.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Candidate, Evidence, EvidenceKind } from '../../core/candidate.js';
import type { GitHubClient } from '../github.js';
import { searchIndex, type DshIndex, type IndexEntry } from '../index/dsh-index.js';
import type { ChangedFile } from '../sources/codex-files.js';
import { minor } from '../sources/codex-releases.js';

export interface DiffFile { path: string; diff: string }

/** Diff characters a pack holds unless the caller passes another budget: about 15k tokens. */
const DIFF_BUDGET = 60_000;
const QUERY_LIMIT = 2_000;
const NAME_LIMIT = 80;
/** Index hits per kind, in the order the pack lists them. Searched per kind, so that the long notes cannot crowd out the package summaries. */
const HIT_LIMITS = [['package', 3], ['config', 2], ['note', 2]] as const;
const DIR_MODE = 0o700, FILE_MODE = 0o600;
const STABLE_TAG = /^rust-v(\d+)\.(\d+)\.(\d+)$/;
const DIFF_HEADER = 'diff --git ';
/** Separates a path from what is said about it on one line, as the report template separates its header fields. */
const SEPARATOR = '\u3000';

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * What the DSH index is searched with for a candidate: its title, its summary and the ref of every evidence entry but a pull request
 * (file paths, i18n keys, chunk names, RSS titles), joined by spaces and cut at a word boundary to at most 2,000 characters. The index is
 * English, so `#123` references and everything outside printable ASCII (Chinese titles and strings, full-width punctuation) are left out:
 * they can match nothing there and would only take room under the cap. A part equal to an earlier one (a release title is its summary) is left out too.
 */
export function queryForCandidate(candidate: Candidate): string {
  const parts = [candidate.title, candidate.summary, ...candidate.evidence.filter(entry => entry.kind !== 'pr').map(entry => entry.ref)];
  const words = parts.map(part => part.replace(/#\d+/g, ' ').replace(/[^\x21-\x7e]+/g, ' ').trim()).filter(Boolean);
  const query = [...new Set(words)].join(' ');
  if (query.length <= QUERY_LIMIT) return query;
  const end = query.lastIndexOf(' ', QUERY_LIMIT);
  return end > 0 ? query.slice(0, end) : query.slice(0, QUERY_LIMIT);
}

/**
 * The index entries a pack shows for a candidate: up to 3 package summaries, 2 config catalog entries and 2 notes, in that order, each kind
 * searched on its own with `queryForCandidate`. An entry the index holds twice (same kind and id) is listed once and the next hit of its kind takes the place.
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

/** 0 for tests, which are never read; 2 for Rust and TypeScript sources; 1 for anything else (docs, schemas, configuration). */
const weight = (path: string) => /(?:^|\/)tests?\//.test(path) || /_tests?\.rs$|\.spec\.|\.test\./.test(path) ? 0 : /\.(rs|ts|tsx)$/.test(path) ? 2 : 1;

/**
 * The diffs a pack holds: sources before other files, smaller before larger within each weight, as long as the total stays within `budget`
 * characters. Tests are never kept. A diff is kept whole or not at all, so one larger than the whole budget is dropped, never cut.
 */
export function rankDiffFiles(files: DiffFile[], budget: number): { kept: DiffFile[]; dropped: DiffFile[] } {
  const sorted = [...files].sort((a, b) => weight(b.path) - weight(a.path) || a.diff.length - b.diff.length);
  const kept: DiffFile[] = [], dropped: DiffFile[] = [];
  let used = 0;
  for (const file of sorted) {
    if (weight(file.path) > 0 && used + file.diff.length <= budget) { kept.push(file); used += file.diff.length; } else dropped.push(file);
  }
  return { kept, dropped };
}

export interface DiffSources {
  github: Pick<GitHubClient, 'pullRequestDiff'>;
  /** The snapshot directory of the OpenCodex data directory; the codex-files snapshots are in its `codex-files/`. */
  snapshotDir: string;
  /** Told about every diff the result lacks or holds only in part: a pull request whose diff failed, a damaged snapshot, a file whose content is unknown. */
  onError?: (message: string) => void;
}

/**
 * The per-file diffs of a candidate. A release candidate gets the diff of each of its pull requests, split into files; a codex-files candidate
 * gets the added lines of its own files (its evidence refs) from the snapshots of its windows, as `+` lines; desktop and RSS candidates have none.
 * What cannot be read is left out and reported through `onError`; an abort is rethrown.
 */
export async function diffsFor(candidate: Candidate, deps: DiffSources, signal?: AbortSignal): Promise<DiffFile[]> {
  signal?.throwIfAborted();
  if (candidate.source === 'codex-release') return releaseDiffs(candidate, deps, signal);
  if (candidate.source === 'codex-files') return snapshotDiffs(candidate, deps);
  return [];
}

/** One pull request at a time, in evidence order, each asked once. A failed request costs only its own pull request. */
async function releaseDiffs(candidate: Candidate, { github, onError }: DiffSources, signal?: AbortSignal): Promise<DiffFile[]> {
  const files: DiffFile[] = [];
  for (const ref of new Set(candidate.evidence.filter(entry => entry.kind === 'pr').map(entry => entry.ref))) {
    const number = /^#(\d+)$/.exec(ref)?.[1];
    if (number === undefined) { onError?.(`no diff for ${ref}: not a pull request number`); continue; }
    signal?.throwIfAborted();
    try { files.push(...splitDiff(await github.pullRequestDiff(Number(number), signal))); }
    catch (error) {
      if (signal?.aborted) throw error;
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

/**
 * The path a `diff --git` section leaves behind. The header names the file twice, `a/<path> b/<path>`, and is split by length, so that a path
 * with spaces or with a ` b/` of its own stays whole. A rename or a copy names its new path in the extended header (`rename to <path>`).
 */
function newPath(section: string): string {
  const [header = '', ...rest] = section.split('\n', 16);
  const names = header.slice(DIFF_HEADER.length).replace(/\r$/, '');
  const half = (names.length - 5) / 2; // `a/` + path + ` b/` + path
  if (Number.isInteger(half) && half > 0 && names.startsWith('a/') && names.slice(half + 2, half + 5) === ' b/' && names.slice(2, half + 2) === names.slice(half + 5)) {
    return names.slice(half + 5);
  }
  for (const line of rest) {
    if (line.startsWith('@@') || line.startsWith('--- ')) break;
    const renamed = /^(?:rename|copy) to (.+)$/.exec(line);
    if (renamed) return renamed[1]!;
  }
  return /^a\/.*? b\/(.+)$/.exec(names)?.[1] ?? names;
}

interface SnapshotFile { name: string; from: number[]; to: number[]; toTag: string }
type SnapshotEntry = Pick<ChangedFile, 'path' | 'added' | 'error'>;

const versionOf = (tag: string | undefined): number[] | undefined => (tag === undefined ? undefined : STABLE_TAG.exec(tag)?.slice(1).map(Number));
const byVersion = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
/** A snapshot is named `<from>__<to>.json` after the stable tags of its window; any other file in the directory is not one. */
function snapshotFile(name: string): SnapshotFile | undefined {
  const tags = /^(.+)__(.+)\.json$/.exec(name);
  const from = versionOf(tags?.[1]), to = versionOf(tags?.[2]);
  return tags && from && to ? { name, from, to, toTag: tags[2]! } : undefined;
}
/**
 * Which snapshots hold the windows merged into a candidate: those whose `to` tag lies after its `fromTag` and at or before its `toTag`, by version
 * (a window ending at `fromTag` came before the candidate). Without a tag window, those whose `to` tag is in the minor version that ends the
 * candidate fingerprint (`codex-files:<group>:<minor>`).
 */
function windowsOf(candidate: Candidate): ((snapshot: SnapshotFile) => boolean) | undefined {
  const from = versionOf(candidate.window?.fromTag), to = versionOf(candidate.window?.toTag);
  if (from && to) return snapshot => byVersion(snapshot.to, from) > 0 && byVersion(snapshot.to, to) <= 0;
  const version = /:(\d+\.\d+)$/.exec(candidate.fingerprint)?.[1];
  return version === undefined ? undefined : snapshot => minor(snapshot.toTag) === version;
}
const isSnapshotEntry = (value: unknown): value is SnapshotEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.path === 'string' && Array.isArray(entry.added) && entry.added.every(line => typeof line === 'string') && (entry.error === undefined || typeof entry.error === 'string');
};
/** The file list of one snapshot, or undefined (reported) when it cannot be read or does not hold one. */
async function readSnapshot(path: string, onError?: (message: string) => void): Promise<SnapshotEntry[] | undefined> {
  try {
    const files = (JSON.parse(await readFile(path, 'utf8')) as { files?: unknown } | null)?.files;
    if (Array.isArray(files) && files.every(isSnapshotEntry)) return files;
    onError?.(`damaged codex-files snapshot ${path}: no valid file list`);
  } catch (error) { onError?.(`damaged codex-files snapshot ${path}: ${messageOf(error)}`); }
  return undefined;
}

/**
 * The added lines of the candidate's own files across the snapshots of its windows, oldest window first, each line once per file.
 * An entry with an `error` was never read: it adds nothing, and its path is reported as `unknown content: <path>`, because unread is not empty.
 * No snapshot directory yet means no diff.
 */
async function snapshotDiffs(candidate: Candidate, { snapshotDir, onError }: DiffSources): Promise<DiffFile[]> {
  const dir = join(snapshotDir, 'codex-files');
  let names: string[];
  try { names = await readdir(dir); } catch (error) { if (isMissing(error)) return []; throw error; }
  const belongs = windowsOf(candidate);
  if (!belongs) { onError?.(`no diff for codex-files candidate ${candidate.id}: it has neither a tag window nor a minor version in its fingerprint`); return []; }
  const snapshots = names.map(snapshotFile).filter((file): file is SnapshotFile => file !== undefined && belongs(file))
    .sort((a, b) => byVersion(a.to, b.to) || byVersion(a.from, b.from));
  const own = new Set(candidate.evidence.map(entry => entry.ref));
  const lines = new Map<string, Set<string>>(), unknown = new Set<string>();
  for (const snapshot of snapshots) {
    for (const file of await readSnapshot(join(dir, snapshot.name), onError) ?? []) {
      if (!own.has(file.path)) continue; // another group's file of the same window
      if (file.error !== undefined) { unknown.add(file.path); continue; }
      const seen = lines.get(file.path) ?? new Set<string>();
      for (const line of file.added) seen.add(line);
      lines.set(file.path, seen);
    }
  }
  for (const path of unknown) onError?.(`unknown content: ${path}`);
  return [...lines].filter(([, added]) => added.size > 0).map(([path, added]) => ({ path, diff: [...added].map(line => `+${line}`).join('\n') }));
}

export interface EvidencePackInput {
  /** The candidate's report directory, `reports/<id>/`; the pack is its `evidence/`. */
  directory: string;
  candidate: Candidate;
  diffs: DiffFile[];
  dshHits: IndexEntry[];
  /** Diff characters to keep; 60,000 by default. */
  budget?: number;
  /** The root of the DSH mirror that the `dsh/` paths are relative to; INDEX.md names it when given. */
  mirror?: string;
  /** Evidence that could not be read, such as the `onError` messages of `diffsFor`. INDEX.md lists them under 没取到的内容: what was not read is unknown, not unchanged. */
  gaps?: string[];
}

/**
 * A file name part: every run of characters other than letters, digits, `.`, `_` and `-` becomes one `-`. Past 80 characters it keeps the first 80,
 * or the last 80 for a path, whose file name says the most. It never starts with `.` (a hidden file) or `-`, and never ends with `-`.
 */
function slug(text: string, keep: 'start' | 'end' = 'start'): string {
  const flat = text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
  const cut = flat.length <= NAME_LIMIT ? flat : keep === 'start' ? flat.slice(0, NAME_LIMIT) : flat.slice(-NAME_LIMIT);
  return cut.replace(/^[-.]+|-+$/g, '');
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

/** What the excerpt of each evidence kind holds, as the sources write it. */
const EXCERPT_LABEL: Record<EvidenceKind, string> = {
  pr: 'PR 标题和改动文件（第一行是标题，其余每行一个文件）：',
  file: '摘录：', 'feature-flag': '新增行：', schema: '新增行：', doc: '新增行：',
  chunk: '本版本的归档路径：', i18n: '文案：', rss: '公告原文：',
};
function evidenceText(evidence: Evidence): string {
  const lines = [`# ${evidence.kind} ${oneLine(evidence.ref)}`, ''];
  if (evidence.url) lines.push(`链接：${evidence.url}`, '');
  if (evidence.excerpt) lines.push(EXCERPT_LABEL[evidence.kind] ?? '摘录：', '', evidence.excerpt);
  else lines.push(evidence.kind === 'pr' ? '（没有取到这个 PR 的标题和文件，只有编号。）' : '（没有摘录。）');
  return `${lines.join('\n')}\n`;
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
  return [`# ${oneLine(hit.title)}`, '', `类型：${KIND_LABEL[hit.kind] ?? hit.kind}`, `路径：${hit.path}（相对 DSH 镜像根目录）`, ...(detail ? [detail] : []), '', hit.text, ''].join('\n');
}

function indexText(input: EvidencePackInput, sources: string[], hits: string[], dropped: DiffFile[], budget: number): string {
  const lines = ['# 证据目录', '', `候选：${oneLine(input.candidate.title)}`, `来源：${input.candidate.source}`];
  if (input.mirror) lines.push(`DSH 镜像根目录：${input.mirror}（只读）`);
  lines.push(
    '',
    '- `candidate.json`：候选的完整记录，含全部证据条目。',
    '- `sources/`：Codex 一侧的证据。每条证据一个 `.md`（PR 标题和改动文件、新增行、桌面端模块路径、i18n 文案、RSS 原文）；选读的 diff 每个文件一个 `.diff`。',
    '- `dsh/`：DSH 官方镜像索引的命中摘要，路径都相对镜像根目录。note 的状态 implemented 表示 DSH 已有，proposed 表示 DSH 尚未实现。摘要没有行号，引用前到镜像里打开原文核对。',
  );
  if (dropped.length) lines.push('- 未读文件：没有放进 `sources/` 的 diff，括号里是原因。');
  if (input.gaps?.length) lines.push('- 没取到的内容：取证据时失败的条目。这些内容未知，不等于没有改动。');
  lines.push('', '## sources/', '', ...(sources.length ? sources : ['- （无）']));
  lines.push('', '## dsh/（官方镜像索引命中，路径相对镜像根目录）', '', ...(hits.length ? hits : ['- （索引没有命中）']));
  if (dropped.length) {
    lines.push('', '## 未读文件', '', ...dropped.map(file => `- ${oneLine(file.path)}（${weight(file.path) === 0 ? '测试文件' : `${file.diff.length} 字符，放不进剩下的 diff 预算（共 ${budget} 字符）`}）`));
  }
  if (input.gaps?.length) lines.push('', '## 没取到的内容', '', ...input.gaps.map(gap => `- ${oneLine(gap)}`));
  return `${lines.join('\n')}\n`;
}

/**
 * Writes `<directory>/evidence/` and returns its path. An earlier pack there is removed first, so that a rerun leaves no stale file to be read as evidence.
 * - `candidate.json`: the candidate as stored.
 * - `sources/`: one `.md` per evidence entry, and one `.diff` per diff that `rankDiffFiles` keeps within `budget`. Two files whose names come out
 *   the same are told apart by `-2`, `-3`.
 * - `dsh/`: one file per index hit, numbered in the order given, with its path relative to the mirror root and, for a note, its status.
 * - `INDEX.md`: what each directory holds, every file above, the diffs left out under 未读文件 with the reason, and the `gaps` under 没取到的内容.
 * Directories are created 0700 and files 0600.
 */
export async function buildEvidencePack(input: EvidencePackInput): Promise<string> {
  const budget = input.budget ?? DIFF_BUDGET;
  const root = join(input.directory, 'evidence');
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, 'sources'), { recursive: true, mode: DIR_MODE });
  await mkdir(join(root, 'dsh'), { mode: DIR_MODE });
  const write = (path: string, text: string) => writeFile(join(root, path), text, { mode: FILE_MODE, flag: 'wx' });
  await write('candidate.json', `${JSON.stringify(input.candidate, null, 2)}\n`);

  const sourceName = namer();
  const sources: string[] = [];
  for (const evidence of input.candidate.evidence) {
    const path = `sources/${sourceName(slug(`${evidence.kind}-${evidence.ref}`), '.md')}`;
    await write(path, evidenceText(evidence));
    sources.push(`- ${path} ← ${evidence.kind} ${oneLine(evidence.ref)}`);
  }
  const { kept, dropped } = rankDiffFiles(input.diffs, budget);
  for (const file of kept) {
    const path = `sources/${sourceName(['diff', slug(file.path, 'end')].filter(Boolean).join('-'), '.diff')}`;
    await write(path, file.diff);
    sources.push(`- ${path} ← ${oneLine(file.path)}`);
  }
  const hits: string[] = [];
  for (const [i, hit] of input.dshHits.entries()) {
    const label = `${hit.path.replace(/\.md$/, '')}${hit.kind === 'config' ? `-${hit.id}` : ''}`;
    const path = `dsh/${String(i + 1).padStart(2, '0')}-${slug(label)}.md`;
    await write(path, hitText(hit));
    const detail = hitDetail(hit);
    hits.push(`- ${path} ← ${hit.path}${detail ? `${SEPARATOR}${detail}` : ''}`);
  }
  await write('INDEX.md', indexText(input, sources, hits, dropped, budget));
  return root;
}
