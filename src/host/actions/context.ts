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

/** Runs work one piece after another, in the order it was handed in; a piece that fails does not stop the next. */
export class Lane {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** What every action works with. The Host builds one when it starts; the fields that change are the Host's state. */
export interface HostContext {
  /** The absolute OpenCodex data directory. */
  readonly directory: string;
  readonly store: CandidateStore;
  /** The Host clock: candidate timestamps and the UTC day of the report counter. */
  readonly now: () => Date;
  /** Aborted when the plugin unloads. Long work runs under it rather than under one request's signal, so a page that goes away does not cut it short. */
  readonly signal: AbortSignal;
  /** The Cordis context: the session controller and agents for report and start (with the default model and approval for report), `llm` for classification. */
  readonly services: ReportHost & { readonly llm: ClassifyLlm };
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
  /** How long a check may run (tests); 30 minutes by default. */
  readonly checkTimeoutMs?: number;
  /** The DSH index, once one is loaded or built. */
  index?: DshIndex;
  /** The last check this process ran. */
  lastCheck?: CheckResult;
  /** Candidates with a task running, by id: one task per candidate at a time. */
  readonly busy: Map<string, Task>;
  /** Runs a second request joins instead of starting another: `check`. */
  readonly running: Map<string, Promise<unknown>>;
  /** Reports admitted against the daily limit that have not finished. */
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

/** The mirror path from the settings, or a refusal that says where to set it. */
export function mirrorOf(settings: Readonly<Settings>): string {
  if (!settings.dshMirrorPath) throw new Error('先在设置里填写 DSH 镜像路径（dshMirrorPath）');
  return settings.dshMirrorPath;
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
