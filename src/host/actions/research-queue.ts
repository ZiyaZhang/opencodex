/**
 * Automatic research: a check and the `classify` action queue the candidates worth a report (`enqueueResearch`), and once that action has
 * ended the Host starts a worker (`ResearchQueue.start`) that writes their reports one at a time through the `report` action, so the daily
 * limit, the evidence pack and the one task per candidate are the manual report's own. The worker holds the data directory's research lock,
 * and runs under the plugin's lifetime only: no request waits for it, and each report bounds its own GitHub part.
 */
import type { Candidate } from '../../core/candidate.js';
import { isRecord } from '../../core/check.js';
import { LockedError, type LockResult } from '../../core/lock.js';
import type { AutoResearch, Settings } from '../../core/settings.js';
import { errorLine, messageOf, type HostContext } from './context.js';
import { DailyLimitError, report } from './report.js';

/** One candidate a run took on: researched, or why not, as one line of at most 300 code points. */
export interface ResearchResult { id: string; ok: boolean; error?: string }
/** Writes the report of one candidate: the `report` action, unless a test passes its own. */
export type Researcher = (ctx: HostContext, id: string) => Promise<void>;

/** The relevances each setting queues. */
const QUEUED: Record<AutoResearch, ReadonlySet<unknown>> = { off: new Set(), high: new Set(['high']), medium: new Set(['high', 'medium']) };
/** Thrown inside the patch that marks a try, so that a candidate no longer to take is left as it is. */
const SKIP = Symbol('left alone');

/** The UTC day of an ISO time, as the daily report counter has it. */
const dayOf = (iso: string) => iso.slice(0, 10);

/**
 * Whether automatic research takes `candidate` on `today` (a UTC day): a mirror path is set, the candidate is `new`, its classification
 * has a relevance the setting queues and merges it into no other candidate, and no automatic try was made on it today. The record comes
 * from disk, so a field of the wrong shape rules it out instead of throwing.
 */
function eligible(candidate: Candidate, settings: Readonly<Settings>, today: string): boolean {
  const { classification, research } = candidate as unknown as Record<string, unknown>;
  return settings.dshMirrorPath !== '' && candidate.status === 'new'
    && isRecord(classification) && QUEUED[settings.autoResearch].has(classification.relevance) && !classification.mergedInto
    && !(isRecord(research) && typeof research.autoAttemptedAt === 'string' && dayOf(research.autoAttemptedAt) === today);
}

/** High relevance before medium, then the newest first. */
function byPriority(a: Candidate, b: Candidate): number {
  const rank = (candidate: Candidate) => (candidate.classification?.relevance === 'high' ? 0 : 1);
  return rank(a) - rank(b) || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
}

/**
 * The candidates waiting for automatic research and the one worker that researches them. The queue lives in this process only: a restart
 * forgets it, and the next check queues again what is still worth it. Waiting and running are not written on the candidate; a try is
 * (`Candidate.research`).
 */
export class ResearchQueue {
  private waiting: string[] = [];
  /** The candidate the worker has taken from the queue and not finished with. */
  private current: string | undefined;
  private running = false;
  private worker: Promise<void> = Promise.resolve();
  private stoppedBecause: string | undefined;
  private tried: ResearchResult[] = [];

  constructor(private readonly researcher: Researcher = report) {}

  /** The ids waiting, in the order the worker takes them. */
  get queued(): string[] { return [...this.waiting]; }
  /**
   * Why the last run stopped short: the data directory's lock was held by another process, taken over by one, or could not be taken, or
   * the day's reports ran out. A run clears it as it starts.
   */
  get notice(): string | undefined { return this.stoppedBecause; }
  /** The candidates the current run, or the last one, took on, in order; one it left alone is not among them. A run clears them as it starts. */
  get results(): readonly ResearchResult[] { return this.tried; }

  /** Resolves once no worker runs: at once when none does, even with ids queued that no run has taken yet (`start` takes them). */
  async idle(): Promise<void> {
    while (this.running) await this.worker;
  }

  /** Makes `ids` the queue, in their order, leaving out the one the worker is on. */
  put(ids: readonly string[]): void {
    this.waiting = ids.filter(id => id !== this.current);
  }

  /**
   * Starts the worker when none runs and ids wait, and returns it, so that the Host waits for it on unload; undefined when one runs
   * already (it takes what is queued meanwhile), when nothing waits, and once the plugin is unloading. The worker never rejects.
   */
  start(ctx: HostContext): Promise<void> | undefined {
    if (this.running || this.waiting.length === 0 || ctx.signal.aborted) return undefined;
    this.running = true;
    this.stoppedBecause = undefined;
    this.tried = [];
    this.worker = this.drain(ctx);
    return this.worker;
  }

