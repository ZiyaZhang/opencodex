/**
 * OpenCodex Host: the `opencodex/call` Remote and the timer that runs a check every `checkIntervalHours`. This file wires; each action lives
 * in `./actions/`, and every external operation goes through the injected DSH services, so tests replace them with plain objects.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { ValidationError } from '../core/check.js';
import { LockedError, acquireLock, type LockKind, type LockOptions, type LockResult } from '../core/lock.js';
import type { CheckTrigger } from '../core/run-log.js';
import { CandidateStore } from '../core/store.js';
import { NODE_TIMERS, type Timers } from '../core/timers.js';
import { loadIndex, type CheckResult } from './collector.js';
import { GitHubClient } from './github.js';
import type { ReportHost } from './report/report-session.js';
import { brief } from './actions/brief.js';
import { check } from './actions/check.js';
import { classify } from './actions/classify.js';
import { Lane, messageOf, type HostContext } from './actions/context.js';
import { ignore, restore } from './actions/ignore-restore.js';
import { rebuildIndex } from './actions/index.js';
import { models } from './actions/models.js';
import { readReport } from './actions/read-report.js';
import { report } from './actions/report.js';
import { loadSettings, updateSettings } from './actions/settings.js';
import { candidate, respond, type ActionResult } from './actions/snapshot.js';
import { start } from './actions/start.js';
import { OPEN_CODEX_DESCRIPTOR, parseRequest, type OpenCodexRequest, type OpenCodexResponse } from './remote.js';

export interface Config { dataDirectory?: string }
export type { Timers } from '../core/timers.js';
/** Replacements for tests; the plugin loader passes none. */
export interface Dependencies {
  /** Serves every GitHub request; a new `GitHubClient` per run by default. */
  github?: GitHubClient;
  /** Serves the RSS feed instead of the proxy-aware public network. */
  fetcher?: typeof fetch;
  now?: () => Date;
  /** The check timer; Node's timers, unref'd, by default. */
  timers?: Timers;
  /** The timers of the data-directory lock's heartbeat and second look; Node's timers, unref'd, by default. */
  lockTimers?: Timers;
  /** How often a report session is polled; 3 seconds by default. */
  reportPollMs?: number;
  /** In ms: a check, a `classify` action and the GitHub part of a report; 30, 15 and 10 minutes by default. */
  timeouts?: Partial<HostContext['timeouts']>;
  /** The waits before each further try of a classification batch that broke off on the connection; 5 and 20 seconds by default. */
  classifyRetryDelaysMs?: number[];
}
declare module '@deepseek-ai/cordis' { interface Context { opencodex: OpenCodex } }

const HOUR = 3_600_000;
/** The first check waits this long, so it does not compete with DSH starting up. */
const FIRST_CHECK_DELAY_MS = 60_000;
/** A check refused by another process's lock is tried again this soon, not a whole interval later: what that process runs takes minutes. */
const LOCKED_RETRY_MS = 10 * 60_000;
const TIMEOUTS: HostContext['timeouts'] = { check: 30 * 60_000, classify: 15 * 60_000, github: 10 * 60_000 };
const CLASSIFY_RETRY_DELAYS_MS = [5_000, 20_000];
/** What the timer starts: the first check after the Host starts, or a later one. */
type TimerTrigger = Extract<CheckTrigger, 'startup' | 'timer'>;

/**
 * What the actions call in DSH: the injected services, taken once. Never `ctx` itself, since a plugin context throws for a member it did not
 * inject, such as the `subagents` that `generateReport` would look for. `llm` is the whole service: classification calls `prepareCall` on
 * it, and the `models` action `listProviders`, `listConfigurableProviders` and `listModels`. `agentDefaultModel` and `approval` are typed
 * on `Context` only by packages this plugin does not depend on, so they are read with `ctx.get`, which skips the inject check (both are
 * injected anyway).
 */
function servicesOf(ctx: Context): HostContext['services'] {
  return {
    sessionController: ctx.sessionController, agents: ctx.agents, llm: ctx.llm,
    agentDefaultModel: ctx.get('agentDefaultModel') as ReportHost['agentDefaultModel'], approval: ctx.get('approval') as ReportHost['approval'],
  };
}

