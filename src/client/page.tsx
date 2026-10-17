/**
 * The OpenCodex page: the data it reads from the Host and the requests it sends, and how the parts fit together (the header, the views
 * and the list, the settings, the detail of one candidate). The detail view below is the one from before the list's redesign.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { canTransition, type Evidence, type ReportChecks, type ReportRecord, type Status } from '../core/candidate.js';
import { CandidateList } from './CandidateList.js';
import type { CandidateAction, RowState } from './CandidateRow.js';
import type { Call, ClientCandidate, ClientRequest, ClientResponse, OpenSession } from './contract.js';
import { Filters } from './Filters.js';
import { Header } from './Header.js';
import { Icon } from './icons.js';
import {
  CATEGORY_LABELS, EVIDENCE_LABELS, RELEVANCE_LABELS, SOURCE_LABELS, STATUS_LABELS, countViews, labelOf, mergeLabel, time, viewOf, type View,
} from './labels.js';
import { Markdown, revealHidden } from './markdown.js';
import { SettingsView } from './SettingsView.js';
import type { Ui } from './ui.js';
import { UiContext, useUi } from './ui-context.js';

type ReportText = NonNullable<ClientResponse['report']>;
/** The controls outside the list, each with its own busy flag and error line. */
type Control = 'check' | 'index' | 'settings';

const BUSY_LABELS: Record<CandidateAction, string> = { report: '调研中', start: '发送中', ignore: '忽略中', restore: '恢复中' };
/** How often a visible page asks for a fresh snapshot: the timer's checks and the reports finish without the page asking. Sooner while the Host is busy. */
const POLL_MS = 60_000, BUSY_POLL_MS = 5_000;
/** What an empty view says, and what the list says before the first check found anything. */
const EMPTY: Record<View, { title: string; hint: string }> = {
  todo: { title: '没有待办的动态', hint: '新发现的动态归类后，相关度不是低的会出现在这里。' },
  low: { title: '没有相关度低的动态', hint: '归类为相关度低的新发现会出现在这里。' },
  ignored: { title: '没有已忽略的动态', hint: '忽略的动态会出现在这里，可以随时恢复。' },
};
const NOTHING_YET = { title: '还没有 Codex 动态', hint: '点「检查更新」从发布说明、仓库文件、桌面端和 RSS 收集 Codex 的新功能。' };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const httpUrl = (url: string | undefined) => (url && /^https?:\/\//i.test(url) ? url : undefined);
const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _dropped, ...rest } = record;
  return rest;
};

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

/** The buttons of one candidate in the detail view, each enabled by the status move it makes. */
function CandidateActions({ candidate, busy, run }: { candidate: ClientCandidate; busy: boolean; run: (action: CandidateAction) => Promise<void> }) {
  const { status, report } = candidate;
  const startHint = status === 'ignored' ? '先恢复这条候选' : status !== 'new' ? undefined : report ? '恢复的候选要先重新生成报告' : '先生成报告再开工';
  return <div className="oc-candidate-actions">
    <button type="button" disabled={busy || !canTransition(status, 'reported')} onClick={() => run('report')}>{report ? '重新生成报告' : '生成报告'}</button>
    <button type="button" disabled={busy || !canTransition(status, 'started')} title={startHint} onClick={() => run('start')}>开工</button>
    {status === 'ignored'
      ? <button type="button" disabled={busy || !canTransition(status, 'new')} onClick={() => run('restore')}>恢复</button>
      : <button type="button" disabled={busy || !canTransition(status, 'ignored')} onClick={() => run('ignore')}>忽略</button>}
  </div>;
}

