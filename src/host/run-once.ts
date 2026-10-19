/**
 * Run-once mode, for the launchd job (`launchd/opencodex-daily.sh`): a DSH started headless with OPENCODEX_RUN_ONCE=1 checks once as soon
 * as the Host has started, lets the automatic research that check queued run out, writes `last-run.json` and arms no timer. The job ends
 * DSH once that file is replaced, so it is written however the run went: refused by another process's lock, failed as a whole, even when
 * the Host could not start. Only an unload writes nothing: it cuts the run short, and the job takes an end without the file as a failure.
 * The job also passes OPENCODEX_DEADLINE (`deadlineOf`), 10 minutes before it ends DSH: the research takes no candidate whose report could
 * not finish by then, and the notice says how many wait for the next run.
 */
import { join } from 'node:path';
import { LockedError } from '../core/lock.js';
import { readLastCheckLog, type CheckLogEntry } from '../core/run-log.js';
import { writeJsonAtomic } from '../core/store.js';
import { check } from './actions/check.js';
import { messageOf, type HostContext } from './actions/context.js';
import type { ResearchResult } from './actions/research-queue.js';

/** The file the launchd job waits for, in the data directory. */
export const LAST_RUN = 'last-run.json';
/** The prefix of the `errors` line a check gets when its checks.jsonl line could not be written. */
const UNLOGGED = 'log: ';

/**
 * OPENCODEX_DEADLINE as the launchd job sets it: when the run should be over, in whole milliseconds since the epoch. Undefined when it is
 * not set or is anything else, which leaves the run without a deadline, as before the job passed one.
 */
export function deadlineOf(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const ms = Number(value);
  return Number.isSafeInteger(ms) ? ms : undefined;
}

/** What `last-run.json` holds: one run-once start, from its start to its end. */
export interface LastRun {
  /** When the run started and when it ended (ISO). */
  startedAt: string;
  finishedAt: string;
  /** The DSH process that ran it. */
  pid: number;
  /**
   * The line the check appended to checks.jsonl, a failed check's included. Null when no check ran (another process's lock refused it, or
   * the Host could not start) or its line is not found; `notice` says which.
   */
  check: CheckLogEntry | null;
  /** The candidates the automatic research took on, in order, as the queue's `results` has them. */
  reports: ResearchResult[];
  /**
   * Why the run fell short, when it did: the refusal of the check, a check line not found, why the research stopped (too little time left
   * included), why the Host did not start.
   */
  notice?: string;
}

/** What a run-once start needs besides the HostContext: what still works when there is none. */
export interface RunOnceOptions {
  /** The data directory, where last-run.json goes even when the Host could not start. */
  directory: string;
  /** The Host clock, which the HostContext has too; this one is there before the Host has started. */
  now: () => Date;
  /** Starts the research worker on what the check queued, as the Host does after any check, so that its unload waits for the worker. */
  startResearch(ctx: HostContext): void;
}

/**
 * The line the check of this run appended to checks.jsonl, read back: the last line, when this process wrote it as the check ended
 * (`lastCheckAt`). Otherwise null, and `notices` gets why: the line could not be written (the check's `log:` error), the log cannot be read,
 * or another process appended a line since.
 */
async function lineOf(ctx: HostContext, notices: string[]): Promise<CheckLogEntry | null> {
  const { entry, problem } = await readLastCheckLog(ctx.directory);
  if (entry && entry.pid === process.pid && entry.at === ctx.lastCheckAt) return entry;
  const unlogged = ctx.lastCheck?.errors.find(line => line.startsWith(UNLOGGED));
  notices.push(unlogged ? `这次检查没能记进 checks.jsonl：${unlogged.slice(UNLOGGED.length)}` : problem ?? 'checks.jsonl 的最后一行不是这次检查的记录');
  return null;
}

async function save(directory: string, run: LastRun): Promise<LastRun> {
  await writeJsonAtomic(join(directory, LAST_RUN), run);
  return run;
}

/**
 * One run-once start: once `ready` settles, the check (trigger `run-once`), then the research, started and waited for until no worker
 * runs, then last-run.json. Returns what it wrote, or undefined when an unload cut the run short; rejects only when the file cannot be
 * written. It arms nothing: the Host arms no timer in run-once mode.
 */
export async function runOnce(ready: Promise<HostContext>, options: RunOnceOptions): Promise<LastRun | undefined> {
  const startedAt = options.now().toISOString();
  let ctx: HostContext;
  try { ctx = await ready; } catch (error) {
    // The Host did not start (a damaged settings.json): nothing is going to run, so the job need not wait out its time limit to find out.
    return save(options.directory, { startedAt, finishedAt: options.now().toISOString(), pid: process.pid, check: null, reports: [], notice: messageOf(error) });
  }
  if (ctx.signal.aborted) return undefined;
  const notices: string[] = [];
  let line: CheckLogEntry | null = null;
  try {
    await check(ctx, 'run-once');
    line = await lineOf(ctx, notices);
  } catch (error) {
    if (ctx.signal.aborted) return undefined;
    // A refused check never ran; one that failed as a whole appended its line all the same, with the reason as its `check:` error.
    if (error instanceof LockedError) notices.push(error.message); else line = await lineOf(ctx, notices);
  }
  // Started whatever the check came to, as after a timer run; with nothing queued it starts nothing. `idle` alone would not start it.
  options.startResearch(ctx);
  await ctx.research.idle();
  if (ctx.signal.aborted) return undefined;
  if (ctx.research.notice !== undefined) notices.push(ctx.research.notice);
  return save(ctx.directory, {
    startedAt, finishedAt: options.now().toISOString(), pid: process.pid, check: line, reports: [...ctx.research.results],
    ...(notices.length > 0 && { notice: notices.join('；') }),
  });
}
