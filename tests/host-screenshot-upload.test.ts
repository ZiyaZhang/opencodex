import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { OpenCodexStore, type ScreenshotMetadata } from '../src/core/index.js';
import OpenCodex from '../src/host/index.js';
import { OPEN_CODEX_DESCRIPTOR, type ReferenceImageInput } from '../src/host/remote.js';
import { addScreenshot, createJobWithReference, readReferenceImage, readScreenshot } from '../src/host/reference-image.js';

const signal = () => new AbortController().signal;
const png: ReferenceImageInput = { mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ8sAAAAASUVORK5CYII=' };
const metadata: ScreenshotMetadata = { subject: 'codex', caption: 'Synthetic uploaded reference', provenance: 'user' };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-upload-'));
  const store = await OpenCodexStore.open({ directory: join(directory, 'state'), artifactRoot: join(directory, 'jobs') });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const job = await store.createJob({ title: 'Synthetic screenshot dossier' });
  return { directory, store, jobId: job.id };
}

test('existing-job uploads register independent screenshots without replacing references or starting research', async t => {
  const f = await fixture(t);
  const jobBefore = f.store.getJob(f.jobId);
  const first = await addScreenshot(f.store, f.jobId, png, metadata, signal());
  const second = await addScreenshot(f.store, f.jobId, png, { ...metadata, subject: 'dsh', caption: 'Synthetic user-supplied implementation view', version: 'test-only' }, signal());
  assert.notEqual(first.path, second.path);
  assert.match(first.path, new RegExp(`^${f.jobId}/screenshot-[0-9a-f-]{36}\\.png$`));
  assert.equal(first.kind, 'screenshot'); assert.deepEqual(first.screenshot, metadata);
  assert.deepEqual(await readScreenshot(f.store, f.jobId, first.id, signal()), png);
  assert.deepEqual(f.store.getJob(f.jobId), jobBefore);
  assert.equal(f.store.snapshot().reservations.length, 0);
  const legacy = await createJobWithReference(f.store, { title: 'Original reference retained' }, png, signal());
  await addScreenshot(f.store, legacy.id, png, metadata, signal());
  assert.deepEqual(await readReferenceImage(f.store, legacy.id, signal()), png);
  assert.equal((await readdir(join(f.store.artifactRoot, legacy.id))).length, 2);
});

test('uploading screenshots preserves paused and ready states and does not create acceptance records', async t => {
  const f = await fixture(t);
  await f.store.transitionJob(f.jobId, 'queued'); await f.store.transitionJob(f.jobId, 'researching');
  await f.store.transitionJob(f.jobId, 'paused');
  const paused = f.store.getJob(f.jobId);
  await addScreenshot(f.store, f.jobId, png, metadata, signal());
  assert.deepEqual(f.store.getJob(f.jobId), paused);
  assert.equal(f.store.snapshot().verifications.length, 0);

  await f.store.transitionJob(f.jobId, 'queued'); await f.store.transitionJob(f.jobId, 'researching');
  const observedPath = `${f.jobId}/synthetic-observation.log`;
  await writeFile(join(f.store.artifactRoot, observedPath), 'Synthetic unit-test observation, not a product acceptance result');
  const evidence = await f.store.addEvidence(f.jobId, { kind: 'observed', claim: 'Synthetic unit-test fixture', localPath: observedPath });
  await f.store.saveSpec(f.jobId, { title: 'Synthetic fixture', behavior: ['Synthetic fixture'], visual: ['Synthetic fixture'], lifecycle: ['Synthetic fixture'], existingCapabilities: [], gaps: [], evidenceIds: [evidence.id] });
  await f.store.transitionJob(f.jobId, 'specifying'); await f.store.transitionJob(f.jobId, 'building');
  const artifactPath = `${f.jobId}/synthetic.tgz`; await writeFile(join(f.store.artifactRoot, artifactPath), 'Synthetic store fixture; never installed');
  const plugin = await f.store.registerArtifact(f.jobId, { path: artifactPath, kind: 'plugin' });
  const codex = await addScreenshot(f.store, f.jobId, png, metadata, signal());
  const dsh = await addScreenshot(f.store, f.jobId, png, { ...metadata, subject: 'dsh' }, signal());
  await f.store.transitionJob(f.jobId, 'verifying');
  for (const scope of ['behavior', 'visual', 'lifecycle'] as const) await f.store.recordVerification(f.jobId, { artifactId: plugin.id, scope, outcome: 'passed', environment: 'isolated', method: 'manual', details: 'Synthetic unit-test fixture', evidenceIds: [evidence.id], ...(scope === 'visual' ? { screenshotIds: [codex.id, dsh.id] } : {}) });
  await f.store.transitionJob(f.jobId, 'ready');
  const ready = f.store.getJob(f.jobId), verifications = f.store.snapshot().verifications;
  await addScreenshot(f.store, f.jobId, png, { ...metadata, subject: 'other' }, signal());
  assert.deepEqual(f.store.getJob(f.jobId), ready);
  assert.deepEqual(f.store.snapshot().verifications, verifications);
});

