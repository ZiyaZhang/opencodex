/** The answer every action ends with, and the `candidate` action that returns one record whole. */
import type { Candidate, Evidence } from '../../core/candidate.js';
import type { Checkpoints } from '../../core/store.js';
import { clip } from '../changelog-parser.js';
import { MAX_PAYLOAD, type OpenCodexResponse } from '../remote.js';
import { messageOf, type HostContext, type Task } from './context.js';

/** Candidates the list carries: the newest by `updatedAt`, ignored ones included. */
const LIST_LIMIT = 800;
/** Code points of a listed summary and of a listed classification rationale. */
const SUMMARY_LIMIT = 300, RATIONALE_LIMIT = 120;

/** What an action adds to the answer: the session it opened, the report it read, the record it returned. */
export type ActionResult = Pick<OpenCodexResponse, 'startedSessionId' | 'report' | 'candidate'>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const listedEvidence = (entry: Evidence): Evidence => (entry.url === undefined ? { kind: entry.kind, ref: entry.ref } : { kind: entry.kind, ref: entry.ref, url: entry.url });

/**
 * A candidate as the list shows it: each evidence entry cut to `kind`, `ref` and `url`, the summary to 300 code points, the classification
 * rationale to 120. A damaged record (evidence that is no list, an entry or a field of the wrong type) is still listed, without what is
 * damaged, and `damaged` gets its id.
 */
function listed(candidate: Candidate, damaged: Set<string>): Candidate {
  const raw = candidate as unknown as Record<string, unknown>;
  const evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  const whole = Array.isArray(raw.evidence) && evidence.every(isRecord) && typeof raw.summary === 'string';
  if (!whole) damaged.add(candidate.id);
  const { classification } = candidate;
  return {
    ...candidate,
    summary: typeof raw.summary === 'string' ? clip(raw.summary, SUMMARY_LIMIT) : '',
    evidence: (evidence.filter(isRecord) as unknown as Evidence[]).map(listedEvidence),
    ...(isRecord(classification) && typeof classification.rationale === 'string' && { classification: { ...classification, rationale: clip(classification.rationale, RATIONALE_LIMIT) } }),
  };
}

function busyOf(ctx: HostContext): OpenCodexResponse['busy'] {
  const candidates: Record<string, Exclude<Task, 'status'>> = {};
  for (const [id, task] of ctx.busy) if (task !== 'status') candidates[id] = task;
  return { check: ctx.running.has('check'), candidates };
}

/**
 * The answer to an action that has finished: the snapshot with `result` laid over it. Building the snapshot never fails the action. When
 * the list or the checkpoints cannot be read, the answer goes without them and `notice` says so; a damaged record is listed without what is
 * damaged and named in `notice`; an answer that would pass the Remote's 4 MB bound goes without the list. The list holds the 800 newest
 * candidates (see `listed` for what each carries); `totalCandidates` and `omittedCandidates` say how many there are and how many it leaves out.
 */
export async function respond(ctx: HostContext, result: ActionResult = {}): Promise<OpenCodexResponse> {
  const notices: string[] = [];
  let listing: Pick<OpenCodexResponse, 'candidates' | 'totalCandidates' | 'omittedCandidates'> = { candidates: [], totalCandidates: 0, omittedCandidates: 0 };
  try {
    const all = await ctx.store.list();
    const damaged = new Set<string>();
    const candidates = all.slice(0, LIST_LIMIT).map(candidate => listed(candidate, damaged));
    listing = { candidates, totalCandidates: all.length, omittedCandidates: all.length - candidates.length };
    if (damaged.size > 0) notices.push(`这些候选的记录有损坏，列表里只显示能读的部分：${[...damaged].join('、')}`);
  } catch (error) {
    notices.push(`候选列表没能读出来：${messageOf(error)}`);
  }
  let checkpoints: Checkpoints = {};
  try { checkpoints = await ctx.store.checkpoints(); } catch (error) { notices.push(`state.json 没能读出来：${messageOf(error)}`); }
  const { index, lastCheck, lastCheckAt } = ctx;
  const response: OpenCodexResponse = {
    settings: ctx.settings(), ...listing, checkpoints, busy: busyOf(ctx),
    ...(lastCheck && { lastCheck }), ...(lastCheckAt && { lastCheckAt }),
    ...(index && { indexSummary: { entries: index.entries.length, commit: index.commit, builtAt: index.builtAt } }),
    ...result,
    ...(notices.length > 0 && { notice: notices.join('；') }),
  };
  if (JSON.stringify(response).length <= MAX_PAYLOAD) return response;
  notices.push(`候选列表超过 4 MB，这次没有带上`);
  return { ...response, candidates: [], omittedCandidates: response.totalCandidates, notice: notices.join('；') };
}

/** The `candidate` action: the whole record, evidence excerpts included. */
export function candidate(ctx: HostContext, id: string): Promise<Candidate> {
  return ctx.store.get(id);
}
