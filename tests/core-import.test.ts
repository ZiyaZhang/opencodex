import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCodexStore } from '../src/core/index.js';

test('operator package import preserves pause, budget and gates, records provenance and is retry-safe', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-import-'));
  const store = await OpenCodexStore.open({ directory });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const job = await store.createJob({ title: 'Operator-assisted experiment' });
  await store.transitionJob(job.id, 'queued'); await store.transitionJob(job.id, 'paused');
  await mkdir(join(store.artifactRoot, job.id));
  const path = `${job.id}/fixture.tgz`;
  // Core tests byte bookkeeping only; Host download separately requires a valid inspected package.
  await writeFile(join(store.artifactRoot, path), 'core import fixture');
  const before = store.getJob(job.id), budget = store.budgetSummary(job.id);
  const input = { path, label: 'Experiment', details: 'Model wrote code; operator fixed compilation and packaged it.', userConfirmed: true as const };
  await assert.rejects(store.importPluginArtifact(job.id, { ...input, userConfirmed: false } as never), /explicit user/);
  const artifact = await store.importPluginArtifact(job.id, input);
  assert.equal((await store.importPluginArtifact(job.id, input)).id, artifact.id);
  assert.deepEqual(store.budgetSummary(job.id), budget);
  assert.equal(store.getJob(job.id).status, 'paused');
  assert.deepEqual(store.getJob(job.id).history, before.history);
  assert.equal(artifact.provenance?.kind, 'operator-assisted');
  assert.equal(store.snapshot().evidence.filter(item => item.localPath === path).length, 1);
  assert.equal(store.snapshot().verifications.length, 0);
  await assert.rejects(store.transitionJob(job.id, 'ready'), /Invalid transition/);
  await assert.rejects(store.importPluginArtifact(job.id, { ...input, path: 'another-job/fixture.tgz' }), /own job/);
  await symlink(join(store.artifactRoot, path), join(store.artifactRoot, job.id, 'linked.tgz'));
  await assert.rejects(store.importPluginArtifact(job.id, { ...input, path: `${job.id}/linked.tgz` }), /links/);
  const investigation = await store.createJob({ title: 'Investigate only', mode: 'investigate' });
  await assert.rejects(store.importPluginArtifact(investigation.id, input), /Investigation/);
});

test('selecting one discovered feature concurrently or after restart creates only one job', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-select-'));
  let store = await OpenCodexStore.open({ directory });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const candidate = await store.saveCandidate({ title: 'Feature', description: 'Release note', sourceUrl: 'https://example.com/changelog#feature', fingerprint: 'release:feature', publishedAt: '2026-10-14T00:00:00.000Z', releaseTitle: 'Codex app update', sourceType: 'public-source' });
  const input = { title: candidate.title, candidateId: candidate.id, source: 'discovery' as const };
  const [one, two] = await Promise.all([store.createJob(input), store.createJob(input)]);
  assert.equal(one.id, two.id);
  await store.close(); store = await OpenCodexStore.open({ directory });
  assert.equal((await store.createJob(input)).id, one.id);
  assert.equal(store.snapshot().jobs.length, 1);
  assert.equal(store.getJob(one.id).status, 'detected');
});
