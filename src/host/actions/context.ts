/** The state the Host's actions share, and the helpers they all use. */
import type { Settings } from '../../core/settings.js';
import type { CandidateStore } from '../../core/store.js';
import type { classifyBatch } from '../classify.js';
import type { CheckResult } from '../collector.js';
import type { GitHubClient } from '../github.js';
import type { DshIndex } from '../index/dsh-index.js';
import type { ReportHost } from '../report/report-session.js';

/** `ctx.llm` as classification uses it. */
export type ClassifyLlm = Parameters<typeof classifyBatch>[0];
/** The work on one candidate that only one request at a time may do. */
export type Task = 'report' | 'start' | 'status';

/** `promise`, or a rejection with `signal.reason` as soon as `signal` fires, whichever comes first. */
function raced<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** Runs work one piece after another, in the order it was handed in; a piece that fails does not stop the next. */
export class Lane {
  private tail: Promise<unknown> = Promise.resolve();
  /**
   * Runs `work` once every piece handed in before it has settled. With `signal`, the call rejects as soon as it fires, waiting or not, and
   * work whose turn has not come never runs; work already running is left to its own signal, and the next piece waits for it to settle.
   */
  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const turn = this.tail.then(() => { signal?.throwIfAborted(); return work(); });
    this.tail = turn.catch(() => undefined);
    return signal ? raced(turn, signal) : turn;
  }
}

/** What every action works with. The Host builds one when it starts; the fields that change are the Host's state. */
export interface HostContext {
  /** The absolute OpenCodex data directory. */
  readonly directory: string;
  readonly store: CandidateStore;
  /** The Host clock: candidate timestamps, the UTC day of the report counter, `lastCheckAt`. */
  readonly now: () => Date;
  /** Aborted when the plugin unloads. Long work runs under it rather than under one request's signal, so a page that goes away does not cut it short. */
  readonly signal: AbortSignal;
  /** The DSH services, taken from the injected ones when the Host starts: session controller and agents for report and start (with the default model and approval for report), `llm` for classification. */
  readonly services: ReportHost & { readonly llm: ClassifyLlm };
  /** How long a check, a `classify` action and the GitHub part of a report may take, in ms. */
  readonly timeouts: { readonly check: number; readonly classify: number; readonly github: number };
  /** The settings in force. */
  settings(): Readonly<Settings>;
  /** Puts settings in force once they are on disk, and re-arms the check timer. */
  setSettings(next: Readonly<Settings>): void;
  /** A GitHub client for one run: a client that finds gh unusable stays on REST for its lifetime, so production makes a new one each time. */
  github(): GitHubClient;
  /** Serves the RSS feed instead of the proxy-aware public network (tests). */
  readonly fetcher?: typeof fetch;
  /** How often a report session is polled (tests); 3 seconds by default. */
  readonly reportPollMs?: number;
  /** The waits before each further try of a classification batch that broke off on the connection. */
  readonly classifyRetryDelaysMs: readonly number[];
  /** The DSH index, once one is loaded or built. */
  index?: DshIndex;
  /** The last check this process ran, and when it ended (ISO); a check that failed is recorded with an `errors` line. */
  lastCheck?: CheckResult;
  lastCheckAt?: string;
  /** Candidates with a task running, by id: one task per candidate at a time. */
  readonly busy: Map<string, Task>;
  /** Runs a second request joins instead of starting another: `check`. */
  readonly running: Map<string, Promise<unknown>>;
  /** Reports admitted against the daily limit whose analyst session has not started yet (a started one is in the day's counter). */
  reportsRunning: number;
  /** One lane each for settings writes, the daily report counter, classification passes and index builds. */
  readonly lanes: { readonly settings: Lane; readonly reports: Lane; readonly classify: Lane; readonly index: Lane };
}

const TASK_LABEL: Record<Task, string> = { report: '生成报告', start: '开工', status: '改状态' };

/**
 * Runs `work` as the one task of candidate `id`. While it runs, a report, a start, an ignore or a restore of the same candidate is refused,
 * so no status can move under a task that is about to record its own.
 */
export async function exclusive<T>(ctx: HostContext, id: string, task: Task, work: () => Promise<T>): Promise<T> {
  const current = ctx.busy.get(id);
  if (current) throw new Error(`这条候选正在${TASK_LABEL[current]}，等它结束再操作`);
  ctx.busy.set(id, task);
  try { return await work(); } finally { ctx.busy.delete(id); }
}

/** Runs `work` under `key`, or, while a run of `key` is going, returns that run. */
export function joined<T>(ctx: HostContext, key: string, work: () => Promise<T>): Promise<T> {
  const current = ctx.running.get(key);
  if (current) return current as Promise<T>;
  const run = work().finally(() => ctx.running.delete(key));
  ctx.running.set(key, run);
  return run;
}

/**
 * `work` under the plugin's lifetime and a deadline of `ms`: a run that outlives the deadline is aborted, and its failure becomes an Error
 * with `late` as the message. An unload stays the abort it is.
 */
export async function withDeadline<T>(ctx: HostContext, ms: number, late: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = AbortSignal.timeout(ms);
  try { return await work(AbortSignal.any([ctx.signal, deadline])); } catch (error) {
    if (deadline.aborted && !ctx.signal.aborted) throw new Error(late, { cause: error });
    throw error;
  }
}

/** The mirror path from the settings, or a refusal that says where to set it. */
export function mirrorOf(settings: Readonly<Settings>): string {
  if (!settings.dshMirrorPath) throw new Error('先在设置里填写 DSH 镜像路径（dshMirrorPath）');
  return settings.dshMirrorPath;
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Characters of one line of a check's `errors`, as the collector cuts its own. */
const LINE_LIMIT = 300;
/** One `errors` line: whitespace collapsed, at most 300 code points, never cut inside a character. */
export function errorLine(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > LINE_LIMIT ? `${chars.slice(0, LINE_LIMIT - 1).join('')}…` : chars.join('');
}
