import { useCallback, useEffect, useLayoutEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import {
  CATEGORIES, RELEVANCES, SOURCES, STATUSES, canTransition,
  type Candidate, type Evidence, type EvidenceKind, type ReportChecks, type ReportRecord, type Source, type Status,
} from '../core/candidate.js';
import type { Settings } from '../core/settings.js';
import type { OpenCodexRequest, OpenCodexResponse } from '../host/remote.js';
import { Icon, type IconName } from './icons.js';
import { Markdown, revealHidden } from './markdown.js';

type Call = (request: OpenCodexRequest, signal?: AbortSignal) => Promise<OpenCodexResponse>;
type OpenSession = (sessionId: string) => void;
/**
 * What the Host's answers are gaining (a capped candidate list, its own busy state, the time of the last check, a notice). Optional, so the
 * page reads them where the Host sends them and does without where it does not yet.
 */
interface HostState {
  totalCandidates?: number;
  /** Older candidates the snapshot left out. */
  omittedCandidates?: number;
  notice?: string;
  /** What the Host is running now, whoever asked for it: a reloaded page learns it from here. */
  busy?: { check: boolean; candidates: Record<string, 'report' | 'start'> };
  lastCheckAt?: string;
}
type Snapshot = OpenCodexResponse & HostState;
type Category = typeof CATEGORIES[number];
type Relevance = typeof RELEVANCES[number];
type LastCheck = NonNullable<OpenCodexResponse['lastCheck']>;
type IndexSummary = NonNullable<OpenCodexResponse['indexSummary']>;
type ReportText = NonNullable<OpenCodexResponse['report']>;
/** The actions on one candidate. */
type CandidateAction = 'report' | 'start' | 'ignore' | 'restore';
/** The controls outside the list, each with its own busy flag and error line. */
type Control = 'check' | 'index' | 'settings';
type Tab = 'candidates' | 'settings';

const TABS: readonly (readonly [Tab, string, IconName])[] = [['candidates', '候选', 'radar'], ['settings', '设置', 'settings']];
const SOURCE_LABELS: Record<Source, string> = { 'codex-release': 'Codex 发布说明', 'codex-files': 'Codex 仓库文件', desktop: 'Codex 桌面端', rss: '官方 RSS' };
const CATEGORY_LABELS: Record<Category, string> = { 'cli-core': 'CLI 核心', desktop: '桌面端', cloud: '云端', model: '模型', fix: '修复', other: '其他' };
const RELEVANCE_LABELS: Record<Relevance, string> = { high: '高', medium: '中', low: '低' };
const STATUS_LABELS: Record<Status, string> = { new: '新发现', reported: '已出报告', started: '已开工', ignored: '已忽略' };
const EVIDENCE_LABELS: Record<EvidenceKind, string> = { pr: 'PR', file: '文件', chunk: 'chunk', i18n: 'i18n key', rss: 'RSS', 'feature-flag': '功能开关', schema: '协议类型', doc: '文档' };
const BUSY_LABELS: Record<CandidateAction, string> = { report: '生成中', start: '开工中', ignore: '忽略中', restore: '恢复中' };
/** How often a visible page asks for a fresh snapshot: the timer's checks and the reports finish without the page asking. Sooner while the Host is busy. */
const POLL_MS = 60_000, BUSY_POLL_MS = 5_000;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The label of a value read from disk, or the value itself when this page does not know it. */
const labelOf = <K extends string>(labels: Record<K, string>, value: string): string => (Object.hasOwn(labels, value) ? labels[value as K] : value);
const time = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const httpUrl = (url: string | undefined) => (url && /^https?:\/\//i.test(url) ? url : undefined);
const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _dropped, ...rest } = record;
  return rest;
};
/** Descending order of ISO timestamps, which sort as strings. */
const newestFirst = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