test('uploads reject invalid metadata, fabricated capture provenance and invalid images before writing', async t => {
  const f = await fixture(t);
  const before = f.store.snapshot();
  for (const value of [{ ...metadata, provenance: 'capture' }, { ...metadata, provenance: 'public-source', sourceUrl: 'https://example.com/fixture' }, { ...metadata, caption: '' }, { ...metadata, extra: true }, { ...metadata, sourceUrl: 'file:///private' }, null]) {
    await assert.rejects(addScreenshot(f.store, f.jobId, png, value as ScreenshotMetadata, signal()), /provenance|caption|field|metadata|sourceUrl|HTTP/i);
  }
  for (const image of [{ ...png, dataBase64: 'AAAA' }, { ...png, dataBase64: 'A'.repeat(3_000_000) }, { ...png, path: '/tmp/not-allowed' }]) {
    await assert.rejects(addScreenshot(f.store, f.jobId, image, metadata, signal()), /signature|2 MiB|only/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(addScreenshot(f.store, f.jobId, png, metadata, controller.signal), /abort/i);
  assert.deepEqual(f.store.snapshot(), before);
  assert.deepEqual(await readdir(f.store.artifactRoot), []);
});

test('uploads refuse unknown jobs, path identifiers and existing directory symlink escapes', async t => {
  const f = await fixture(t);
  await assert.rejects(addScreenshot(f.store, randomUUID(), png, metadata, signal()), /Unknown job/);
  await assert.rejects(addScreenshot(f.store, '../escape', png, metadata, signal()), /Invalid image job/);
  const outside = join(f.directory, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.store.artifactRoot, f.jobId));
  await assert.rejects(addScreenshot(f.store, f.jobId, png, metadata, signal()), /symlinks/);
  assert.deepEqual(await readdir(outside), []);
  const alias = join(f.directory, 'alias'); await symlink(f.store.artifactRoot, alias);
  const linkedStore = { artifactRoot: alias, getJob: (id: string) => f.store.getJob(id) } as OpenCodexStore;
  await assert.rejects(addScreenshot(linkedStore, f.jobId, png, metadata, signal()), /symlinks/);
});

test('registration failure removes only the new upload and leaves the dossier state unchanged', async t => {
  const f = await fixture(t);
  await mkdir(join(f.store.artifactRoot, f.jobId));
  await writeFile(join(f.store.artifactRoot, f.jobId, 'keep.txt'), 'Existing local research');
  const before = f.store.snapshot();
  f.store.registerArtifact = async () => { throw new Error('Synthetic registration failure'); };
  await assert.rejects(addScreenshot(f.store, f.jobId, png, metadata, signal()), /Synthetic registration failure/);
  assert.deepEqual(await readdir(join(f.store.artifactRoot, f.jobId)), ['keep.txt']);
  assert.deepEqual(f.store.snapshot(), before);
});

test('existing screenshot upload is an explicit path-free user RPC with no model invocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-upload-rpc-'));
  const ctx = new Context();
  ctx.provide('typert', { register() { return async () => {}; } } as never);
  ctx.provide('tools', { schemas: () => [], register: () => () => {} } as never);
  ctx.provide('sessions', { get: () => undefined } as never);
  ctx.provide('agents', { get: () => undefined } as never);
  ctx.provide('sessionController', { create: () => { throw new Error('Screenshot upload must not start a model'); } } as never);
  const plugin = new OpenCodex(ctx, { dataDirectory: directory, monitorTickMs: 1000 });
  try {
    const made = await plugin.call({ action: 'create', input: { title: 'Existing RPC job' } }, signal());
    const jobId = made.state.jobs[0]!.id;
    const request = { action: 'addScreenshot', jobId, image: png, metadata } as const;
    const result = await plugin.call(request, signal());
    const artifact = result.state.artifacts.find(item => item.jobId === jobId)!;
    assert.deepEqual(result.state.jobs, made.state.jobs);
    assert.deepEqual(artifact.screenshot, metadata);
    assert.equal('screenshot' in result, false);
    assert.deepEqual((await plugin.call({ action: 'readScreenshot', jobId, artifactId: artifact.id }, signal())).screenshot, png);
    const codec = OPEN_CODEX_DESCRIPTOR.parameters[0]!.codec as { create: () => { parse: (input: unknown) => unknown } };
    assert.deepEqual(codec.create().parse(request), request);
    assert.throws(() => codec.create().parse({ ...request, path: '/arbitrary' }), /never a path/);
    assert.throws(() => codec.create().parse({ action: 'addScreenshot', jobId, image: png }), /requires/);
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('retrying candidate creation with a reference keeps its existing job, original image and status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-reference-retry-'));
  const ctx = new Context();
  ctx.provide('typert', { register() { return async () => {}; } } as never);
  ctx.provide('tools', { schemas: () => [], register: () => () => {} } as never);
  ctx.provide('sessions', { get: () => undefined } as never);
  ctx.provide('agents', { get: () => undefined } as never);
  ctx.provide('sessionController', {} as never);
  const plugin = new OpenCodex(ctx, { dataDirectory: directory, monitorTickMs: 1000 });
  try {
    const store = await (plugin as unknown as { store: Promise<OpenCodexStore> }).store;
    const candidate = await store.saveCandidate({ title: 'Synthetic feature', description: 'Reference retry fixture', sourceUrl: 'https://example.com/fixture', fingerprint: 'reference-retry-fixture' });
    const request = { action: 'create', input: { title: candidate.title, candidateId: candidate.id, source: 'discovery' }, referenceImage: png } as const;
    const [first, second] = await Promise.all([plugin.call(request, signal()), plugin.call(request, signal())]);
    assert.equal(first.state.jobs.length, 1); assert.equal(second.state.jobs.length, 1);
    const jobId = first.state.jobs[0]!.id;
    assert.equal(second.state.jobs[0]!.id, jobId);
    await store.transitionJob(jobId, 'queued'); await store.transitionJob(jobId, 'paused');
    const before = store.snapshot();
    const result = await plugin.call(request, signal());
    assert.deepEqual(result.state.jobs, before.jobs);
    assert.deepEqual(result.state.artifacts, before.artifacts);
    assert.deepEqual(await readReferenceImage(store, jobId, signal()), png);
    assert.deepEqual(await readdir(join(store.artifactRoot, jobId)), ['reference.png']);
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});
