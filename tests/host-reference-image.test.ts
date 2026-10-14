import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, open, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { OpenCodexStore } from '../src/core/index.js';
import OpenCodex from '../src/host/index.js';
import { OPEN_CODEX_DESCRIPTOR, type ReferenceImageInput } from '../src/host/remote.js';
import { createJobWithReference, MAX_REFERENCE_IMAGE_BYTES, readReferenceImage, readScreenshot } from '../src/host/reference-image.js';

const png: ReferenceImageInput = { mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ8sAAAAASUVORK5CYII=' };
const webp: ReferenceImageInput = { mimeType: 'image/webp', dataBase64: 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==' };
const signal = () => new AbortController().signal;
const metadata = { subject: 'other', caption: 'Synthetic test image', provenance: 'capture' } as const;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-images-'));
  const store = await OpenCodexStore.open({ directory: join(directory, 'state'), artifactRoot: join(directory, 'jobs') });
  return { directory, store, close: async () => { await store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('draft reference reads are same-job, explicit, and do not require a bound workspace or mutate state', async () => {
  const f = await fixture();
  try {
    const one = await createJobWithReference(f.store, { title: 'PNG draft' }, png, signal());
    const two = await createJobWithReference(f.store, { title: 'WebP draft' }, webp, signal());
    const empty = await f.store.createJob({ title: 'No reference' });
    const before = f.store.snapshot();
    assert.equal(one.workdir, undefined);
    const registered = before.artifacts.find(artifact => artifact.jobId === one.id)!;
    assert.equal(registered.kind, 'screenshot');
    assert.equal(registered.path, `${one.id}/reference.png`);
    assert.deepEqual(registered.screenshot, { subject: 'codex', caption: 'PNG draft', provenance: 'user' });
    assert.deepEqual(await readReferenceImage(f.store, one.id, signal()), png);
    assert.deepEqual(await readReferenceImage(f.store, two.id, signal()), webp);
    assert.equal(await readReferenceImage(f.store, empty.id, signal()), undefined);
    await mkdir(join(f.store.artifactRoot, empty.id));
    assert.equal(await readReferenceImage(f.store, empty.id, signal()), undefined);
    // Old drafts may have a local image but no registered screenshot metadata.
    await writeFile(join(f.store.artifactRoot, empty.id, 'reference.png'), Buffer.from(png.dataBase64, 'base64'));
    assert.deepEqual(await readReferenceImage(f.store, empty.id, signal()), png);
    assert.equal(f.store.snapshot().artifacts.some(artifact => artifact.jobId === empty.id), false);
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(JSON.stringify(before).includes(png.dataBase64), false);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(readReferenceImage(f.store, one.id, controller.signal), /abort/i);
  } finally { await f.close(); }
});

test('reference reads reject path input, unknown filesystem jobs, and job-directory links to other jobs or outside', async () => {
  const f = await fixture();
  try {
    const valid = await createJobWithReference(f.store, { title: 'Own image' }, png, signal());
    const other = await f.store.createJob({ title: 'Other job' });
    for (const id of ['../escape', `${valid.id}/../${other.id}`, '/tmp/reference.png', '', `${valid.id}%2f..`]) {
      await assert.rejects(readReferenceImage(f.store, id, signal()), /Invalid image job ID/);
    }
    const unknown = randomUUID();
    await mkdir(join(f.store.artifactRoot, unknown));
    await writeFile(join(f.store.artifactRoot, unknown, 'reference.png'), Buffer.from(png.dataBase64, 'base64'));
    await assert.rejects(readReferenceImage(f.store, unknown, signal()), /Unknown job/);
    await symlink(join(f.store.artifactRoot, valid.id), join(f.store.artifactRoot, other.id));
    await assert.rejects(readReferenceImage(f.store, other.id, signal()), /symlink/);
    await unlink(join(f.store.artifactRoot, other.id));
    await symlink(f.directory, join(f.store.artifactRoot, other.id));
    await assert.rejects(readReferenceImage(f.store, other.id, signal()), /symlink/);
  } finally { await f.close(); }
});

test('reference reads reject symlinked, hard-linked and nonregular image files', async () => {
  const f = await fixture();
  try {
    const source = await createJobWithReference(f.store, { title: 'Source' }, png, signal());
    const target = await f.store.createJob({ title: 'Target' });
    const path = join(f.store.artifactRoot, target.id, 'reference.png');
    const sourcePath = join(f.store.artifactRoot, source.id, 'reference.png');
    await mkdir(join(f.store.artifactRoot, target.id));
    await symlink(sourcePath, path);
    await assert.rejects(readReferenceImage(f.store, target.id, signal()), /regular file/);
    await unlink(path); await link(sourcePath, path);
    await assert.rejects(readReferenceImage(f.store, target.id, signal()), /hard links/);
    await unlink(path); await mkdir(path);
    await assert.rejects(readReferenceImage(f.store, target.id, signal()), /regular file/);
  } finally { await f.close(); }
});

test('reference reads enforce the byte bound and revalidate format, including filename/MIME mismatch', async () => {
  const f = await fixture();
  try {
    const job = await f.store.createJob({ title: 'Bounded image' });
    await mkdir(join(f.store.artifactRoot, job.id));
    const path = join(f.store.artifactRoot, job.id, 'reference.png');
    const file = await open(path, 'w'); await file.truncate(MAX_REFERENCE_IMAGE_BYTES + 1); await file.close();
    await assert.rejects(readReferenceImage(f.store, job.id, signal()), /2 MiB/);
    await writeFile(path, Buffer.from(webp.dataBase64, 'base64'));
    await assert.rejects(readReferenceImage(f.store, job.id, signal()), /signature/);
    await writeFile(path, Buffer.from(png.dataBase64, 'base64').subarray(0, 30));
    await assert.rejects(readReferenceImage(f.store, job.id, signal()), /signature/);
    await writeFile(path, Buffer.from(png.dataBase64, 'base64'));
    await writeFile(join(f.store.artifactRoot, job.id, 'reference.webp'), Buffer.from(webp.dataBase64, 'base64'));
    await assert.rejects(readReferenceImage(f.store, job.id, signal()), /Multiple reference/);
  } finally { await f.close(); }
});

test('screenshot reads require same-job registered screenshot kind and a path within that job', async () => {
  const f = await fixture();
  try {
    const one = await f.store.createJob({ title: 'Screenshot owner' });
    const two = await f.store.createJob({ title: 'Other owner' });
    const path = `${one.id}/captures/screen.png`;
    await mkdir(join(f.store.artifactRoot, one.id, 'captures'), { recursive: true });
    await writeFile(join(f.store.artifactRoot, path), Buffer.from(png.dataBase64, 'base64'));
    const screenshot = await f.store.registerArtifact(one.id, { path, kind: 'screenshot', screenshot: metadata, label: 'Synthetic reference, not a Codex observation' });
    const before = f.store.snapshot();
    assert.deepEqual(await readScreenshot(f.store, one.id, screenshot.id, signal()), png);
    assert.deepEqual(f.store.snapshot(), before);
    await assert.rejects(readScreenshot(f.store, two.id, screenshot.id, signal()), /of this job/);
    await assert.rejects(readScreenshot(f.store, one.id, randomUUID(), signal()), /registered/);
    const report = await f.store.registerArtifact(one.id, { path, kind: 'report' });
    await assert.rejects(readScreenshot(f.store, one.id, report.id, signal()), /screenshot artifact/);
    await assert.rejects(f.store.registerArtifact(two.id, { path, kind: 'screenshot', screenshot: metadata }), /inside its own job/);
    // Old registry data can predate strict registration. Reading remains defensive.
    const legacy = f.store.snapshot();
    const misplaced = { ...screenshot, id: randomUUID(), jobId: two.id };
    legacy.artifacts.push(misplaced);
    const legacyStore = { artifactRoot: f.store.artifactRoot, getJob: (id: string) => f.store.getJob(id), snapshot: () => legacy } as OpenCodexStore;
    await assert.rejects(readScreenshot(legacyStore, two.id, misplaced.id, signal()), /inside its own job/);
  } finally { await f.close(); }
});

test('screenshot reads reject changed checksums, missing files and linked path segments', async () => {
  const f = await fixture();
  try {
    const job = await f.store.createJob({ title: 'Screenshot integrity' });
    const directory = join(f.store.artifactRoot, job.id, 'captures');
    await mkdir(directory, { recursive: true });
    const path = `${job.id}/captures/screen.png`;
    const bytes = Buffer.from(png.dataBase64, 'base64');
    await writeFile(join(f.store.artifactRoot, path), bytes);
    const artifact = await f.store.registerArtifact(job.id, { path, kind: 'screenshot', screenshot: metadata });
    const changed = Buffer.from(bytes); changed[40] = changed[40]! ^ 1;
    await writeFile(join(f.store.artifactRoot, path), changed);
    await assert.rejects(readScreenshot(f.store, job.id, artifact.id, signal()), /SHA-256/);
    await writeFile(join(f.store.artifactRoot, path), bytes);
    const renamed = join(f.store.artifactRoot, job.id, 'renamed');
    await rename(directory, renamed); await symlink(renamed, directory);
    await assert.rejects(readScreenshot(f.store, job.id, artifact.id, signal()), /symlink/);
    await unlink(directory); await rename(renamed, directory);
    await unlink(join(f.store.artifactRoot, path));
    await assert.rejects(readScreenshot(f.store, job.id, artifact.id, signal()), /ENOENT/);
  } finally { await f.close(); }
});

test('registered screenshots still reject oversized payloads and non-image signatures', async () => {
  const f = await fixture();
  try {
    const job = await f.store.createJob({ title: 'Invalid screenshot' });
    await mkdir(join(f.store.artifactRoot, job.id));
    const path = `${job.id}/screen.png`;
    await writeFile(join(f.store.artifactRoot, path), Buffer.from(png.dataBase64, 'base64'));
    const valid = await f.store.registerArtifact(job.id, { path, kind: 'screenshot', screenshot: metadata });
    const file = await open(join(f.store.artifactRoot, path), 'w'); await file.truncate(MAX_REFERENCE_IMAGE_BYTES + 1); await file.close();
    await assert.rejects(readScreenshot(f.store, job.id, valid.id, signal()), /2 MiB/);
    await writeFile(join(f.store.artifactRoot, path), '<svg>not a supported raster image</svg>');
    // Simulate a legacy registry whose image kind predates signature validation.
    const svg = await f.store.registerArtifact(job.id, { path, kind: 'report' });
    const historical = f.store.snapshot(); historical.artifacts.find(item => item.id === svg.id)!.kind = 'screenshot';
    f.store.snapshot = () => structuredClone(historical);
    await assert.rejects(readScreenshot(f.store, job.id, svg.id, signal()), /signature/);
  } finally { await f.close(); }
});

test('authenticated host actions return images only on explicit requests, with path-free carrier schemas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-image-rpc-'));
  const ctx = new Context();
  ctx.provide('typert', { register() { return async () => {}; } } as never);
  ctx.provide('tools', { schemas: () => [], register: () => () => {} } as never);
  ctx.provide('sessions', { get: () => undefined } as never);
  ctx.provide('agents', { get: () => undefined } as never);
  ctx.provide('sessionController', {} as never);
  const plugin = new OpenCodex(ctx, { dataDirectory: directory, monitorTickMs: 1000 });
  try {
    const created = await plugin.call({ action: 'create', input: { title: 'RPC draft image' }, referenceImage: png }, signal());
    const jobId = created.state.jobs[0]!.id;
    const result = await plugin.call({ action: 'readReferenceImage', jobId }, signal());
    assert.deepEqual(result.referenceImage, png);
    assert.deepEqual(result.state, created.state);
    const store = await (plugin as unknown as { store: Promise<OpenCodexStore> }).store;
    const artifact = await store.registerArtifact(jobId, { path: `${jobId}/reference.png`, kind: 'screenshot', screenshot: metadata });
    assert.deepEqual((await plugin.call({ action: 'readScreenshot', jobId, artifactId: artifact.id }, signal())).screenshot, png);
    const snapshot = await plugin.call({ action: 'snapshot' }, signal());
    assert.equal('referenceImage' in snapshot, false); assert.equal('screenshot' in snapshot, false);
    assert.equal(JSON.stringify(snapshot).includes(png.dataBase64), false);
    const codec = OPEN_CODEX_DESCRIPTOR.parameters[0]!.codec as { create: () => { parse: (input: unknown) => unknown } };
    assert.deepEqual(codec.create().parse({ action: 'readReferenceImage', jobId }), { action: 'readReferenceImage', jobId });
    assert.deepEqual(codec.create().parse({ action: 'readScreenshot', jobId, artifactId: artifact.id }), { action: 'readScreenshot', jobId, artifactId: artifact.id });
    assert.throws(() => codec.create().parse({ action: 'readReferenceImage', jobId, path: '/arbitrary' }), /never a path/);
    assert.throws(() => codec.create().parse({ action: 'readScreenshot', jobId, artifactId: artifact.id, path: '/arbitrary' }), /never a path/);
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});