export interface Filters {
  source: Source | 'all';
  /** `none`: not classified yet. */
  category: Category | 'all' | 'none';
  /** `not-low`: everything but `low`, the unclassified included. */
  relevance: Relevance | 'all' | 'not-low';
  status: Status | 'all' | 'not-ignored';
}
export const DEFAULT_FILTERS: Filters = { source: 'all', category: 'all', relevance: 'not-low', status: 'not-ignored' };

/** The candidates the filters let through, latest change first. */
export function visibleCandidates(list: readonly Candidate[], filters: Filters): Candidate[] {
  const { source, category, relevance, status } = filters;
  return list.filter(item => {
    const classification = item.classification;
    return (source === 'all' || item.source === source)
      && (category === 'all' || (category === 'none' ? !classification : classification?.category === category))
      && (relevance === 'all' || (relevance === 'not-low' ? classification?.relevance !== 'low' : classification?.relevance === relevance))
      && (status === 'all' || (status === 'not-ignored' ? item.status !== 'ignored' : item.status === status));
  }).sort((a, b) => newestFirst(a.updatedAt, b.updatedAt) || newestFirst(a.createdAt, b.createdAt) || (a.id < b.id ? -1 : 1));
}

/** Where a merged candidate went, one hop only: classifications can point in a circle. The target's title when it is listed, else its id. */
export function mergeLabel(mergedInto: string, candidates: readonly Candidate[]): string {
  return `并入：${candidates.find(item => item.id === mergedInto)?.title ?? mergedInto}`;
}

/** The report checks as the report header shows them. A report without any DSH reference does not pass. */
export function checksSummary({ requiredSections, dshRefsTotal: total, dshRefsResolved: resolved }: ReportChecks) {
  const refsOk = total > 0 && resolved >= total;
  const warnings = total === 0 ? ['没有引用'] : resolved < total ? [`有 ${total - resolved} 处引用未在镜像里找到`] : [];
  return {
    passed: requiredSections && refsOk,
    items: [
      { label: requiredSections ? '模板要求的节齐全' : '缺少模板要求的节', ok: requiredSections },
      { label: `DSH 引用在镜像里找到 ${resolved}/${total}`, ok: refsOk },
    ],
    warnings,
  };
}

/** The settings form's fields, all text as inputs hold them. */
export interface SettingsDraft {
  dshMirrorPath: string; desktopPlistPath: string; desktopLocale: string;
  classifyProvider: string; classifyModel: string; reportProvider: string; reportModel: string;
  reportPreset: string; startPreset: string; dailyReportLimit: string; checkIntervalHours: string;
}
export const draftOf = (settings: Settings): SettingsDraft => ({
  dshMirrorPath: settings.dshMirrorPath, desktopPlistPath: settings.desktopPlistPath, desktopLocale: settings.desktopLocale,
  classifyProvider: settings.classifyModel.provider, classifyModel: settings.classifyModel.model,
  reportProvider: settings.reportModel.provider, reportModel: settings.reportModel.model,
  reportPreset: settings.reportPreset, startPreset: settings.startPreset,
  dailyReportLimit: String(settings.dailyReportLimit), checkIntervalHours: String(settings.checkIntervalHours),
});
/** The settings the draft changes, trimmed, numbers as numbers, a changed model route whole. The Host checks the values. */
export function settingsPatch(current: Settings, draft: SettingsDraft): Partial<Settings> {
  const next: Settings = {
    ...current,
    dshMirrorPath: draft.dshMirrorPath.trim(), desktopPlistPath: draft.desktopPlistPath.trim(), desktopLocale: draft.desktopLocale.trim(),
    classifyModel: { provider: draft.classifyProvider.trim(), model: draft.classifyModel.trim() },
    reportModel: { provider: draft.reportProvider.trim(), model: draft.reportModel.trim() },
    reportPreset: draft.reportPreset.trim(), startPreset: draft.startPreset.trim(),
    dailyReportLimit: Number(draft.dailyReportLimit), checkIntervalHours: Number(draft.checkIntervalHours),
  };
  const changed = (Object.keys(next) as (keyof Settings)[]).filter(key => JSON.stringify(next[key]) !== JSON.stringify(current[key]));
  return Object.fromEntries(changed.map(key => [key, next[key]])) as Partial<Settings>;
}

