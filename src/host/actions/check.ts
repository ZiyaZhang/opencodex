/** The `check` action, which the timer runs as well. */
import { refreshIndex, runCheck, type CheckResult } from '../collector.js';
import { classifyPending } from './classify.js';
import { errorLine, joined, messageOf, withDeadline, type HostContext } from './context.js';

/** A check that failed as a whole: nothing collected, and one `check:` line that says why. */
function failedCheck(error: unknown): CheckResult {
  return {
    releases: { added: 0, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false },
    files: { added: 0, merged: 0, gap: false, unread: { overBudget: 0, rateLimited: 0, failed: 0 } },
    desktop: { version: '', changed: false, added: 0, keys: 0 }, rss: 0, errors: [errorLine(`check: ${messageOf(error)}`)],
  };
}

/**
 * The check's index refresh, done here rather than inside `runCheck`: it waits its turn in the index lane like every other build and reads
 * the mirror path when the turn comes, so a check that started before the path changed cannot write the old mirror's index over the new
 * one. Without `force`, so the collector's guards against a broken mirror apply. A failure becomes an `index:` line.
 */
async function refreshIndexOf(ctx: HostContext, signal: AbortSignal): Promise<{ index?: CheckResult['index']; errors: string[] }> {
  try {
    const index = await ctx.lanes.index.run(async () => {
      const mirror = ctx.settings().dshMirrorPath;
      return mirror ? refreshIndex(ctx.directory, ctx.store, mirror) : undefined;
    }, signal);
    signal.throwIfAborted(); // the build takes no signal
    if (!index) return { errors: [] };
    ctx.index = index;
    return { index: { entries: index.entries.length, commit: index.commit, builtAt: index.builtAt }, errors: [] };
  } catch (error) {
    signal.throwIfAborted();
    return { errors: [errorLine(`index: ${messageOf(error)}`)] };
  }
}

/**
 * One check: the sources through `runCheck`, the index refresh, then the classification of the new candidates, whose problems join the
 * check's `errors` as `classify:` lines. The result becomes `lastCheck`, and its end `lastCheckAt`; a check that fails as a whole is
 * recorded too, with a `check:` line, so a failed timer run shows on the page. A check asked for while one runs joins it, so the run is under
 * the plugin's lifetime signal and a deadline (`timeouts.check`), never one request's signal: a run that stalls, even waiting for its turn
 * at the classification, gives up at the deadline instead of holding every later check.
 */
export function check(ctx: HostContext): Promise<CheckResult> {
  return joined(ctx, 'check', async () => {
    const minutes = Math.round(ctx.timeouts.check / 60_000);
    try {
      const checked = await withDeadline(ctx, ctx.timeouts.check, `检查超过 ${minutes} 分钟还没结束，已停止`, async signal => {
        // An empty mirror path keeps runCheck's own index step out: refreshIndexOf does it in the lane.
        const result = await runCheck({
          directory: ctx.directory, store: ctx.store, settings: { ...ctx.settings(), dshMirrorPath: '' }, github: ctx.github(), signal, fetcher: ctx.fetcher, now: ctx.now(),
        });
        const { index, errors } = await refreshIndexOf(ctx, signal);
        const problems = await classifyPending(ctx, signal);
        return { ...result, ...(index && { index }), errors: [...result.errors, ...errors, ...problems.map(problem => errorLine(`classify: ${problem}`))] };
      });
      ctx.lastCheck = checked;
      return checked;
    } catch (error) {
      if (!ctx.signal.aborted) ctx.lastCheck = failedCheck(error);
      throw error;
    } finally {
      if (!ctx.signal.aborted) ctx.lastCheckAt = ctx.now().toISOString();
    }
  });
}
