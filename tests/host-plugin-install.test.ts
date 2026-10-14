import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BundleInfo, ChangeResult } from '@deepseek-ai/dsh-plugin-manager';
import { OpenCodexStore } from '../src/core/store.js';
import { PluginInstaller } from '../src/host/plugin-install.js';
import { fixtureTarball, verifyingPlugin } from './helpers/plugin-fixture.js';

const applied: ChangeResult = { changed: true, application: 'applied', stage: 'enable', target: 'dsh-install-fixture', enabled: true, bundle: 'dsh-install-fixture', version: '1.0.0' };
async function fixture(t: TestContext, ready = true) {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-install-'));
  let store = await OpenCodexStore.open({ directory });
  const data = await verifyingPlugin(store);
  if (ready) {
    for (const scope of ['behavior', 'visual', 'lifecycle'] as const) await store.recordVerification(data.jobId, data.verification(scope));
    await store.transitionJob(data.jobId, 'ready');
  }
  const installs: Array<{ path: string; options: unknown }> = [], enables: string[] = [];
  const manager = {
    async listBundles(): Promise<BundleInfo[]> { return []; },
    async installBundle(path: string, options?: unknown): Promise<ChangeResult> { installs.push({ path, options }); return applied; },
    async setBundleEnabled(name: string): Promise<ChangeResult> { enables.push(name); return applied; },
    async cancelInstall() { return { status: 'not-running' as const }; },
  };
  const controller = new AbortController();
  const installer = () => new PluginInstaller(store, directory, () => manager, controller.signal);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...data, directory, get store() { return store; }, manager, installer, installs, enables, controller,
    async reopen() { await store.close(); store = await OpenCodexStore.open({ directory }); } };
}

test('accepted package automatically installs and enables once, with a retained exact source and durable receipt', async t => {
  const f = await fixture(t), installer = f.installer();
  await Promise.all([installer.install(f.jobId), installer.install(f.jobId)]);
  await installer.install(f.jobId);
  assert.equal(f.installs.length, 1);
  assert.deepEqual(await readFile(f.installs[0]!.path), f.bytes);
  assert.match(f.installs[0]!.path, /installed-packages\/[a-f0-9]{64}\/plugin.tgz$/);
  assert.deepEqual(f.installs[0]!.options, { enabled: true, saveExact: true, requestId: f.store.getJob(f.jobId).installation!.requestId });
  await f.reopen();
  const job = f.store.getJob(f.jobId);
  assert.equal(job.status, 'installed'); assert.equal(job.installation?.application, 'applied');
  assert.equal(job.installation?.artifactSha256, f.artifact.sha256);
});

test('unaccepted or modified packages never reach DSH package management', async t => {
  const pending = await fixture(t, false);
  await assert.rejects(pending.installer().install(pending.jobId), /accepted/);
  assert.equal(pending.installs.length, 0);
  const modified = await fixture(t);
  await writeFile(join(modified.store.artifactRoot, modified.artifact.path), 'modified after acceptance');
  await modified.installer().install(modified.jobId);
  assert.equal(modified.installs.length, 0);
  assert.equal(modified.store.getJob(modified.jobId).installation?.status, 'failed');
});

for (const application of ['restart-required', 'failed', 'overridden', 'cancelled'] as const) {
  test(`native ${application} is recorded without claiming running state`, async t => {
    const f = await fixture(t);
    f.manager.installBundle = async () => ({ ...applied, application, ...(application === 'failed' ? { packageResult: { exitCode: 1, output: 'Fixture failure', truncated: false, logPath: '/fixture/install.log' } } : {}) });
    await f.installer().install(f.jobId);
    const job = f.store.getJob(f.jobId);
    assert.equal(job.installation?.application, application);
    assert.equal(job.status, application === 'restart-required' ? 'installed' : 'ready');
    assert.equal(job.installation?.status, application === 'restart-required' ? 'installed' : 'failed');
    if (application === 'failed') assert.equal(job.installation?.logPath, '/fixture/install.log');
  });
}

test('restart marks uncertain installation interrupted; retry reconciles exact installed source without reinstalling', async t => {
  const f = await fixture(t);
  await f.store.beginInstallation(f.jobId);
  await f.reopen();
  assert.equal(f.store.getJob(f.jobId).installation?.status, 'interrupted');
  f.manager.listBundles = async () => [{ name: 'dsh-install-fixture', version: '1.0.0', installed: true, enabled: true, availability: 'profile', source: `file:${join(await realpath(f.directory), 'installed-packages', f.artifact.sha256, 'plugin.tgz')}` } as BundleInfo];
  await f.installer().install(f.jobId);
  assert.equal(f.installs.length, 0); assert.deepEqual(f.enables, ['dsh-install-fixture']);
  assert.equal(f.store.getJob(f.jobId).status, 'installed');
});

test('name collisions, missing manager, and wrong installer targets keep the artifact with a failed receipt', async t => {
  const f = await fixture(t);
  f.manager.listBundles = async () => [{ name: 'dsh-install-fixture', version: '1.0.0', installed: true, availability: 'profile', source: '^1.0.0' } as BundleInfo];
  await f.installer().install(f.jobId);
  assert.equal(f.installs.length, 0); assert.match(f.store.getJob(f.jobId).installation!.error!, /已被其他安装占用/);
  await new PluginInstaller(f.store, f.directory, () => undefined, f.controller.signal).install(f.jobId);
  assert.match(f.store.getJob(f.jobId).installation!.error!, /未提供插件管理/);
  f.manager.listBundles = async () => [];
  f.manager.installBundle = async () => ({ ...applied, target: 'another-package' });
  await f.installer().install(f.jobId);
  assert.equal(f.store.getJob(f.jobId).status, 'ready');
  assert.equal(f.store.getJob(f.jobId).installedReceipt, undefined);
});

test('unload cancels an active native installation and settles before closing the journal', async t => {
  const f = await fixture(t);
  let settle!: (result: ChangeResult) => void, started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  f.manager.installBundle = () => new Promise(resolve => { settle = resolve; started(); });
  let cancelled = false;
  f.manager.cancelInstall = async () => { cancelled = true; settle({ ...applied, application: 'cancelled' }); return { status: 'not-running' }; };
  const installer = f.installer(), operation = installer.install(f.jobId);
  await start; f.controller.abort(); await operation; await installer.whenIdle();
  assert.equal(cancelled, true); assert.equal(f.store.getJob(f.jobId).installation?.application, 'cancelled');
});

test('independence inspection rejects an OpenCodex runtime dependency before installation', async t => {
  const f = await fixture(t, false);
  await writeFile(join(f.store.artifactRoot, f.artifact.path), fixtureTarball({ dependencies: { 'dsh-opencodex': '^0.1.2' } }));
  const artifact = await f.store.registerArtifact(f.jobId, { path: f.artifact.path });
  for (const scope of ['behavior', 'visual', 'lifecycle'] as const) await f.store.recordVerification(f.jobId, { ...f.verification(scope), artifactId: artifact.id });
  await f.store.transitionJob(f.jobId, 'ready');
  await f.installer().install(f.jobId);
  assert.equal(f.installs.length, 0); assert.match(f.store.getJob(f.jobId).installation!.error!, /independently/);
});
