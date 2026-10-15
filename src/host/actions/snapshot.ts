/** The snapshot every action answers with, and the `candidate` action that returns one record whole. */
import type { Candidate } from '../../core/candidate.js';
import type { OpenCodexResponse } from '../remote.js';
import type { HostContext } from './context.js';

/**
 * A candidate as the list shows it: each evidence entry cut to `kind`, `ref` and `url`. Excerpts make up most of a candidate's size, and with
 * them 2,000 candidates come to about 4.2 MB, past the Remote's 4 MB bound; the detail panel asks for them with `candidate`.
 */
function listed(candidate: Candidate): Candidate {
  return { ...candidate, evidence: candidate.evidence.map(({ kind, ref, url }) => (url === undefined ? { kind, ref } : { kind, ref, url })) };
}

/** The settings, every candidate (listed, latest change first), the checkpoints of state.json, and the last check and the index when there are any. */
export async function snapshot(ctx: HostContext): Promise<OpenCodexResponse> {
  const [candidates, checkpoints] = await Promise.all([ctx.store.list(), ctx.store.checkpoints()]);
  const { index, lastCheck } = ctx;
  return {
    settings: ctx.settings(), candidates: candidates.map(listed), checkpoints,
    ...(lastCheck && { lastCheck }),
    ...(index && { indexSummary: { entries: index.entries.length, commit: index.commit, builtAt: index.builtAt } }),
  };
}

/** The `candidate` action: the whole record, evidence excerpts included. */
export function candidate(ctx: HostContext, id: string): Promise<Candidate> {
  return ctx.store.get(id);
}
