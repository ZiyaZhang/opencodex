/** Classification of the candidates still waiting for one, and again of older ones classified without a headline: after every check, and as the `classify` action. */
import { setTimeout as sleep } from 'node:timers/promises';
import type { Candidate, Classification, Status } from '../../core/candidate.js';
import { isRecord } from '../../core/check.js';
import { BATCH_SIZE, ClassifyError, classifyBatch } from '../classify.js';
import { errorLine, withDeadline, type HostContext } from './context.js';

/** Failure codes of a model finish that a later try may well not see: the connection, not the request. */
const TRANSIENT = new Set(['TRANSPORT', 'TIMEOUT']);
/** Older candidates one pass classifies again at most, so that a large data directory is redone over several checks rather than in one long pass. */
const REDO_LIMIT = 60;
/** The statuses of the older candidates classified again: an ignored one is not worth a model call, and is picked up once it is restored. */
const REDO_STATUSES: ReadonlySet<Status> = new Set(['new', 'reported', 'started']);

/**
 * What a pass classifies: every `new` candidate without a classification, latest change first as the store lists them, then up to 60
 * (`REDO_LIMIT`) `new`, `reported` or `started` ones whose classification has no `headline`, oldest first. Only a classification made
 * before headlines existed lacks one; when the model gives none it is saved as empty, so a candidate it answered for is not asked about again.
 */
async function pendingOf(ctx: HostContext): Promise<Candidate[]> {
  const all = await ctx.store.list();
  const unclassified = all.filter(candidate => candidate.status === 'new' && !candidate.classification);
  const older = all.filter(candidate => REDO_STATUSES.has(candidate.status) && candidate.classification && candidate.classification.headline === undefined)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return [...unclassified, ...older.slice(0, REDO_LIMIT)];
}

/**
 * `next`, with the merge `previous` had when `next` names none, so that classifying an older candidate again does not lose it. An answer's
 * merge is kept only when it names an earlier candidate of the same batch, which rules out loops within one batch only: a merge kept from
 * an earlier pass can meet a new one pointing back at it (a into b, then b into a). That is accepted, since the page follows one hop.
 */
function withMerge(next: Classification, previous: unknown): Classification {
  return next.mergedInto === undefined && isRecord(previous) && typeof previous.mergedInto === 'string' ? { ...next, mergedInto: previous.mergedInto } : next;
}

/**
 * Whether a batch failed in a way worth another try. The plugin's own `prepareCall().stream()` gets none of DSH's retries, which cover
 * agent-loop requests only, so a dropped connection would otherwise leave a whole batch unclassified until the next check.
 */
function isTransient(error: unknown): boolean {
  if (!(error instanceof ClassifyError) || !error.finish) return false;
  const { finish } = error;
  return (finish.kind === 'error' || finish.kind === 'aborted') && TRANSIENT.has(finish.failure.code);
}

/** A failure as one line of text: the message of the error and of each `cause` under it, each once, then a model finish's HTTP status and request id. */
function describe(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  for (let current: unknown = error; current !== undefined && current !== null && !seen.has(current); current = (current as { cause?: unknown }).cause) {
    seen.add(current);
    const message = current instanceof Error ? current.message : typeof current === 'object' ? (current as { message?: unknown }).message : current;
    const text = typeof message === 'string' ? message.trim() : String(message ?? '');
    if (text && !parts.some(part => part.includes(text))) parts.push(text);
    if (typeof current !== 'object') break;
  }
  if (error instanceof ClassifyError && error.finish && (error.finish.kind === 'error' || error.finish.kind === 'aborted')) {
    const { status, requestId } = error.finish.failure;
    if (status !== undefined) parts.push(`HTTP ${status}`);
    if (requestId !== undefined) parts.push(`request ${requestId}`);
  }
  return parts.join(' ← ');
}

/** Waits `ms`, or rejects with the abort reason as soon as `signal` fires. */
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try { await sleep(ms, undefined, { signal, ref: false }); } catch (error) { signal.throwIfAborted(); throw error; }
}

/**
 * Classifies the candidates `pendingOf` picks, `BATCH_SIZE` per model call, and saves each answer on its candidate (the classification
 * only: the status stays as it is), with the merge it had when the answer names none (`withMerge`). Batches run one after another and a
 * failed one does not stop the rest; a batch whose model call broke off on the connection (`TRANSPORT`, `TIMEOUT`) is tried again after
 * each of `classifyRetryDelaysMs` (5 and 20 seconds). Returns what went wrong, one line of at most 300 characters per problem: a batch that
 * failed (with its cause), an answer that held no JSON array (with its start), candidates an answer left out. Passes never overlap: one
 * asked for while another runs starts when that one ends, and picks its candidates then. An abort of `signal` (the plugin's lifetime by
 * default) ends the pass, the wait for its turn included, and nothing is saved after it.
 */
export function classifyPending(ctx: HostContext, signal: AbortSignal = ctx.signal): Promise<string[]> {
  return ctx.lanes.classify.run(async () => {
    const pending = await pendingOf(ctx);
    const problems: string[] = [];
    const batches = Math.ceil(pending.length / BATCH_SIZE);
    for (let n = 0; n < batches; n++) {
      const batch = pending.slice(n * BATCH_SIZE, (n + 1) * BATCH_SIZE);
      const label = `batch ${n + 1} of ${batches}`;
      const unparsed: { raw?: string } = {};
      let answers: Map<string, Classification> | undefined;
      for (let tries = 1; !answers; tries++) {
        try {
          answers = await classifyBatch(ctx.services.llm, ctx.settings().classifyModel, batch, signal, { onUnparsed: raw => { unparsed.raw = raw; } });
        } catch (error) {
          if (signal.aborted) throw error;
          const delay = ctx.classifyRetryDelaysMs[tries - 1];
          if (delay !== undefined && isTransient(error)) { await pause(delay, signal); continue; }
          problems.push(errorLine(`${label} failed${tries > 1 ? ` (${tries} tries)` : ''}, so its ${batch.length} candidates stay unclassified: ${describe(error)}`));
          break;
        }
      }
      if (!answers) continue;
      for (const [id, classification] of answers) {
        signal.throwIfAborted();
        await ctx.store.patch(id, current => ({ ...current, classification: withMerge(classification, current.classification) }));
      }
      if (unparsed.raw !== undefined) problems.push(errorLine(`${label}: the answer held no JSON array, so its ${batch.length} candidates stay unclassified; it began: ${unparsed.raw}`));
      else if (answers.size < batch.length) problems.push(errorLine(`${label}: ${batch.length - answers.size} of ${batch.length} candidates were not in the answer`));
    }
    return problems;
  }, signal);
}

/**
 * The `classify` action: one pass, with 15 minutes (`timeouts.classify`) to finish. What it classified is saved either way; any problem
 * rejects the call with every problem line.
 */
export async function classify(ctx: HostContext): Promise<void> {
  const minutes = Math.round(ctx.timeouts.classify / 60_000);
  const problems = await withDeadline(ctx, ctx.timeouts.classify, `归类超过 ${minutes} 分钟还没结束，已停止；已归类的都已保存`, signal => classifyPending(ctx, signal));
  if (problems.length > 0) throw new Error(`归类没有全部完成：${problems.join('；')}`);
}
