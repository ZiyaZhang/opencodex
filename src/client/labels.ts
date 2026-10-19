/**
 * What the page calls things and how it orders them: the labels of sources, categories, statuses and views; a row's title, second line and
 * reference; the version groups of the list. Plain functions of the snapshot, tested without rendering anything.
 */
import type { Candidate, Classification, EvidenceKind, Source, Status } from '../core/candidate.js';
import type { TagTone } from './ui.js';

type Category = Classification['category'];
type Relevance = Classification['relevance'];

export const SOURCE_LABELS: Record<Source, string> = { 'codex-release': 'Codex 发布说明', 'codex-files': 'Codex 仓库文件', desktop: 'Codex 桌面端', rss: '官方 RSS' };
export const CATEGORY_LABELS: Record<Category, string> = { 'cli-core': 'CLI 核心', desktop: '桌面端', cloud: '云端', model: '模型', fix: '修复', other: '其他' };
export const RELEVANCE_LABELS: Record<Relevance, string> = { high: '高', medium: '中', low: '低' };
export const EVIDENCE_LABELS: Record<EvidenceKind, string> = { pr: 'PR', file: '文件', chunk: 'chunk', i18n: '文案 key', rss: 'RSS', 'feature-flag': '功能开关', schema: '协议类型', doc: '文档' };

/** The label of a value read from disk, or the value itself when this page does not know it. */
export const labelOf = <K extends string>(labels: Record<K, string>, value: string): string => (Object.hasOwn(labels, value) ? labels[value as K] : value);

/** A timestamp in this machine's time zone, month to minute; the text as it is when it is no date. */
export const time = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
/** The month and day of a timestamp, as a group title gives its latest discovery. */
export const monthDay = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
};

/**
 * Where a row stands: its status, or, while automatic research has it, `queued` (a new candidate waiting in the queue) or `researching`
 * (a report being written, a second one for a reported candidate too). Both are the Host's in-process marks, not statuses on disk.
 */
export type Phase = Status | 'queued' | 'researching';
export const PHASE_TAGS: Record<Phase, { label: string; tone: TagTone }> = {
  new: { label: '新发现', tone: 'outline' },
  queued: { label: '排队中', tone: 'quiet' },
  researching: { label: '调研中', tone: 'info' },
  reported: { label: '已调研', tone: 'success' },
  started: { label: '执行中', tone: 'warning' },
  ignored: { label: '已忽略', tone: 'quiet' },
};
export const STATUS_LABELS: Record<Status, string> = {
  new: PHASE_TAGS.new.label, reported: PHASE_TAGS.reported.label, started: PHASE_TAGS.started.label, ignored: PHASE_TAGS.ignored.label,
};
/** The queue only ever holds new candidates; one that has moved on since the snapshot is shown by its status. */
export function phaseOf(status: Status, { queued, researching }: { queued: boolean; researching: boolean }): Phase {
  if (researching) return 'researching';
  return queued && status === 'new' ? 'queued' : status;
}
/** The tag of a phase; a status this page does not know is shown as it is, in the neutral tone. */
export const tagOf = (phase: string): { label: string; tone: TagTone } =>
  (Object.hasOwn(PHASE_TAGS, phase) ? PHASE_TAGS[phase as Phase] : { label: phase, tone: 'neutral' });

/** The list's views. Every candidate is in exactly one. */
export const VIEWS = ['todo', 'low', 'ignored'] as const;
export type View = typeof VIEWS[number];
export const VIEW_LABELS: Record<View, string> = { todo: '待办', low: '相关度低', ignored: '已忽略' };
/** 待办: new and not low (the unclassified included), and every reported or started one, whatever its relevance. */
export function viewOf(candidate: Candidate): View {
  if (candidate.status === 'ignored') return 'ignored';
  return candidate.status === 'new' && candidate.classification?.relevance === 'low' ? 'low' : 'todo';
}
export function countViews(list: readonly Candidate[]): Record<View, number> {
  const counts: Record<View, number> = { todo: 0, low: 0, ignored: 0 };
  for (const item of list) counts[viewOf(item)]++;
  return counts;
}

