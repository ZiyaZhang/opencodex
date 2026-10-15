/** Classification of the candidates still waiting for one: after every check, and as the `classify` action. */
import type { Classification } from '../../core/candidate.js';
import { BATCH_SIZE, classifyBatch } from '../classify.js';
import { errorLine, messageOf, withDeadline, type HostContext } from './context.js';

/**
 * Classifies every `new` candidate without a classification, `BATCH_SIZE` per model call, and saves each answer on its candidate (the
 * classification only: the status stays as it is). Batches run one after another and a failed one does not stop the rest. Returns what
 * went wrong, one line of at most 300 characters per problem: a batch that failed, an answer that held no JSON array (with its start),
 * candidates an answer left out. Passes never overlap: one asked for while another runs starts when that one ends, with the candidates
 * still unclassified then. An abort of `signal` (the plugin's lifetime by default) ends the pass, the wait for its turn included, and
 * nothing is saved after it.
 */
export function classifyPending(ctx: HostContext, signal: AbortSignal = ctx.signal): Promise<string[]> {
  return ctx.lanes.classify.run(async () => {
    const pending = (await ctx.store.list({ status: 'new' })).filter(candidate => !candidate.classification);
    const problems: string[] = [];
    const batches = Math.ceil(pending.length / BATCH_SIZE);
    for (let n = 0; n < batches; n++) {
      const batch = pending.slice(n * BATCH_SIZE, (n + 1) * BATCH_SIZE);
      const label = `batch ${n + 1} of ${batches}`;
      const unparsed: { raw?: string } = {};
      let answers: Map<string, Classification>;
      try {
        answers = await classifyBatch(ctx.services.llm, ctx.settings().classifyModel, batch, signal, { onUnparsed: raw => { unparsed.raw = raw; } });
      } catch (error) {
        if (signal.aborted) throw error;
        problems.push(errorLine(`${label} failed, so its ${batch.length} candidates stay unclassified: ${messageOf(error)}`));
        continue;
      }
      for (const [id, classification] of answers) {
        signal.throwIfAborted();
        await ctx.store.patch(id, current => ({ ...current, classification }));
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
