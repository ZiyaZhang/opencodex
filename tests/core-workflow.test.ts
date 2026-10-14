import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ARTIFACT_BYTES, OpenCodexStore, type VerificationScope } from '../src/core/index.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-flow-'));
  const store = await OpenCodexStore.open({ directory });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const job = await store.createJob({ title: 'Keep composer available while asking a question' });
  await store.transitionJob(job.id, 'queued'); await store.transitionJob(job.id, 'researching');
  return { store, jobId: job.id, directory, artifactRoot: store.artifactRoot };
}
async function verifying(t: TestContext) {
  const f = await fixture(t);
  await writeFile(join(f.artifactRoot, 'probe.log'), 'Browser recording: question visible, composer editable, draft survives refresh.');
  const evidence = await f.store.addEvidence(f.jobId, { kind: 'observed', claim: 'A real isolated UI probe produced the local recording', localPath: 'probe.log' });
  await f.store.transitionJob(f.jobId, 'specifying');
  await f.store.saveSpec(f.jobId, { title: 'Question and composer coexist', behavior: ['Reply without losing draft'], visual: ['Compare fixed viewport'], lifecycle: ['Unload restores original composer'], existingCapabilities: ['Timed question service'], gaps: [], evidenceIds: [evidence.id] });
  await f.store.transitionJob(f.jobId, 'building');
  await writeFile(join(f.artifactRoot, 'plugin.tgz'), 'synthetic package for store unit tests');
  const artifact = await f.store.registerArtifact(f.jobId, { path: 'plugin.tgz' });
  const screenshotIds: string[] = [];
  // Tiny synthetic images exercise the acceptance contract, not product fidelity.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZQAAAAASUVORK5CYII=', 'base64');
  await mkdir(join(f.artifactRoot, f.jobId));
  for (const subject of ['codex', 'dsh'] as const) {
    const path = `${f.jobId}/${subject}.png`; await writeFile(join(f.artifactRoot, path), png);
    screenshotIds.push((await f.store.registerArtifact(f.jobId, { path, kind: 'screenshot', screenshot: { subject, caption: 'Synthetic unit-test image', provenance: 'user' } })).id);
  }
  await f.store.transitionJob(f.jobId, 'verifying');
  return { ...f, evidence, artifact, screenshotIds };
}

test('state transitions and unsupported claims cannot manufacture a ready plugin', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.transitionJob(f.jobId, 'ready'), /Invalid transition/);
  await assert.rejects(f.store.addEvidence(f.jobId, { kind: 'observed', claim: 'Assumed feature exists' }), /needs a source/);
  const inferred = await f.store.addEvidence(f.jobId, { kind: 'inferred', claim: 'The feature might share the composer service' });
  const unknown = await f.store.addEvidence(f.jobId, { kind: 'unknown', claim: 'Cloud workflow is not observable' });
  assert.equal(inferred.kind, 'inferred'); assert.equal(unknown.kind, 'unknown');
  await f.store.transitionJob(f.jobId, 'specifying'); await f.store.transitionJob(f.jobId, 'building'); await f.store.transitionJob(f.jobId, 'verifying');
  await assert.rejects(f.store.transitionJob(f.jobId, 'ready'), /feature spec/);
});

test('all three verification scopes are required; latest failure supersedes an older pass', async t => {
  const f = await verifying(t);
  const record = (scope: VerificationScope, outcome: 'passed' | 'failed' = 'passed') => f.store.recordVerification(f.jobId, { artifactId: f.artifact.id, scope, outcome, environment: 'isolated', method: 'browser', details: 'Unit-test fixture for host validation records', evidenceIds: [f.evidence.id], ...(scope === 'visual' ? { screenshotIds: f.screenshotIds } : {}) });
  await record('behavior'); await record('visual');
  await assert.rejects(f.store.transitionJob(f.jobId, 'ready'), /lifecycle/);
  await record('lifecycle'); await record('visual', 'failed');
  await assert.rejects(f.store.transitionJob(f.jobId, 'ready'), /visual/);
  await record('visual'); await f.store.transitionJob(f.jobId, 'ready');
  await assert.rejects(f.store.transitionJob(f.jobId, 'installed'), /Invalid transition/);
  await assert.rejects(f.store.markInstalled(f.jobId, { userConfirmed: false, artifactId: f.artifact.id, receipt: 'fake' } as never), /explicit confirmation/);
  const installed = await f.store.markInstalled(f.jobId, { userConfirmed: true, artifactId: f.artifact.id, receipt: 'unit-test installer receipt' });
  assert.equal(installed.status, 'installed');
});

