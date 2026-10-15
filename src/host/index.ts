/** OpenCodex Host plugin: DSH sessions, scoped metering, guidance and authenticated UI commands. */
import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import type { GenerateOptions, StreamChunk, TokenUsage as DshUsage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types';
import type {} from '@deepseek-ai/dsh-sandbox';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { OpenCodexStore } from '../core/index.js';
import type { EvidenceInput, Job, JobStatus, ScreenshotMetadata, SpecInput } from '../core/types.js';
import { OPEN_CODEX_DESCRIPTOR, type OpenCodexRequest, type OpenCodexResponse } from './remote.js';
import { ResourceReader } from './resources.js';
import { researchPrompt } from './prompt.js';
import { billableUsage, requestShape, calibratedRequestTokens, type BudgetCalibration } from './budget.js';
import { scanSources, seedDiscoveryEvidence, type ScanResult } from './discovery.js';
import { inspectArtifact } from './artifact.js';
import { VersionMonitor } from './version-monitor.js';
import { scaffoldPlugin } from './scaffold.js';
import { addScreenshot, createJobWithReference, readReferenceImage, readScreenshot } from './reference-image.js';
import { readPluginArtifact } from './plugin-download.js';
import { PluginInstaller } from './plugin-install.js';
import { AcceptanceController } from './acceptance.js';
import { inspectJobSdk } from './sdk.js';
import { developmentRecipe, executionBrief, executionPreflight, researchAdmissionError, researchAllowance, seedRequestEvidence } from './execution.js';

export interface Config { dataDirectory?: string; maxOutputTokens?: number; monitorTickMs?: number; allowSubagents?: boolean; backgroundToolNames?: string[]; automaticVerification?: boolean }
const ACTIVE = new Set<JobStatus>(['researching', 'specifying', 'building', 'verifying']);
const GENERATING = new Set<JobStatus>(['researching', 'specifying', 'building']);
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100_000) throw new Error(`${name} must be nonempty text`);
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

declare module '@deepseek-ai/cordis' { interface Context { opencodex: OpenCodex } }

export default class OpenCodex extends TypertRemoteService {
  static inject = ['typert', 'sessionController', 'tools', 'llm', 'sessions', 'agents'];
  readonly executionProtocolVersion = 3;
  readonly directory: string;
  readonly artifactRoot: string;
  private readonly resources = new ResourceReader(fileURLToPath(new URL('../../', import.meta.url)));
  private readonly requestCalibrations = new Map<string, BudgetCalibration>();
  private readonly planningScopes = new Map<string, () => void>();
  private readonly pendingBuildHandoffs = new Set<string>();
  private readonly extraTools = new Map<string, Set<string>>();
  private readonly store: Promise<OpenCodexStore>;
  private readonly installer: Promise<PluginInstaller>;
  private readonly acceptance: Promise<AcceptanceController>;
  private readonly automaticVerification: boolean;
  private readonly versionMonitor: VersionMonitor;
  private readonly lifetime = new AbortController();
  private readonly jobOperations = new Map<string, Promise<unknown>>();
  private readonly drivenSessions = new Set<string>();
  private readonly turnEndReasons = new Map<string, TurnEndReason['kind'] | 'disposed'>();
  private readonly maxOutputTokens: number;
  private closed = false;
  private scanOperation?: Promise<ScanResult>;
  private lastScanAt = 0;
  private readonly allowSubagents: boolean;
  private readonly backgroundToolNames: ReadonlySet<string>;
  private readonly discoveryFetch?: typeof fetch;

