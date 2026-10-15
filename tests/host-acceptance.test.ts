import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCodexStore } from '../src/core/store.js';
import { AcceptanceController, type FeatureVerifier } from '../src/host/acceptance.js';
import { VerificationUnavailableError, type NativeVerificationReport } from '../src/host/native-verification.js';
import { verifyingPlugin } from './helpers/plugin-fixture.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-acceptance-'));
  const store = await OpenCodexStore.open({ directory });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const data = await verifyingPlugin(store);
  let accepted = 0, repairs = 0, nativeCalls = 0;
  const report: NativeVerificationReport = { passed: true, packageName: 'dsh-install-fixture', version: '1.0.0', phases: ['Synthetic adapter output; not runtime evidence'], limitations: ['Unit test'] };
  const make = (verifier?: FeatureVerifier, native?: (input: { signal: AbortSignal }) => Promise<NativeVerificationReport>) => new AcceptanceController(store, {
    signal: new AbortController().signal, whenResearchIdle: async () => {}, verifier: () => verifier,
    native: async input => { nativeCalls++; return native ? native(input) : report; },
    accepted: async id => { accepted++; await store.transitionJob(id, 'ready'); },
    repair: async id => { repairs++; await store.startRepair(id); },
  });
  return { store, data, directory, report, make, counts: () => ({ accepted, repairs, nativeCalls }) };
}

test('native lifecycle alone leaves feature obligations blocked and never installs or loops a repair', async t => {
  const f = await fixture(t), runner = f.make();
  await Promise.all([runner.run(f.data.jobId), runner.run(f.data.jobId)]);
  assert.deepEqual(f.counts(), { accepted: 0, repairs: 0, nativeCalls: 1 });
  const job = f.store.getJob(f.data.jobId);
  assert.equal(job.status, 'blocked'); assert.equal(job.acceptance?.status, 'blocked');
  assert.equal(f.store.snapshot().verifications.length, 3);
  assert.ok(f.store.snapshot().verifications.every(check => check.outcome === 'partial'));
  const report = JSON.parse(await readFile(join(f.store.artifactRoot, job.acceptance!.reportPath!), 'utf8'));
  assert.equal(report.native.passed, true); assert.equal(report.run.artifactSha256, f.data.artifact.sha256);
  const before = f.store.snapshot().specs;
  await f.store.resumeAcceptance(job.id);
  assert.equal(f.store.getJob(job.id).status, 'verifying'); assert.equal(f.store.getJob(job.id).repairRounds, 0);
  assert.deepEqual(f.store.snapshot().specs, before);
});

test('complete independent results bind every spec obligation and screenshot pair before acceptance', async t => {
  const f = await fixture(t);
  const runner = f.make({ verify: async () => ['behavior', 'visual', 'lifecycle'].map(scope => ({ scope: scope as 'behavior' | 'visual' | 'lifecycle', outcome: 'passed', details: 'Synthetic independent-provider result for orchestration only', assertionIds: [`${scope}:1`], ...(scope === 'visual' ? { screenshotIds: f.data.verification('visual').screenshotIds } : {}) })) });
  await runner.run(f.data.jobId);
  assert.equal(f.store.getJob(f.data.jobId).status, 'ready');
  assert.equal(f.store.getJob(f.data.jobId).acceptance?.status, 'passed');
  assert.deepEqual(f.counts(), { accepted: 1, repairs: 0, nativeCalls: 1 });
});

test('a provider claiming pass without covering the specification cannot grant readiness', async t => {
  const f = await fixture(t);
  await f.make({ verify: async () => [{ scope: 'behavior', outcome: 'passed', details: 'Missing obligations', assertionIds: [] }] }).run(f.data.jobId);
  assert.equal(f.counts().accepted, 0); assert.equal(f.counts().repairs, 0);
  assert.equal(f.store.getJob(f.data.jobId).status, 'blocked');
  assert.match(f.store.getJob(f.data.jobId).acceptance!.details!, /every behavior obligation/);
});

test('cancelling while waiting for research shutdown does not hold the acceptance queue open', async t => {
  const f = await fixture(t);
  let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
  const runner = new AcceptanceController(f.store, {
    signal: new AbortController().signal,
    whenResearchIdle: () => { entered(); return new Promise(() => {}); },
    verifier: () => undefined, accepted: async () => assert.fail('Unexpected acceptance'), repair: async () => assert.fail('Unexpected repair'),
  });
  const operation = runner.run(f.data.jobId); await waiting;
  const rejected = assert.rejects(operation, /Acceptance stopped/);
  runner.cancel(f.data.jobId); await rejected; await runner.whenIdle();
  assert.equal(f.store.getJob(f.data.jobId).acceptance, undefined);
});

test('missing verification runtime blocks without spending a model repair round', async t => {
  const f = await fixture(t);
  await f.make(undefined, async () => { throw new VerificationUnavailableError('DSH runtime unavailable'); }).run(f.data.jobId);
  assert.equal(f.store.getJob(f.data.jobId).status, 'blocked');
  assert.deepEqual(f.counts(), { accepted: 0, repairs: 0, nativeCalls: 1 });
});

test('cancellation reaches the child runner and leaves an interrupted receipt instead of false success', async t => {
  const f = await fixture(t);
  let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
  const runner = f.make(undefined, ({ signal }) => new Promise((_, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  const operation = runner.run(f.data.jobId); await start; runner.cancel(f.data.jobId); await operation;
  assert.equal(f.store.getJob(f.data.jobId).status, 'paused'); assert.equal(f.store.getJob(f.data.jobId).acceptance?.status, 'interrupted');
  assert.equal(f.counts().repairs, 0); assert.equal(f.counts().accepted, 0);
});

test('a restart preserves verification identity and requires explicit resume of the existing artifact', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-acceptance-restart-'));
  let store = await OpenCodexStore.open({ directory });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const data = await verifyingPlugin(store), run = await store.beginAcceptance(data.jobId);
  await store.close(); store = await OpenCodexStore.open({ directory });
  assert.equal(store.getJob(data.jobId).acceptance?.id, run.id);
  assert.equal(store.getJob(data.jobId).acceptance?.status, 'interrupted');
  await store.resumeAcceptance(data.jobId);
  assert.equal(store.getJob(data.jobId).artifactId, data.artifact.id);
  assert.equal(store.getJob(data.jobId).status, 'verifying');
});