export default class OpenCodex extends TypertRemoteService {
  /** `agentDefaultModel` and `approval` are read by the report session (default model put back, approval policy `never`). */
  static inject = ['typert', 'sessionController', 'agents', 'llm', 'agentDefaultModel', 'approval'];
  /** `config.dataDirectory`, else `$DSH_HOME/opencodex`, else `~/.dsh/opencodex`. */
  readonly directory: string;
  /** Settles once settings.json is read and the store and index are open; rejects, naming the file, when settings.json is damaged. */
  private readonly ready: Promise<HostContext>;
  /** Aborted on unload: every report, start, check and classification runs under it. */
  private readonly lifetime = new AbortController();
  private readonly timers: Timers;
  /** Calls and timer runs in progress, waited for on unload. */
  private readonly work = new Set<Promise<unknown>>();
  /** Holds of the data-directory lock taken through the HostContext and not released yet. */
  private readonly locks = new Set<Extract<LockResult, { held: true }>>();
  private timer: unknown;
  private closed = false;

  constructor(ctx: Context, public config: Config = {}, deps: Dependencies = {}) {
    super(ctx, 'opencodex', { namespace: 'opencodex' });
    this.directory = resolve(config.dataDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'opencodex'));
    this.timers = deps.timers ?? NODE_TIMERS;
    ctx.typert.register({ package: 'dsh-opencodex', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: [OPEN_CODEX_DESCRIPTOR] });
    this.ready = this.open(deps);
    void this.ready.catch(() => undefined); // reported by [Service.init] and by every call
    ctx.effect(() => () => this.close(), 'opencodex: unload');
  }

  /** Cordis runs this after construction: a settings.json that cannot be used fails the plugin start with the reason. */
  async [Service.init](): Promise<void> { await this.ready; }

  /**
   * The one Remote method: checks the request, runs its action, and answers with the snapshot plus what the action returns. The wire codec
   * only checks for a JSON object, because the gateway would turn its errors into a bare "failed boundary validation"; the real check runs
   * here, and a request the Host refuses (by `parseRequest`, or by a check such as `mergeSettings`) rejects with a `gateway/bad-request`
   * RemoteError carrying the reason, which the page shows. A finished action is never reported as failed: see `respond`.
   */
  async call(request: OpenCodexRequest, signal: AbortSignal): Promise<OpenCodexResponse> {
    signal.throwIfAborted();
    if (this.closed) throw new Error('OpenCodex 已卸载');
    return this.track((async () => {
      try {
        const parsed = parseRequest(request);
        const host = await this.ready;
        return await respond(host, await this.act(host, parsed));
      } catch (error) {
        if (error instanceof ValidationError) throw new RemoteError('gateway/bad-request', error.message, {}, { cause: error });
        throw error;
      }
    })());
  }

  private async act(host: HostContext, request: OpenCodexRequest): Promise<ActionResult> {
    switch (request.action) {
      case 'snapshot': return {};
      case 'check': await this.checkAndRearm(host, 'manual'); return {};
      case 'classify': await classify(host); return {};
      case 'report': await report(host, request.id); return {};
      case 'brief': return { brief: await brief(host, request.id) };
      case 'start': {
        const { instructions, model, preset } = request;
        return { startedSessionId: await start(host, request.id, { instructions, model, preset }) };
      }
      case 'ignore': await ignore(host, request.id); return {};
      case 'restore': await restore(host, request.id); return {};
      case 'readReport': return { report: await readReport(host, request.id) };
      case 'candidate': return { candidate: await candidate(host, request.id) };
      case 'rebuildIndex': await rebuildIndex(host); return {};
      case 'models': return models(host);
      case 'settings': await updateSettings(host, request.patch); return {};
    }
  }

  private async open(deps: Dependencies): Promise<HostContext> {
    const now = deps.now ?? (() => new Date());
    let settings = await loadSettings(this.directory);
    const host: HostContext = {
      directory: this.directory, store: new CandidateStore(this.directory, now), now, signal: this.lifetime.signal, services: servicesOf(this.ctx),
      settings: () => settings,
      setSettings: next => { settings = next; this.rearm(host); },
      github: () => deps.github ?? new GitHubClient(),
      lock: kind => this.lock(kind, { now, timers: deps.lockTimers }),
      fetcher: deps.fetcher, reportPollMs: deps.reportPollMs, timeouts: { ...TIMEOUTS, ...deps.timeouts },
      classifyRetryDelaysMs: deps.classifyRetryDelaysMs ?? CLASSIFY_RETRY_DELAYS_MS,
      index: await loadIndex(this.directory),
      busy: new Map(), running: new Map(), reportsRunning: 0,
      lanes: { settings: new Lane(), reports: new Lane(), classify: new Lane(), index: new Lane() },
    };
    this.arm(FIRST_CHECK_DELAY_MS, 'startup');
    return host;
  }

  /** The data-directory lock under the Host clock and lifetime. A hold is kept here until released, so that one still held at unload is released then. */
  private async lock(kind: LockKind, options: Pick<LockOptions, 'now' | 'timers'>): Promise<LockResult> {
    const taken = await acquireLock(this.directory, kind, { ...options, signal: this.lifetime.signal });
    if (!taken.held) return taken;
    this.locks.add(taken);
    return { held: true, release: () => { this.locks.delete(taken); return taken.release(); }, signal: taken.signal };
  }

  /**
   * A check, by request or by the timer; when it ends, the next one is due a whole interval later, or 10 minutes later when another
   * process's lock refused it.
   */
  private async checkAndRearm(host: HostContext, trigger: CheckTrigger): Promise<CheckResult> {
    let refused = false;
    try { return await check(host, trigger); } catch (error) { refused = error instanceof LockedError; throw error; } finally {
      this.arm(refused ? LOCKED_RETRY_MS : host.settings().checkIntervalHours * HOUR);
    }
  }

  private disarm(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }
  /** Arms the timer to run a check in `ms`, replacing the armed one; nothing once the plugin is unloading. */
  private arm(ms: number, trigger: TimerTrigger = 'timer'): void {
    this.disarm();
    if (!this.closed) this.timer = this.timers.set(() => { this.timer = undefined; void this.scheduled(trigger); }, Math.max(0, ms));
  }

  /** After a settings change: the next check is due one (new) interval after the last one ended. The startup timer, and a check in progress, re-arm by themselves. */
  private rearm(host: HostContext): void {
    if (host.lastCheckAt === undefined || host.running.has('check')) return;
    this.arm(Date.parse(host.lastCheckAt) + host.settings().checkIntervalHours * HOUR - host.now().getTime());
  }

  /**
   * A timer run. A failure is recorded as `lastCheck` and in checks.jsonl by the check itself, so the page shows it; the DSH log gets it
   * too. A refusal by another process's lock is no failure, and its retry is armed already.
   */
  private async scheduled(trigger: TimerTrigger): Promise<void> {
    try { await this.track(this.ready.then(host => this.checkAndRearm(host, trigger))); } catch (error) {
      if (this.closed) return;
      if (error instanceof LockedError) this.ctx.logger.info(`OpenCodex: scheduled check skipped: ${error.message}`);
      else this.ctx.logger.warn(`OpenCodex: scheduled check failed: ${messageOf(error)}`);
    }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.work.add(work);
    const forget = () => { this.work.delete(work); };
    work.then(forget, forget);
    return work;
  }

  /** Unload: no more timer, every running report, start, check and classification aborted, their ends waited for, and the lock let go. */
  private async close(): Promise<void> {
    this.closed = true;
    this.disarm();
    this.lifetime.abort(new DOMException('OpenCodex 已卸载', 'AbortError'));
    await Promise.allSettled([...this.work]);
    // Each run lets go of its lock as it ends. A hold still here would go on beating, and refusing every other process, while DSH runs.
    const left = [...this.locks];
    this.locks.clear();
    await Promise.all(left.map(lock => lock.release()));
  }
}