function StatusBadge({ status, busy }: { status: Status; busy?: CandidateAction }) {
  return <>
    <span className={`oc-status oc-status-${status}`}>{labelOf(STATUS_LABELS, status)}</span>
    {busy && <span className="oc-status oc-busy" role="status">{BUSY_LABELS[busy]}</span>}
  </>;
}

/** The report of a candidate: its checks, then the text, or why there is none to show. */
export function ReportView({ record, report, error, loading }: { record?: ReportRecord; report?: ReportText; error?: string; loading?: boolean }) {
  if (!record) return <p className="oc-muted">尚未生成报告</p>;
  const { passed, items, warnings } = checksSummary(record.checks);
  return <div className="oc-report">
    <div className="oc-report-head">
      <strong className={passed ? 'oc-ok' : 'oc-warn'}>{passed ? '校验通过' : '校验未通过'}</strong>
      {items.map(item => <span key={item.label} className={item.ok ? '' : 'oc-warn'}>{item.ok ? '✓' : '✗'} {item.label}</span>)}
      <span className="oc-muted">生成于 {time(record.generatedAt)}</span>
    </div>
    {warnings.map(warning => <p key={warning} className="oc-warning" role="note">{warning}</p>)}
    {error ? <p className="oc-error" role="alert">报告读取失败：{error}</p>
      : report?.notice ? <p className="oc-notice" role="status">{report.notice}</p>
      : report ? <Markdown text={report.markdown} />
      : loading ? <p className="oc-muted" role="status">正在读取报告…</p> : null}
  </div>;
}