test('digest checks reject modified artifacts and evidence after verification', async t => {
  const f = await verifying(t);
  for (const scope of ['behavior', 'visual', 'lifecycle'] as const) await f.store.recordVerification(f.jobId, { artifactId: f.artifact.id, scope, outcome: 'passed', environment: 'isolated', method: 'browser', details: 'Fixture validation', evidenceIds: [f.evidence.id], ...(scope === 'visual' ? { screenshotIds: f.screenshotIds } : {}) });
  await writeFile(join(f.artifactRoot, 'plugin.tgz'), 'different package');
  await assert.rejects(f.store.transitionJob(f.jobId, 'ready'), /verified bytes/);
  await writeFile(join(f.artifactRoot, 'plugin.tgz'), 'synthetic package for store unit tests');
  await writeFile(join(f.artifactRoot, 'probe.log'), 'changed evidence');
  await assert.rejects(f.store.transitionJob(f.jobId, 'ready'), /evidence no longer/);
  assert.equal(f.store.getJob(f.jobId).status, 'verifying');
});

test('local evidence rejects traversal, absolute paths, symlink escape and another job references', async t => {
  const f = await fixture(t); await writeFile(join(f.directory, 'outside.txt'), 'private outside artifact root');
  await symlink(join(f.directory, 'outside.txt'), join(f.artifactRoot, 'escape.txt'));
  for (const path of ['../outside.txt', '/etc/passwd', 'C:\\private\\file.txt', 'escape.txt']) await assert.rejects(f.store.addEvidence(f.jobId, { kind: 'observed', claim: 'Invalid local evidence', localPath: path }));
  const other = await f.store.createJob({ title: 'Another job' });
  const otherEvidence = await f.store.addEvidence(other.id, { kind: 'unknown', claim: 'Unknown behavior' });
  await assert.rejects(f.store.addEvidence(f.jobId, { kind: 'inferred', claim: 'Wrong association', relatedEvidenceIds: [otherEvidence.id] }), /Invalid related evidence/);
});

test('session mapping accepts only an established lineage, and foreground operations persist a user start', async t => {
  const f = await fixture(t); const workdir = join(f.artifactRoot, 'work'); await mkdir(workdir);
  await f.store.bindSession(f.jobId, { sessionId: 'root-session', workdir });
  await assert.rejects(f.store.bindSession(f.jobId, { sessionId: 'unrelated' }), /registered parent/);
  await f.store.bindSession(f.jobId, { sessionId: 'child-session', parentSessionId: 'root-session' });
  const other = await f.store.createJob({ title: 'Other job' });
  await assert.rejects(f.store.bindSession(other.id, { sessionId: 'child-session' }), /bound elsewhere/);
  const request = await f.store.requestForeground(f.jobId, { target: 'Desktop app', scope: 'Inspect question card', steps: ['Open a synthetic task', 'Capture visible question state'] });
  assert.equal(f.store.getJob(f.jobId).status, 'paused');
  await assert.rejects(f.store.completeForeground(f.jobId, request.id), /prior user approval/);
  await f.store.approveForeground(f.jobId, request.id); await f.store.completeForeground(f.jobId, request.id);
  assert.ok(f.store.getJob(f.jobId).foreground?.completedAt);
});

