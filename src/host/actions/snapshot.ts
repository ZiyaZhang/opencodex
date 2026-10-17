/** The answer every action ends with, and the `candidate` action that returns one record whole. */
import type { Candidate, Evidence } from '../../core/candidate.js';
import { isRecord } from '../../core/check.js';
import { lockHolder, type LockHolder } from '../../core/lock.js';
import { readLastCheckLog } from '../../core/run-log.js';
import type { Checkpoints } from '../../core/store.js';
import { clip } from '../changelog-parser.js';
import { MAX_PAYLOAD, type OpenCodexResponse } from '../remote.js';
import { messageOf, type HostContext, type Task } from './context.js';

/** Candidates the list carries at least: every reported and started one, then the newest new ones, then the newest ignored ones. */
const LIST_LIMIT = 800;
/** Code points of a listed summary and of a listed classification rationale. */
const SUMMARY_LIMIT = 300, RATIONALE_LIMIT = 120;

/**
 * What an action adds to the answer: the session it opened, the report it read, the record, model list or start brief it returned, and
 * what that lacks.
 */
export type ActionResult = Pick<OpenCodexResponse, 'startedSessionId' | 'report' | 'candidate' | 'models' | 'brief' | 'notice'>;

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

/**
 * The candidates the list carries, in this order: every `reported` and `started` one, however many, then the newest others up to 800 in
 * all, `new` before `ignored`; within each group latest change first. Ignoring a batch can then never push an active candidate out.
 */
function selected(all: Candidate[]): Candidate[] {
  const active = all.filter(candidate => candidate.status === 'reported' || candidate.status === 'started');
  const rest = [...all.filter(candidate => candidate.status === 'new'), ...all.filter(candidate => candidate.status === 'ignored')];
  return [...active, ...rest.slice(0, Math.max(0, LIST_LIMIT - active.length))];
}

function busyOf(ctx: HostContext): OpenCodexResponse['busy'] {
  const candidates: Record<string, Exclude<Task, 'status'>> = {};
  for (const [id, task] of ctx.busy) if (task !== 'status') candidates[id] = task;
  return { check: ctx.running.has('check'), candidates };
}

/**
 * The answer to an action that has finished: the snapshot with `result` laid over it. Building the snapshot never fails the action. When
 * the list, the checkpoints, the check log or the lock file cannot be read, the answer goes without them and `notice` says so; a damaged
 * record is listed without what is damaged and named in `notice`; an answer that would pass the Remote's 4 MB bound goes without the list.
 * The action's own `notice` comes first in `notice`, the snapshot's after it, joined by `；`.
 * The list holds the candidates `selected` picks, each as `listed` shows it; `totalCandidates` and `omittedCandidates` say how many there
 * are and how many it leaves out.
 */
export async function respond(ctx: HostContext, result: ActionResult = {}): Promise<OpenCodexResponse> {
  const { notice, ...fields } = result;
  const notices: string[] = notice ? [notice] : [];
  let listing: Pick<OpenCodexResponse, 'candidates' | 'totalCandidates' | 'omittedCandidates'> = { candidates: [], totalCandidates: 0, omittedCandidates: 0 };
  try {
    const all = await ctx.store.list();
    const damaged = new Set<string>();
    const candidates = selected(all).map(candidate => listed(candidate, damaged));
    listing = { candidates, totalCandidates: all.length, omittedCandidates: all.length - candidates.length };
    if (damaged.size > 0) notices.push(`这些候选的记录有损坏，列表里只显示能读的部分：${[...damaged].join('、')}`);
  } catch (error) {
    notices.push(`候选列表没能读出来：${messageOf(error)}`);
  }
  let checkpoints: Checkpoints = {};
  try { checkpoints = await ctx.store.checkpoints(); } catch (error) { notices.push(`state.json 没能读出来：${messageOf(error)}`); }
  const log = await readLastCheckLog(ctx.directory);
  if (log.problem) notices.push(log.problem);
  let lock: LockHolder | undefined;
  try { lock = await lockHolder(ctx.directory, { now: ctx.now }); } catch (error) { notices.push(`lock.json 没能读出来：${messageOf(error)}`); }
  const { index, lastCheck, lastCheckAt } = ctx;
  const response: OpenCodexResponse = {
    settings: ctx.settings(), ...listing, checkpoints, busy: busyOf(ctx),
    ...(lastCheck && { lastCheck }), ...(lastCheckAt && { lastCheckAt }), ...(log.entry && { lastCheckLog: log.entry }),
    hostPid: process.pid, ...(lock && { lock }),
    ...(index && { indexSummary: { entries: index.entries.length, commit: index.commit, builtAt: index.builtAt } }),
    ...fields,
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
