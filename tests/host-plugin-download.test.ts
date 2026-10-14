import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, open, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import { OpenCodexStore } from '../src/core/index.js';
import OpenCodex from '../src/host/index.js';
import { OPEN_CODEX_DESCRIPTOR } from '../src/host/remote.js';
import { MAX_PLUGIN_DOWNLOAD_BYTES, PLUGIN_DOWNLOAD_CHUNK_BYTES, readPluginArtifact } from '../src/host/plugin-download.js';

const signal = () => new AbortController().signal;
function tarball(padding?: Buffer): Buffer {
  const files: Record<string, Buffer> = {
    'package/package.json': Buffer.from(JSON.stringify({ name: 'synthetic-download-fixture', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })),
    'package/cordis.patch.yml': Buffer.from('plugins: []'),
    'package/dist/client.js': Buffer.from('throw new Error("Downloads must never execute this code");'),
    ...(padding ? { 'package/synthetic.bin': padding } : {}),
  };
  const chunks: Buffer[] = [];
  for (const [name, body] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    header[156] = 48; header.fill(32, 148, 156);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

async function packageJob(store: OpenCodexStore, bytes = tarball()) {
  const job = await store.createJob({ title: 'Synthetic downloadable package' });
  for (const status of ['queued', 'researching', 'specifying', 'building'] as const) await store.transitionJob(job.id, status);
  const relativePath = `${job.id}/dist/fixture-1.0.0.tgz`;
  const path = join(store.artifactRoot, relativePath);
  await mkdir(join(store.artifactRoot, job.id, 'dist'), { recursive: true });
  await writeFile(path, bytes);
  const artifact = await store.registerArtifact(job.id, { path: relativePath, kind: 'plugin' });
  return { jobId: job.id, artifact, path, bytes };
}

async function fixture(t: TestContext, bytes?: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-download-'));
  const store = await OpenCodexStore.open({ directory: join(directory, 'state'), artifactRoot: join(directory, 'jobs') });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, ...await packageJob(store, bytes) };
}

test('registered packages download in bounded, hash-consistent chunks before readiness without changing acceptance', async t => {
  const f = await fixture(t, tarball(randomBytes(PLUGIN_DOWNLOAD_CHUNK_BYTES + 1200)));
  const before = f.store.snapshot();
  const first = await readPluginArtifact(f.store, f.jobId, f.artifact.id, undefined, signal());
  assert.equal(first.offset, 0); assert.equal(first.filename, 'fixture-1.0.0.tgz');
  assert.equal(first.totalBytes, f.bytes.length); assert.equal(first.sha256, f.artifact.sha256);
  assert.equal(Buffer.from(first.dataBase64, 'base64').length, PLUGIN_DOWNLOAD_CHUNK_BYTES);
  assert.equal(first.nextOffset, PLUGIN_DOWNLOAD_CHUNK_BYTES);
  assert.ok(JSON.stringify(first).length < 710_000);
  const last = await readPluginArtifact(f.store, f.jobId, f.artifact.id, first.nextOffset, signal());
  assert.equal(last.nextOffset, undefined); assert.equal(last.offset, first.nextOffset);
  const bytes = Buffer.concat([Buffer.from(first.dataBase64, 'base64'), Buffer.from(last.dataBase64, 'base64')]);
  assert.deepEqual(bytes, f.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), f.artifact.sha256);
  assert.deepEqual(f.store.snapshot(), before);
  await f.store.transitionJob(f.jobId, 'verifying');
  await assert.rejects(f.store.transitionJob(f.jobId, 'ready'), /feature spec/);
  assert.equal(f.store.getJob(f.jobId).status, 'verifying');
});

test('download only accepts a registered plugin in the requested existing job and its own directory', async t => {
  const f = await fixture(t);
  const other = await f.store.createJob({ title: 'Other job' });
  await assert.rejects(readPluginArtifact(f.store, other.id, f.artifact.id, 0, signal()), /of this job/);
  await assert.rejects(readPluginArtifact(f.store, f.jobId, randomUUID(), 0, signal()), /registered plugin/);
  await assert.rejects(readPluginArtifact(f.store, randomUUID(), f.artifact.id, 0, signal()), /Unknown job/);
  await assert.rejects(readPluginArtifact(f.store, '../escape', f.artifact.id, 0, signal()), /Invalid plugin/);
  const report = await f.store.registerArtifact(f.jobId, { path: f.artifact.path, kind: 'report' });
  await assert.rejects(readPluginArtifact(f.store, f.jobId, report.id, 0, signal()), /registered plugin/);
  const state = f.store.snapshot();
  const original = state.artifacts.find(item => item.id === f.artifact.id)!;
  const historicalStore = { artifactRoot: f.store.artifactRoot, getJob: (id: string) => f.store.getJob(id), snapshot: () => state } as OpenCodexStore;
  for (const path of [`../${f.artifact.path}`, `/tmp/${f.artifact.path}`, `${f.jobId}/../escape.tgz`, `${f.jobId}\\escape.tgz`]) {
    original.path = path;
    await assert.rejects(readPluginArtifact(historicalStore, f.jobId, f.artifact.id, 0, signal()), /Invalid plugin artifact path/);
  }
  original.path = `${other.id}/fixture.tgz`;
  await assert.rejects(readPluginArtifact(historicalStore, f.jobId, f.artifact.id, 0, signal()), /inside its own job/);
});