function LastCheckLine({ lastCheck, at }: { lastCheck?: LastCheck; at?: string }) {
  if (!lastCheck) return <p className="oc-line oc-muted">{at ? `上次检查在 ${time(at)}，没有结果可显示。` : 'DSH 启动后还没有检查过。'}</p>;
  const { releases, files, desktop, rss, errors } = lastCheck;
  const range = releases.window ?? files.window;
  return <div className="oc-line">
    <strong>上次检查</strong>
    {at && <time dateTime={at}>{time(at)}</time>}
    <span>{range ? `${range.from} → ${range.to}` : '没有新的正式版'}</span>
    <span>发布说明 +{releases.added}</span>
    <span>仓库文件 +{files.added}</span>
    <span>桌面端 +{desktop.added}</span>
    <span>RSS +{rss}</span>
    {errors.length === 0 ? <span>没有错误</span>
      : <details className="oc-errors"><summary className="oc-warn">{errors.length} 条错误</summary><ul>{errors.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}
  </div>;
}

function IndexLine({ summary, busy, rebuild }: { summary?: IndexSummary; busy: boolean; rebuild: () => Promise<boolean> }) {
  return <div className="oc-line">
    <strong>DSH 索引</strong>
    {summary
      ? <><span>{summary.entries.toLocaleString('zh-CN')} 条</span><span>提交 <code>{summary.commit.slice(0, 12)}</code></span><span>建于 {time(summary.builtAt)}</span></>
      : <span className="oc-muted">还没有建，先在设置里填 DSH 镜像路径</span>}
    <button type="button" className="oc-small" disabled={busy} onClick={rebuild}>{busy ? '重建中…' : '重建索引'}</button>
  </div>;
}

function FilterBar({ filters, change, shown, total }: { filters: Filters; change: (next: Filters) => void; shown: number; total: number }) {
  const pick = <K extends keyof Filters>(key: K, label: string, options: readonly (readonly [string, string])[]) =>
    <label>{label}<select value={filters[key]} onChange={event => { const next = { ...filters }; next[key] = event.target.value as Filters[K]; change(next); }}>
      {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
    </select></label>;
  const isDefault = (Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]).every(key => filters[key] === DEFAULT_FILTERS[key]);
  return <div className="oc-filters">
    {pick('source', '来源', [['all', '全部'], ...SOURCES.map(value => [value, SOURCE_LABELS[value]] as const)])}
    {pick('category', '分类', [['all', '全部'], ...CATEGORIES.map(value => [value, CATEGORY_LABELS[value]] as const), ['none', '未归类']])}
    {pick('relevance', '相关度', [['not-low', '不含低'], ['all', '全部'], ...RELEVANCES.map(value => [value, RELEVANCE_LABELS[value]] as const)])}
    {pick('status', '状态', [['not-ignored', '不含已忽略'], ['all', '全部'], ...STATUSES.map(value => [value, STATUS_LABELS[value]] as const)])}
    <span className="oc-filter-count">显示 {shown} / {total}</span>
    {!isDefault && <button type="button" className="oc-small" onClick={() => change(DEFAULT_FILTERS)}>恢复默认</button>}
  </div>;
}

/** The buttons of one candidate, each enabled by the status move it makes. `view` (the list) turns the report button into 查看报告 once there is a report. */
function CandidateActions({ candidate, busy, run, view }: { candidate: Candidate; busy: boolean; run: (action: CandidateAction) => Promise<void>; view?: () => void }) {
  const { status, report } = candidate;
  const startHint = status === 'new' ? '先生成报告再开工' : status === 'ignored' ? '先恢复这条候选' : undefined;
  return <div className="oc-candidate-actions">
    {report && view
      ? <button type="button" disabled={busy} onClick={view}>查看报告</button>
      : <button type="button" disabled={busy || !canTransition(status, 'reported')} onClick={() => run('report')}>{report ? '重新生成报告' : '生成报告'}</button>}
    <button type="button" disabled={busy || !canTransition(status, 'started')} title={startHint} onClick={() => run('start')}>开工</button>
    {status === 'ignored'
      ? <button type="button" disabled={busy || !canTransition(status, 'new')} onClick={() => run('restore')}>恢复</button>
      : <button type="button" disabled={busy || !canTransition(status, 'ignored')} onClick={() => run('ignore')}>忽略</button>}
  </div>;
}

function Meta({ candidate, candidates }: { candidate: Candidate; candidates: readonly Candidate[] }) {
  const { classification } = candidate;
  return <div className="oc-row-meta">
    <span>{labelOf(SOURCE_LABELS, candidate.source)}</span>
    <span>{classification ? labelOf(CATEGORY_LABELS, classification.category) : '未归类'}</span>
    {classification && <span>相关度{labelOf(RELEVANCE_LABELS, classification.relevance)}</span>}
    <time dateTime={candidate.updatedAt}>{time(candidate.updatedAt)}</time>
    {classification?.mergedInto && <span>{mergeLabel(classification.mergedInto, candidates)}</span>}
  </div>;
}

/** What this page knows about one candidate's action: the request it has out, or the error the last one ended with. */
interface RowState { pending?: CandidateAction; error?: string }

function CandidateRow({ candidate, candidates, busy, error, open, run }: {
  candidate: Candidate; candidates: readonly Candidate[]; busy?: CandidateAction; error?: string; open: () => void; run: (action: CandidateAction) => Promise<void>;
}) {
  return <article className="oc-candidate" aria-busy={busy !== undefined}>
    <div className="oc-candidate-main">
      <div className="oc-candidate-title"><button type="button" className="oc-title-button" onClick={open}>{candidate.title}</button><StatusBadge status={candidate.status} busy={busy} /></div>
      {candidate.summary && <p className="oc-candidate-summary">{candidate.summary}</p>}
      <Meta candidate={candidate} candidates={candidates} />
      {error && <p className="oc-error" role="alert">{error}</p>}
    </div>
    <CandidateActions candidate={candidate} busy={busy !== undefined} run={run} view={open} />
  </article>;
}

function EvidenceList({ evidence }: { evidence: readonly Evidence[] }) {
  if (evidence.length === 0) return <p className="oc-muted">没有证据条目。</p>;
  return <ul className="oc-evidence">{evidence.map((item, index) => {
    const url = httpUrl(item.url);
    return <li key={index}>
      <div className="oc-evidence-head">
        <span className="oc-tag">{labelOf(EVIDENCE_LABELS, item.kind)}</span><code>{item.ref}</code>
        {url && <a href={url} target="_blank" rel="noreferrer">打开<Icon name="external" /></a>}
      </div>
      {item.excerpt && <details><summary>摘录</summary><pre className="oc-raw">{revealHidden(item.excerpt)}</pre></details>}
    </li>;
  })}</ul>;
}

/** What the detail view reads for one candidate: the whole record (evidence excerpts) and the report text. */
interface Detail { id: string; loading: boolean; candidate?: Candidate; candidateError?: string; report?: ReportText; reportError?: string }

function CandidateDetail({ candidate, candidates, detail, busy, error, run, back, openSession }: {
  candidate: Candidate; candidates: readonly Candidate[]; detail?: Detail; busy?: CandidateAction; error?: string;
  run: (action: CandidateAction) => Promise<void>; back: () => void; openSession?: OpenSession;
}) {
  const { classification, started, window: range } = candidate;
  // The list carries a clipped summary and rationale; the whole record has them in full.
  const whole = detail?.candidate;
  const summary = whole?.summary ?? candidate.summary;
  const rationale = whole?.classification?.rationale ?? classification?.rationale;
  const evidence = whole?.evidence ?? candidate.evidence;
  return <section className="oc-detail">
    <button type="button" className="oc-back" onClick={back}><Icon name="back" />全部候选</button>
    <div className="oc-detail-head"><h2>{candidate.title}</h2><StatusBadge status={candidate.status} busy={busy} /></div>
    <div className="oc-row-meta">
      <span>{labelOf(SOURCE_LABELS, candidate.source)}</span>
      {range?.toTag && <span>{range.fromTag ? `${range.fromTag} → ` : ''}{range.toTag}</span>}
      {range?.version && <span>版本 {range.version}</span>}
      <span>发现于 {time(candidate.createdAt)}</span>
      <span>更新于 {time(candidate.updatedAt)}</span>
    </div>
    {summary && <p className="oc-text">{summary}</p>}
    <CandidateActions candidate={candidate} busy={busy !== undefined} run={run} />
    {error && <p className="oc-error" role="alert">{error}</p>}
    {started && <p className="oc-row-meta">
      <span>开工会话 <code>{started.sessionId}</code>，{time(started.at)}</span>
      {openSession && <button type="button" className="oc-small" onClick={() => openSession(started.sessionId)}>打开会话</button>}
    </p>}
    <section className="oc-section">
      <h3>归类</h3>
      {classification ? <>
        <div className="oc-row-meta">
          <span>{labelOf(CATEGORY_LABELS, classification.category)}</span>
          <span>相关度{labelOf(RELEVANCE_LABELS, classification.relevance)}</span>
          {classification.mergedInto && <span>{mergeLabel(classification.mergedInto, candidates)}</span>}
        </div>
        <p className="oc-text">{rationale}</p>
      </> : <p className="oc-muted">还没有归类，检查更新后会自动归类。</p>}
    </section>
    <section className="oc-section">
      <h3>报告</h3>
      <ReportView record={candidate.report} report={detail?.report} error={detail?.reportError} loading={detail?.loading ?? true} />
    </section>
    <section className="oc-section">
      <h3>证据 <span>{evidence.length}</span></h3>
      {detail?.candidateError && <p className="oc-error" role="alert">摘录读取失败：{detail.candidateError}</p>}
      <EvidenceList evidence={evidence} />
    </section>
  </section>;
}

function SettingsForm({ settings, saving, error, save }: { settings: Settings; saving: boolean; error?: string; save: (patch: Partial<Settings>) => Promise<boolean> }) {
  const [draft, setDraft] = useState(() => draftOf(settings));
  const [saved, setSaved] = useState(false);
  /** The last save's error describes values the user has edited since. */
  const [edited, setEdited] = useState(false);
  const stored = JSON.stringify(settings);
  // A new value from the Host (a save, or a change made elsewhere) replaces the draft; a refresh with the same settings leaves edits alone.
  useEffect(() => { setDraft(draftOf(JSON.parse(stored) as Settings)); }, [stored]);
  const patch = settingsPatch(settings, draft);
  const dirty = Object.keys(patch).length > 0;
  const field = (name: keyof SettingsDraft, label: string, attributes: InputHTMLAttributes<HTMLInputElement> = {}) =>
    <label>{label}<input name={name} value={draft[name]} spellCheck={false} {...attributes}
      onChange={event => { const value = event.target.value; setSaved(false); setEdited(true); setDraft(current => ({ ...current, [name]: value })); }} /></label>;
  const submit = async () => {
    if (!dirty || saving) return;
    setEdited(false);
    if (await save(patch)) setSaved(true);
  };
  return <form className="oc-form" onSubmit={event => { event.preventDefault(); return submit(); }}>
    <h3>镜像与桌面端</h3>
    {field('dshMirrorPath', 'DSH 镜像路径', { placeholder: '/Users/…/deepseek-harness' })}
    <p className="oc-hint">报告里的 DSH 引用都相对这个目录；改了以后马上重建索引。</p>
    {field('desktopPlistPath', '桌面端 Info.plist 路径')}
    <p className="oc-hint">ChatGPT.app 的 Info.plist；留空就不检查桌面端。</p>
    {field('desktopLocale', '桌面端文案语言', { placeholder: 'zh-CN' })}
    <h3>模型</h3>
    <div className="oc-two-columns">{field('classifyProvider', '归类模型的提供方')}{field('classifyModel', '归类模型')}</div>
    <div className="oc-two-columns">{field('reportProvider', '报告模型的提供方')}{field('reportModel', '报告模型')}</div>
    <h3>会话</h3>
    <div className="oc-two-columns">
      {field('reportPreset', '报告会话的 Agent 预设', { placeholder: '留空用 DSH 默认预设' })}
      {field('startPreset', '开工会话的 Agent 预设', { placeholder: '留空用 DSH 默认预设' })}
    </div>
    <p className="oc-hint">cordis 是创造模式。</p>
    <h3>频率</h3>
    <div className="oc-two-columns">
      {field('dailyReportLimit', '每天最多生成报告（份）', { type: 'number', min: 1, step: 1, required: true })}
      {field('checkIntervalHours', '检查间隔（小时）', { type: 'number', min: 1, max: 168, step: 1, required: true })}
    </div>
    <div className="oc-form-actions">
      <button type="submit" disabled={saving || !dirty}>{saving ? '保存中…' : '保存'}</button>
      {saved && !dirty && <span className="oc-muted" role="status">已保存</span>}
    </div>
    {error && !edited && <p className="oc-error" role="alert">{error}</p>}
  </form>;
}

export function OpenCodexPage({ call, openSession }: { call: Call; openSession?: OpenSession }) {
  const [data, setData] = useState<Snapshot>();
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<Tab>('candidates');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<Detail>();
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [busy, setBusy] = useState<Partial<Record<Control, boolean>>>({});
  const [controlErrors, setControlErrors] = useState<Partial<Record<Control, string>>>({});
  const page = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  /** Aborted when the page goes away; whatever comes back after that is dropped. */
  const lifetime = useRef<AbortController>();
  /** Counts the responses shown, so a snapshot asked for before another response arrived does not replace it. */
  const shownCount = useRef(0);

  const show = useCallback((response: Snapshot) => { shownCount.current++; setData(response); }, []);
  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal, before = shownCount.current;
    try {
      const response = await call({ action: 'snapshot' }, signal);
      if (signal?.aborted) return;
      if (shownCount.current === before) show(response);
      setLoadError('');
    } catch (error) {
      if (!signal?.aborted) setLoadError(messageOf(error));
    }
  }, [call, show]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void refresh();
    return () => controller.abort();
  }, [refresh]);
  const hostBusy = Boolean(data?.busy?.check) || Object.keys(data?.busy?.candidates ?? {}).length > 0;
  useEffect(() => {
    const timer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState === 'visible') void refresh(); }, hostBusy ? BUSY_POLL_MS : POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, hostBusy]);

  const setRow = (id: string, update: (state: RowState) => RowState) => setRows(current => {
    const next = update(current[id] ?? {});
    return next.pending === undefined && next.error === undefined ? without(current, id) : { ...current, [id]: next };
  });
  /** One action on one candidate: its buttons wait, the answer replaces the page, an error stays on its row. */
  const run = async (id: string, action: CandidateAction) => {
    const signal = lifetime.current?.signal;
    setRow(id, () => ({ pending: action }));
    try {
      const response = await call({ action, id }, signal);
      setRow(id, () => ({}));
      if (signal?.aborted) return;
      show(response);
      if (action === 'start' && response.startedSessionId) openSession?.(response.startedSessionId);
    } catch (error) {
      if (signal?.aborted) { setRow(id, () => ({})); return; }
      setRow(id, () => ({ error: messageOf(error) }));
      await refresh(); // the action may have changed something before it failed
    }
  };
  /** A request from one of the controls outside the list; true when it went through. */
  const control = async (name: Control, request: OpenCodexRequest): Promise<boolean> => {
    const signal = lifetime.current?.signal;
    setBusy(current => ({ ...current, [name]: true }));
    setControlErrors(current => ({ ...current, [name]: undefined }));
    try {
      const response = await call(request, signal);
      if (!signal?.aborted) show(response);
      return true;
    } catch (error) {
      if (signal?.aborted) return false;
      setControlErrors(current => ({ ...current, [name]: messageOf(error) }));
      await refresh();
      return false;
    } finally {
      setBusy(current => ({ ...current, [name]: false }));
    }
  };

  const candidates = data?.candidates ?? [];
  const listed = candidates.find(item => item.id === selected);
  const hasReport = Boolean(listed?.report);
  // The detail reads the whole record and the report again whenever the candidate changes (a report written, evidence repaired).
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setDetail(current => ({ ...(current?.id === selected ? current : {}), id: selected, loading: true }));
    void Promise.allSettled([
      call({ action: 'candidate', id: selected }, controller.signal),
      hasReport ? call({ action: 'readReport', id: selected }, controller.signal) : Promise.resolve(undefined),
    ]).then(([whole, read]) => {
      if (controller.signal.aborted) return;
      setDetail({
        id: selected, loading: false,
        ...(whole.status === 'fulfilled' ? { candidate: whole.value.candidate } : { candidateError: messageOf(whole.reason) }),
        ...(read.status === 'rejected' ? { reportError: messageOf(read.reason) } : read.value?.report ? { report: read.value.report } : {}),
      });
    });
    return () => controller.abort();
  }, [call, selected, listed?.updatedAt, hasReport]);

  // The list keeps its scroll position while a detail is open; a detail starts at the top.
  useLayoutEffect(() => { if (page.current) page.current.scrollTop = selected ? 0 : listScroll.current; }, [selected]);
  const open = (id: string) => {
    listScroll.current = page.current?.scrollTop ?? 0;
    setDetail(undefined);
    setSelected(id);
  };

  const shown = visibleCandidates(candidates, filters);
  const waiting = candidates.filter(item => item.status === 'new').length;
  const checking = Boolean(busy.check || data?.busy?.check);
  /** The action running on a candidate: the one this page asked for, else the one the Host reports. */
  const busyOf = (id: string): CandidateAction | undefined => rows[id]?.pending ?? data?.busy?.candidates?.[id];
  const omitted = data?.omittedCandidates ?? 0;
  return <div className="oc-page" ref={page}>
    <header className="oc-header">
      <div className="oc-brand">OpenCodex</div>
      <button type="button" disabled={!data || checking} onClick={() => control('check', { action: 'check' })}>
        <Icon name="refresh" />{checking ? '检查中…' : '检查更新'}
      </button>
    </header>
    {!data ? <div className="oc-overview">
      {loadError
        ? <><p className="oc-error" role="alert">读不到 OpenCodex：{loadError}</p><button type="button" onClick={refresh}>重试</button></>
        : <p className="oc-muted" role="status">正在读取…</p>}
    </div> : <>
      <section className="oc-overview" aria-label="检查与索引">
        {data.notice && <p className="oc-notice" role="status">{data.notice}</p>}
        <LastCheckLine lastCheck={data.lastCheck} at={data.lastCheckAt} />
        {controlErrors.check && <p className="oc-error" role="alert">{controlErrors.check}</p>}
        <IndexLine summary={data.indexSummary} busy={Boolean(busy.index)} rebuild={() => control('index', { action: 'rebuildIndex' })} />
        {controlErrors.index && <p className="oc-error" role="alert">{controlErrors.index}</p>}
        {loadError && <p className="oc-error" role="alert">刷新失败：{loadError}</p>}
      </section>
      <nav className="oc-tabs" aria-label="OpenCodex"><div>
        {TABS.map(([id, label, icon]) => <button type="button" key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); setSelected(undefined); }}>
          <Icon name={icon} />{label}{id === 'candidates' && waiting > 0 && <span className="oc-count" title="新发现">{waiting}</span>}
        </button>)}
      </div></nav>
      {tab === 'settings'
        ? <SettingsForm settings={data.settings} saving={Boolean(busy.settings)} error={controlErrors.settings} save={patch => control('settings', { action: 'settings', patch })} />
        : selected
          ? listed
            ? <CandidateDetail candidate={listed} candidates={candidates} detail={detail?.id === selected ? detail : undefined}
              busy={busyOf(selected)} error={rows[selected]?.error} run={action => run(selected, action)} back={() => setSelected(undefined)} openSession={openSession} />
            : <section className="oc-detail">
              <button type="button" className="oc-back" onClick={() => setSelected(undefined)}><Icon name="back" />全部候选</button>
              <p className="oc-muted">这条候选不在列表里了。</p>
            </section>
          : <>
            <FilterBar filters={filters} change={setFilters} shown={shown.length} total={candidates.length} />
            {shown.length === 0
              ? <div className="oc-empty">
                <h2>{candidates.length === 0 ? '还没有候选' : '没有符合筛选的候选'}</h2>
                <p className="oc-muted">{candidates.length === 0 ? '点「检查更新」从发布说明、仓库文件、桌面端和 RSS 收集 Codex 的新功能。' : '换个筛选条件，或点「恢复默认」。'}</p>
              </div>
              : <div className="oc-list">{shown.map(item => <CandidateRow key={item.id} candidate={item} candidates={candidates} busy={busyOf(item.id)}
                error={rows[item.id]?.error} open={() => open(item.id)} run={action => run(item.id, action)} />)}</div>}
            {omitted > 0 && <p className="oc-muted oc-omitted">另有 {omitted.toLocaleString('zh-CN')} 条较旧的候选未列出</p>}
          </>}
    </>}
    <footer className="oc-footer">
      <span>OpenCodex · 第三方插件</span>
      <a href="https://github.com/ZiyaZhang/opencodex" target="_blank" rel="noreferrer"><Icon name="code" />源码<Icon name="external" /></a>
    </footer>
  </div>;
}
