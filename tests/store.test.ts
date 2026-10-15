import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { CandidateStore, writeJsonAtomic, type UpsertInput } from '../src/core/store.ts';
import type { Candidate, ReportRecord } from '../src/core/candidate.ts';

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

async function inTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'oc-store-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const seed = (key: string): UpsertInput => ({ source: 'codex-release', key, title: key, summary: '', evidence: [] });

test('patch keeps the identity fields, moves status only along allowed edges, and stamps updatedAt itself', async () => {
  await inTempDir(async dir => {
    let clock = '2026-10-15T00:00:00.000Z';
    const store = new CandidateStore(dir, () => new Date(clock));
    const a = (await store.upsert(seed('pr:10'))).candidate;
    const b = (await store.upsert(seed('pr:11'))).candidate;

    clock = '2026-10-15T02:00:00.000Z';
    const edited = await store.patch(a.id, c => ({ ...c, summary: 'edited', updatedAt: 'the store sets this, not the callback' }));
    assert.equal(edited.id, a.id);
    assert.equal(edited.summary, 'edited');
    assert.equal(edited.updatedAt, clock);
    assert.deepEqual(await store.get(a.id), edited);

    const forgeries: Array<[string, (c: Candidate) => Candidate]> = [
      ['id', c => ({ ...c, id: b.id })],
      ['fingerprint', c => ({ ...c, fingerprint: 'codex-release:pr:99' })],
      ['source', c => ({ ...c, source: 'rss' })],
      ['createdAt', c => ({ ...c, createdAt: '2020-01-01T00:00:00.000Z' })],
    ];
    for (const [field, update] of forgeries) {
      await assert.rejects(store.patch(a.id, update), { name: 'ValidationError', message: `patch must not change the candidate ${field}` });
    }
    // Mutating the argument in place and returning it must not get past the same guard, or it could overwrite b.
    await assert.rejects(store.patch(a.id, c => { c.id = b.id; return c; }), { name: 'ValidationError', message: 'patch must not change the candidate id' });
    assert.deepEqual(await store.get(a.id), edited);
    assert.deepEqual(await store.get(b.id), b);
    assert.equal((await readdir(join(dir, 'candidates'))).length, 2);

    const report: ReportRecord = { path: 'reports/x/report.md', generatedAt: clock, checks: { requiredSections: true, dshRefsTotal: 3, dshRefsResolved: 2 } };
    const reported = await store.patch(a.id, c => ({ ...c, status: 'reported', report }));
    assert.equal(reported.status, 'reported');
    assert.deepEqual(reported.report, report);
    assert.deepEqual(await store.get(a.id), reported);
    await assert.rejects(store.patch(b.id, c => ({ ...c, status: 'started' })), { name: 'ValidationError', message: 'Invalid transition new -> started' });
    assert.deepEqual(await store.get(b.id), b);
  });
});

test('get tells a malformed id from an unknown candidate and leaves other read errors alone', async () => {
  await inTempDir(async dir => {
    const store = new CandidateStore(dir);
    const unknown = '11111111-1111-4111-8111-111111111111';
    await assert.rejects(store.get('not-a-uuid'), { name: 'ValidationError', message: 'candidate id must be a UUID' });
    await assert.rejects(store.get(unknown), { name: 'ValidationError', message: `Unknown candidate ${unknown}` });
    await store.upsert(seed('pr:20'));
    await assert.rejects(store.get(unknown), { name: 'ValidationError', message: `Unknown candidate ${unknown}` });
    await assert.rejects(store.transition(unknown, 'ignored'), { name: 'ValidationError', message: `Unknown candidate ${unknown}` });
    await mkdir(join(dir, 'candidates', `${unknown}.json`));
    await assert.rejects(store.get(unknown), { code: 'EISDIR' });
  });
});

test('a damaged file is reported by its absolute path', async () => {
  await inTempDir(async dir => {
    const store = new CandidateStore(dir);
    const { candidate } = await store.upsert(seed('pr:30'));
    const corruptIn = (file: string) => (error: unknown) => {
      assert.ok(error instanceof Error && error.message.startsWith(`Corrupt JSON in ${file}: `), String(error));
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    };

    const candidateFile = join(dir, 'candidates', `${candidate.id}.json`);
    await writeFile(candidateFile, '{"id": ');
    await assert.rejects(store.list(), corruptIn(candidateFile));
    await assert.rejects(store.get(candidate.id), corruptIn(candidateFile));
    await assert.rejects(store.upsert(seed('pr:31')), corruptIn(candidateFile));
    await writeFile(candidateFile, 'null');
    await assert.rejects(store.list(), { name: 'ValidationError', message: `${candidateFile} must hold a JSON object` });

    const stateFile = join(dir, 'state.json');
    await writeFile(stateFile, '{"lastStableTag": ');
    await assert.rejects(store.checkpoint('lastStableTag'), corruptIn(stateFile));
    await assert.rejects(store.setCheckpoint('lastStableTag', 'rust-v0.162.1'), corruptIn(stateFile));
    // A store opened on a relative directory still names an absolute path.
    await assert.rejects(new CandidateStore(relative(process.cwd(), dir)).checkpoint('lastStableTag'), corruptIn(stateFile));
    await writeFile(stateFile, '[]');
    await assert.rejects(store.checkpoint('lastStableTag'), { name: 'ValidationError', message: `${stateFile} must hold a JSON object` });
  });
});

test('checkpoint names and values are validated, and a normal one round-trips', async () => {
  await inTempDir(async dir => {
    const store = new CandidateStore(dir);
    await store.setCheckpoint('lastStableTag', 'rust-v0.162.1');
    await store.setCheckpoint('lastDesktopVersion', 'Codex 26.1 (build 20)');
    const longestName = `a${'b'.repeat(63)}`;
    await store.setCheckpoint(longestName, 'x'.repeat(512));
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.162.1');
    assert.equal(await store.checkpoint('lastDesktopVersion'), 'Codex 26.1 (build 20)');
    assert.equal(await store.checkpoint(longestName), 'x'.repeat(512));
    const saved = { lastStableTag: 'rust-v0.162.1', lastDesktopVersion: 'Codex 26.1 (build 20)', [longestName]: 'x'.repeat(512) };
    assert.deepEqual(await store.checkpoints(), saved);

    for (const name of ['', '1tag', '_tag', '__proto__', 'a b', 'a/b', '../state', 'a.b', 'tag\n', `${longestName}c`, undefined as unknown as string]) {
      await assert.rejects(store.setCheckpoint(name, 'v'), { name: 'ValidationError', message: /^Invalid checkpoint name/ });
      await assert.rejects(store.checkpoint(name), { name: 'ValidationError', message: /^Invalid checkpoint name/ });
    }
    for (const value of ['', 'two\nlines', 'cr\rhere', 'tab\there', 'nul\u0000byte', 'nel\u0085here', 'sep here', 'x'.repeat(513), undefined as unknown as string, 5 as unknown as string]) {
      await assert.rejects(store.setCheckpoint('lastStableTag', value), { name: 'ValidationError', message: /^Invalid value for checkpoint lastStableTag/ });
    }
    assert.deepEqual(await store.checkpoints(), saved);

    // Names that exist on every object are not checkpoints until someone sets them.
    assert.equal(await store.checkpoint('constructor'), undefined);
    assert.equal(await store.checkpoint('toString'), undefined);
  });
});