function RowMessages({ state }: { state: RowState }) {
  return <>
    {state.note && <p className="oc-row-note" role="status">{state.note}</p>}
    {state.error && <p className="oc-error" role="alert">{state.error}</p>}
  </>;
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
interface Detail { id: string; loading: boolean; candidate?: ClientCandidate; candidateError?: string; report?: ReportText; reportError?: string }

function CandidateDetail({ candidate, candidates, detail, busy, state, run, back, openSession }: {
  candidate: ClientCandidate; candidates: readonly ClientCandidate[]; detail?: Detail; busy?: CandidateAction; state: RowState;
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
    <RowMessages state={state} />
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

/** The page, with `ui` the DSH controls its parts are built from: the real ones in the plugin (ui.ts), stand-ins in tests. */
export function OpenCodexPage({ ui, ...props }: { call: Call; openSession?: OpenSession; ui: Ui }) {
  return <UiContext.Provider value={ui}><Page {...props} /></UiContext.Provider>;
}

function Page({ call, openSession }: { call: Call; openSession?: OpenSession }) {
  const { Button } = useUi();
  const [data, setData] = useState<ClientResponse>();
  const [loadError, setLoadError] = useState('');
  const [view, setView] = useState<View>('todo');
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const show = useCallback((response: ClientResponse) => { shownCount.current++; setData(response); }, []);
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
  // A queue waiting for automatic research counts as busy too: its rows move on without the page asking.
  const hostBusy = Boolean(data?.busy?.check) || Object.keys(data?.busy?.candidates ?? {}).length > 0 || (data?.researchQueue?.length ?? 0) > 0;
  useEffect(() => {
    const timer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState === 'visible') void refresh(); }, hostBusy ? BUSY_POLL_MS : POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, hostBusy]);

  const setRow = (id: string, update: (state: RowState) => RowState) => setRows(current => {
    const next = update(current[id] ?? {});
    return next.pending === undefined && next.error === undefined && next.note === undefined ? without(current, id) : { ...current, [id]: next };
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
      const sessionId = action === 'start' ? response.startedSessionId : undefined;
      if (sessionId) {
        // The start went through; only switching to its session failed.
        try { openSession?.(sessionId); } catch { setRow(id, () => ({ note: `开工会话已创建（${sessionId}），但没能自动打开` })); }
      }
    } catch (error) {
      if (signal?.aborted) { setRow(id, () => ({})); return; }
      setRow(id, () => ({ error: messageOf(error) }));
      await refresh(); // the action may have changed something before it failed
    }
  };
  /** Shows a candidate's creator session, or says on its row that the workspace did not switch. */
  const showSession = (id: string, sessionId: string) => {
    try { openSession?.(sessionId); } catch { setRow(id, () => ({ note: `会话 ${sessionId} 没能自动打开` })); }
  };
  /** A request from one of the controls outside the list; true when it went through. */
  const control = async (name: Control, request: ClientRequest): Promise<boolean> => {
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

  // The list keeps its scroll position while a detail or the settings are open; those start at the top.
  const away = selected !== undefined || settingsOpen;
  useLayoutEffect(() => { if (page.current) page.current.scrollTop = away ? 0 : listScroll.current; }, [away, selected, settingsOpen]);
  const leaveList = () => { if (!away) listScroll.current = page.current?.scrollTop ?? 0; };
  /** Opens a candidate's detail. A row asks for the part it means (the report, the execute step); this detail shows them all on one page. */
  const open = (id: string) => {
    leaveList();
    setDetail(undefined);
    setSelected(id);
  };
  const toggleSettings = () => { leaveList(); setSettingsOpen(current => !current); };

  // `busy` and the counts are read with care: right after the plugin is reinstalled, this page can still be talking to the previous Host.
  const checking = Boolean(busy.check || data?.busy?.check);
  /** The action running on a candidate: the one this page asked for, else the one the Host reports. */
  const busyOf = (id: string): CandidateAction | undefined => rows[id]?.pending ?? data?.busy?.candidates?.[id];
  const omitted = data?.omittedCandidates ?? 0;
  return <div className="oc-page" ref={page}>
    <Header data={data} checking={checking} indexBusy={Boolean(busy.index)} settingsOpen={settingsOpen}
      errors={{ check: controlErrors.check, index: controlErrors.index, refresh: data && loadError ? loadError : undefined }}
      check={() => control('check', { action: 'check' })} rebuildIndex={() => control('index', { action: 'rebuildIndex' })} toggleSettings={toggleSettings} />
    {!data ? <div className="oc-loading">
      {loadError
        ? <><p className="oc-error" role="alert">读不到 OpenCodex：{loadError}</p><Button variant="outline" size="sm" onClick={refresh}>重试</Button></>
        : <p className="oc-muted" role="status">正在读取…</p>}
    </div>
      : settingsOpen
        ? <SettingsView settings={data.settings} call={call} saving={Boolean(busy.settings)} error={controlErrors.settings}
          save={patch => control('settings', { action: 'settings', patch })} back={() => setSettingsOpen(false)} />
        : selected
          ? listed
            ? <CandidateDetail candidate={listed} candidates={candidates} detail={detail?.id === selected ? detail : undefined}
              busy={busyOf(selected)} state={rows[selected] ?? {}} run={action => run(selected, action)} back={() => setSelected(undefined)} openSession={openSession} />
            : <section className="oc-detail">
              <button type="button" className="oc-back" onClick={() => setSelected(undefined)}><Icon name="back" />全部候选</button>
              <p className="oc-muted">这条候选不在列表里了。</p>
            </section>
          : <>
            <Filters view={view} counts={countViews(candidates)} change={setView} />
            <CandidateList shown={candidates.filter(item => viewOf(item) === view)} candidates={candidates} queue={data.researchQueue ?? []}
              busyOf={busyOf} rows={rows} open={open} run={run} showSession={openSession && showSession}
              empty={candidates.length === 0 ? NOTHING_YET : EMPTY[view]} />
            {omitted > 0 && <p className="oc-muted oc-omitted">另有 {omitted.toLocaleString('zh-CN')} 条较旧的动态未列出</p>}
          </>}
    <footer className="oc-footer">
      <span>OpenCodex · 第三方插件</span>
      <a href="https://github.com/ZiyaZhang/opencodex" target="_blank" rel="noreferrer"><Icon name="code" />源码<Icon name="external" /></a>
    </footer>
  </div>;
}
