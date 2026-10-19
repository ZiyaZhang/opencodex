/**
 * The detail of one candidate: the head of its list row at page scale (the feature, its tag, the third line, and at the top right the
 * buttons its phase allows), then 概览 / 报告 / 执行. The page keeps which part is open and reads the whole record and the report's text;
 * 执行 asks the Host itself for what only it needs (the brief, the model list), when it opens.
 */
import { useId } from 'react';
import type { Candidate } from '../core/candidate.js';
import type { Settings } from '../core/settings.js';
import { RowActions, RowInfo, RowMessages, StatusTag, phaseOfRow, type CandidateAction, type RowState } from './CandidateRow.js';
import type { Call, ReportText } from './contract.js';
import { ExecutePane, type StartFields } from './ExecutePane.js';
import { Icon } from './icons.js';
import { headlineOf } from './labels.js';
import { OverviewPane } from './OverviewPane.js';
import { ReportPane } from './ReportPane.js';
import { useUi } from './ui-context.js';

/** The parts of the detail. A row's 阅读报告 and 开始执行 open the detail at the part of the same name (`OpenTarget`). */
export type DetailTab = 'overview' | 'report' | 'execute';
const TAB_LABELS: Record<DetailTab, string> = { overview: '概览', report: '报告', execute: '执行' };

/** The part a detail opens at when nothing asks for one: the report where there is one to read. */
export const defaultTab = (candidate: Candidate | undefined): DetailTab => (candidate?.report ? 'report' : 'overview');

/** What the page read for the open candidate: its whole record (evidence excerpts) and its report's text, or why either failed. */
export interface DetailRecord { id: string; loading: boolean; candidate?: Candidate; candidateError?: string; report?: ReportText; reportError?: string }

export interface DetailProps {
  /** The candidate as listed. */
  candidate: Candidate;
  /** Every listed candidate, to name the one a merged candidate went into. */
  candidates: readonly Candidate[];
  /** The whole record and the report, once read. */
  record?: DetailRecord;
  settings: Settings;
  call: Call;
  tab: DetailTab;
  changeTab: (tab: DetailTab) => void;
  /** The action running on it, its place in the research queue, and how its last action ended, as for its row. */
  busy?: CandidateAction;
  queued?: number;
  state: RowState;
  run: (action: Exclude<CandidateAction, 'start'>) => unknown;
  send: (fields: StartFields) => unknown;
  /** Shows its creator session; absent where there is none, or the page cannot switch sessions. */
  showSession?: () => void;
  back: () => void;
}

export function Detail({ candidate, candidates, record, settings, call, tab, changeTab, busy, queued, state, run, send, showSession, back }: DetailProps) {
  const { Button, SegmentedTabs } = useUi();
  const ids = useId();
  const phase = phaseOfRow(candidate, busy, queued);
  const tabId = (value: DetailTab) => `${ids}-tab-${value}`, panelId = (value: DetailTab) => `${ids}-panel-${value}`;
  const item = (value: DetailTab) => ({ value, label: TAB_LABELS[value], id: tabId(value), panelId: panelId(value) });
  // A start's outcome shows in 执行, beside the button that sent it; any other action's under the head, where its buttons are.
  const fromStart = state.from === 'start';
  return <section className="oc-detail" aria-labelledby={`${ids}-title`}>
    <Button variant="ghost" size="sm" className="oc-back-button" icon={<Icon name="back" />} onClick={back}>返回列表</Button>
    <header className="oc-detail-head">
      <div className="oc-detail-main">
        <div className="oc-detail-title">
          <h2 id={`${ids}-title`}>{headlineOf(candidate)}</h2>
          <StatusTag phase={phase} />
        </div>
        <RowInfo candidate={candidate} candidates={candidates} />
        {!fromStart && <RowMessages state={state} />}
      </div>
      <div className="oc-row-actions">
        <RowActions candidate={candidate} phase={phase} busy={busy} queued={queued} open={target => changeTab(target ?? 'overview')} run={run}
          showSession={showSession} />
      </div>
    </header>
    <SegmentedTabs className="oc-detail-tabs" label="详情" value={tab} onChange={changeTab} items={[item('overview'), item('report'), item('execute')]} />
    <div className="oc-pane" role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)}>
      {tab === 'overview'
        ? <OverviewPane candidate={candidate} whole={record?.candidate} error={record?.candidateError} candidates={candidates} />
        : tab === 'report'
          ? <ReportPane candidate={candidate} report={record?.report} error={record?.reportError} loading={record?.loading ?? true} busy={busy} queued={queued} run={run} />
          : <ExecutePane candidate={candidate} settings={settings} call={call} busy={busy} state={fromStart ? state : {}} send={send}
            showSession={showSession} />}
    </div>
  </section>;
}
