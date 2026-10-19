/**
 * One row of the list: the Codex feature and its tag, what Codex does, where it comes from, and at the top right the buttons its phase
 * allows, the one primary button last. A row whose research is queued or running shows how far it is instead of buttons. The detail's
 * head is built from the same parts (the tag, the third line, the buttons, the messages), so the two never tell a candidate apart.
 */
import { canTransition, type Candidate } from '../core/candidate.js';
import {
  CATEGORY_LABELS, RELEVANCE_LABELS, SOURCE_LABELS, gistOf, headlineOf, labelOf, mergeLabel, phaseOf, referenceOf, researchErrorOf, tagOf, time,
  type Phase,
} from './labels.js';
import { useUi } from './ui-context.js';

/** The actions on one candidate. */
export type CandidateAction = 'report' | 'start' | 'ignore' | 'restore';
/**
 * What this page knows about one candidate's action: the request it has out, or how the last one ended (an error, or a note) and which
 * action that was, so the detail shows a start's outcome beside the button that sent it.
 */
export interface RowState { pending?: CandidateAction; error?: string; note?: string; from?: CandidateAction }
/** The part of the detail a row's button is for: the report, or the start of a creator session. */
export type OpenTarget = 'report' | 'execute';

/** A button's text while its action runs. */
const RUNNING: Record<CandidateAction, string> = { report: '调研中…', start: '发送中…', ignore: '忽略中…', restore: '恢复中…' };

export interface CandidateRowProps {
  candidate: Candidate;
  /** Every listed candidate, to name the one a merged candidate went into. */
  candidates: readonly Candidate[];
  /** The action running on it: the one this page asked for, else the one the Host reports. */
  busy?: CandidateAction;
  /** Its place in the automatic research queue, from 1; absent when it is not queued. */
  queued?: number;
  state: RowState;
  open: (target?: OpenTarget) => void;
  run: (action: Exclude<CandidateAction, 'start'>) => unknown;
  /** Shows its creator session; absent where there is none, or the page cannot switch sessions. */
  showSession?: () => void;
}

/** Where a candidate stands as its row and its detail show it: a running report first, then its place in the queue, then its status. */
export const phaseOfRow = (candidate: Candidate, busy: CandidateAction | undefined, queued: number | undefined): Phase =>
  phaseOf(candidate.status, { queued: queued !== undefined, researching: busy === 'report' });

/** The tag of a phase, after a running dot while a report is being written. */
export function StatusTag({ phase }: { phase: Phase }) {
  const { StateDot, Tag } = useUi();
  const tag = tagOf(phase);
  return <span className="oc-row-status">{phase === 'researching' && <StateDot state="ongoing" size={12} />}<Tag tone={tag.tone}>{tag.label}</Tag></span>;
}

/** The third line: source and reference, category, relevance, the latest of discovery / report / send, a merge, an automatic research error. */
export function RowInfo({ candidate, candidates }: { candidate: Candidate; candidates: readonly Candidate[] }) {
  const { classification, started, report } = candidate;
  const reference = referenceOf(candidate);
  const [event, at] = started ? ['发送', started.at] : report ? ['报告', report.generatedAt] : ['发现', candidate.createdAt];
  // A failure matters while the candidate waits for research; once it has a report, or was ignored, it is history.
  const failure = candidate.status === 'new' ? researchErrorOf(candidate) : undefined;
  return <p className="oc-row-info">
    <span>{labelOf(SOURCE_LABELS, candidate.source)}{reference && ` ${reference}`}</span>
    <span>{classification ? labelOf(CATEGORY_LABELS, classification.category) : '未归类'}</span>
    {classification && <span>相关度{labelOf(RELEVANCE_LABELS, classification.relevance)}</span>}
    <span>{event} <time dateTime={at}>{time(at)}</time></span>
    {classification?.mergedInto && <span>{mergeLabel(classification.mergedInto, candidates)}</span>}
    {failure && <span className="oc-row-failure" title={candidate.research?.lastError}>自动调研失败：{failure}</span>}
  </p>;
}

/** How the last action on a candidate ended, when it did not end plainly: a note (the session did not open), or the error as text. */
export function RowMessages({ state }: { state: RowState }) {
  return <>
    {state.note && <p className="oc-row-note" role="status">{state.note}</p>}
    {state.error && <p className="oc-error" role="alert">{state.error}</p>}
  </>;
}

/** The buttons a phase allows, the primary one last; in the detail `open` switches to the part a button is for. */
export function RowActions({ candidate, phase, busy, queued, open, run, showSession }: Omit<CandidateRowProps, 'candidates' | 'state'> & { phase: Phase }) {
  const { Button } = useUi();
  if (phase === 'queued') return <span className="oc-progress" role="status">排在第 {queued} 个</span>;
  if (phase === 'researching') return <span className="oc-progress" role="status">正在写报告</span>;
  const { status } = candidate;
  // While one request on the candidate is out, every button waits; the one that sent it says so.
  const waiting = busy !== undefined;
  const text = (action: CandidateAction, idle: string) => (busy === action ? RUNNING[action] : idle);
  const ignore = <Button variant="ghost" size="sm" disabled={waiting || !canTransition(status, 'ignored')} onClick={() => run('ignore')}>{text('ignore', '忽略')}</Button>;
  switch (phase) {
    case 'new': return <>
      {ignore}
      <Button variant="primary" size="sm" disabled={waiting || !canTransition(status, 'reported')} onClick={() => run('report')}>开始调研</Button>
    </>;
    case 'reported': return <>
      {ignore}
      <Button variant="outline" size="sm" disabled={waiting} onClick={() => open('execute')}>{text('start', '开始执行')}</Button>
      <Button variant="primary" size="sm" disabled={waiting} onClick={() => open('report')}>阅读报告</Button>
    </>;
    // Another session for it is started from the detail's 执行.
    case 'started': return <Button variant="primary" size="sm" disabled={waiting || !showSession} onClick={showSession}>打开会话</Button>;
    case 'ignored': return <Button variant="primary" size="sm" disabled={waiting || !canTransition(status, 'new')} onClick={() => run('restore')}>{text('restore', '恢复')}</Button>;
    default: return null;
  }
}

export function CandidateRow({ candidate, candidates, busy, queued, state, open, run, showSession }: CandidateRowProps) {
  const phase = phaseOfRow(candidate, busy, queued);
  const gist = gistOf(candidate);
  return <article className="oc-row" aria-busy={busy !== undefined}>
    <div className="oc-row-main">
      <div className="oc-row-head">
        <h3 className="oc-row-title"><button type="button" className="oc-row-link" onClick={() => open()}>{headlineOf(candidate)}</button></h3>
        <StatusTag phase={phase} />
      </div>
      {gist && <p className="oc-row-gist">{gist}</p>}
      <RowInfo candidate={candidate} candidates={candidates} />
      <RowMessages state={state} />
    </div>
    <div className="oc-row-actions">
      <RowActions candidate={candidate} phase={phase} busy={busy} queued={queued} open={open} run={run} showSession={showSession} />
    </div>
  </article>;
}
