/** The candidates of one view, in version groups: latest discovery first, each group titled with its version, discovery date and size. */
import { useId } from 'react';
import type { Candidate } from '../core/candidate.js';
import { CandidateRow, type CandidateAction, type OpenTarget, type RowState } from './CandidateRow.js';
import { groupCandidates, monthDay } from './labels.js';

export interface CandidateListProps {
  /** The candidates of the view. */
  shown: readonly Candidate[];
  /** Every listed candidate, to name the one a merged candidate went into. */
  candidates: readonly Candidate[];
  /** The automatic research queue, in order. */
  queue: readonly string[];
  busyOf: (id: string) => CandidateAction | undefined;
  rows: Readonly<Record<string, RowState>>;
  open: (id: string, target?: OpenTarget) => void;
  run: (id: string, action: Exclude<CandidateAction, 'start'>) => unknown;
  /** Shows a candidate's creator session; absent where the page cannot switch sessions. */
  showSession?: (id: string, sessionId: string) => void;
  /** What the list says when the view is empty. */
  empty: { title: string; hint: string };
}

export function CandidateList({ shown, candidates, queue, busyOf, rows, open, run, showSession, empty }: CandidateListProps) {
  const ids = useId();
  const groups = groupCandidates(shown);
  if (groups.length === 0) return <div className="oc-empty"><h2>{empty.title}</h2><p className="oc-muted">{empty.hint}</p></div>;
  return <div className="oc-groups">{groups.map((group, index) => <section key={group.key} className="oc-group" aria-labelledby={`${ids}-${index}`}>
    <header className="oc-group-head">
      <h2 id={`${ids}-${index}`} className="oc-group-title">{group.title}</h2>
      <span className="oc-group-meta">{monthDay(group.latest)} 发现 · {group.items.length.toLocaleString('zh-CN')} 条</span>
    </header>
    {group.items.map(item => {
      const place = queue.indexOf(item.id);
      const session = item.started?.sessionId;
      return <CandidateRow key={item.id} candidate={item} candidates={candidates} busy={busyOf(item.id)} queued={place >= 0 ? place + 1 : undefined}
        state={rows[item.id] ?? {}} open={target => open(item.id, target)} run={action => run(item.id, action)}
        showSession={showSession && session ? () => showSession(item.id, session) : undefined} />;
    })}
  </section>)}</div>;
}