  constructor(ctx: Context, config: Config = {}, dependencies: { fetch?: typeof fetch } = {}) {
    super(ctx, 'opencodex', { namespace: 'opencodex' });
    this.directory = resolve(config.dataDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'opencodex'));
    this.artifactRoot = join(this.directory, 'jobs');
    this.maxOutputTokens = config.maxOutputTokens ?? 4096;
    this.allowSubagents = config.allowSubagents ?? false;
    this.automaticVerification = config.automaticVerification ?? true;
    this.discoveryFetch = dependencies.fetch;
    ctx.effect(() => () => { for (const dispose of this.planningScopes.values()) dispose(); this.planningScopes.clear(); });
    if (config.backgroundToolNames !== undefined && (!Array.isArray(config.backgroundToolNames) || config.backgroundToolNames.some(name => typeof name !== 'string' || !name.trim()))) throw new Error('backgroundToolNames must be exact operator-verified tool names');
    this.backgroundToolNames = new Set(config.backgroundToolNames ?? []);
    if (!Number.isSafeInteger(this.maxOutputTokens) || this.maxOutputTokens < 256 || this.maxOutputTokens > 32768) throw new Error('maxOutputTokens must be an integer from 256 to 32768');
    const tick = config.monitorTickMs ?? 30_000;
    if (!Number.isSafeInteger(tick) || tick < 1000) throw new Error('monitorTickMs must be at least 1000');
    this.store = OpenCodexStore.open({ directory: this.directory, artifactRoot: this.artifactRoot });
    this.installer = this.store.then(store => new PluginInstaller(store, this.directory, () => ctx.get('pluginManager'), this.lifetime.signal));
    this.acceptance = this.store.then(store => new AcceptanceController(store, {
      signal: this.lifetime.signal,
      whenResearchIdle: async job => { await Promise.all(job.sessionIds.map(id => this.ctx.agents.get(SessionId(id))?.whenIdle())); },
      verifier: () => this.ctx.get('opencodexFeatureVerifier'),
      accepted: id => this.completeAcceptance(id),
      repair: (id, details) => this.repairAfterAcceptance(id, details),
    }));
    void this.acceptance.catch(() => undefined);
    void this.installer.catch(() => undefined);
    // Retain the failure for RPC callers without an unhandled rejection before the first call.
    void this.store.catch(() => undefined);
    this.versionMonitor = new VersionMonitor(this.directory, this.store, id => this.localVersionCandidate(id));
    void this.store.then(async store => { await this.versionMonitor.configure(store.snapshot().settings.localVersionFile); await this.recoverLocalInvestigations(); }).catch(() => undefined);
    ctx.typert.register({ package: 'dsh-opencodex', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: [OPEN_CODEX_DESCRIPTOR] });
    this.installHooks();
    this.registerTools();
    const timer = setInterval(() => { void this.maintenance().catch(error => ctx.logger.warn(`OpenCodex maintenance: ${errorText(error)}`)); }, tick);
    timer.unref();
    ctx.effect(() => async () => {
      this.closed = true;
      clearInterval(timer);
      await this.versionMonitor.close();
      this.lifetime.abort(new Error('OpenCodex plugin unloaded'));
      let store: OpenCodexStore;
      try { store = await this.store; } catch { return; }
      for (const job of store.snapshot().jobs) if (ACTIVE.has(job.status)) await this.stop(job.id, 'paused', 'OpenCodex plugin unloaded');
      await Promise.allSettled([...this.jobOperations.values(), ...(this.scanOperation ? [this.scanOperation] : [])]);
      await (await this.installer).whenIdle();
      await (await this.acceptance).whenIdle();
      const idle = store.snapshot().jobs.flatMap(job => job.sessionIds.map(id => this.ctx.agents.get(SessionId(id)))).filter(agent => agent !== undefined);
      for (const agent of idle) agent.cancel({ kind: 'user' });
      await Promise.allSettled(idle.map(agent => agent.whenIdle()));
      await store.close();
    });
  }

  /** Only the authenticated DSH Remote carrier exposes user control operations. */
  async call(request: OpenCodexRequest, signal: AbortSignal): Promise<OpenCodexResponse> {
    signal.throwIfAborted();
    if (this.closed) throw new Error('OpenCodex is unloading');
    const store = await this.store;
    let extra: Partial<OpenCodexResponse> = {};
    switch (request.action) {
      case 'snapshot': break;
      case 'readReferenceImage': extra = { referenceImage: await readReferenceImage(store, request.jobId, signal) }; break;
      case 'readScreenshot': extra = { screenshot: await readScreenshot(store, request.jobId, request.artifactId, signal) }; break;
      case 'addScreenshot': await addScreenshot(store, request.jobId, request.image, request.metadata, signal); break;
      case 'readPluginArtifact': extra = { pluginArtifact: await readPluginArtifact(store, request.jobId, request.artifactId, request.offset, signal) }; break;
      case 'create': {
        const create = async () => {
          if (request.referenceImage !== undefined) await createJobWithReference(store, request.input, request.referenceImage, signal);
          else await store.createJob(request.input);
        };
        if (request.input?.candidateId) await this.serial(`candidate-create:${text(request.input.candidateId, 'candidateId')}`, create);
        else await create();
        break;
      }
      case 'settings': await store.updateSettings(request.patch); await this.versionMonitor.configure(store.snapshot().settings.localVersionFile); break;
      case 'start': await this.serial(text(request.jobId, 'jobId'), async () => {
        if (request.acceptanceMode !== undefined) await store.setAcceptanceMode(request.jobId, request.acceptanceMode);
        await this.start(request.jobId, request.note, request.freshContext);
      }); break;
      case 'pause': await this.serial(text(request.jobId, 'jobId'), () => this.stop(request.jobId, 'paused', 'Paused by user')); break;
      case 'cancel': await this.serial(text(request.jobId, 'jobId'), () => this.stop(request.jobId, 'cancelled', 'Cancelled by user')); break;
      case 'extendBudget': await store.extendBudget(text(request.jobId, 'jobId'), request.patch); break;
      case 'approveForeground':
        await this.serial(text(request.jobId, 'jobId'), async () => { await store.approveForeground(request.jobId, text(request.requestId, 'requestId')); await this.start(request.jobId); });
        break;
      case 'recordVerification':
        await this.serial(text(request.jobId, 'jobId'), async () => {
          await store.recordVerification(request.jobId, request.input);
          const state = store.snapshot(), job = store.getJob(request.jobId), specId = state.specs.filter(s => s.jobId === job.id).at(-1)?.id;
          if (['behavior', 'visual', 'lifecycle'].every(scope => state.verifications.filter(v => v.jobId === job.id && v.artifactId === job.artifactId && v.specId === specId && v.scope === scope).at(-1)?.outcome === 'passed')) await this.completeAcceptance(job.id);
        });
        break;
      case 'markReady': await this.serial(text(request.jobId, 'jobId'), () => this.completeAcceptance(request.jobId)); break;
      case 'installPlugin': {
        const job = store.getJob(text(request.jobId, 'jobId'));
        if (!['ready', 'installed'].includes(job.status)) throw new Error('Only accepted plugins can be installed');
        this.queueInstallation(job.id); break;
      }
      case 'markCovered': await store.markCovered(text(request.jobId, 'jobId'), { userConfirmed: true, specId: text(request.specId, 'specId'), reason: text(request.reason, 'reason') }); this.cancelSessions(store.getJob(request.jobId)); break;
      case 'validateArtifact': extra = { validation: await this.validateArtifact(text(request.jobId, 'jobId')) }; break;
      case 'scanLocalVersion': extra = { scan: await this.versionMonitor.check(signal) }; await this.capabilities(); break;
      case 'scan': extra = { scan: await this.scan(signal) }; break;
      case 'capabilities': await this.capabilities(); break;
      case 'readResource': extra = { resource: await this.resources.read(text(request.id, 'resource id')) }; break;
      default: throw new Error('Unknown OpenCodex request');
    }
    return { ...this.response(store), ...extra };
  }

  private response(store: OpenCodexStore): OpenCodexResponse {
    const state = store.snapshot();
    return { state, budgets: Object.fromEntries(state.jobs.map(job => [job.id, store.budgetSummary(job.id)])) };
  }
  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.jobOperations.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.jobOperations.set(id, task);
    void task.finally(() => { if (this.jobOperations.get(id) === task) this.jobOperations.delete(id); }).catch(() => undefined);
    return task;
  }
  private async capabilities(): Promise<void> {
    const names = this.ctx.tools.schemas().map(tool => tool.name).filter(name => !name.startsWith('opencodex_'));
    const rea = names.filter(name => /^(?:mcp[_:.]+)?rea(?:[_:.]|$)|(?:^|[_:.])reverse[_-]engineer(?:[_:.]|$)/i.test(name));
    const localVersion = this.versionMonitor.status();
    const checks = [
      { id: 'local-version', available: localVersion.selected && !localVersion.error, detail: localVersion.error ?? (localVersion.selected ? `Local version ${localVersion.version ?? 'baseline pending'}${localVersion.build ? ` (${localVersion.build})` : ''}; ${localVersion.watching ? 'watcher active' : 'periodic fallback'}` : 'Select a local version metadata file to enable immediate version checks') },
      { id: 'dsh-sessions', available: true, detail: 'Uses DSH sessionController and the configured main Agent' },
      { id: 'execution-protocol', available: true, version: String(this.executionProtocolVersion), detail: 'Durable research limits, scoped planning tools, atomic plan handoff and acceptance preflight' },
      { id: 'plugin-manager', available: Boolean(this.ctx.get('pluginManager')), detail: 'Accepted generated bundles install and enable automatically through the current DSH profile plugin manager' },
      { id: 'feature-verifier', available: Boolean(this.ctx.get('opencodexFeatureVerifier')), detail: this.ctx.get('opencodexFeatureVerifier') ? 'Independent feature verifier is registered; each specification obligation must be covered' : 'Native package lifecycle runs automatically. Behavior and visual comparison need a configured verifier or actual user acceptance; missing checks never pass automatically' },
      { id: 'workspace-sandbox', available: Boolean(this.ctx.get('sandbox') && this.ctx.get('sandboxPolicy')), detail: 'Research requires workspace-write confinement; no escalation is allowed' },
      { id: 'cua', available: names.some(name => /cua|computer/i.test(name)), detail: names.filter(name => /cua|computer/i.test(name)).join(', ') || 'Install and configure a DSH CUA provider' },
      { id: 'browser', available: names.some(name => /browser|playwright/i.test(name)), detail: names.filter(name => /browser|playwright/i.test(name)).join(', ') || 'No browser tool is currently registered' },
      { id: 'rea', available: rea.length > 0, detail: rea.join(', ') || 'Install REA with its DSH adapter; inspect current schemas before use' },
      { id: 'subagents', available: this.allowSubagents, detail: this.allowSubagents ? 'Operator enabled delegation; only in-process DSH descendants can be accounted' : 'Delegation disabled until the operator verifies the configured provider is in-process' },
    ];
    await (await this.store).saveCapabilities({ checkedAt: new Date().toISOString(), checks });
  }
  private async start(id: string, note?: string, freshContext = false): Promise<void> {
    if (typeof freshContext !== 'boolean') throw new Error('freshContext must be boolean');
    if (note !== undefined && (typeof note !== 'string' || note.length > 4000)) throw new Error('Start note must be at most 4000 characters');
    note = note?.trim();
    const current = (await this.store).getJob(id);
    if (ACTIVE.has(current.status)) return; // Duplicate UI delivery must not cancel the existing run.
    if (['ready', 'installed', 'covered', 'researched', 'cancelled'].includes(current.status)) throw new Error('This job cannot be started');
    try { await this.startUnsafe(id, note, freshContext); } catch (error) {
      const store = await this.store;
      const job = store.getJob(id);
      if (!job.foreground || job.foreground.completedAt || this.hasForegroundLease(job, store)) {
        if (['draft', 'detected', 'failed'].includes(job.status)) await store.transitionJob(id, 'queued', { reason: 'Preparing research session' });
        const current = store.getJob(id);
        if (['queued', 'researching', 'specifying', 'building', 'verifying', 'paused'].includes(current.status)) await store.transitionJob(id, 'blocked', { reason: errorText(error) });
        this.cancelSessions(store.getJob(id));
      }
      throw error;
    }
  }
  private async startUnsafe(id: string, note?: string, freshContext = false): Promise<void> {
    const store = await this.store;
    let job = store.getJob(id);
    if (ACTIVE.has(job.status)) throw new Error('Research is already running');
    if (['ready', 'installed', 'covered', 'researched', 'cancelled'].includes(job.status)) throw new Error('This job cannot be started');
    if (job.foreground && !job.foreground.completedAt && !this.hasForegroundLease(job, store)) throw new Error('Start the queued foreground request explicitly');
    if (!this.ctx.get('sandbox') || !this.ctx.get('sandboxPolicy')) throw new Error('A DSH sandbox provider and sandboxPolicy are required before research starts');
    const preflight = executionPreflight(job, this.automaticVerification && typeof this.ctx.get('opencodexFeatureVerifier')?.verify === 'function', typeof this.ctx.get('pluginManager')?.installBundle === 'function');
    if (preflight.blockers.length) throw new Error(preflight.blockers.join('\n'));
    const resuming = ['paused', 'blocked', 'failed'].includes(job.status);
    const previousPhase = resuming ? [...job.history].reverse().find(event => ['paused', 'blocked', 'failed'].includes(event.to) && event.from && ACTIVE.has(event.from))?.from : undefined;
    const snapshot = store.snapshot();
    const savedSpec = snapshot.specs.filter(spec => spec.jobId === job.id).at(-1);
    const validSpec = savedSpec && savedSpec.behavior.length > 0 && savedSpec.visual.length > 0 && savedSpec.lifecycle.length > 0 && savedSpec.evidenceIds.length > 0
      && savedSpec.evidenceIds.every(evidenceId => snapshot.evidence.some(evidence => evidence.id === evidenceId && evidence.jobId === job.id));
    const restorePhase = validSpec && (previousPhase === 'specifying' || (previousPhase === 'building' && job.mode === 'reconstruct')) ? previousPhase : undefined;
    if (previousPhase === 'verifying' && validSpec && job.artifactId) {
      await store.resumeAcceptance(id);
      this.queueAcceptance(id);
      return;
    }
    const workdir = join(this.artifactRoot, job.id);
    await mkdir(workdir, { recursive: true, mode: 0o700 });
    const normalizedWorkdir = await realpath(workdir);
    const continuation = freshContext && resuming && Boolean(job.sessionId);
    const previousGuidance = continuation ? job.history.map(event => event.reason.match(/; user note: ([\s\S]*)$/)?.[1]).filter(Boolean).join('\n\n') : '';
    if (previousGuidance.length > 16_000) throw new Error('Prior user guidance is too large for a bounded fresh context; continue the existing session instead');
    if (!job.sessionId || continuation) {
      if (continuation) {
        this.cancelSessions(job);
        await Promise.all(job.sessionIds.map(id => this.ctx.agents.get(SessionId(id))?.whenIdle()));
      }
      const created = await this.ctx.sessionController.create({ cwd: normalizedWorkdir });
      job = await store.bindSession(id, { sessionId: created.sessionId, workdir: normalizedWorkdir, ...(continuation ? { parentSessionId: job.executionSessionId ?? job.sessionId, continuation: true } : {}) });
      await this.ctx.sessionController.rename({ sessionId: created.sessionId, title: `OpenCodex · ${job.title}` });
    }
    const sessionId = SessionId(job.executionSessionId ?? job.sessionId!);
    await seedDiscoveryEvidence(this.directory, store, job.id);
    await seedRequestEvidence(store, job);
    const activation = await this.ctx.sessionController.resolveAgent(sessionId);
    if ('error' in activation) throw activation.error;
    const session = this.ctx.sessions.get(sessionId);
    if (!session || session.header.cwd !== normalizedWorkdir) throw new Error('Research session workspace no longer matches the job');
    setSandboxMode(session, 'workspace-write');
    this.drivenSessions.delete(sessionId);
    this.turnEndReasons.delete(sessionId);
    if (['draft', 'detected', 'paused', 'blocked', 'failed'].includes(job.status)) job = await store.transitionJob(id, 'queued', { reason: 'User selected research' });
    job = await store.transitionJob(id, 'researching', { reason: `Research started in a dedicated DSH session${note ? `; user note: ${note}` : ''}` });
    if (restorePhase) {
      job = await store.transitionJob(id, 'specifying', { reason: `Restored saved specification ${savedSpec!.id} after explicit resume` });
      if (restorePhase === 'building') job = await store.transitionJob(id, 'building', { reason: `Resumed implementation from saved specification ${savedSpec!.id}` });
    }
    // Use DSH's scoped registry so this smaller tool surface is logged normally.
    // Disposing our filter does not lift another plugin's restrictions.
    this.planningScopes.get(sessionId)?.(); this.planningScopes.delete(sessionId);
    if (job.mode === 'reconstruct') this.configureExecutionTools(job);
    try {
      await this.capabilities();
      const entry = await this.resources.read('opencodex', 32_000);
      const content = researchPrompt(job, await this.resources.catalog(), this.ctx.tools.schemas(activation.agent).map(tool => tool.name), resuming && (!continuation || job.status === 'building'), entry.content, executionBrief(store.snapshot(), job, preflight))
        + (continuation || !resuming ? await developmentRecipe(this.resources, job) : '')
        + (continuation ? `\n\nThis is a fresh execution context of the SAME job. All prior sessions, evidence, code, limits and spent tokens remain in its ledger. Read saved records instead of repeating research. Target access denials remain binding. No budget was reset.\nPrevious user guidance remains binding:\n${previousGuidance}` : '')
        + (previousPhase === 'verifying' ? '\n\nThe previous phase was verifying, but its current package or specification is missing. Recover the required deliverable before handing off again; no acceptance was resumed. No repair round was started.' : '')
        + (note ? `\n\nUser guidance for this run:\n${note}` : '');
      await this.ctx.sessionController.prompt({ sessionId, requestId: randomUUID() as SessionRequestId, mode: 'queue', content: [{ type: 'text', text: content }] }, this.lifetime.signal);
    } catch (error) { await this.stop(id, 'paused', errorText(error)); throw error; }
  }
  private async stop(id: string, status: 'paused' | 'cancelled', reason: string): Promise<void> {
    this.pendingBuildHandoffs.delete(id);
    const store = await this.store;
    const job = store.getJob(id);
    (await this.acceptance).cancel(id);
    if (job.status === status && job.foreground && this.hasForegroundLease(job, store)) await store.revokeForeground(job.id, job.foreground.id, reason);
    if (job.status !== status && !['installed', 'covered', 'researched', 'cancelled'].includes(job.status)) await store.transitionJob(id, status, { reason });
    this.cancelSessions(job);
  }
  private cancelSessions(job: Job): void {
    for (const sessionId of job.sessionIds) {
      const agent = this.ctx.agents.get(SessionId(sessionId));
      if (agent) agent.cancel({ kind: 'user' });
    }
  }
  private async jobForSession(id: string, seen = new Set<string>()): Promise<Job | undefined> {
    let store: OpenCodexStore;
    try { store = await this.store; } catch (error) {
      // A broken optional plugin must not disable unrelated DSH conversations.
      // Research workspaces still fail closed when their budget ledger cannot be read.
      const cwd = this.ctx.sessions.get(SessionId(id))?.header.cwd;
      if (cwd) {
        let root = this.artifactRoot;
        try { root = await realpath(root); } catch { /* The lexical configured root remains a useful fallback. */ }
        const rel = relative(root, cwd);
        if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw new Error(`OpenCodex research state is unavailable: ${errorText(error)}`);
      }
      return undefined;
    }
    const existing = store.snapshot().jobs.find(job => job.sessionIds.includes(id));
    if (existing) return existing;
    if (seen.has(id)) throw new Error('Invalid Session lineage');
    seen.add(id);
    const session = this.ctx.sessions.get(SessionId(id));
    if (session?.header.origin !== 'subagent' || !session.header.parentSession) return undefined;
    const parent = await this.jobForSession(session.header.parentSession, seen);
    if (!parent) return undefined;
    if (session.header.cwd !== parent.workdir) throw new Error('Research child escaped the dedicated workspace');
    setSandboxMode(session, 'workspace-write');
    return store.bindSession(parent.id, { sessionId: id, parentSessionId: session.header.parentSession });
  }
  private hasForegroundLease(job: Job, store: OpenCodexStore): boolean {
    const request = job.foreground;
    const lease = store.snapshot().foregroundLease;
    return Boolean(request && !request.completedAt && !request.releasedAt && lease?.jobId === job.id && lease.requestId === request.id && lease.approvedAt === request.approvedAt);
  }
  private async assertActive(job: Job): Promise<void> {
    const store = await this.store;
    const current = store.getJob(job.id);
    const budget = store.budgetSummary(job.id);
    if (current.status === 'verifying') throw new Error('The Host is verifying the saved package; research calls are closed during acceptance');
    if (!ACTIVE.has(current.status)) throw new Error(`OpenCodex job is ${current.status}; resume from the UI`);
    if (budget.elapsedMs >= current.budget.maxDurationMs || budget.job.remainingTokens <= 0 || budget.daily.remainingTokens <= 0) {
      await this.stop(job.id, 'paused', 'Research budget exhausted');
      throw new Error('OpenCodex research budget exhausted');
    }
  }
  private async reconcileIdleJob(id: string): Promise<void> {
    await this.serial(id, async () => {
      if (this.closed) return;
      const store = await this.store;
      const job = store.getJob(id);
      const executionId = job.executionSessionId ?? job.sessionId;
      if (!GENERATING.has(job.status) || !executionId || !this.drivenSessions.has(executionId)) return;
      // A completed child must not pause its still-running parent or siblings.
      if (job.sessionIds.some(sessionId => this.ctx.agents.get(SessionId(sessionId))?.status === 'running')) return;
      if (store.snapshot().reservations.some(request => request.jobId === id && request.status === 'inflight')) return;
      const kind = this.turnEndReasons.get(executionId);
      if (job.status === 'building' && this.pendingBuildHandoffs.has(id) && !['error', 'max-tokens', 'aborted', 'disposed', 'interrupted'].includes(kind ?? '')) {
        await store.transitionJob(id, 'paused', { reason: 'Specification committed; preparing a fresh development context with the same ledger' });
        // Leave the status callback before waiting for the driver's idle barrier.
        setTimeout(() => { void this.serial(id, async () => {
          if (this.closed || !this.pendingBuildHandoffs.delete(id) || store.getJob(id).status !== 'paused') return;
          await this.start(id, undefined, true);
        }).catch(() => undefined); }, 0);
        return;
      }
      const reason = kind === 'max-tokens'
        ? 'The DSH turn reached its single-call output token limit before finishing the job. Review the session, DSH model output settings and OpenCodex maxOutputTokens cap, then explicitly resume; the job budget and saved specification are unchanged.'
        : kind === 'error'
          ? 'The DSH agent failed and is now idle. Inspect the session error, correct the cause and explicitly resume; saved work and token usage are retained.'
          : kind === 'aborted' || kind === 'disposed' || kind === 'interrupted'
            ? 'The DSH agent stopped before completing the job. Review its saved progress and explicitly resume when ready.'
            : 'The DSH agent is idle without handing off a completed specification or plugin for acceptance. Review its last response and explicitly resume with the next concrete step.';
      await this.stop(id, 'paused', reason);
    });
  }
  private installHooks(): void {
    this.ctx.on('session/event', async (session, event) => {
      if (this.closed || event.type !== 'turn/end') return;
      if (await this.jobForSession(session.id)) this.turnEndReasons.set(session.id, event.data.reason.kind);
    });
    this.ctx.on('agent/status', async ({ agent, status }) => {
      if (this.closed) return;
      const job = await this.jobForSession(agent.session.id);
      if (!job) return;
      if (status === 'running') {
        this.drivenSessions.add(agent.session.id);
        this.turnEndReasons.delete(agent.session.id);
      } else await this.reconcileIdleJob(job.id);
    });
    this.ctx.on('agent/error', async ({ agent }) => {
      if (this.closed) return;
      const job = await this.jobForSession(agent.session.id);
      if (!job) return;
      this.drivenSessions.add(agent.session.id);
      this.turnEndReasons.set(agent.session.id, 'error');
      await this.reconcileIdleJob(job.id);
    });
    this.ctx.on('agent/disposed', async ({ agent }) => {
      if (this.closed) return;
      const job = await this.jobForSession(agent.session.id);
      if (!job) return;
      this.turnEndReasons.set(agent.session.id, this.turnEndReasons.get(agent.session.id) ?? 'disposed');
      await this.reconcileIdleJob(job.id);
    });
    this.ctx.on('agent/request', async (payload, next) => {
      const job = await this.jobForSession(payload.agent.session.id);
      if (!job) return next();
      await this.assertActive(job);
      const config = await next();
      const budget = (await this.store).budgetSummary(job.id);
      const allowance = Math.max(1, Math.floor(Math.min(budget.job.remainingTokens, budget.daily.remainingTokens) / 4));
      return { ...config, maxTokens: Math.min(config.maxTokens ?? this.maxOutputTokens, this.maxOutputTokens, allowance) };
    });
    const self = this;
    this.ctx.on('llm/stream', async function* (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) {
      const initiator = self.ctx.agents.currentInitiator();
      const initiatedJob = initiator ? await self.jobForSession(initiator.session.id) : undefined;
      const job = options.sessionId ? await self.jobForSession(options.sessionId) : initiatedJob;
      if (initiatedJob && options.sessionId && (!job || job.id !== initiatedJob.id)) throw new Error('Refusing unattributed model call within OpenCodex research');
      if (!job) { yield* next(); return; }
      await self.assertActive(job);
      if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens! <= 0 || options.maxTokens! > self.maxOutputTokens) throw new Error('Research model calls require an explicit bounded maxTokens; auxiliary calls must respect the job cap');
      const store = await self.store;
      const requestId = randomUUID();
      const shape = requestShape(options), calibrationKey = `${job.id}:${options.sessionId ?? initiator?.session.id ?? 'auxiliary'}`;
      const reservedTokens = calibratedRequestTokens(shape, self.requestCalibrations.get(calibrationKey)) + options.maxTokens!;
      const admissionError = researchAdmissionError(store.snapshot(), store.getJob(job.id), reservedTokens);
      if (admissionError) { await self.stop(job.id, 'paused', admissionError); throw new Error(admissionError); }
      try { await store.reserveTokens(job.id, { requestId, reservedTokens, enforceResearchAllowance: true }); }
      catch (error) { await self.stop(job.id, 'paused', errorText(error)); throw error; }
      let usage: DshUsage | undefined;
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') usage = chunk.usage;
          yield chunk;
        }
      } finally {
        try {
          const measured = usage ? billableUsage(usage) : null;
          await store.reconcileUsage(requestId, measured);
          if (measured) self.requestCalibrations.set(calibrationKey, { shape, inputTokens: measured.inputTokens });
        } catch (error) {
          await store.reconcileUsage(requestId, null);
          if (ACTIVE.has(store.getJob(job.id).status)) await self.stop(job.id, 'paused', `Unusable provider usage: ${errorText(error)}`);
          throw error;
        }
        if (!ACTIVE.has(store.getJob(job.id).status)) self.cancelSessions(store.getJob(job.id));
      }
    });
    this.ctx.on('tools/execute', async (exec, next) => {
      if (!exec.agent) return next();
      const job = await this.jobForSession(exec.agent.session.id);
      if (!job) return next();
      await this.assertActive(job);
      const policy = this.ctx.get('sandboxPolicy')?.resolve({ session: exec.agent.session });
      if (policy?.mode !== 'workspace-write' || policy.workspaceRoot !== job.workdir) throw new Error('OpenCodex requires the dedicated workspace-write policy');
      const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments as Record<string, unknown> : {};
      if (args.sandbox_permissions !== undefined) throw new Error('OpenCodex research cannot escalate sandbox permissions');
      if (/working.directory|plugin.*(?:install|update|remove)|cordis|schedule|automation/i.test(exec.name)) throw new Error('This operation is outside isolated OpenCodex research');
      if (!this.allowSubagents && /subagent|spawn_agent|fork_agent|ralph/i.test(exec.name)) throw new Error('Delegation is disabled until an in-process provider has been verified');
      if (/computer|cua|browser|playwright/i.test(exec.name) && !exec.name.startsWith('opencodex_') && !this.backgroundToolNames.has(exec.name)) {
        if (!this.hasForegroundLease(job, await this.store)) throw new Error('Request and start a scoped foreground task in OpenCodex before desktop control');
      }
      const result = await next();
      if (!result.isError && (exec.name === 'opencodex_submit_plan' || (exec.name === 'opencodex_job' && args.action === 'stage' && record(args.payload).status === 'building'))) {
        this.pendingBuildHandoffs.add(job.id);
        return { ...result, concludesTurn: true };
      }
      if (!result.isError && exec.name === 'opencodex_job' && (args.action === 'request_foreground' || (args.action === 'stage' && ['verifying', 'researched', 'blocked'].includes(String(record(args.payload).status))))) {
        const current = (await this.store).getJob(job.id);
        for (const id of current.sessionIds) if (id !== exec.agent.session.id) this.ctx.agents.get(SessionId(id))?.cancel({ kind: 'user' });
        return { ...result, concludesTurn: true };
      }
      return result;
    });
  }
  private registerTools(): void {
    this.ctx.tools.register(defineTool({
      name: 'opencodex_submit_plan',
      description: 'Commit the minimal source-grounded specification and enter implementation in one call. Use before broad SDK exploration. Keep unknown visual/runtime details in gaps; submitting a plan is not acceptance. Creates the generic empty plugin scaffold, with exact build commands, when packageName is supplied. Never replaces existing code. Investigation-only jobs use opencodex_job spec instead.',
      parameters: {
        title: { type: 'string', required: true },
        behavior: { type: 'array', items: { type: 'string' }, required: true },
        visual: { type: 'array', items: { type: 'string' }, required: true },
        lifecycle: { type: 'array', items: { type: 'string' }, required: true },
        existingCapabilities: { type: 'array', items: { type: 'string' }, required: true },
        gaps: { type: 'array', items: { type: 'string' }, required: true },
        evidenceIds: { type: 'array', items: { type: 'string' }, required: true },
        packageName: { type: 'string' },
      },
      output: { schema: { type: 'object', properties: { result: { type: 'string', required: true } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.result }] },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        const job = exec.agent ? await this.jobForSession(exec.agent.session.id) : undefined;
        if (!job) throw new Error('This tool requires a dedicated OpenCodex research session');
        await this.assertActive(job);
        const store = await this.store;
        const { packageName, ...spec } = args;
        const saved = await store.submitPlan(job.id, spec);
        let scaffold: unknown;
        if (packageName) {
          try { scaffold = await scaffoldPlugin(fileURLToPath(new URL('../../', import.meta.url)), this.artifactRoot, store.getJob(job.id), packageName); }
          catch (error) { scaffold = { error: errorText(error), next: 'The specification is saved and stage is building. Keep existing files; use scaffold only if a new empty plugin directory is needed.' }; }
        }
        return { result: JSON.stringify({ specId: saved.id, stage: 'building', scaffold, next: 'Write the smallest implementation now. Query SDK only for an unresolved signature or a compiler error. Build and register the tarball; do not repeat the plan.' }) };
      },
    }));
    this.ctx.tools.register(defineTool({
      name: 'opencodex_read_resource', description: 'Inspect one allowlisted guide. Defaults to a compact index with title, description, heading/source offsets, totalCharacters and sha256. Short resources of at most 3000 characters also include their full excerpt and complete:true; longer resources never include body text implicitly. Use action read for an excerpt: offset defaults to 0, maxCharacters defaults to 3000 and is capped at 6000. Offsets count UTF-16 code units; concatenate excerpts using nextOffset to reconstruct exactly. If sha256 changes, restart from the new index. Index labels are bounded and omittedEntries reports unusually long outlines.',
      parameters: { id: { type: 'string', required: true }, action: { type: 'string', enum: ['index', 'read'] }, offset: { type: 'number' }, maxCharacters: { type: 'number' } },
      output: { schema: { type: 'object', properties: { result: { type: 'string', required: true } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.result }] },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        const result = await this.resources.readForAgent(args.id, { action: args.action, offset: args.offset, maxCharacters: args.maxCharacters });
        exec.signal.throwIfAborted();
        return { result: JSON.stringify(result) };
      },
    }));
    this.ctx.tools.register(defineTool({
      name: 'opencodex_job', description: `Maintain the calling OpenCodex job dossier. Cannot approve foreground operations, increase budgets, mark ready, or install. Payloads by action:
sdk: {package:string,path?:string,symbol?:string,offset?:number}; returns the installed version, export/type paths, digest and at most 5000 declaration characters for one allowlisted DSH package. Start with the package, then follow only relevant returned declarations; prefer this to scanning node_modules. tools: {query?:string,offset?:number,names?:string[]}; development only, inspect a bounded tool catalog or load up to four exact registered schemas; this never grants target access or permission. status: {offset?:number}; returns compact job/budget and latest-first paginated dossier summaries, 30 per category, without the description or full history. record: {id:string,offset?:number}; returns one same-job dossier record as JSON text in 16000-character chunks; concatenate content using nextOffset until absent. repair: {}. scaffold: {packageName:string}; reconstruction only, copies the bundled feature-free skeleton into an absent/empty plugin directory, refuses symlinks and overwrites, does not install or build. Returns exact starter Client source, target SDK versions and build/package commands; use this brief instead of rereading every template file. Use an unscoped lowercase name with letters/digits/hyphens, at most 80 characters. evidence: {kind:'observed'|'inferred'|'unknown',claim:string,sourceUrl?:string,localPath?:string,relatedEvidenceIds?:string[]}; observed needs sourceUrl or localPath. spec: {title:string,behavior:string[],visual:string[],lifecycle:string[],existingCapabilities:string[],gaps:string[],evidenceIds:string[]}; required arrays behavior/visual/lifecycle/evidenceIds must be nonempty. artifact: {path:string,label?:string,kind?:'plugin'|'report'|'screenshot'|'log',screenshot?:{subject:'codex'|'dsh'|'other',caption:string,provenance:'user'|'capture'|'public-source',sourceUrl?:string,version?:string}}; plugin is a real npm tarball. New screenshot artifacts require screenshot metadata, a real PNG/JPEG/WebP file at most 2 MiB, a concise caption explaining the visible feature, and honest subject/source labels. Capture Codex reference and DSH implementation separately; missing reference is a visual gap, not a passed comparison. verification: {details:string,localPath?:string}; records an agent report only. stage: {status:'specifying'|'building'|'verifying'|'blocked'|'researched',reason:string}; advance sequentially. request_foreground: {target:string,scope:string,steps:string[]}; pauses the job until user approval. foreground_done: {requestId:string}. Stage, repair and foreground_done return compact acknowledgements. Paths are relative to the dedicated job workspace.`,
      parameters: { action: { type: 'string', required: true, enum: ['status', 'record', 'sdk', 'tools', 'evidence', 'spec', 'scaffold', 'artifact', 'verification', 'stage', 'request_foreground', 'foreground_done', 'repair'] }, payload: { type: 'object', additionalProperties: true } },
      output: { schema: { type: 'object', properties: { result: { type: 'string', required: true } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: String(value.result) }] },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        const job = exec.agent ? await this.jobForSession(exec.agent.session.id) : undefined;
        if (!job) throw new Error('This tool requires a dedicated OpenCodex research session');
        const store = await this.store;
        const payload = record(args.payload ?? {});
        const result = await (async (): Promise<unknown> => {
        switch (args.action) {
          case 'tools': {
            if (job.status !== 'building') throw new Error('Additional tools are loaded during development; submit the requirements first');
            const requested = payload.names;
            if (requested !== undefined && (!Array.isArray(requested) || requested.length > 4 || requested.some(name => typeof name !== 'string'))) throw new Error('Choose at most four exact registered tool names');
            if (payload.query !== undefined && (typeof payload.query !== 'string' || payload.query.length > 120)) throw new Error('Tool query must be at most 120 characters');
            return this.configureExecutionTools(job, requested as string[] | undefined, true, this.pageOffset(payload.offset), payload.query as string | undefined);
          }
          case 'status': return this.dossierStatus(store, job.id, payload.offset);
          case 'record': {
            const state = store.snapshot();
            const id = text(payload.id, 'record id');
            const item = [...state.evidence, ...state.specs, ...state.artifacts, ...state.verifications].find(item => item.id === id && item.jobId === job.id);
            if (!item) throw new Error('Unknown same-job dossier record');
            const offset = this.pageOffset(payload.offset);
            const content = JSON.stringify(item);
            return { id, offset, totalCharacters: content.length, content: content.slice(offset, offset + 16000), ...(offset + 16000 < content.length ? { nextOffset: offset + 16000 } : {}) };
          }
          case 'evidence': return store.addEvidence(job.id, this.evidenceInput(job, payload));
          case 'sdk': return inspectJobSdk(store, job.id, { package: text(payload.package, 'package'), ...(typeof payload.path === 'string' ? { path: payload.path } : {}), ...(typeof payload.symbol === 'string' ? { symbol: payload.symbol } : {}), ...(payload.offset !== undefined ? { offset: Number(payload.offset) } : {}) });
          case 'spec': return store.saveSpec(job.id, payload as SpecInput);
          case 'scaffold': return this.serial(`scaffold:${job.id}`, () => scaffoldPlugin(this.resources.packageRoot, this.artifactRoot, store.getJob(job.id), text(payload.packageName, 'packageName')));
          case 'artifact': return store.registerArtifact(job.id, { path: this.artifactPath(job, text(payload.path, 'path')), ...(typeof payload.label === 'string' ? { label: payload.label } : {}), ...(typeof payload.kind === 'string' ? { kind: payload.kind as 'plugin' | 'report' | 'screenshot' | 'log' } : {}), ...(payload.screenshot !== undefined ? { screenshot: payload.screenshot as ScreenshotMetadata } : {}) });
          case 'verification': return store.addEvidence(job.id, { kind: 'inferred', claim: `Agent test report (not independent acceptance): ${text(payload.details, 'details')}`, ...(typeof payload.localPath === 'string' ? { localPath: this.artifactPath(job, payload.localPath) } : {}) });
          case 'stage': {
            const stage = text(payload.status, 'status');
            if (!['specifying', 'building', 'verifying', 'blocked', 'researched'].includes(stage)) throw new Error('Agents may only advance specification, build, verification or report a blocker');
            if (job.mode === 'investigate' && ['building', 'verifying'].includes(stage)) throw new Error('Version investigations only inventory changes; choose a feature in a new reconstruction job before implementing it');
            if (stage === 'building' && !store.snapshot().specs.some(spec => spec.jobId === job.id && spec.evidenceIds.some(id => store.snapshot().evidence.some(e => e.id === id && e.kind === 'observed')))) throw new Error('Save the minimal specification grounded in observed evidence before implementation');
            if (stage === 'verifying') await this.validateArtifact(job.id);
            const advanced = await store.transitionJob(job.id, stage as JobStatus, { reason: text(payload.reason, 'reason') });
            if (stage === 'verifying') this.queueAcceptance(job.id);
            return this.jobAcknowledgement(advanced);
          }
          case 'request_foreground': {
            const request = await store.requestForeground(job.id, { target: text(payload.target, 'target'), scope: text(payload.scope, 'scope'), steps: Array.isArray(payload.steps) ? payload.steps.map(step => text(step, 'step')) : [] });
            // The next model/tool admission is blocked by the paused state; avoid cancelling this tool before its result is logged.
            return request;
          }
          case 'foreground_done': {
            await store.completeForeground(job.id, text(payload.requestId, 'requestId'));
            return this.jobAcknowledgement(store.getJob(job.id));
          }
          case 'repair': return this.jobAcknowledgement(await store.startRepair(job.id));
          default: throw new Error('Unknown OpenCodex job action');
        }
        })();
        const current = store.getJob(job.id);
        return { result: JSON.stringify(['researching', 'specifying'].includes(current.status)
          ? { ...record(result), researchAllowance: researchAllowance(store.snapshot(), current), next: 'Commit the source-grounded plan with opencodex_submit_plan; SDK reads are not milestones.' }
          : result) };
      },
    }));
  }
  private pageOffset(value: unknown): number {
    if (value === undefined) return 0;
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('offset must be a nonnegative integer');
    return Number(value);
  }
  private configureExecutionTools(job: Job, requested: string[] = [], list = false, offset = 0, query = '') {
    const id = job.executionSessionId ?? job.sessionId!;
    const agent = this.ctx.agents.get(SessionId(id));
    if (!agent) throw new Error('Execution agent is unavailable');
    this.planningScopes.get(id)?.(); this.planningScopes.delete(id);
    const available = this.ctx.tools.schemas(agent);
    const globalNames = new Set(this.ctx.tools.schemas().map(tool => tool.name));
    const extras = this.extraTools.get(job.id) ?? new Set<string>();
    const invalid = requested.find(name => !available.some(tool => tool.name === name));
    if (!invalid) for (const name of requested) extras.add(name);
    this.extraTools.set(job.id, extras);
    const names = job.status === 'building'
      ? ['opencodex_job', 'opencodex_read_resource', 'read', 'edit', 'write', 'bash', 'grep', 'glob', ...this.backgroundToolNames, ...extras]
      : ['opencodex_submit_plan', 'opencodex_job', 'opencodex_read_resource'];
    const allow = [...new Set(names)].filter(name => globalNames.has(name) && available.some(tool => tool.name === name));
    if (allow.length) this.planningScopes.set(id, agent.ctx.tools.restrict({ allow }));
    if (invalid) throw new Error(`Tool is unavailable in this agent: ${invalid}`);
    const matches = available.filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase()));
    return { enabled: allow, ...(list ? { available: matches.slice(offset, offset + 24).map(tool => ({ name: tool.name, description: tool.description?.slice(0, 100) })), ...(offset + 24 < matches.length ? { nextOffset: offset + 24 } : {}) } : {}), note: 'Loading a schema does not grant target access, foreground permission or sandbox escalation.' };
  }
  private jobAcknowledgement(job: Job) {
    return { id: job.id, status: job.status, mode: job.mode, repairRounds: job.repairRounds,
      ...(job.artifactId ? { artifactId: job.artifactId } : {}),
      ...(job.foreground ? { foreground: job.foreground } : {}),
    };
  }
  private jobSummary(job: Job) {
    const last = job.history.at(-1);
    return { ...this.jobAcknowledgement(job), title: job.title, budget: job.budget,
      ...(job.sessionId ? { sessionId: job.executionSessionId ?? job.sessionId } : {}), ...(job.workdir ? { workdir: job.workdir } : {}),
      ...(last ? { lastHistory: { ...last, reason: last.reason.slice(0, 512) } } : {}),
    };
  }
  private dossierStatus(store: OpenCodexStore, jobId: string, offsetInput: unknown): unknown {
    const state = store.snapshot();
    const offset = this.pageOffset(offsetInput);
    const page = <T extends { id: string; jobId: string; createdAt: string }>(items: T[], summarize: (item: T) => Record<string, unknown>) => {
      const matching = items.filter(item => item.jobId === jobId).reverse();
      return { total: matching.length, offset, ...(offset + 30 < matching.length ? { nextOffset: offset + 30 } : {}), items: matching.slice(offset, offset + 30).map(item => ({ id: item.id, createdAt: item.createdAt, ...summarize(item) })) };
    };
    return { job: this.jobSummary(store.getJob(jobId)), budget: store.budgetSummary(jobId), dossier: {
      evidence: page(state.evidence, item => ({ kind: item.kind, claim: item.claim.slice(0, 512), localPath: item.localPath, sourceUrl: item.sourceUrl })),
      specs: page(state.specs, item => ({ title: item.title.slice(0, 512), evidenceIds: item.evidenceIds })),
      artifacts: page(state.artifacts, item => ({ kind: item.kind, path: item.path, sha256: item.sha256, bytes: item.bytes })),
      verifications: page(state.verifications, item => ({ scope: item.scope, outcome: item.outcome, artifactId: item.artifactId, specId: item.specId })),
    } };
  }
  private artifactPath(job: Job, input: string): string {
    const path = resolve(job.workdir ?? join(this.artifactRoot, job.id), input);
    const jobRelative = relative(job.workdir ?? join(this.artifactRoot, job.id), path);
    if (jobRelative === '..' || jobRelative.startsWith(`..${sep}`) || isAbsolute(jobRelative)) throw new Error('Evidence and artifacts must stay inside the current job workspace');
    return relative(job.workdir ? dirname(job.workdir) : this.artifactRoot, path);
  }
  private evidenceInput(job: Job, input: Record<string, unknown>): EvidenceInput {
    return { ...input, ...(typeof input.localPath === 'string' ? { localPath: this.artifactPath(job, input.localPath) } : {}) } as EvidenceInput;
  }
  private async validateArtifact(id: string): Promise<{ passed: boolean; details: string[] }> {
    const store = await this.store;
    const job = store.getJob(id);
    const artifact = store.snapshot().artifacts.find(item => item.id === job.artifactId);
    if (!artifact) throw new Error('Register a generated plugin tarball before package inspection');
    return inspectArtifact(resolve(this.artifactRoot, artifact.path), artifact.sha256);
  }
  private async completeAcceptance(id: string): Promise<void> {
    const store = await this.store;
    if (store.getJob(id).status === 'installed') return;
    if (store.getJob(id).status !== 'ready') {
      await this.validateArtifact(id);
      await store.transitionJob(id, 'ready', { reason: 'All independent isolated acceptance scopes passed; installing through DSH' });
      this.cancelSessions(store.getJob(id));
    }
    this.queueInstallation(id);
  }
  private queueInstallation(id: string): void {
    void this.installer.then(installer => installer.install(id)).catch(error => {
      if (!this.closed) this.ctx.logger.warn(`OpenCodex installation: ${errorText(error)}`);
    });
  }
  private queueAcceptance(id: string): void {
    if (!this.automaticVerification || this.closed) return;
    void this.acceptance.then(controller => controller.run(id)).catch(error => {
      if (!this.closed) this.ctx.logger.warn(`OpenCodex acceptance: ${errorText(error)}`);
    });
  }
  private async repairAfterAcceptance(id: string, details: string): Promise<void> {
    const store = await this.store;
    if (this.closed || store.getJob(id).status !== 'verifying') return;
    const job = store.getJob(id);
    const executionId = job.executionSessionId ?? job.sessionId;
    if (!executionId || !this.ctx.agents.get(SessionId(executionId))) {
      await store.transitionJob(id, 'blocked', { reason: details }); return;
    }
    try {
      const repairing = await store.startRepair(id);
      const content = researchPrompt(repairing, await this.resources.catalog(), this.ctx.tools.schemas().map(tool => tool.name), true)
        + `\n\nIndependent acceptance failed. Repair only the failing implementation, rerun the affected checks, register a new tarball, and hand off to verifying. Do not repeat research or erase contrary evidence. Failure: ${details.slice(0, 4000)}. Full report: ${repairing.acceptance?.reportPath ?? 'see dossier'}`;
      await this.ctx.sessionController.prompt({ sessionId: SessionId(executionId), requestId: randomUUID() as SessionRequestId, mode: 'queue', content: [{ type: 'text', text: content }] }, this.lifetime.signal);
    } catch (error) {
      if (GENERATING.has(store.getJob(id).status)) await this.stop(id, 'paused', errorText(error));
    }
  }
  private scan(signal: AbortSignal): Promise<ScanResult> {
    if (this.scanOperation) return this.scanOperation;
    const run = this.store.then(store => scanSources(this.directory, store, AbortSignal.any([signal, this.lifetime.signal]), this.discoveryFetch));
    this.scanOperation = run;
    void run.finally(() => { this.lastScanAt = Date.now(); if (this.scanOperation === run) this.scanOperation = undefined; }).catch(() => undefined);
    return run;
  }
  private async localVersionCandidate(candidateId: string): Promise<void> {
    // A version event is a trigger: refresh individual release-note features without a model.
    try { await this.scan(this.lifetime.signal); }
    catch (error) {
      if (this.closed || this.lifetime.signal.aborted) return;
      // A broken public checkpoint must not discard an independently detected local update.
      this.ctx.logger.warn(`OpenCodex public source refresh: ${errorText(error)}`);
    }
    await this.serial(`local-candidate:${candidateId}`, async () => {
      const store = await this.store;
      const state = store.snapshot();
      if (state.settings.updateResearchMode !== 'investigate' || this.closed) return;
      const candidate = state.candidates.find(item => item.id === candidateId);
      if (!candidate || !candidate.autoInvestigate || candidate.status !== 'new' || state.jobs.some(job => job.candidateId === candidateId)) return;
      const job = await store.createJob({ title: `Investigate ${candidate.title}`, description: `${candidate.description}\n\nInventory and explain newly available features using sources and observed evidence. Do not implement or install any feature. Finish with a researched specification so the user can choose which features to reconstruct.`, source: 'discovery', candidateId, mode: 'investigate' });
      await store.transitionJob(job.id, 'queued', { reason: 'User enabled automatic investigation of local version updates' });
    });
    await this.startQueuedInvestigation();
  }
  private async recoverLocalInvestigations(): Promise<void> {
    const state = (await this.store).snapshot();
    if (this.closed || state.settings.updateResearchMode !== 'investigate') return;
    for (const candidate of state.candidates) {
      if (candidate.autoInvestigate && candidate.status === 'new' && !state.jobs.some(job => job.candidateId === candidate.id)) await this.localVersionCandidate(candidate.id);
    }
  }
  private async startQueuedInvestigation(): Promise<void> {
    await this.serial('automatic-investigation', async () => {
      const store = await this.store;
      const state = store.snapshot();
      if (this.closed || state.settings.updateResearchMode !== 'investigate' || state.jobs.some(job => ACTIVE.has(job.status))) return;
      const next = state.jobs.find(job => job.mode === 'investigate' && job.source === 'discovery' && (job.status === 'queued' || (job.status === 'detected' && state.candidates.some(candidate => candidate.id === job.candidateId && candidate.autoInvestigate))));
      if (next) await this.serial(next.id, async () => {
        if (store.getJob(next.id).status === 'detected') await store.transitionJob(next.id, 'queued', { reason: 'Recovering automatic local version investigation after interruption' });
        await this.start(next.id);
      });
    });
  }
  private async maintenance(): Promise<void> {
    if (this.closed) return;
    const store = await this.store;
    const state = store.snapshot();
    // Ready jobs never need a second install confirmation. Failed/interrupted attempts
    // stay visible for explicit retry; polling must not loop native side effects.
    for (const job of state.jobs) if (job.status === 'ready' && !job.installation) this.queueInstallation(job.id);
    for (const job of state.jobs) if (ACTIVE.has(job.status)) {
      const budget = store.budgetSummary(job.id);
      if (budget.elapsedMs >= job.budget.maxDurationMs || (GENERATING.has(job.status) && (budget.job.remainingTokens <= 0 || budget.daily.remainingTokens <= 0))) await this.stop(job.id, 'paused', 'Research budget exhausted');
      else if (GENERATING.has(job.status)) await this.reconcileIdleJob(job.id);
      else if (job.status === 'verifying' && (!job.acceptance || job.acceptance.artifactId !== job.artifactId)) this.queueAcceptance(job.id);
    }
    await this.versionMonitor.configure(state.settings.localVersionFile);
    await this.versionMonitor.tick(state.settings.monitorIntervalMinutes);
    await this.recoverLocalInvestigations();
    await this.startQueuedInvestigation();
    if (state.settings.monitorEnabled && Date.now() - this.lastScanAt >= state.settings.monitorIntervalMinutes * 60_000) await this.scan(this.lifetime.signal);
  }
}
