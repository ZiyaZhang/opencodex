import { JOB_STATUSES, type ScreenshotMetadata, type StoreState } from './types.js';
import { isAbsolute } from 'node:path';

export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ValidationError(message);
}
export function textValue(value: unknown, label: string, allowEmpty = false): asserts value is string {
  check(typeof value === 'string' && value.length <= 100_000 && (allowEmpty || value.trim().length > 0), `${label} must be a nonempty string`);
}
export function count(value: unknown, label: string, minimum = 0): asserts value is number {
  check(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum, `${label} must be an integer >= ${minimum}`);
}
export function isoDate(value: unknown, label: string): asserts value is string {
  textValue(value, label);
  check(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, `${label} must be an ISO timestamp`);
}
export function webUrl(value: unknown, label: string): asserts value is string {
  textValue(value, label);
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationError(`${label} must be an absolute HTTP(S) URL`); }
  check(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, `${label} must be a credential-free HTTP(S) URL`);
}
export function relativePath(value: unknown, label = 'path'): asserts value is string {
  textValue(value, label);
  check(!value.includes('\0') && !value.includes('\\') && !value.startsWith('/') && !/^[a-zA-Z]:/.test(value), `${label} must be relative to the artifact root`);
  check(value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'), `${label} contains an unsafe path segment`);
}
type Dict = Record<string, unknown>;
function object(value: unknown, label: string, required: string[], optional: string[] = []): Dict {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  const item = value as Dict;
  check(required.every(key => Object.hasOwn(item, key)), `${label} has missing fields`);
  const allowed = new Set([...required, ...optional]);
  check(Object.keys(item).every(key => allowed.has(key)), `${label} has unsupported fields`);
  return item;
}
function list(value: unknown, label: string): unknown[] {
  check(Array.isArray(value) && value.length <= 100_000, `${label} must be an array`); return value;
}
function strings(value: unknown, label: string): string[] {
  const values = list(value, label); values.forEach(v => textValue(v, label)); return values as string[];
}
function enumeration(value: unknown, options: readonly string[], label: string) {
  check(typeof value === 'string' && options.includes(value), `${label} is invalid`);
}
function digest(value: unknown) { check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Invalid SHA-256'); }
function budget(value: unknown) {
  const b = object(value, 'budget', ['tokenLimit', 'maxDurationMs', 'maxRepairRounds']);
  count(b.tokenLimit, 'tokenLimit', 1); count(b.maxDurationMs, 'maxDurationMs', 1); count(b.maxRepairRounds, 'maxRepairRounds');
}
function idDates(item: Dict, extra = false) {
  textValue(item.id, 'id'); isoDate(item.createdAt, 'createdAt');
  if (extra) isoDate(item.updatedAt, 'updatedAt');
}
export function validateSettings(value: unknown) {
  const s = object(value, 'settings', ['defaultJobTokenLimit', 'dailyTokenLimit', 'maxDurationMs', 'maxRepairRounds', 'monitorEnabled', 'monitorIntervalMinutes', 'localVersionFile', 'updateResearchMode']);
  for (const key of ['defaultJobTokenLimit', 'dailyTokenLimit', 'maxDurationMs', 'monitorIntervalMinutes']) count(s[key], key, 1);
  count(s.maxRepairRounds, 'maxRepairRounds'); check(typeof s.monitorEnabled === 'boolean', 'monitorEnabled must be boolean');
  textValue(s.localVersionFile, 'localVersionFile', true);
  check(!s.localVersionFile.includes('\0') && (s.localVersionFile === '' || isAbsolute(s.localVersionFile)), 'localVersionFile must be empty or an absolute file path');
  enumeration(s.updateResearchMode, ['notify', 'investigate'], 'updateResearchMode');
}
export function validateCapabilities(value: unknown) {
  const c = object(value, 'capabilities', ['checkedAt', 'checks']); isoDate(c.checkedAt, 'checkedAt');
  const ids = new Set<string>();
  for (const raw of list(c.checks, 'checks')) {
    const item = object(raw, 'capability', ['id', 'available', 'detail'], ['version']);
    textValue(item.id, 'capability id'); textValue(item.detail, 'detail', true);
    check(!ids.has(item.id), 'Duplicate capability id'); ids.add(item.id);
    check(typeof item.available === 'boolean', 'available must be boolean');
    if (item.version !== undefined) textValue(item.version, 'version');
  }
}

export function validateScreenshotMetadata(value: unknown): asserts value is ScreenshotMetadata {
  const s = object(value, 'screenshot metadata', ['subject', 'caption', 'provenance'], ['sourceUrl', 'version']);
  enumeration(s.subject, ['codex', 'dsh', 'other'], 'screenshot subject');
  enumeration(s.provenance, ['user', 'capture', 'public-source'], 'screenshot provenance');
  textValue(s.caption, 'screenshot caption');
  if (s.provenance === 'public-source') check(s.sourceUrl !== undefined, 'Public-source screenshot requires sourceUrl');
  if (s.sourceUrl !== undefined) webUrl(s.sourceUrl, 'screenshot sourceUrl');
  if (s.version !== undefined) textValue(s.version, 'screenshot version');
}

/** Fail closed on malformed or unsupported state. Never replace a bad file with defaults. */
export function validateState(value: unknown): asserts value is StoreState {
  const s = object(value, 'state', ['schemaVersion', 'createdAt', 'updatedAt', 'settings', 'jobs', 'candidates', 'evidence', 'specs', 'artifacts', 'verifications', 'reservations', 'capabilities'], ['foregroundLease']);
  check(s.schemaVersion === 1, 'Unsupported OpenCodex state version'); isoDate(s.createdAt, 'createdAt'); isoDate(s.updatedAt, 'updatedAt'); validateSettings(s.settings);
  if (s.capabilities !== null) validateCapabilities(s.capabilities);
  for (const raw of list(s.jobs, 'jobs')) {
    const j = object(raw, 'job', ['id', 'title', 'description', 'source', 'mode', 'status', 'createdAt', 'updatedAt', 'budget', 'elapsedMs', 'activeSince', 'repairRounds', 'history', 'budgetHistory', 'sessionIds', 'sessionBindings'], ['candidateId', 'sessionId', 'workdir', 'foreground', 'artifactId', 'installedReceipt', 'coverage']);
    idDates(j, true); textValue(j.title, 'title'); textValue(j.description, 'description', true); enumeration(j.source, ['user', 'discovery'], 'source'); enumeration(j.status, JOB_STATUSES, 'status'); budget(j.budget);
    enumeration(j.mode, ['reconstruct', 'investigate'], 'job mode');
    if (j.mode === 'investigate') check(!['building', 'verifying', 'ready', 'covered', 'installed'].includes(j.status as string), 'Investigation jobs cannot reconstruct or install plugins');
    count(j.elapsedMs, 'elapsedMs'); count(j.repairRounds, 'repairRounds'); if (j.activeSince !== null) isoDate(j.activeSince, 'activeSince');
    check((j.activeSince !== null) === ['researching', 'specifying', 'building', 'verifying'].includes(j.status as string), 'Job activity clock disagrees with state');
    for (const key of ['candidateId', 'sessionId', 'workdir', 'artifactId', 'installedReceipt']) if (j[key] !== undefined) textValue(j[key], key);
    const history = list(j.history, 'history'); check(history.length > 0, 'Job history must not be empty');
    let prior: unknown = null;
    for (const rawEvent of history) {
      const e = object(rawEvent, 'event', ['at', 'from', 'to', 'reason']); isoDate(e.at, 'at'); enumeration(e.to, JOB_STATUSES, 'to'); textValue(e.reason, 'reason', true);
      check(e.from === prior, 'Broken job history'); prior = e.to;
    }
    check(prior === j.status, 'Job history does not match status');
    for (const rawChange of list(j.budgetHistory, 'budgetHistory')) {
      const h = object(rawChange, 'budget history', ['at', 'previous', 'next']); isoDate(h.at, 'at'); budget(h.previous); budget(h.next);
    }
    const sessionIds = strings(j.sessionIds, 'sessionIds'); check(new Set(sessionIds).size === sessionIds.length, 'Duplicate job session');
    const seen = new Set<string>();
    for (const rawBinding of list(j.sessionBindings, 'sessionBindings')) {
      const b = object(rawBinding, 'session binding', ['sessionId', 'boundAt'], ['parentSessionId']); textValue(b.sessionId, 'sessionId'); isoDate(b.boundAt, 'boundAt');
      check(!seen.has(b.sessionId), 'Duplicate session binding');
      if (seen.size === 0) check(b.parentSessionId === undefined && j.sessionId === b.sessionId, 'First session must be the root');
      else check(typeof b.parentSessionId === 'string' && seen.has(b.parentSessionId), 'Session parent must be bound first');
      seen.add(b.sessionId);
    }
    check(seen.size === sessionIds.length && sessionIds.every(id => seen.has(id)), 'Session indexes disagree');
    if (!seen.size) check(j.sessionId === undefined, 'Root session without a binding');
    if (j.foreground !== undefined) {
      const f = object(j.foreground, 'foreground', ['id', 'target', 'scope', 'steps', 'requestedAt'], ['approvedAt', 'completedAt', 'releasedAt', 'releaseReason']);
      for (const key of ['id', 'target', 'scope']) textValue(f[key], key); check(strings(f.steps, 'steps').length > 0, 'Foreground request needs steps'); isoDate(f.requestedAt, 'requestedAt');
      if (f.approvedAt !== undefined) isoDate(f.approvedAt, 'approvedAt');
      if (f.completedAt !== undefined) { isoDate(f.completedAt, 'completedAt'); check(f.approvedAt !== undefined, 'Foreground completion requires approval'); }
      if (f.releasedAt !== undefined) { isoDate(f.releasedAt, 'releasedAt'); textValue(f.releaseReason, 'releaseReason'); check(f.approvedAt !== undefined, 'Released foreground request needs prior approval'); }
      else check(f.releaseReason === undefined, 'Foreground release reason needs a release timestamp');
    }
    if (j.coverage !== undefined) {
      const coverage = object(j.coverage, 'coverage', ['specId', 'confirmedAt', 'reason']); textValue(coverage.specId, 'specId'); isoDate(coverage.confirmedAt, 'confirmedAt'); textValue(coverage.reason, 'reason'); check(j.status === 'covered', 'Coverage receipt requires the covered state');
    }
  }
  for (const raw of list(s.candidates, 'candidates')) {
    const c = object(raw, 'candidate', ['id', 'title', 'description', 'sourceUrl', 'detectedAt', 'updatedAt', 'fingerprint', 'status'], ['version', 'sourceType', 'autoInvestigate']);
    for (const key of ['id', 'title', 'fingerprint']) textValue(c[key], key); textValue(c.description, 'description', true); webUrl(c.sourceUrl, 'sourceUrl'); isoDate(c.detectedAt, 'detectedAt'); isoDate(c.updatedAt, 'updatedAt'); enumeration(c.status, ['new', 'selected', 'dismissed'], 'candidate status'); if (c.version !== undefined) textValue(c.version, 'version');
    if (c.sourceType !== undefined) enumeration(c.sourceType, ['public-source', 'local-version'], 'candidate sourceType');
    if (c.autoInvestigate !== undefined) { check(typeof c.autoInvestigate === 'boolean', 'candidate autoInvestigate must be boolean'); check(!c.autoInvestigate || c.sourceType === 'local-version', 'Only local-version candidates can be automatically investigated'); }
  }
  for (const raw of list(s.evidence, 'evidence')) {
    const e = object(raw, 'evidence', ['id', 'jobId', 'kind', 'claim', 'createdAt', 'relatedEvidenceIds'], ['sourceUrl', 'localPath', 'sha256']);
    idDates(e); textValue(e.jobId, 'jobId'); textValue(e.claim, 'claim'); enumeration(e.kind, ['observed', 'inferred', 'unknown'], 'kind'); strings(e.relatedEvidenceIds, 'relatedEvidenceIds');
    if (e.sourceUrl !== undefined) webUrl(e.sourceUrl, 'sourceUrl');
    if (e.localPath !== undefined) { relativePath(e.localPath); digest(e.sha256); }
    else check(e.sha256 === undefined, 'Evidence digest needs a local path');
    if (e.kind === 'observed') check(e.sourceUrl !== undefined || e.localPath !== undefined, 'Observed evidence needs a source');
  }
  for (const raw of list(s.specs, 'specs')) {
    const f = object(raw, 'spec', ['id', 'jobId', 'title', 'behavior', 'visual', 'lifecycle', 'existingCapabilities', 'gaps', 'evidenceIds', 'createdAt']); idDates(f); textValue(f.jobId, 'jobId'); textValue(f.title, 'title');
    for (const key of ['behavior', 'visual', 'lifecycle', 'existingCapabilities', 'gaps', 'evidenceIds']) strings(f[key], key);
    check((f.behavior as string[]).length > 0 && (f.visual as string[]).length > 0 && (f.lifecycle as string[]).length > 0, 'Spec needs behavior, visual and lifecycle criteria');
    check((f.evidenceIds as string[]).length > 0, 'Spec needs evidence');
  }
  for (const raw of list(s.artifacts, 'artifacts')) {
    const a = object(raw, 'artifact', ['id', 'jobId', 'path', 'label', 'kind', 'sha256', 'bytes', 'createdAt'], ['screenshot']); idDates(a); textValue(a.jobId, 'jobId'); relativePath(a.path); textValue(a.label, 'label'); enumeration(a.kind, ['plugin', 'report', 'screenshot', 'log'], 'artifact kind'); digest(a.sha256); count(a.bytes, 'bytes');
    if (a.screenshot !== undefined) { check(a.kind === 'screenshot', 'Screenshot metadata requires a screenshot artifact'); validateScreenshotMetadata(a.screenshot); }
  }
  for (const raw of list(s.verifications, 'verifications')) {
    const v = object(raw, 'verification', ['id', 'jobId', 'specId', 'artifactId', 'artifactSha256', 'scope', 'outcome', 'method', 'environment', 'details', 'evidenceIds', 'createdAt'], ['screenshotIds']); idDates(v); textValue(v.jobId, 'jobId'); textValue(v.specId, 'specId'); textValue(v.artifactId, 'artifactId'); digest(v.artifactSha256); enumeration(v.scope, ['behavior', 'visual', 'lifecycle'], 'scope'); enumeration(v.outcome, ['passed', 'failed', 'partial'], 'outcome'); enumeration(v.method, ['browser', 'command', 'manual'], 'method'); check(v.environment === 'isolated', 'Verification must use an isolated environment'); textValue(v.details, 'details'); check(strings(v.evidenceIds, 'evidenceIds').length > 0, 'Verification needs evidence');
    if (v.screenshotIds !== undefined) { const ids = strings(v.screenshotIds, 'screenshotIds'); check(new Set(ids).size === ids.length, 'Duplicate verification screenshot'); }
  }
  for (const raw of list(s.reservations, 'reservations')) {
    const r = object(raw, 'reservation', ['requestId', 'jobId', 'reservedTokens', 'reservedAt', 'status'], ['usage', 'settledAt', 'unknownReason']); textValue(r.requestId, 'requestId'); textValue(r.jobId, 'jobId'); count(r.reservedTokens, 'reservedTokens', 1); isoDate(r.reservedAt, 'reservedAt'); enumeration(r.status, ['inflight', 'settled', 'unknown'], 'reservation status');
    if (r.status === 'settled') {
      const u = object(r.usage, 'usage', ['inputTokens', 'outputTokens']); count(u.inputTokens, 'inputTokens'); count(u.outputTokens, 'outputTokens'); count((u.inputTokens as number) + (u.outputTokens as number), 'usage total'); isoDate(r.settledAt, 'settledAt'); check(r.unknownReason === undefined, 'Settled usage cannot be unknown');
    } else { check(r.usage === undefined && r.settledAt === undefined, 'Unsettled request cannot contain settled usage'); if (r.status === 'unknown') textValue(r.unknownReason, 'unknownReason'); }
  }
  const state = value as StoreState;
  for (const [name, values] of Object.entries({ jobs: state.jobs, candidates: state.candidates, evidence: state.evidence, specs: state.specs, artifacts: state.artifacts, verifications: state.verifications })) check(new Set(values.map(v => v.id)).size === values.length, `Duplicate ${name} id`);
  check(new Set(state.reservations.map(r => r.requestId)).size === state.reservations.length, 'Duplicate request id');
  count(state.reservations.reduce((total, r) => total + (r.status === 'settled' ? r.usage!.inputTokens + r.usage!.outputTokens : r.reservedTokens), 0), 'Complete token ledger total');
  check(new Set(state.candidates.map(c => c.fingerprint)).size === state.candidates.length, 'Duplicate candidate fingerprint');
  const sessions = state.jobs.flatMap(j => j.sessionIds); check(new Set(sessions).size === sessions.length, 'Session belongs to multiple jobs');
  const jobs = new Map(state.jobs.map(j => [j.id, j])); const evidence = new Map(state.evidence.map(e => [e.id, e])); const artifacts = new Map(state.artifacts.map(a => [a.id, a]));
  if (state.foregroundLease !== undefined) {
    const lease = object(state.foregroundLease, 'foregroundLease', ['jobId', 'requestId', 'approvedAt']); textValue(lease.jobId, 'jobId'); textValue(lease.requestId, 'requestId'); isoDate(lease.approvedAt, 'approvedAt');
    const owner = jobs.get(lease.jobId); const request = owner?.foreground;
    check(request?.id === lease.requestId && request?.approvedAt === lease.approvedAt && !request.releasedAt && !request.completedAt, 'Foreground lease must match an active user approval');
    check(owner && ['paused', 'queued', 'researching', 'specifying', 'building', 'verifying'].includes(owner.status), 'Foreground lease belongs to an inactive job');
  }
  for (const v of [...state.evidence, ...state.specs, ...state.artifacts, ...state.verifications, ...state.reservations]) check(jobs.has(v.jobId), 'Record refers to an unknown job');
  for (const e of state.evidence) for (const id of e.relatedEvidenceIds) check(id !== e.id && evidence.get(id)?.jobId === e.jobId, 'Invalid related evidence');
  for (const v of [...state.specs, ...state.verifications]) for (const id of v.evidenceIds) check(evidence.get(id)?.jobId === v.jobId, 'Evidence must belong to the same job');
  for (const v of state.verifications) {
    check(state.specs.some(f => f.id === v.specId && f.jobId === v.jobId), 'Verification needs a same-job spec');
    const a = artifacts.get(v.artifactId); check(a?.jobId === v.jobId && a.sha256 === v.artifactSha256, 'Verification artifact mismatch');
    for (const id of v.screenshotIds ?? []) { const screenshot = artifacts.get(id); check(screenshot?.jobId === v.jobId && screenshot.kind === 'screenshot', 'Verification screenshot must be a same-job screenshot artifact'); }
    check(v.evidenceIds.some(id => evidence.get(id)?.kind === 'observed' && evidence.get(id)?.localPath), 'Verification needs observed local evidence');
  }
  for (const j of state.jobs) {
    if (j.candidateId) check(state.candidates.some(c => c.id === j.candidateId), 'Unknown candidate');
    if (j.artifactId) check(artifacts.get(j.artifactId)?.jobId === j.id, 'Unknown job artifact');
    if (j.status === 'ready' || j.status === 'installed') {
      check(state.specs.some(f => f.jobId === j.id), 'Ready job needs a feature spec');
      check(j.artifactId && artifacts.get(j.artifactId)?.kind === 'plugin', 'Ready job needs a plugin artifact');
      for (const scope of ['behavior', 'visual', 'lifecycle']) {
        const specId = state.specs.filter(f => f.jobId === j.id).at(-1)?.id;
        const matching = state.verifications.filter(v => v.jobId === j.id && v.artifactId === j.artifactId && v.specId === specId && v.scope === scope);
        check(matching.at(-1)?.outcome === 'passed', `Ready job lacks passed ${scope} verification`);
      }
    }
    if (j.status === 'installed') check(j.installedReceipt, 'Installed job needs a receipt');
    if (j.status === 'covered') {
      const spec = state.specs.filter(f => f.jobId === j.id).at(-1);
      check(j.coverage && spec?.id === j.coverage.specId, 'Covered job needs explicit confirmation for its latest spec');
      check(spec.existingCapabilities.length > 0 && spec.gaps.length === 0, 'Covered job must identify existing capabilities with no known gaps');
      check(spec.evidenceIds.some(id => evidence.get(id)?.kind === 'observed' && evidence.get(id)?.localPath), 'Covered job needs observed local evidence');
    }
    if (j.status === 'researched') {
      check(j.mode === 'investigate', 'Only investigation jobs can finish as researched');
      const spec = state.specs.filter(f => f.jobId === j.id).at(-1);
      check(spec && spec.evidenceIds.some(id => evidence.get(id)?.kind === 'observed'), 'Researched job needs a specification grounded in observed evidence');
    }
  }
}
