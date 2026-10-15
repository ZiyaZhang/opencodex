import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandidateStore, writeJsonAtomic, type UpsertInput } from '../src/core/store.ts';

test('upsert dedupes by fingerprint, list filters by status, transitions persist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-store-'));
  try {
    const store = new CandidateStore(dir, () => new Date('2026-10-15T00:00:00Z'));
    const first = await store.upsert({ source: 'codex-release', key: 'pr:1', title: 'A', summary: 's', evidence: [] });
    const again = await store.upsert({ source: 'codex-release', key: 'pr:1', title: 'A2', summary: 's2', evidence: [] });
    const a = first.candidate;
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.candidate.id, a.id);
    assert.equal(again.candidate.title, 'A2');
    assert.equal((await readdir(join(dir, 'candidates'))).length, 1);
    await store.transition(a.id, 'ignored');
    assert.deepEqual((await store.list({ status: 'ignored' })).map(c => c.id), [a.id]);
    assert.equal((await store.list({ status: 'new' })).length, 0);
    await store.setCheckpoint('lastStableTag', 'rust-v0.162.1');
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.162.1');
    const reopened = new CandidateStore(dir);
    assert.equal((await reopened.get(a.id)).status, 'ignored');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('upsert returns exactly what get reads back, and an omitted window is neither written nor lost', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-store-'));
  try {
    const store = new CandidateStore(dir);
    const plain: UpsertInput = { source: 'desktop', key: 'chunk:a', title: 'A', summary: '', evidence: [] };
    const created = await store.upsert(plain);
    assert.equal(Object.hasOwn(created.candidate, 'window'), false);
    assert.deepEqual(created.candidate, await store.get(created.candidate.id));
    const refreshed = await store.upsert({ ...plain, title: 'A2' });
    assert.equal(Object.hasOwn(refreshed.candidate, 'window'), false);
    assert.deepEqual(refreshed.candidate, await store.get(created.candidate.id));
    const releaseWindow = { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.1' };
    assert.deepEqual((await store.upsert({ ...plain, window: releaseWindow })).candidate.window, releaseWindow);
    const kept = await store.upsert(plain);
    assert.deepEqual(kept.candidate.window, releaseWindow);
    assert.deepEqual(kept.candidate, await store.get(created.candidate.id));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a state.json that is not a JSON object is rejected and left untouched, not silently dropping checkpoints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-store-'));
  try {
    const store = new CandidateStore(dir);
    for (const body of ['null', '[]', '"x"']) {
      await writeFile(join(dir, 'state.json'), body);
      await assert.rejects(store.checkpoint('lastStableTag'), { name: 'ValidationError', message: /state\.json/ });
      await assert.rejects(store.setCheckpoint('lastStableTag', 'rust-v0.162.1'), { name: 'ValidationError', message: /state\.json/ });
      assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), body);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed atomic write keeps the previous file and leaves no temp file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-store-'));
  try {
    const path = join(dir, 'doc.json');
    await writeJsonAtomic(path, { n: 1 });
    // JSON.stringify throws on a BigInt, after the temp file has already been opened.
    await assert.rejects(writeJsonAtomic(path, { n: 1n }), TypeError);
    assert.deepEqual(await readdir(dir), ['doc.json']);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 1 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
