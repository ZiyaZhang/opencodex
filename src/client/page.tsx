/**
 * The OpenCodex page: the data it reads from the Host and the requests it sends, and how the parts fit together: the header, the views
 * and the list, the settings, the detail of one candidate.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { OpenCodexRequest, OpenCodexResponse } from '../host/remote.js';
import { CandidateList } from './CandidateList.js';
import type { CandidateAction, OpenTarget, RowState } from './CandidateRow.js';
import type { Call, OpenSession } from './contract.js';
import { Detail, defaultTab, type DetailRecord, type DetailTab } from './Detail.js';
import type { StartFields } from './ExecutePane.js';
import { Filters } from './Filters.js';
import { Header } from './Header.js';
import { Icon } from './icons.js';
import { countViews, viewOf, type View } from './labels.js';
import { SettingsView } from './SettingsView.js';
import type { Ui } from './ui.js';
import { UiContext, useUi } from './ui-context.js';

/** The controls outside the list, each with its own busy flag and error line. */
type Control = 'check' | 'index' | 'settings';

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
const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _dropped, ...rest } = record;
  return rest;
};

/** The page, with `ui` the DSH controls its parts are built from: the real ones in the plugin (ui.ts), stand-ins in tests. */
export function OpenCodexPage({ ui, ...props }: { call: Call; openSession?: OpenSession; ui: Ui }) {
  return <UiContext.Provider value={ui}><Page {...props} /></UiContext.Provider>;
}

function Page({ call, openSession }: { call: Call; openSession?: OpenSession }) {
  const { Button } = useUi();
  const [data, setData] = useState<OpenCodexResponse>();
  const [loadError, setLoadError] = useState('');
  const [view, setView] = useState<View>('todo');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  /** The part of the detail that is open; it stays while the settings are open over the detail. */
  const [tab, setTab] = useState<DetailTab>('overview');
  const [detail, setDetail] = useState<DetailRecord>();
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [busy, setBusy] = useState<Partial<Record<Control, boolean>>>({});
  const [controlErrors, setControlErrors] = useState<Partial<Record<Control, string>>>({});
  const page = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  /** Aborted when the page goes away; whatever comes back after that is dropped. */
  const lifetime = useRef<AbortController>();
  /** Counts the responses shown, so a snapshot asked for before another response arrived does not replace it. */
  const shownCount = useRef(0);

  const show = useCallback((response: OpenCodexResponse) => { shownCount.current++; setData(response); }, []);
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
  /**
   * One action on one candidate: its buttons wait, the answer replaces the page, an error stays on its row with the action it came from.
   * A start sends what the detail's 执行 holds and then switches to the session it opened.
   */
  const run = async (id: string, action: CandidateAction, fields?: StartFields) => {
    const signal = lifetime.current?.signal;
    setRow(id, () => ({ pending: action }));
    try {
      const request: OpenCodexRequest = action === 'start' ? { action, id, ...fields } : { action, id };
      const response = await call(request, signal);
      setRow(id, () => ({}));
      if (signal?.aborted) return;
      show(response);
      const sessionId = action === 'start' ? response.startedSessionId : undefined;
      if (sessionId) {
        // The start went through; only switching to its session failed.
        try { openSession?.(sessionId); } catch { setRow(id, () => ({ note: `执行会话已创建（${sessionId}），但没能自动打开`, from: action })); }
      }
    } catch (error) {
      if (signal?.aborted) { setRow(id, () => ({})); return; }
      setRow(id, () => ({ error: messageOf(error), from: action }));
      await refresh(); // the action may have changed something before it failed
    }
  };
  /** Shows a candidate's creator session, or says on its row that the workspace did not switch. */
  const showSession = (id: string, sessionId: string) => {
    try { openSession?.(sessionId); } catch { setRow(id, () => ({ note: `会话 ${sessionId} 没能自动打开` })); }
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

  // The list keeps its scroll position while a detail or the settings are open; those start at the top.
  const away = selected !== undefined || settingsOpen;
  useLayoutEffect(() => { if (page.current) page.current.scrollTop = away ? 0 : listScroll.current; }, [away, selected, settingsOpen]);
  const leaveList = () => { if (!away) listScroll.current = page.current?.scrollTop ?? 0; };
  /** Opens a candidate's detail at the part a row's button means (阅读报告, 开始执行), else at its report when it has one. */
  const open = (id: string, target?: OpenTarget) => {
    leaveList();
    setDetail(undefined);
    setSelected(id);
    setTab(target ?? defaultTab(candidates.find(item => item.id === id)));
  };
  const toggleSettings = () => { leaveList(); setSettingsOpen(current => !current); };

  // `busy` and the counts are read with care: right after the plugin is reinstalled, this page can still be talking to the previous Host.
  const checking = Boolean(busy.check || data?.busy?.check);
  /** The action running on a candidate: the one this page asked for, else the one the Host reports. */
  const busyOf = (id: string): CandidateAction | undefined => rows[id]?.pending ?? data?.busy?.candidates?.[id];
  /** A candidate's place in the automatic research queue, from 1. */
  const placeOf = (id: string): number | undefined => {
    const place = data?.researchQueue?.indexOf(id) ?? -1;
    return place >= 0 ? place + 1 : undefined;
  };
  const omitted = data?.omittedCandidates ?? 0;
  const back = () => setSelected(undefined);
  const session = listed?.started?.sessionId;
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
            ? <Detail key={selected} candidate={listed} candidates={candidates} record={detail?.id === selected ? detail : undefined}
              settings={data.settings} call={call} tab={tab} changeTab={setTab} busy={busyOf(selected)} queued={placeOf(selected)}
              state={rows[selected] ?? {}} run={action => run(selected, action)} send={fields => run(selected, 'start', fields)}
              showSession={openSession && session ? () => showSession(selected, session) : undefined} back={back} />
            : <section className="oc-detail">
              <Button variant="ghost" size="sm" className="oc-back-button" icon={<Icon name="back" />} onClick={back}>返回列表</Button>
              <p className="oc-muted">这条动态不在列表里了。</p>
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
