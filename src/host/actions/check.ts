/** The `check` action, which the timer runs as well. */
import { loadIndex, runCheck, type CheckResult } from '../collector.js';
import { classifyPending } from './classify.js';
import { joined, type HostContext } from './context.js';

/** How long one check may run, classification included, unless the Host sets another limit (tests). */
const CHECK_TIMEOUT_MS = 30 * 60_000;

/**
 * One check: the sources through `runCheck`, then the classification of the new candidates, whose problems join the check's `errors` as
 * `classify:` lines. A check that rebuilt the index reloads it. The result becomes `lastCheck`. A check asked for while one runs joins it,
 * so the run is under the plugin's lifetime signal and a deadline, never one request's signal: a run that stalls gives up at the deadline
 * instead of holding every later check.
 */
export function check(ctx: HostContext): Promise<CheckResult> {
  return joined(ctx, 'check', async () => {
    const limit = ctx.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
    const deadline = AbortSignal.timeout(limit);
    const signal = AbortSignal.any([ctx.signal, deadline]);
    try {
      const result = await runCheck({
        directory: ctx.directory, store: ctx.store, settings: ctx.settings(), github: ctx.github(), signal, fetcher: ctx.fetcher, now: ctx.now(),
      });
      if (result.index) ctx.index = await loadIndex(ctx.directory) ?? ctx.index;
      const problems = await classifyPending(ctx, signal);
      const checked: CheckResult = { ...result, errors: [...result.errors, ...problems.map(problem => `classify: ${problem}`)] };
      ctx.lastCheck = checked;
      return checked;
    } catch (error) {
      if (deadline.aborted && !ctx.signal.aborted) throw new Error(`检查超过 ${Math.round(limit / 60_000)} 分钟还没结束，已停止`, { cause: error });
      throw error;
    }
  });
}
