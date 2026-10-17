/** The `check` action, which the timer runs as well. */
import { LockedError, type LockResult } from '../../core/lock.js';
import { appendCheckLog, type CheckTrigger } from '../../core/run-log.js';
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
 * The end of a check that ran: its result becomes `lastCheck` and its end `lastCheckAt`, and both go to checks.jsonl as one line. A line
 * that cannot be written does not cost the check its result: the problem becomes a `log:` line of it instead.
 */
async function recordCheck(ctx: HostContext, result: CheckResult, startedAt: string, trigger: CheckTrigger): Promise<void> {
  const at = ctx.now().toISOString();
  const range = result.releases.window ?? result.files.window;
  try {
    await appendCheckLog(ctx.directory, {
      at, startedAt, trigger, pid: process.pid, window: range ? { fromTag: range.from, toTag: range.to } : null,
      added: { releases: result.releases.added, files: result.files.added, desktop: result.desktop.added, rss: result.rss },
      errors: result.errors, ...(result.index && { index: { entries: result.index.entries, commit: result.index.commit } }),
    });
  } catch (error) {
    result.errors.push(errorLine(`log: ${messageOf(error)}`));
  }
  ctx.lastCheck = result;
  ctx.lastCheckAt = at;
}

/**
 * One check: the sources through `runCheck`, the index refresh, then the classification of the new candidates, whose problems join the
 * check's `errors` as `classify:` lines. The result is recorded (`recordCheck`); a check that fails as a whole is recorded too, with a `check:`
 * line, so a failed timer run shows on the page. A check asked for while one runs joins it, so the run is under the plugin's lifetime signal
 * and a deadline (`timeouts.check`), never one request's signal: a run that stalls, even waiting for its turn at the classification, gives
 * up at the deadline instead of holding every later check. The run holds the data-directory lock, taken inside the joined run so that a
 * second request of this process joins rather than meets it; while another live process holds it, the check is refused with a LockedError
 * and records nothing. A check whose lock another process takes over stops, and is recorded as failed.
 */
export function check(ctx: HostContext, trigger: CheckTrigger): Promise<CheckResult> {
  return joined(ctx, 'check', async () => {
    const startedAt = ctx.now().toISOString();
    const minutes = Math.round(ctx.timeouts.check / 60_000);
    let lock: LockResult | undefined;
    try {
      lock = await ctx.lock('check');
      if (!lock.held) throw new LockedError(lock.by);
      const checked = await withDeadline(ctx, ctx.timeouts.check, `检查超过 ${minutes} 分钟还没结束，已停止`, async signal => {
        // An empty mirror path keeps runCheck's own index step out: refreshIndexOf does it in the lane.
        const result = await runCheck({
          directory: ctx.directory, store: ctx.store, settings: { ...ctx.settings(), dshMirrorPath: '' }, github: ctx.github(), signal, fetcher: ctx.fetcher, now: ctx.now(),
        });
        const { index, errors } = await refreshIndexOf(ctx, signal);
        const problems = await classifyPending(ctx, signal);
        return { ...result, ...(index && { index }), errors: [...result.errors, ...errors, ...problems.map(problem => errorLine(`classify: ${problem}`))] };
      }, lock.signal);
      await recordCheck(ctx, checked, startedAt, trigger);
      return checked;
    } catch (error) {
      // A refused check never ran, and an unload leaves no result to keep.
      if (!(error instanceof LockedError) && !ctx.signal.aborted) await recordCheck(ctx, failedCheck(error), startedAt, trigger);
      throw error;
    } finally {
      if (lock?.held) await lock.release();
    }
  });
}