test('existing-capability calibration needs explicit user review and observed evidence, not a generated plugin', async t => {
  const f = await fixture(t);
  await writeFile(join(f.artifactRoot, 'existing-capability.log'), 'Synthetic fixture: existing DSH session reference selected, previewed and opened.');
  const evidence = await f.store.addEvidence(f.jobId, { kind: 'observed', claim: 'Existing feature was exercised in DSH', localPath: 'existing-capability.log' });
  const criteria = { title: 'Existing session reference', behavior: ['Select and open a session'], visual: ['Check preview and chip layout'], lifecycle: ['Retain draft while navigating'], existingCapabilities: ['DSH session reference'], evidenceIds: [evidence.id] };
  const incomplete = await f.store.saveSpec(f.jobId, { ...criteria, gaps: ['Preview behavior not yet checked'] });
  await assert.rejects(f.store.markCovered(f.jobId, { userConfirmed: true, specId: incomplete.id, reason: 'Premature review' }), /no known gaps/);
  const spec = await f.store.saveSpec(f.jobId, { ...criteria, gaps: [] });
  await assert.rejects(f.store.transitionJob(f.jobId, 'covered'), /Invalid transition/);
  await assert.rejects(f.store.markCovered(f.jobId, { userConfirmed: false, specId: spec.id, reason: 'Not confirmed' } as never), /explicit confirmation/);
  await assert.rejects(f.store.markCovered(f.jobId, { userConfirmed: true, specId: incomplete.id, reason: 'Stale spec' }), /latest spec/);
  const covered = await f.store.markCovered(f.jobId, { userConfirmed: true, specId: spec.id, reason: 'User reviewed existing DSH behavior and visual evidence' });
  assert.equal(covered.status, 'covered'); assert.equal(covered.artifactId, undefined); assert.equal(covered.coverage?.specId, spec.id);
  await assert.rejects(f.store.transitionJob(f.jobId, 'queued'), /Invalid transition/);
});

test('foreground starts are exclusive across jobs and pausing releases the desktop for the queue', async t => {
  const f = await fixture(t);
  const other = await f.store.createJob({ title: 'Second desktop study' });
  await f.store.transitionJob(other.id, 'queued'); await f.store.transitionJob(other.id, 'researching');
  const a = await f.store.requestForeground(f.jobId, { target: 'Desktop', scope: 'First study', steps: ['Inspect first feature'] });
  const b = await f.store.requestForeground(other.id, { target: 'Desktop', scope: 'Second study', steps: ['Inspect second feature'] });
  const results = await Promise.allSettled([f.store.approveForeground(f.jobId, a.id), f.store.approveForeground(other.id, b.id)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.message.includes('Another OpenCodex job'), true);
  const lease = f.store.snapshot().foregroundLease!;
  const waiting = lease.jobId === f.jobId ? { jobId: other.id, requestId: b.id } : { jobId: f.jobId, requestId: a.id };
  await f.store.transitionJob(lease.jobId, 'queued'); await f.store.transitionJob(lease.jobId, 'researching');
  assert.equal(f.store.snapshot().foregroundLease?.jobId, lease.jobId);
  await f.store.transitionJob(lease.jobId, 'paused', { reason: 'User paused desktop work' });
  assert.equal(f.store.snapshot().foregroundLease, undefined);
  assert.ok(f.store.getJob(lease.jobId).foreground?.releasedAt);
  await assert.rejects(f.store.completeForeground(lease.jobId, lease.requestId), /released/);
  await f.store.approveForeground(waiting.jobId, waiting.requestId);
  assert.equal(f.store.snapshot().foregroundLease?.jobId, waiting.jobId);
  await f.store.completeForeground(waiting.jobId, waiting.requestId);
  assert.equal(f.store.snapshot().foregroundLease, undefined);
});

test('restart revokes stale foreground approval and cancellation releases a fresh lease', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-lease-'));
  let store = await OpenCodexStore.open({ directory });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const job = await store.createJob({ title: 'Recoverable desktop study' });
  await store.transitionJob(job.id, 'queued'); await store.transitionJob(job.id, 'researching');
  const request = await store.requestForeground(job.id, { target: 'Desktop', scope: 'Inspect after approval', steps: ['Open feature'] });
  await store.approveForeground(job.id, request.id); await store.close();
  store = await OpenCodexStore.open({ directory });
  assert.equal(store.snapshot().foregroundLease, undefined); assert.ok(store.getJob(job.id).foreground?.releasedAt);
  await assert.rejects(store.completeForeground(job.id, request.id), /released/);
  await store.approveForeground(job.id, request.id); assert.equal(store.snapshot().foregroundLease?.jobId, job.id);
  await store.revokeForeground(job.id, request.id, 'Starting the foreground research failed');
  assert.equal(store.snapshot().foregroundLease, undefined); assert.equal(store.getJob(job.id).status, 'paused');
  await store.approveForeground(job.id, request.id);
  await store.transitionJob(job.id, 'cancelled'); assert.equal(store.snapshot().foregroundLease, undefined);
});