  /**
   * Holds of the research lock, one after another, until nothing waits. Ids queued while a hold is let go get one more, so none is left
   * waiting with no worker; `running` turns false in the step that finds the queue empty, so a `start` after that starts a new run.
   */
  private async drain(ctx: HostContext): Promise<void> {
    try {
      while (this.waiting.length > 0 && !ctx.signal.aborted) await this.round(ctx);
    } finally {
      if (ctx.signal.aborted) this.waiting = [];
      this.running = false;
    }
  }

  /** One hold of the research lock: the queue, one candidate at a time, until it is empty or the run has to stop. */
  private async round(ctx: HostContext): Promise<void> {
    let lock: LockResult;
    try { lock = await ctx.lock('research'); } catch (error) {
      this.halt(ctx.signal.aborted ? undefined : `自动调研没能拿到数据目录锁：${messageOf(error)}`);
      return;
    }
    // Another live process is checking or researching in this data directory; the next check here queues these candidates again.
    if (!lock.held) { this.halt(new LockedError(lock.by).message); return; }
    try {
      while (this.waiting.length > 0 && !ctx.signal.aborted) {
        // The lock went over to another process while this one stood still: what is left is that process's to do now.
        if (lock.signal.aborted) { this.halt(messageOf(lock.signal.reason)); return; }
        const id = this.waiting.shift()!;
        this.current = id;
        try { if (!await this.one(ctx, id)) return; } finally { this.current = undefined; }
      }
    } finally {
      await lock.release();
    }
  }

  /**
   * Researches candidate `id`, unless by now it is no longer one to take or has a task running: such a candidate is left exactly as it is.
   * The try is marked on the candidate first, the error of an earlier one dropped; a failure is recorded on it and the run goes on. Returns
   * false when the run has to stop: the day's reports ran out (the queue is cleared and `notice` counts what waits), or the plugin unloads.
   */
  private async one(ctx: HostContext, id: string): Promise<boolean> {
    const at = ctx.now().toISOString();
    try {
      // The second look and the mark are one patch, so nothing that changes the candidate comes between them.
      await ctx.store.patch(id, current => {
        if (ctx.busy.has(id) || !eligible(current, ctx.settings(), dayOf(at))) throw SKIP;
        return { ...current, research: { autoAttemptedAt: at } };
      });
    } catch (error) {
      if (error === SKIP) return true;
      this.tried.push({ id, ok: false, error: errorLine(messageOf(error)) });
      return !ctx.signal.aborted;
    }
    // A task asked for while the mark was written goes ahead; this run leaves the candidate to it.
    if (ctx.busy.has(id)) return true;
    try {
      await this.researcher(ctx, id);
      this.tried.push({ id, ok: true });
      return true;
    } catch (error) {
      const line = errorLine(messageOf(error));
      this.tried.push({ id, ok: false, error: line });
      if (error instanceof DailyLimitError) {
        // The candidate that met the limit waits too: its try of today never ran.
        this.halt(`今天的报告额度用完，还有 ${this.waiting.length + 1} 条明天继续`);
        return false;
      }
      // Cut short by an unload, which is no failure of the candidate.
      if (ctx.signal.aborted) return false;
      try {
        await ctx.store.patch(id, current => ({ ...current, research: { autoAttemptedAt: at, lastError: line } }));
      } catch (recording) {
        this.tried[this.tried.length - 1] = { id, ok: false, error: errorLine(`${line}；没能记到这条动态上：${messageOf(recording)}`) };
      }
      return true;
    }
  }

  /** Ends the run: the queue is cleared and, when one is given, `notice` says why. */
  private halt(notice?: string): void {
    this.waiting = [];
    if (notice !== undefined) this.stoppedBecause = notice;
  }
}

/**
 * Queues the candidates automatic research takes today (`eligible`), high relevance first and then the newest. The queue becomes exactly
 * those, so one already waiting is not queued twice and one no longer worth it leaves; the candidate the worker is on, and any with a task
 * running, are left out. It only queues: the Host starts the worker once the check or the classification has ended.
 */
export async function enqueueResearch(ctx: HostContext): Promise<void> {
  const all = await ctx.store.list();
  const settings = ctx.settings();
  const today = dayOf(ctx.now().toISOString());
  ctx.research.put(all.filter(candidate => eligible(candidate, settings, today) && !ctx.busy.has(candidate.id)).sort(byPriority).map(candidate => candidate.id));
}
