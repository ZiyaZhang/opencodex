import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCodexStore } from '../src/core/index.js';
import { scaffoldPlugin, SCAFFOLD_FILES } from '../src/host/scaffold.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
async function fixture(mode: 'reconstruct' | 'investigate' = 'reconstruct') {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-scaffold-'));
  const store = await OpenCodexStore.open({ directory });
  let job = await store.createJob({ title: 'Scaffold fixture', mode });
  await mkdir(join(store.artifactRoot, job.id));
  const workdir = await realpath(join(store.artifactRoot, job.id));
  job = await store.bindSession(job.id, { sessionId: 'scaffold-fixture-session', workdir });
  await store.transitionJob(job.id, 'queued'); job = await store.transitionJob(job.id, 'researching');
  return { directory, store, job, workdir, close: async () => { await store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('packaged scaffold creates the complete generic bundle without executing or overwriting it', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.workdir, 'plugin'));
    const result = await scaffoldPlugin(packageRoot, f.store.artifactRoot, f.job, 'dsh-fixture-plugin');
    assert.equal(result.path, 'plugin'); assert.deepEqual(result.files, [...SCAFFOLD_FILES]);
    for (const name of SCAFFOLD_FILES) {
      const source = await readFile(join(packageRoot, 'templates/dsh-plugin', name), 'utf8');
      const actual = await readFile(join(f.workdir, result.path, name), 'utf8');
      assert.equal(actual, source.replaceAll('__PLUGIN_NAME__', 'dsh-fixture-plugin'));
      assert.doesNotMatch(actual, /__PLUGIN_NAME__/);
    }
    const manifest = JSON.parse(await readFile(join(f.workdir, 'plugin/package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(join(f.workdir, 'plugin/package-lock.json'), 'utf8'));
    assert.equal(manifest.name, 'dsh-fixture-plugin'); assert.equal(lock.name, manifest.name);
    assert.equal(lock.packages[''].name, manifest.name);
    assert.equal(result.quickstart.clientSource, await readFile(join(f.workdir, 'plugin', result.quickstart.clientEntry), 'utf8'));
    assert.equal(result.quickstart.templateDependencies['@deepseek-ai/dsh-client-ui-slots'], manifest.devDependencies['@deepseek-ai/dsh-client-ui-slots']);
    assert.equal(result.quickstart.output, 'plugin/release/dsh-fixture-plugin-0.1.0.tgz');
    assert.match(result.quickstart.note, /not a probe/);
    for (const file of result.quickstart.files) assert.equal(file.sha256, createHash('sha256').update(await readFile(join(f.workdir, 'plugin', file.path))).digest('hex'));
    assert.equal((await readdir(join(f.workdir, 'plugin'))).includes('node_modules'), false);
    assert.equal((await readdir(join(f.workdir, 'plugin'))).includes('dist'), false);
    await assert.rejects(scaffoldPlugin(packageRoot, f.store.artifactRoot, f.job, 'dsh-second-plugin'), /empty|overwritten/);
    assert.equal(JSON.parse(await readFile(join(f.workdir, 'plugin/package.json'), 'utf8')).name, manifest.name);
  } finally { await f.close(); }
});

test('scaffold rejects package traversal, another workspace, investigation jobs, symlink output and nonempty directories', async () => {
  const f = await fixture();
  try {
    for (const name of ['../escape', '@scope/plugin', 'MixedCase', 'a'.repeat(81), 'a;echo-owned', '-invalid']) await assert.rejects(scaffoldPlugin(packageRoot, f.store.artifactRoot, f.job, name), /packageName/);
    await assert.rejects(scaffoldPlugin(packageRoot, f.store.artifactRoot, { ...f.job, workdir: f.directory }, 'safe-name'), /workspace/);
    await assert.rejects(scaffoldPlugin(packageRoot, f.store.artifactRoot, { ...f.job, id: '../escape' }, 'safe-name'), /path segment/);
    await assert.rejects(scaffoldPlugin(packageRoot, f.store.artifactRoot, { ...f.job, mode: 'investigate' }, 'safe-name'), /reconstruction/);
    const outside = join(f.directory, 'outside'); await mkdir(outside);
    await symlink(outside, join(f.workdir, 'plugin'));
    await assert.rejects(scaffoldPlugin(packageRoot, f.store.artifactRoot, f.job, 'safe-name'), /symlink/);
    assert.deepEqual(await readdir(outside), []);
    await rm(join(f.workdir, 'plugin'));
    await mkdir(join(f.workdir, 'plugin'));
    await writeFile(join(f.workdir, 'plugin/keep.txt'), 'user-owned');
    await assert.rejects(scaffoldPlugin(packageRoot, f.store.artifactRoot, f.job, 'safe-name'), /empty/);
    assert.equal(await readFile(join(f.workdir, 'plugin/keep.txt'), 'utf8'), 'user-owned');
  } finally { await f.close(); }
});

test('scaffold rejects symlinked or oversized templates before publishing any output', async () => {
  const f = await fixture();
  try {
    const fake = join(f.directory, 'package'); const templates = join(fake, 'templates/dsh-plugin');
    for (const name of SCAFFOLD_FILES) { await mkdir(dirname(join(templates, name)), { recursive: true }); await writeFile(join(templates, name), 'generic __PLUGIN_NAME__'); }
    const outside = join(f.directory, 'outside.txt'); await writeFile(outside, 'private fixture');
    await rm(join(templates, 'package.json')); await symlink(outside, join(templates, 'package.json'));
    await assert.rejects(scaffoldPlugin(fake, f.store.artifactRoot, f.job, 'safe-name'), /ELOOP|symbolic|symlink/i);
    await rm(join(templates, 'package.json')); await writeFile(join(templates, 'package.json'), 'x'.repeat(128_001));
    await assert.rejects(scaffoldPlugin(fake, f.store.artifactRoot, f.job, 'safe-name'), /bounded|limit/);
    assert.equal((await readdir(f.workdir)).includes('plugin'), false);
    await writeFile(join(templates, 'package.json'), '{}');
    await rm(join(templates, 'src/client'), { recursive: true });
    const escapedDirectory = join(f.directory, 'escaped'); await mkdir(escapedDirectory); await writeFile(join(escapedDirectory, 'index.ts'), 'outside');
    await symlink(escapedDirectory, join(templates, 'src/client'));
    await assert.rejects(scaffoldPlugin(fake, f.store.artifactRoot, f.job, 'safe-name'), /symlink/);
  } finally { await f.close(); }
});