test('download rejects invalid offsets, oversized files, cancellation and changes between chunks', async t => {
  const f = await fixture(t);
  for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, f.bytes.length, '0', null]) {
    await assert.rejects(readPluginArtifact(f.store, f.jobId, f.artifact.id, offset as number, signal()), /offset/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readPluginArtifact(f.store, f.jobId, f.artifact.id, 0, controller.signal), /abort/i);
  await readPluginArtifact(f.store, f.jobId, f.artifact.id, 0, signal());
  const changed = Buffer.from(f.bytes); changed[changed.length - 1] ^= 1;
  await writeFile(f.path, changed);
  await assert.rejects(readPluginArtifact(f.store, f.jobId, f.artifact.id, 0, signal()), /SHA-256/);
  const file = await open(f.path, 'w'); await file.truncate(MAX_PLUGIN_DOWNLOAD_BYTES + 1); await file.close();
  await assert.rejects(readPluginArtifact(f.store, f.jobId, f.artifact.id, 0, signal()), /16 MB/);
});

test('download rejects file symlinks, hard links, directory symlink chains and symlinked roots', async t => {
  const f = await fixture(t);
  const saved = `${f.path}.saved`; await rename(f.path, saved);
  await symlink(saved, f.path);
  await assert.rejects(readPluginArtifact(f.store, f.jobId, f.artifact.id, 0, signal()), /regular file/);
  await unlink(f.path); await link(saved, f.path);
  await assert.rejects(readPluginArtifact(f.store, f.jobId, f.artifact.id, 0, signal()), /hard links/);
  await unlink(f.path); await rename(saved, f.path);
  const dist = join(f.store.artifactRoot, f.jobId, 'dist'), moved = `${dist}-saved`;
  await rename(dist, moved); await symlink(moved, dist);
  await assert.rejects(readPluginArtifact(f.store, f.jobId, f.artifact.id, 0, signal()), /symlinks/);
  await unlink(dist); await rename(moved, dist);
  const alias = join(f.directory, 'alias'); await symlink(f.store.artifactRoot, alias);
  const linkedStore = { artifactRoot: alias, getJob: (id: string) => f.store.getJob(id), snapshot: () => f.store.snapshot() } as OpenCodexStore;
  await assert.rejects(readPluginArtifact(linkedStore, f.jobId, f.artifact.id, 0, signal()), /symlinks/);
  await unlink(f.path); await mkdir(f.path);
  await assert.rejects(readPluginArtifact(f.store, f.jobId, f.artifact.id, 0, signal()), /regular file/);
});

test('download reuses structural npm package inspection and refuses arbitrary registered bytes', async t => {
  const f = await fixture(t, gzipSync(Buffer.from('not a package tar archive')));
  await assert.rejects(readPluginArtifact(f.store, f.jobId, f.artifact.id, 0, signal()), /package.json/);
  const path = `${f.jobId}/not-a-tarball.txt`;
  await writeFile(join(f.store.artifactRoot, path), tarball());
  const artifact = await f.store.registerArtifact(f.jobId, { path, kind: 'plugin' });
  await assert.rejects(readPluginArtifact(f.store, f.jobId, artifact.id, 0, signal()), /npm tarball filename/);
});

test('download RPC is explicit, path-free, read-only and absent from ordinary snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-download-rpc-'));
  const ctx = new Context();
  ctx.provide('typert', { register() { return async () => {}; } } as never);
  ctx.provide('tools', { schemas: () => [], register: () => () => {} } as never);
  ctx.provide('sessions', { get: () => undefined } as never);
  ctx.provide('agents', { get: () => undefined } as never);
  ctx.provide('sessionController', {} as never);
  const plugin = new OpenCodex(ctx, { dataDirectory: directory, monitorTickMs: 1000 });
  try {
    const store = await (plugin as unknown as { store: Promise<OpenCodexStore> }).store;
    const f = await packageJob(store);
    const before = store.snapshot();
    const request = { action: 'readPluginArtifact', jobId: f.jobId, artifactId: f.artifact.id } as const;
    const response = await plugin.call(request, signal());
    assert.deepEqual(Buffer.from(response.pluginArtifact!.dataBase64, 'base64'), f.bytes);
    assert.deepEqual(response.state, before);
    const snapshot = await plugin.call({ action: 'snapshot' }, signal());
    assert.equal('pluginArtifact' in snapshot, false);
    assert.equal(JSON.stringify(snapshot).includes(f.bytes.toString('base64')), false);
    const codec = OPEN_CODEX_DESCRIPTOR.parameters[0]!.codec as { create: () => { parse: (input: unknown) => unknown } };
    assert.deepEqual(codec.create().parse(request), request);
    assert.deepEqual(codec.create().parse({ ...request, offset: 1 }), { ...request, offset: 1 });
    assert.throws(() => codec.create().parse({ ...request, path: '/arbitrary' }), /never a path/);
    for (const offset of [-1, '0', 0.1, null]) assert.throws(() => codec.create().parse({ ...request, offset }), /offset/);
    assert.throws(() => codec.create().parse({ action: 'readPluginArtifact', jobId: f.jobId }), /identifiers/);
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});