/** Code points of a row's second line, and of an automatic research error on its third. */
const GIST_LIMIT = 120, ERROR_LIMIT = 60;
const oneLine = (text: string) => text.replace(/\s+/gu, ' ').trim();
/** `text` on one line, at most `limit` code points: a longer one is cut to its first `limit - 1` and `…`, as the Host cuts a headline. */
export function clipLine(text: string, limit: number): string {
  const chars = Array.from(oneLine(text));
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, limit - 1).join('')}…`;
}
/** A classification text, unless it is empty: the Host stores an empty one when the model gave none. */
export const given = (text: string | undefined) => (text === undefined || text.trim() === '' ? undefined : text.trim());

/** A row's title: the Codex feature the classification names, else the candidate's own title. */
export const headlineOf = (candidate: Candidate): string => given(candidate.classification?.headline) ?? candidate.title;
/**
 * A row's second line: what Codex does, in the classification's sentence, else the summary, on one line and cut to 120 code points.
 * Empty when it would only repeat the title, as a release note's summary does.
 */
export function gistOf(candidate: Candidate): string {
  const gist = given(candidate.classification?.gist);
  if (gist) return clipLine(gist, GIST_LIMIT);
  return oneLine(candidate.summary) === oneLine(headlineOf(candidate)) ? '' : clipLine(candidate.summary, GIST_LIMIT);
}
/** The automatic research error a row's third line ends with, cut to 60 code points; the whole one goes in its tooltip. */
export const researchErrorOf = (candidate: Candidate): string | undefined => {
  const error = given(candidate.research?.lastError);
  return error && clipLine(error, ERROR_LIMIT);
};

/** References a row names before it only counts the rest. */
const REFERENCES_SHOWN = 3;
const unique = (values: readonly string[]) => [...new Set(values)];
/** The first few names, and how many `unit` there are when they do not show them all. */
function named(names: readonly string[], total: number, unit: string): string {
  const shown = unique(names).slice(0, REFERENCES_SHOWN);
  return total > shown.length ? `${shown.join('、')} 等 ${total} 个${unit}` : shown.join('、');
}
/** Where in its source a candidate comes from: pull request numbers, file names, the desktop chunks and keys counted, or 公告. */
export function referenceOf(candidate: Candidate): string {
  const { evidence } = candidate;
  if (evidence.length === 0) return '';
  switch (candidate.source) {
    case 'codex-release': {
      const prs = unique(evidence.filter(entry => entry.kind === 'pr').map(entry => entry.ref));
      return named(prs, prs.length, ' PR');
    }
    case 'codex-files': return named(evidence.map(entry => entry.ref.split('/').at(-1) ?? entry.ref), evidence.length, '文件');
    case 'desktop': {
      const chunks = evidence.filter(entry => entry.kind === 'chunk').length, keys = evidence.filter(entry => entry.kind === 'i18n').length;
      return [chunks > 0 ? `chunk ${chunks}` : '', keys > 0 ? `key ${keys}` : ''].filter(Boolean).join('、');
    }
    case 'rss': return '公告';
    default: return '';
  }
}

/** Where a merged candidate went, one hop only: classifications can point in a circle. The target as its row names it, else its id. */
export function mergeLabel(mergedInto: string, candidates: readonly Candidate[]): string {
  const target = candidates.find(item => item.id === mergedInto);
  return `并入：${target ? headlineOf(target) : mergedInto}`;
}

/** The x.y.z of a release tag such as `rust-v0.163.0`, as numbers and as text. */
export function versionOf(tag: string | undefined): { parts: [number, number, number]; text: string } | undefined {
  const match = tag === undefined ? null : /(\d+)\.(\d+)(?:\.(\d+))?/.exec(tag);
  if (!match) return undefined;
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  return { parts, text: parts.join('.') };
}
/** Whether version `a` comes after `b`, compared part by part as numbers (0.162.10 after 0.162.9). */
function laterVersion(a: readonly number[], b: readonly number[]): boolean {
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index]! > b[index]!;
  return false;
}

export interface CandidateGroup {
  key: string; title: string;
  /** The latest discovery in the group, which orders the groups. */
  latest: string;
  items: Candidate[];
}
const STATUS_ORDER: readonly string[] = ['new', 'reported', 'started', 'ignored'];
const RELEVANCE_ORDER: readonly string[] = ['high', 'medium', 'low'];
/** The position of `value` in `order`; values it does not list go last. */
const rank = (order: readonly string[], value: string | undefined) => {
  const at = value === undefined ? -1 : order.indexOf(value);
  return at < 0 ? order.length : at;
};
const descending = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
/** Within a group: new, reported, started; then high, medium, low relevance, the unclassified after them; then the latest change. */
const rowOrder = (a: Candidate, b: Candidate) => rank(STATUS_ORDER, a.status) - rank(STATUS_ORDER, b.status)
  || rank(RELEVANCE_ORDER, a.classification?.relevance) - rank(RELEVANCE_ORDER, b.classification?.relevance)
  || descending(a.updatedAt, b.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The group of one candidate: its key, and the title it gives the group (a release group takes the highest one of its members). */
function groupOf(candidate: Candidate): { key: string; title: string; version?: [number, number, number] } {
  switch (candidate.source) {
    case 'codex-release': case 'codex-files': {
      // A release window and a file window of one minor version end at different patch tags (v0.162.0, v0.162.1): one Codex release.
      const version = versionOf(candidate.window?.toTag);
      return version
        ? { key: `codex:${version.parts[0]}.${version.parts[1]}`, title: `Codex ${version.text}`, version: version.parts }
        : { key: 'codex:', title: 'Codex（版本不明）' };
    }
    case 'desktop': {
      const version = candidate.window?.version;
      return { key: `desktop:${version ?? ''}`, title: version ? `Codex 桌面端 ${version}` : 'Codex 桌面端' };
    }
    case 'rss': return { key: 'rss', title: '官方公告' };
    default: return { key: `source:${candidate.source}`, title: labelOf(SOURCE_LABELS, candidate.source) };
  }
}

/**
 * The list in groups: a Codex release by its minor version (titled with the highest full version in it), a desktop app version, the
 * announcements. Groups go latest discovery first, a tie later key first; rows go by `rowOrder`. The input is not reordered.
 */
export function groupCandidates(list: readonly Candidate[]): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup & { version?: [number, number, number] }>();
  for (const candidate of list) {
    const { key, title, version } = groupOf(candidate);
    const group = groups.get(key);
    if (!group) { groups.set(key, { key, title, latest: candidate.createdAt, items: [candidate], ...(version && { version }) }); continue; }
    group.items.push(candidate);
    if (candidate.createdAt > group.latest) group.latest = candidate.createdAt;
    if (version && (!group.version || laterVersion(version, group.version))) { group.version = version; group.title = title; }
  }
  return [...groups.values()]
    .map(({ key, title, latest, items }) => ({ key, title, latest, items: items.sort(rowOrder) }))
    .sort((a, b) => descending(a.latest, b.latest) || descending(a.key, b.key));
}