test('oversized local evidence is rejected before hashing its contents', async t => {
  const f = await fixture(t); const file = await open(join(f.artifactRoot, 'oversized.log'), 'wx');
  try { await file.truncate(MAX_ARTIFACT_BYTES + 1); } finally { await file.close(); }
  await assert.rejects(f.store.addEvidence(f.jobId, { kind: 'observed', claim: 'Unbounded log', localPath: 'oversized.log' }), /inspection limit/);
  assert.equal(f.store.snapshot().evidence.length, 0);
});

test('blocked and failed foreground jobs can explicitly reacquire approval and resume', async t => {
  const f = await fixture(t);
  const request = await f.store.requestForeground(f.jobId, { target: 'Desktop', scope: 'Recover a stopped probe', steps: ['Inspect the feature'] });
  for (const status of ['blocked', 'failed'] as const) {
    await f.store.approveForeground(f.jobId, request.id);
    await f.store.transitionJob(f.jobId, 'queued'); await f.store.transitionJob(f.jobId, 'researching');
    await f.store.transitionJob(f.jobId, status, { reason: 'Temporary probe failure' });
    assert.equal(f.store.snapshot().foregroundLease, undefined);
    await f.store.approveForeground(f.jobId, request.id);
    assert.equal(f.store.getJob(f.jobId).status, 'paused');
    assert.deepEqual(f.store.getJob(f.jobId).history.at(-1)?.from, status);
    assert.equal(f.store.snapshot().foregroundLease?.jobId, f.jobId);
    await f.store.transitionJob(f.jobId, 'queued'); await f.store.transitionJob(f.jobId, 'researching');
    assert.equal(f.store.getJob(f.jobId).status, 'researching');
    await f.store.transitionJob(f.jobId, 'paused');
  }
});

test('investigation jobs finish an evidence-backed inventory while known gaps remain and never enter plugin building', async t => {
  const f = await fixture(t);
  const job = await f.store.createJob({ title: 'Investigate a synthetic update', source: 'discovery', mode: 'investigate' });
  await f.store.transitionJob(job.id, 'queued'); await f.store.transitionJob(job.id, 'researching'); await f.store.transitionJob(job.id, 'specifying');
  await assert.rejects(f.store.transitionJob(job.id, 'building'), /do not reconstruct/);
  await assert.rejects(f.store.registerArtifact(job.id, { path: 'not-a-plugin.tgz' }), /cannot register plugin/);
  await assert.rejects(f.store.transitionJob(job.id, 'researched'), /observed evidence/);
  const hypothesis = await f.store.addEvidence(job.id, { kind: 'inferred', claim: 'An updated version might contain a new interaction' });
  const input = { title: 'Observed update inventory', behavior: ['Identify observable changes'], visual: ['Record uninspected UI differences'], lifecycle: ['Document installed version'], existingCapabilities: [], gaps: ['Actual target UI is not yet available'] };
  await f.store.saveSpec(job.id, { ...input, evidenceIds: [hypothesis.id] });
  await assert.rejects(f.store.transitionJob(job.id, 'researched'), /observed evidence/);
  await writeFile(join(f.artifactRoot, 'version-observation.log'), 'Synthetic fixture version changed from 0.0.1 to 0.0.2');
  const observed = await f.store.addEvidence(job.id, { kind: 'observed', claim: 'Synthetic local version observation', localPath: 'version-observation.log' });
  await f.store.saveSpec(job.id, { ...input, evidenceIds: [observed.id, hypothesis.id] });
  const researched = await f.store.transitionJob(job.id, 'researched');
  assert.equal(researched.status, 'researched'); assert.equal(researched.artifactId, undefined);
  assert.ok(f.store.snapshot().specs.filter(s => s.jobId === job.id).at(-1)!.gaps.length > 0);
  await assert.rejects(f.store.transitionJob(job.id, 'queued'), /Invalid transition/);
  assert.equal(f.store.snapshot().jobs.find(j => j.id === f.jobId)?.mode, 'reconstruct');
});

test('local-version candidates retain their source label independently of the public reference URL', async t => {
  const f = await fixture(t);
  const candidate = await f.store.saveCandidate({ title: 'Synthetic local update', description: 'Version observed in a user-selected local file', fingerprint: 'local-fixture-v2', sourceUrl: 'https://example.com/reference', sourceType: 'local-version' });
  assert.equal(candidate.sourceType, 'local-version');
  await assert.rejects(f.store.saveCandidate({ title: 'Invalid source type', description: '', fingerprint: 'bad-source', sourceUrl: 'https://example.com/reference', sourceType: 'unknown-type' } as never), /sourceType/);
});
