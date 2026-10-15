/** Classification of the candidates still waiting for one: after every check, and as the `classify` action. */
import type { Classification } from '../../core/candidate.js';
import { BATCH_SIZE, classifyBatch } from '../classify.js';
import { messageOf, type HostContext } from './context.js';

/** Code points of an unreadable answer quoted in a problem line. */
const QUOTE_LIMIT = 500;
const quote = (raw: string) => Array.from(raw).slice(0, QUOTE_LIMIT).join('').replace(/\s+/g, ' ').trim();

/**
 * Classifies every `new` candidate without a classification, `BATCH_SIZE` per model call, and saves each answer on its candidate (the
 * classification only: the status stays as it is). Batches run one after another and a failed one does not stop the rest. Returns what
 * went wrong, one line per problem: a batch that failed, an answer that held no JSON array (with its first 500 characters), candidates an
 * answer left out. An abort of `signal` (the plugin's lifetime by default) ends the pass, and nothing is saved after it. Passes never
 * overlap: one asked for while another runs starts when that one ends, with the candidates still unclassified then.
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
        problems.push(`${label} failed: ${messageOf(error)}`);
        continue;
      }
      for (const [id, classification] of answers) {
        signal.throwIfAborted();
        await ctx.store.patch(id, current => ({ ...current, classification }));
      }
      if (unparsed.raw !== undefined) problems.push(`${label}: the answer held no JSON array, so its ${batch.length} candidates stay unclassified; it began: ${quote(unparsed.raw)}`);
      else if (answers.size < batch.length) problems.push(`${label}: ${batch.length - answers.size} of ${batch.length} candidates were not in the answer`);
    }
    return problems;
  });
}

/** The `classify` action: one pass. What it classified is saved either way; any problem rejects the call with every problem line. */
export async function classify(ctx: HostContext): Promise<void> {
  const problems = await classifyPending(ctx);
  if (problems.length > 0) throw new Error(`归类没有全部完成：${problems.join('；')}`);
}
