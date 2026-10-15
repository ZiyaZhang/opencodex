/**
 * OpenCodex Host: the `opencodex/call` Remote and the timer that runs a check every `checkIntervalHours`. This file wires; each action lives
 * in `./actions/`, and every external operation goes through the injected DSH services, so tests replace them with plain objects.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { CandidateStore } from '../core/store.js';
import { loadIndex, type CheckResult } from './collector.js';
import { GitHubClient } from './github.js';
import { check } from './actions/check.js';
import { classify } from './actions/classify.js';
import { Lane, messageOf, type HostContext } from './actions/context.js';
import { ignore, restore } from './actions/ignore-restore.js';
import { rebuildIndex } from './actions/index.js';
import { readReport } from './actions/read-report.js';
import { report } from './actions/report.js';
import { loadSettings, updateSettings } from './actions/settings.js';
import { candidate, snapshot } from './actions/snapshot.js';
import { start } from './actions/start.js';
import { OPEN_CODEX_DESCRIPTOR, parseRequest, type OpenCodexRequest, type OpenCodexResponse } from './remote.js';

export interface Config { dataDirectory?: string }
/** Arms and clears the check timer. */
export interface Timers { set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
/** Replacements for tests; the plugin loader passes none. */
export interface Dependencies {
  /** Serves every GitHub request; a new `GitHubClient` per run by default. */
  github?: GitHubClient;
  /** Serves the RSS feed instead of the proxy-aware public network. */
  fetcher?: typeof fetch;
  now?: () => Date;
  /** Node's timers, unref'd, by default. */
  timers?: Timers;
  /** How often a report session is polled; 3 seconds by default. */
  reportPollMs?: number;
  /** How long a check may run; 30 minutes by default. */
  checkTimeoutMs?: number;
}
declare module '@deepseek-ai/cordis' { interface Context { opencodex: OpenCodex } }

const HOUR = 3_600_000;
/** The first check waits this long, so it does not compete with DSH starting up. */
const FIRST_CHECK_DELAY_MS = 60_000;
const NODE_TIMERS: Timers = { set: (run, ms) => setTimeout(run, ms).unref(), clear: handle => clearTimeout(handle as NodeJS.Timeout) };

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
  private timer: unknown;
  /** When the last check ended, by the Host clock. */
  private lastCheckAt?: number;
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

  /** The one Remote method: checks the request, runs its action, and answers with the snapshot plus what the action returns. */
  async call(request: OpenCodexRequest, signal: AbortSignal): Promise<OpenCodexResponse> {
    signal.throwIfAborted();
    const parsed = parseRequest(request); // the codec ran it on the wire; in-process callers get the same check
    if (this.closed) throw new Error('OpenCodex 已卸载');
    return this.track(this.ready.then(host => this.dispatch(host, parsed)));
  }

  private async dispatch(host: HostContext, request: OpenCodexRequest): Promise<OpenCodexResponse> {
    let extra: Partial<OpenCodexResponse> = {};
    switch (request.action) {
      case 'snapshot': break;
      case 'check': await this.checkAndRearm(host); break;
      case 'classify': await classify(host); break;
      case 'report': await report(host, request.id); break;
      case 'start': extra = { startedSessionId: await start(host, request.id) }; break;
      case 'ignore': await ignore(host, request.id); break;
      case 'restore': await restore(host, request.id); break;
      case 'readReport': extra = { report: await readReport(host, request.id) }; break;
      case 'candidate': extra = { candidate: await candidate(host, request.id) }; break;
      case 'rebuildIndex': await rebuildIndex(host); break;
      case 'settings': await updateSettings(host, request.patch); break;
    }
    return { ...await snapshot(host), ...extra };
  }

  private async open(deps: Dependencies): Promise<HostContext> {
    const now = deps.now ?? (() => new Date());
    let settings = await loadSettings(this.directory);
    const host: HostContext = {
      directory: this.directory, store: new CandidateStore(this.directory, now), now, signal: this.lifetime.signal, services: this.ctx,
      settings: () => settings,
      setSettings: next => { settings = next; this.rearm(host); },
      github: () => deps.github ?? new GitHubClient(),
      fetcher: deps.fetcher, reportPollMs: deps.reportPollMs, checkTimeoutMs: deps.checkTimeoutMs,
      index: await loadIndex(this.directory),
      busy: new Map(), running: new Map(), reportsRunning: 0,
      lanes: { settings: new Lane(), reports: new Lane(), classify: new Lane(), index: new Lane() },
    };
    this.arm(FIRST_CHECK_DELAY_MS);
    return host;
  }

  /** A check, by request or by the timer; when it ends, the next one is due a whole interval later. */
  private async checkAndRearm(host: HostContext): Promise<CheckResult> {
    try { return await check(host); } finally {
      this.lastCheckAt = host.now().getTime();
      this.arm(host.settings().checkIntervalHours * HOUR);
    }
  }

  private disarm(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }
  /** Arms the timer to fire in `ms`, replacing the armed one; nothing once the plugin is unloading. */
  private arm(ms: number): void {
    this.disarm();
    if (!this.closed) this.timer = this.timers.set(() => { this.timer = undefined; void this.scheduled(); }, Math.max(0, ms));
  }

  /** After a settings change: the next check is due one (new) interval after the last one ended. The startup timer, and a check in progress, re-arm by themselves. */
  private rearm(host: HostContext): void {
    if (this.lastCheckAt === undefined || host.running.has('check')) return;
    this.arm(this.lastCheckAt + host.settings().checkIntervalHours * HOUR - host.now().getTime());
  }

  private async scheduled(): Promise<void> {
    try { await this.track(this.ready.then(host => this.checkAndRearm(host))); } catch (error) {
      if (!this.closed) this.ctx.logger.warn(`OpenCodex: scheduled check failed: ${messageOf(error)}`);
    }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.work.add(work);
    const forget = () => { this.work.delete(work); };
    work.then(forget, forget);
    return work;
  }

  /** Unload: no more timer, every running report, start, check and classification aborted, and their ends waited for. */
  private async close(): Promise<void> {
    this.closed = true;
    this.disarm();
    this.lifetime.abort(new DOMException('OpenCodex 已卸载', 'AbortError'));
    await Promise.allSettled([...this.work]);
  }
}
