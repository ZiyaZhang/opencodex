import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, unlink, realpath, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Artifact, BudgetSummary, CandidateInput, CapabilitySnapshot, CreateJobInput, EvidenceInput, ForegroundRequest, Job, JobBudget, JobStatus, Settings, SpecInput, StoreOptions, StoreState, TokenReservation, TokenUsage, VerificationInput } from './types.js';
import { check, count, relativePath, textValue, validateCapabilities, validateScreenshotMetadata, validateSettings, validateState, ValidationError } from './validation.js';
import { readScreenshotFile } from './screenshot.js';

export const STATE_FILE = 'opencodex-state.json';
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ defaultJobTokenLimit: 120_000, dailyTokenLimit: 300_000, maxDurationMs: 3_600_000, maxRepairRounds: 3, monitorEnabled: false, monitorIntervalMinutes: 360, localVersionFile: '', updateResearchMode: 'notify' });
const ACTIVE = new Set<JobStatus>(['researching', 'specifying', 'building', 'verifying']);
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  detected: ['draft', 'queued', 'cancelled'], draft: ['queued', 'cancelled'],
  queued: ['researching', 'paused', 'blocked', 'failed', 'cancelled'],
  researching: ['specifying', 'paused', 'blocked', 'failed', 'cancelled'],
  specifying: ['building', 'researched', 'paused', 'blocked', 'failed', 'cancelled'],
  building: ['verifying', 'paused', 'blocked', 'failed', 'cancelled'],
  verifying: ['ready', 'paused', 'blocked', 'failed', 'cancelled'],
  ready: ['queued', 'cancelled'], paused: ['queued', 'blocked', 'cancelled'],
  blocked: ['queued', 'paused', 'cancelled'], failed: ['queued', 'paused', 'cancelled'], installed: [], covered: [], researched: [], cancelled: [],
};
export class BudgetLimitError extends Error {
  constructor(message: string) { super(message); this.name = 'BudgetLimitError'; }
}
function stamp(now: () => Date) { const date = now(); check(Number.isFinite(date.getTime()), 'Clock returned an invalid date'); return date.toISOString(); }
function initial(at: string): StoreState {
  return { schemaVersion: 1, createdAt: at, updatedAt: at, settings: { ...DEFAULT_SETTINGS }, jobs: [], candidates: [], evidence: [], specs: [], artifacts: [], verifications: [], reservations: [], capabilities: null };
}
function findJob(state: StoreState, id: string): Job {
  const job = state.jobs.find(item => item.id === id); check(job, `Unknown job: ${id}`); return job;
}
function elapsed(job: Job, at: string) {
  return job.elapsedMs + (job.activeSince ? Math.max(0, Date.parse(at) - Date.parse(job.activeSince)) : 0);
}
function releaseForeground(state: StoreState, jobId: string, at: string, reason: string) {
  if (state.foregroundLease?.jobId !== jobId) return;
  const request = findJob(state, jobId).foreground;
  if (request?.id === state.foregroundLease.requestId) { request.releasedAt = at; request.releaseReason = reason; }
  delete state.foregroundLease;
}
function change(state: StoreState, job: Job, status: JobStatus, at: string, reason: string) {
  const previous = job.status;
  if (['paused', 'blocked', 'failed', 'cancelled', 'ready', 'covered', 'researched', 'installed'].includes(status)) releaseForeground(state, job.id, at, reason || `Job entered ${status}`);
  if (ACTIVE.has(previous) && !ACTIVE.has(status)) { job.elapsedMs = elapsed(job, at); job.activeSince = null; }
  if (!ACTIVE.has(previous) && ACTIVE.has(status)) job.activeSince = at;
  job.status = status; job.updatedAt = at; job.history.push({ at, from: previous, to: status, reason });
}
function summary(state: StoreState, jobId: string, at: string): BudgetSummary {
  const job = findJob(state, jobId); const day = at.slice(0, 10);
  const aggregate = (requests: TokenReservation[], limit: number) => {
    const confirmedTokens = requests.reduce((sum, r) => sum + (r.status === 'settled' ? r.usage!.inputTokens + r.usage!.outputTokens : 0), 0);
    const reservedTokens = requests.reduce((sum, r) => sum + (r.status !== 'settled' ? r.reservedTokens : 0), 0);
    count(confirmedTokens + reservedTokens, 'budget ledger total');
    return { confirmedTokens, reservedTokens, unknownRequests: requests.filter(r => r.status === 'unknown').length, remainingTokens: Math.max(0, limit - confirmedTokens - reservedTokens) };
  };
  return {
    job: aggregate(state.reservations.filter(r => r.jobId === jobId), job.budget.tokenLimit),
    // Unknown and in-flight reservations survive midnight. Confirmed usage is charged
    // on settlement day, so a response arriving after midnight cannot disappear.
    daily: aggregate(state.reservations.filter(r => r.status !== 'settled' || r.settledAt!.slice(0, 10) === day), state.settings.dailyTokenLimit),
    day, elapsedMs: elapsed(job, at), repairRounds: job.repairRounds,
  };
}
function inRoot(root: string, path: string) {
  const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** One owner per directory. All mutations use copy/validate/fsync/rename before publishing. */
export class OpenCodexStore {
  readonly directory: string;
  readonly artifactRoot: string;
  readonly filePath: string;
  #state: StoreState;
  #now: () => Date;
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  #closing = false;
  #lockToken: string;

  private constructor(directory: string, artifactRoot: string, state: StoreState, now: () => Date, lockToken: string) {
    this.directory = directory; this.artifactRoot = artifactRoot; this.filePath = join(directory, STATE_FILE); this.#state = state; this.#now = now; this.#lockToken = lockToken;
  }

  static async open(options: StoreOptions): Promise<OpenCodexStore> {
    const now = options.now ?? (() => new Date());
    await mkdir(resolve(options.directory), { recursive: true, mode: 0o700 });
    const directory = await realpath(resolve(options.directory));
    const artifactRoot = resolve(options.artifactRoot ?? join(directory, 'artifacts'));
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    const resolvedArtifacts = await realpath(artifactRoot);
    const lockPath = join(directory, `${STATE_FILE}.lock`); const lockToken = randomUUID();
    await acquireLock(lockPath, lockToken);
    try {
      const filePath = join(directory, STATE_FILE); let state: StoreState; let fresh = false; let migrated = false;
      try {
        const stat = await lstat(filePath); check(stat.isFile() && !stat.isSymbolicLink(), 'State file must be a regular file'); check(stat.size <= 64 * 1024 * 1024, 'State file exceeds the 64 MiB limit');
        const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
        // Add only known, previously absent schema-1 defaults. Invalid supplied
        // values and every unrelated malformed field still fail full validation.
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as Record<string, unknown>).schemaVersion === 1) {
          const legacy = parsed as Record<string, unknown>; const settings = legacy.settings;
          if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
            const config = settings as Record<string, unknown>;
            for (const key of ['localVersionFile', 'updateResearchMode'] as const) if (!Object.hasOwn(config, key)) { config[key] = DEFAULT_SETTINGS[key]; migrated = true; }
          }
          if (Array.isArray(legacy.jobs)) for (const job of legacy.jobs) if (job && typeof job === 'object' && !Array.isArray(job) && !Object.hasOwn(job, 'mode')) { job.mode = 'reconstruct'; migrated = true; }
        }
        validateState(parsed); state = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        state = initial(stamp(now)); fresh = true;
      }
      const store = new OpenCodexStore(directory, resolvedArtifacts, state, now, lockToken);
      let recovered = false; const at = stamp(now);
      if (state.foregroundLease) { releaseForeground(state, state.foregroundLease.jobId, at, 'Process restarted; foreground control needs fresh user approval'); recovered = true; }
      for (const job of state.jobs) if (job.foreground?.approvedAt && !job.foreground.releasedAt && !job.foreground.completedAt) {
        job.foreground.releasedAt = at; job.foreground.releaseReason = 'No live foreground lease after restart; fresh approval required'; recovered = true;
      }
      for (const request of state.reservations) if (request.status === 'inflight') {
        request.status = 'unknown'; request.unknownReason = 'Process restarted before usage was confirmed; reservation retained'; recovered = true;
      }
      for (const job of state.jobs) if (ACTIVE.has(job.status) || job.status === 'queued') {
        change(state, job, 'paused', at, 'Process restarted; review and resume explicitly'); recovered = true;
      }
      if (fresh || recovered || migrated) { state.updatedAt = at; validateState(state); await store.#write(state); }
      return store;
    } catch (error) { await releaseLock(lockPath, lockToken); throw error; }
  }

  snapshot(): StoreState { check(!this.#closed, 'Store is closed'); return structuredClone(this.#state); }
  getJob(id: string): Job { return structuredClone(findJob(this.#state, id)); }
  budgetSummary(jobId: string): BudgetSummary { return summary(this.#state, jobId, stamp(this.#now)); }

  async close(): Promise<void> {
    this.#closing = true; await this.#queue; if (this.#closed) return; this.#closed = true;
    await releaseLock(join(this.directory, `${STATE_FILE}.lock`), this.#lockToken);
  }

  async #write(state: StoreState): Promise<void> {
    const content = `${JSON.stringify(state, null, 2)}\n`;
    check(Buffer.byteLength(content, 'utf8') <= 64 * 1024 * 1024, 'State file exceeds the 64 MiB limit; archive completed jobs before continuing');
    const temp = join(this.directory, `.${STATE_FILE}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.filePath);
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  #mutate<T>(edit: (state: StoreState, at: string) => T | Promise<T>): Promise<T> {
    if (this.#closing || this.#closed) return Promise.reject(new ValidationError('Store is closed'));
    const work = this.#queue.then(async () => {
      check(!this.#closed, 'Store is closed'); const draft = structuredClone(this.#state); const at = stamp(this.#now);
      const result = await edit(draft, at); draft.updatedAt = at; validateState(draft);
      await this.#write(draft); this.#state = draft; return structuredClone(result);
    });
    this.#queue = work.then(() => undefined, () => undefined); return work;
  }

  updateSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.#mutate(state => { state.settings = { ...state.settings, ...patch }; validateSettings(state.settings); return state.settings; });
  }

  createJob(input: CreateJobInput): Promise<Job> {
    return this.#mutate((state, at) => {
      const source = input.source ?? 'user';
      const job: Job = { id: randomUUID(), title: input.title, description: input.description ?? '', source, mode: input.mode ?? 'reconstruct', status: source === 'discovery' ? 'detected' : 'draft', createdAt: at, updatedAt: at,
        budget: { tokenLimit: state.settings.defaultJobTokenLimit, maxDurationMs: state.settings.maxDurationMs, maxRepairRounds: state.settings.maxRepairRounds, ...input.budget }, elapsedMs: 0, activeSince: null, repairRounds: 0, history: [], budgetHistory: [], sessionIds: [], sessionBindings: [], ...(input.candidateId ? { candidateId: input.candidateId } : {}) };
      job.history.push({ at, from: null, to: job.status, reason: source === 'user' ? 'Requested by user' : 'Discovered feature; awaiting selection' });
      if (input.candidateId) { const candidate = state.candidates.find(c => c.id === input.candidateId); check(candidate, 'Unknown candidate'); candidate.status = 'selected'; candidate.updatedAt = at; }
      state.jobs.push(job); return job;
    });
  }

  transitionJob(id: string, status: JobStatus, options: { reason?: string } = {}): Promise<Job> {
    return this.#mutate(async (state, at) => {
      const job = findJob(state, id); check(TRANSITIONS[job.status].includes(status), `Invalid transition ${job.status} -> ${status}`);
      if (job.mode === 'investigate') check(!['building', 'verifying', 'ready'].includes(status), 'Investigation jobs do not reconstruct plugins; select a feature to create a reconstruction job');
      if (ACTIVE.has(status)) {
        const usage = summary(state, id, at); check(usage.elapsedMs < job.budget.maxDurationMs, 'Run time budget exhausted');
        check(usage.job.remainingTokens > 0 && usage.daily.remainingTokens > 0, 'Token budget exhausted');
      }
      if (status === 'ready') await this.#assertReady(state, job);
      if (status === 'researched') {
        check(job.mode === 'investigate', 'Only investigation jobs can finish as researched');
        const spec = state.specs.filter(s => s.jobId === id).at(-1);
        check(spec && spec.evidenceIds.some(evidenceId => state.evidence.some(e => e.id === evidenceId && e.kind === 'observed')), 'Research completion needs a specification grounded in observed evidence');
        for (const evidenceId of spec.evidenceIds) {
          const evidence = state.evidence.find(e => e.id === evidenceId)!;
          if (evidence.localPath) check((await this.#inspectFile(evidence.localPath)).sha256 === evidence.sha256, 'Research evidence changed after recording');
        }
      }
      change(state, job, status, at, options.reason ?? ''); return job;
    });
  }

  extendBudget(id: string, patch: Partial<JobBudget>): Promise<Job> {
    return this.#mutate((state, at) => {
      const job = findJob(state, id); check(!['installed', 'covered', 'researched', 'cancelled'].includes(job.status), 'Cannot change a terminal job budget');
      const next = { ...job.budget, ...patch };
      for (const key of ['tokenLimit', 'maxDurationMs', 'maxRepairRounds'] as const) check(next[key] >= job.budget[key], 'Budget extensions cannot erase or lower prior limits');
      job.budgetHistory.push({ at, previous: { ...job.budget }, next: { ...next } }); job.budget = next; job.updatedAt = at; return job;
    });
  }

  async reserveTokens(jobId: string, input: { requestId: string; reservedTokens: number }): Promise<TokenReservation> {
    textValue(input.requestId, 'requestId'); count(input.reservedTokens, 'reservedTokens', 1);
    const result = await this.#mutate((state, at) => {
      const job = findJob(state, jobId); const existing = state.reservations.find(r => r.requestId === input.requestId);
      if (existing) { check(existing.jobId === jobId && existing.reservedTokens === input.reservedTokens && existing.status === 'inflight', 'Request id already used; retries need a new request id'); return { reservation: existing }; }
      check(ACTIVE.has(job.status), 'Tokens may only be reserved for an active job');
      const usage = summary(state, jobId, at);
      const reason = usage.elapsedMs >= job.budget.maxDurationMs
        ? 'Run time budget exhausted'
        : input.reservedTokens > usage.job.remainingTokens
          ? `Next request needs ${input.reservedTokens} reserved tokens; job has ${usage.job.remainingTokens} remaining`
          : input.reservedTokens > usage.daily.remainingTokens
            ? `Next request needs ${input.reservedTokens} reserved tokens; daily budget has ${usage.daily.remainingTokens} remaining`
            : undefined;
      if (reason) { change(state, job, 'paused', at, reason); return { error: reason }; }
      const reservation: TokenReservation = { requestId: input.requestId, jobId, reservedTokens: input.reservedTokens, reservedAt: at, status: 'inflight' };
      state.reservations.push(reservation); return { reservation };
    });
    if (result.error) throw new BudgetLimitError(result.error); return result.reservation!;
  }

  reconcileUsage(requestId: string, usage: TokenUsage | null): Promise<TokenReservation> {
    if (usage) { count(usage.inputTokens, 'inputTokens'); count(usage.outputTokens, 'outputTokens'); count(usage.inputTokens + usage.outputTokens, 'totalTokens'); }
    return this.#mutate((state, at) => {
      const request = state.reservations.find(r => r.requestId === requestId); check(request, 'Unknown request id');
      if (request.status === 'settled') { check(usage && usage.inputTokens === request.usage!.inputTokens && usage.outputTokens === request.usage!.outputTokens, 'Settled usage is immutable'); return request; }
      if (usage === null) { request.status = 'unknown'; request.unknownReason = 'Provider did not supply authoritative usage; reservation retained'; }
      else { request.status = 'settled'; request.usage = { ...usage }; request.settledAt = at; delete request.unknownReason; }
      // Actual provider usage is authoritative even if it exceeds the estimate.
      // Stop subsequent work rather than clipping the ledger to the configured cap.
      for (const job of state.jobs) if (ACTIVE.has(job.status)) {
        const totals = summary(state, job.id, at);
        if (totals.job.remainingTokens === 0 || totals.daily.remainingTokens === 0) change(state, job, 'paused', at, 'Confirmed usage and outstanding reservations reached the token limit');
      }
      return request;
    });
  }

  async startRepair(id: string): Promise<Job> {
    const result = await this.#mutate((state, at) => {
      const job = findJob(state, id); check(job.status === 'verifying', 'Repair can only start after verification');
      const usage = summary(state, id, at);
      const reason = job.repairRounds >= job.budget.maxRepairRounds ? 'Repair round budget exhausted' : usage.elapsedMs >= job.budget.maxDurationMs ? 'Run time budget exhausted' : usage.job.remainingTokens === 0 || usage.daily.remainingTokens === 0 ? 'Token budget exhausted' : undefined;
      if (reason) { change(state, job, 'paused', at, reason); return { error: reason }; }
      job.repairRounds += 1; change(state, job, 'building', at, 'Starting a bounded repair round'); return { job };
    });
    if (result.error) throw new BudgetLimitError(result.error); return result.job!;
  }

  saveCandidate(input: CandidateInput) {
    return this.#mutate((state, at) => {
      check(!Object.hasOwn(input, 'autoInvestigate'), 'Automatic investigation eligibility is assigned by the Host at first detection');
      let candidate = state.candidates.find(c => c.fingerprint === input.fingerprint);
      if (candidate) { Object.assign(candidate, input, { updatedAt: at }); }
      else { candidate = { ...input, id: randomUUID(), detectedAt: at, updatedAt: at, status: input.status ?? 'new', autoInvestigate: input.sourceType === 'local-version' && state.settings.updateResearchMode === 'investigate' }; state.candidates.push(candidate); }
      return candidate;
    });
  }

  addEvidence(jobId: string, input: EvidenceInput) {
    return this.#mutate(async (state, at) => {
      findJob(state, jobId);
      const file = input.localPath === undefined ? undefined : await this.#inspectFile(input.localPath);
      const evidence = { ...input, id: randomUUID(), jobId, createdAt: at, relatedEvidenceIds: input.relatedEvidenceIds ?? [], ...(file ? { sha256: file.sha256 } : {}) };
      state.evidence.push(evidence); return evidence;
    });
  }

  saveSpec(jobId: string, input: SpecInput) {
    return this.#mutate((state, at) => {
      const job = findJob(state, jobId); check(['researching', 'specifying'].includes(job.status), 'Specs must be recorded during research or specification');
      const spec = { ...input, id: randomUUID(), jobId, createdAt: at }; state.specs.push(spec); return spec;
    });
  }

  registerArtifact(jobId: string, input: { path: string; label?: string; kind?: Artifact['kind']; screenshot?: Artifact['screenshot'] }): Promise<Artifact> {
    return this.#mutate(async (state, at) => {
      const job = findJob(state, jobId); const kind = input.kind ?? 'plugin';
      if (kind === 'plugin') check(job.mode === 'reconstruct', 'Investigation jobs cannot register plugin artifacts');
      if (kind === 'plugin') check(['building', 'verifying'].includes(job.status), 'Plugin artifacts may only be registered while building or verifying');
      if (kind === 'screenshot') validateScreenshotMetadata(input.screenshot);
      else check(input.screenshot === undefined, 'Screenshot metadata requires a screenshot artifact');
      const file = await this.#inspectFile(input.path, kind === 'screenshot' ? jobId : undefined);
      const artifact: Artifact = { id: randomUUID(), jobId, path: input.path, label: input.label ?? input.path, kind, ...file, ...(input.screenshot ? { screenshot: structuredClone(input.screenshot) } : {}), createdAt: at };
      state.artifacts.push(artifact); if (kind === 'plugin') { job.artifactId = artifact.id; job.updatedAt = at; } return artifact;
    });
  }

  recordVerification(jobId: string, input: VerificationInput) {
    return this.#mutate(async (state, at) => {
      const job = findJob(state, jobId); check(job.status === 'verifying', 'Verification records require the verifying state');
      const artifact = state.artifacts.find(a => a.id === input.artifactId && a.jobId === jobId); check(artifact?.kind === 'plugin', 'Verification needs a same-job plugin artifact');
      const spec = state.specs.filter(s => s.jobId === jobId).at(-1); check(spec, 'Verification needs a feature spec');
      check((await this.#inspectFile(artifact.path)).sha256 === artifact.sha256, 'Artifact changed after registration');
      for (const id of input.evidenceIds) {
        const evidence = state.evidence.find(e => e.id === id && e.jobId === jobId); check(evidence, 'Unknown verification evidence');
        if (evidence.localPath) check((await this.#inspectFile(evidence.localPath)).sha256 === evidence.sha256, 'Evidence changed after recording');
      }
      await this.#assertScreenshots(state, jobId, input.screenshotIds, input.scope === 'visual' && input.outcome === 'passed');
      const verification = { ...input, id: randomUUID(), jobId, specId: spec.id, artifactSha256: artifact.sha256, createdAt: at };
      state.verifications.push(verification); return verification;
    });
  }

  saveCapabilities(capabilities: CapabilitySnapshot): Promise<CapabilitySnapshot> {
    return this.#mutate(state => { validateCapabilities(capabilities); state.capabilities = structuredClone(capabilities); return capabilities; });
  }

  bindSession(jobId: string, input: { sessionId: string; parentSessionId?: string; workdir?: string }): Promise<Job> {
    return this.#mutate(async (state, at) => {
      const job = findJob(state, jobId); textValue(input.sessionId, 'sessionId');
      const existing = state.jobs.find(j => j.sessionIds.includes(input.sessionId));
      if (existing) { check(existing.id === jobId && existing.sessionBindings.find(b => b.sessionId === input.sessionId)?.parentSessionId === input.parentSessionId, 'Session is already bound elsewhere'); return job; }
      if (job.sessionId) check(input.parentSessionId && job.sessionIds.includes(input.parentSessionId), 'Child session needs an already registered parent');
      else { check(!input.parentSessionId, 'First session must be a root session'); job.sessionId = input.sessionId; }
      if (input.workdir) {
        const path = await realpath(resolve(input.workdir)); check(inRoot(this.artifactRoot, path), 'Session workdir must stay inside the artifact root'); check((await lstat(path)).isDirectory(), 'Session workdir must be a directory');
        check(!job.workdir || job.workdir === path, 'Job workdir is immutable'); job.workdir = path;
      }
      job.sessionIds.push(input.sessionId); job.sessionBindings.push({ sessionId: input.sessionId, ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}), boundAt: at }); job.updatedAt = at; return job;
    });
  }

  requestForeground(jobId: string, input: Pick<ForegroundRequest, 'target' | 'scope' | 'steps'>) {
    return this.#mutate((state, at) => {
      const job = findJob(state, jobId); check(ACTIVE.has(job.status) || job.status === 'paused', 'Foreground requests require active or paused research');
      check(!job.foreground || job.foreground.completedAt || job.foreground.releasedAt, 'An existing foreground request is still pending');
      job.foreground = { ...input, id: randomUUID(), requestedAt: at };
      if (ACTIVE.has(job.status)) change(state, job, 'paused', at, 'Waiting for the user to start foreground operations');
      job.updatedAt = at; return job.foreground;
    });
  }

  approveForeground(jobId: string, requestId: string) {
    return this.#mutate((state, at) => {
      const job = findJob(state, jobId); check(['paused', 'blocked', 'failed'].includes(job.status), 'Foreground approval requires a paused, blocked or failed job');
      const request = job.foreground; check(request?.id === requestId && !request.completedAt, 'Unknown or completed foreground request');
      const lease = state.foregroundLease;
      check(!lease || (lease.jobId === jobId && lease.requestId === requestId), 'Another OpenCodex job controls the foreground; finish or pause it before starting this request');
      if (job.status !== 'paused') change(state, job, 'paused', at, 'User explicitly restarted the foreground request');
      if (!lease) {
        request.approvedAt = at; delete request.releasedAt; delete request.releaseReason;
        state.foregroundLease = { jobId, requestId, approvedAt: at };
      }
      job.updatedAt = at; return request;
    });
  }

  completeForeground(jobId: string, requestId: string) {
    return this.#mutate((state, at) => {
      const job = findJob(state, jobId); const request = job.foreground;
      check(request?.id === requestId && request.approvedAt && !request.completedAt, 'Foreground request needs prior user approval');
      check(state.foregroundLease?.jobId === jobId && state.foregroundLease.requestId === requestId && !request.releasedAt, 'Foreground approval was released; start the request again');
      request.completedAt = at; releaseForeground(state, jobId, at, 'Foreground steps completed'); job.updatedAt = at; return request;
    });
  }

  /** Release an approved request when user pause or a failed start leaves the job paused. */
  revokeForeground(jobId: string, requestId: string, reason: string) {
    return this.#mutate((state, at) => {
      const job = findJob(state, jobId); textValue(reason, 'foreground revocation reason');
      check(job.foreground?.id === requestId, 'Unknown foreground request');
      releaseForeground(state, jobId, at, reason); job.updatedAt = at; return job.foreground;
    });
  }

  /** Call only after an explicit UI action and a successful real installer result. */
  markInstalled(jobId: string, input: { userConfirmed: true; artifactId: string; receipt: string }): Promise<Job> {
    return this.#mutate(async (state, at) => {
      const job = findJob(state, jobId); check(job.status === 'ready', 'Only a ready job can be installed');
      check(input.userConfirmed === true && input.artifactId === job.artifactId, 'Installation requires explicit confirmation for the current artifact'); textValue(input.receipt, 'installation receipt');
      await this.#assertReady(state, job); job.installedReceipt = input.receipt; change(state, job, 'installed', at, 'User confirmed installation; installer returned a receipt'); return job;
    });
  }

  /** User-reviewed calibration: the existing DSH capability already satisfies the spec. */
  markCovered(jobId: string, input: { userConfirmed: true; specId: string; reason: string }): Promise<Job> {
    return this.#mutate(async (state, at) => {
      const job = findJob(state, jobId); check(['researching', 'specifying', 'verifying'].includes(job.status), 'Coverage review requires research, specification or verification');
      check(job.mode === 'reconstruct', 'Investigation inventory does not establish existing-feature equivalence');
      const spec = state.specs.filter(s => s.jobId === jobId).at(-1);
      check(input.userConfirmed === true && spec?.id === input.specId, 'Coverage requires explicit confirmation for the latest spec'); textValue(input.reason, 'coverage reason');
      check(spec.existingCapabilities.length > 0 && spec.gaps.length === 0, 'Coverage needs existing capabilities and no known gaps');
      const observed = spec.evidenceIds.map(id => state.evidence.find(e => e.id === id)).filter(e => e?.kind === 'observed' && e.localPath);
      check(observed.length > 0, 'Coverage requires observed local evidence');
      for (const evidence of observed) check((await this.#inspectFile(evidence!.localPath!)).sha256 === evidence!.sha256, 'Coverage evidence no longer matches recorded bytes');
      job.coverage = { specId: spec.id, confirmedAt: at, reason: input.reason }; change(state, job, 'covered', at, input.reason); return job;
    });
  }

  async #assertReady(state: StoreState, job: Job) {
    const probe = structuredClone(state); findJob(probe, job.id).status = 'ready';
    const target = findJob(probe, job.id); target.activeSince = null; target.history.push({ at: stamp(this.#now), from: job.status, to: 'ready', reason: 'Readiness validation' });
    releaseForeground(probe, job.id, stamp(this.#now), 'Readiness validation'); validateState(probe);
    const artifact = state.artifacts.find(a => a.id === job.artifactId)!;
    check((await this.#inspectFile(artifact.path)).sha256 === artifact.sha256, 'Plugin artifact no longer matches verified bytes');
    const specId = state.specs.filter(s => s.jobId === job.id).at(-1)!.id;
    const records = state.verifications.filter(v => v.jobId === job.id && v.artifactId === artifact.id && v.specId === specId);
    for (const scope of ['behavior', 'visual', 'lifecycle']) {
      const record = records.filter(v => v.scope === scope).at(-1)!;
      for (const id of record.evidenceIds) {
        const evidence = state.evidence.find(e => e.id === id)!;
        if (evidence.localPath) check((await this.#inspectFile(evidence.localPath)).sha256 === evidence.sha256, 'Verification evidence no longer matches recorded bytes');
      }
      await this.#assertScreenshots(state, job.id, record.screenshotIds, scope === 'visual');
    }
  }

  async #assertScreenshots(state: StoreState, jobId: string, ids: string[] | undefined, requirePair: boolean) {
    check(ids === undefined || Array.isArray(ids), 'screenshotIds must be an array');
    const screenshotIds = ids ?? [];
    check(new Set(screenshotIds).size === screenshotIds.length, 'Duplicate verification screenshot');
    const subjects = new Set<string>();
    for (const id of screenshotIds) {
      const artifact = state.artifacts.find(a => a.id === id && a.jobId === jobId);
      check(artifact?.kind === 'screenshot', 'Verification screenshot must be a same-job screenshot artifact');
      if (requirePair) validateScreenshotMetadata(artifact.screenshot);
      if (artifact.screenshot) subjects.add(artifact.screenshot.subject);
      const file = await this.#inspectFile(artifact.path, jobId);
      check(file.sha256 === artifact.sha256 && file.bytes === artifact.bytes, 'Verification screenshot no longer matches recorded bytes');
    }
    if (requirePair) check(subjects.has('codex') && subjects.has('dsh'), 'Passed visual verification requires explicitly linked Codex and DSH screenshots; otherwise record partial');
  }

  async #inspectFile(path: string, screenshotJobId?: string): Promise<{ sha256: string; bytes: number }> {
    if (screenshotJobId !== undefined) {
      const bytes = await readScreenshotFile(this.artifactRoot, screenshotJobId, path);
      return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    }
    relativePath(path); const requested = resolve(this.artifactRoot, path); const resolved = await realpath(requested);
    check(inRoot(this.artifactRoot, resolved), 'Artifact path escapes its root through a symlink');
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      check(await realpath(requested) === resolved, 'Artifact path changed during inspection');
      const before = await handle.stat(); check(before.isFile(), 'Artifacts must be regular files');
      check(before.size <= MAX_ARTIFACT_BYTES, 'Artifact exceeds the 64 MiB inspection limit');
      const hash = createHash('sha256'); let bytesRead = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        bytesRead += chunk.length; check(bytesRead <= MAX_ARTIFACT_BYTES, 'Artifact grew beyond the 64 MiB inspection limit'); hash.update(chunk);
      }
      const after = await handle.stat(); check(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ino === after.ino, 'Artifact changed during inspection');
      return { sha256: hash.digest('hex'), bytes: after.size };
    } finally { await handle.close(); }
  }
}

async function acquireLock(path: string, token: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token }), 'utf8'); await handle.sync(); } finally { await handle.close(); }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt !== 0) throw error;
      // Serialize stale-owner reclamation so two simultaneous starts cannot
      // unlink a fresh owner's lock after both observed the old dead process.
      const recoveryPath = `${path}.recover`; let recovery;
      try { recovery = await open(recoveryPath, 'wx', 0o600); }
      catch { throw new ValidationError('Store lock recovery is already active; retry opening later'); }
      try {
        let owner: { pid?: unknown; token?: unknown };
        try { owner = JSON.parse(await readFile(path, 'utf8')); } catch { throw new ValidationError('Unreadable store lock; refusing concurrent access'); }
        check(typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string', 'Invalid store lock; refusing concurrent access');
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        check(!alive, 'OpenCodex state is already open in another store; close it before reopening');
        await unlink(path);
      } finally { await recovery.close(); await unlink(recoveryPath); }
    }
  }
}
async function releaseLock(path: string, token: string): Promise<void> {
  try { const owner = JSON.parse(await readFile(path, 'utf8')); check(owner.token === token, 'Store lock ownership changed'); await unlink(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
