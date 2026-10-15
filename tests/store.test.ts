import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
      await assert.rejects(store.checkpoint('lastStableTag'), { name: 'Error', message: /state\.json/ });
      await assert.rejects(store.setCheckpoint('lastStableTag', 'rust-v0.162.1'), { name: 'Error', message: /state\.json/ });
      assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), body);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed atomic write keeps the previous file and leaves no temp file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-store-'));
  try {
    const path = join(dir, 'doc.json');
    await writeJsonAtomic(path, { n: 1 });
    // A value JSON cannot hold is refused before anything touches the disk: BigInt makes JSON.stringify throw, undefined has no JSON text at all.
    await assert.rejects(writeJsonAtomic(path, { n: 1n }), TypeError);
    await assert.rejects(writeJsonAtomic(path, undefined), TypeError);
    await assert.rejects(writeJsonAtomic(join(dir, 'new-dir', 'doc.json'), undefined), TypeError);
    assert.deepEqual(await readdir(dir), ['doc.json']);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 1 });
    // Once the temp file exists, a failing rename must remove it again: a directory at the target path gives EISDIR.
    const blocked = join(dir, 'blocked.json');
    await mkdir(blocked);
    await assert.rejects(writeJsonAtomic(blocked, { n: 2 }), { code: 'EISDIR' });
    assert.deepEqual((await readdir(dir)).sort(), ['blocked.json', 'doc.json']);
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
    const candidateFile = join(dir, 'candidates', `${candidate.id}.json`);
    const stateFile = join(dir, 'state.json');
    const failsWith = (message: string) => ({ name: 'Error', message });
    const corruptIn = (file: string) => (error: unknown) => {
      assert.ok(error instanceof Error && error.name === 'Error' && error.message.startsWith(`Corrupt JSON in ${file}: `), String(error));
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    };
    // upsert scans every file for the fingerprint, so it has to refuse a damaged one just like list() and get().
    const expectRefused = async (content: string, expected: object | ((error: unknown) => boolean)) => {
      await writeFile(candidateFile, content);
      await assert.rejects(store.list(), expected);
      await assert.rejects(store.get(candidate.id), expected);
      await assert.rejects(store.upsert(seed('pr:31')), expected);
    };

    await expectRefused('{"id": ', corruptIn(candidateFile));
    await expectRefused('null', failsWith(`${candidateFile} must hold a JSON object`));
    await expectRefused('[]', failsWith(`${candidateFile} must hold a JSON object`));
    await expectRefused('{}', failsWith(`${candidateFile} is not a candidate: id must be a string`));
    for (const field of ['id', 'fingerprint', 'status', 'updatedAt']) {
      await expectRefused(JSON.stringify({ ...candidate, [field]: 5 }), failsWith(`${candidateFile} is not a candidate: ${field} must be a string`));
    }
    const other = '22222222-2222-4222-8222-222222222222';
    await expectRefused(JSON.stringify({ ...candidate, id: other }), failsWith(`${candidateFile} is not a candidate: id "${other}" does not match the file name`));
    // A valid candidate filed under another name is just as wrong.
    const stray = join(dir, 'candidates', 'stray.json');
    await writeFile(candidateFile, JSON.stringify(candidate));
    await writeFile(stray, JSON.stringify(candidate));
    await assert.rejects(store.list(), failsWith(`${stray} is not a candidate: id "${candidate.id}" does not match the file name`));
    await rm(stray);
    assert.deepEqual((await store.list()).map(c => c.id), [candidate.id]);

    await writeFile(stateFile, '{"lastStableTag": ');
    await assert.rejects(store.checkpoint('lastStableTag'), corruptIn(stateFile));
    await assert.rejects(store.setCheckpoint('lastStableTag', 'rust-v0.162.1'), corruptIn(stateFile));
    // A store opened on a relative directory still names an absolute path.
    await assert.rejects(new CandidateStore(relative(process.cwd(), dir)).checkpoint('lastStableTag'), corruptIn(stateFile));
    await writeFile(stateFile, '[]');
    await assert.rejects(store.checkpoint('lastStableTag'), failsWith(`${stateFile} must hold a JSON object`));
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
    for (const value of ['', 'two\nlines', 'cr\rhere', 'tab\there', 'nul\u0000byte', 'nel\u0085here', 'sep\u2028here', 'x'.repeat(513), undefined as unknown as string, 5 as unknown as string]) {
      await assert.rejects(store.setCheckpoint('lastStableTag', value), { name: 'ValidationError', message: /^Invalid value for checkpoint lastStableTag/ });
    }
    assert.deepEqual(await store.checkpoints(), saved);

    // Names that exist on every object are not checkpoints until someone sets them.
    assert.equal(await store.checkpoint('constructor'), undefined);
    assert.equal(await store.checkpoint('toString'), undefined);
  });
});

/** A store clock that stays put until `advance()` moves it an hour forward and returns the new time. */
function steppedClock() {
  let hours = 0;
  const iso = () => new Date(Date.UTC(2026, 9, 15, hours)).toISOString();
  return { now: () => new Date(iso()), advance: () => { hours += 1; return iso(); } };
}
const feedItem: UpsertInput = { source: 'rss', key: 'item-1', title: 'T', summary: 'S', evidence: [{ kind: 'rss', ref: 'Release', excerpt: 'E' }], window: { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.1' } };

test('an upsert that changes nothing writes nothing and leaves updatedAt alone', async () => {
  await inTempDir(async dir => {
    const clock = steppedClock();
    const store = new CandidateStore(dir, clock.now);
    const first = await store.upsert(feedItem);
    const file = join(dir, 'candidates', `${first.candidate.id}.json`);
    const longAgo = new Date('2001-09-09T01:46:40Z');
    await utimes(file, longAgo, longAgo); // a rewrite then shows up as a new mtime, however fast this test runs
    const text = await readFile(file, 'utf8');
    const mtimeMs = (await stat(file)).mtimeMs;

    clock.advance();
    const second = await store.upsert(feedItem);
    assert.equal(second.created, false);
    assert.deepEqual(second.candidate, first.candidate);
    assert.equal(await readFile(file, 'utf8'), text);
    assert.equal((await stat(file)).mtimeMs, mtimeMs);

    const later = clock.advance();
    const third = await store.upsert({ ...feedItem, summary: 'S2' });
    assert.equal(third.created, false);
    assert.equal(third.candidate.summary, 'S2');
    assert.equal(third.candidate.updatedAt, later);
    assert.deepEqual(await store.get(first.candidate.id), third.candidate);
    assert.notEqual((await stat(file)).mtimeMs, mtimeMs);

    clock.advance();
    assert.equal((await store.upsert({ ...feedItem, summary: 'S2' })).candidate.updatedAt, later); // the refreshed content is the new baseline
  });
});

test('a changed title, summary, evidence or window refreshes the candidate; an omitted window, an undefined optional field or a different key order does not', async () => {
  await inTempDir(async dir => {
    const clock = steppedClock();
    const store = new CandidateStore(dir, clock.now);
    const { candidate } = await store.upsert(feedItem);
    const changes: Array<['title' | 'summary' | 'evidence' | 'window', UpsertInput]> = [
      ['title', { ...feedItem, title: 'T2' }],
      ['summary', { ...feedItem, summary: 'S2' }],
      ['evidence', { ...feedItem, evidence: [{ kind: 'rss', ref: 'Release', excerpt: 'E2' }] }],
      ['evidence', { ...feedItem, evidence: [] }],
      ['window', { ...feedItem, window: { fromTag: 'rust-v0.162.1', toTag: 'rust-v0.163.0' } }],
    ];
    for (const [field, changed] of changes) {
      clock.advance();
      await store.upsert(feedItem); // back to the baseline
      const bumped = clock.advance();
      const refreshed = await store.upsert(changed);
      assert.equal(refreshed.created, false);
      assert.deepEqual(refreshed.candidate[field], changed[field]);
      assert.equal(refreshed.candidate.updatedAt, bumped, field);
      assert.deepEqual(await store.get(candidate.id), refreshed.candidate);
    }

    clock.advance();
    await store.upsert(feedItem);
    const baseline = await store.get(candidate.id);
    const unchanged: Array<[string, UpsertInput]> = [
      ['omitted window', { ...feedItem, window: undefined }],
      ['undefined optional evidence field', { ...feedItem, evidence: [{ kind: 'rss', ref: 'Release', url: undefined, excerpt: 'E' }] }],
      ['reordered keys', { ...feedItem, evidence: [{ excerpt: 'E', ref: 'Release', kind: 'rss' }], window: { toTag: 'rust-v0.162.1', fromTag: 'rust-v0.161.0' } }],
    ];
    for (const [label, input] of unchanged) {
      clock.advance();
      assert.deepEqual((await store.upsert(input)).candidate, baseline, label);
      assert.deepEqual(await store.get(candidate.id), baseline, label);
    }
  });
});

test('upsert never touches status, classification, report or started, whether it refreshes or skips', async () => {
  await inTempDir(async dir => {
    const clock = steppedClock();
    const store = new CandidateStore(dir, clock.now);
    const { candidate } = await store.upsert(feedItem);
    const report: ReportRecord = { path: 'reports/x/report.md', generatedAt: clock.advance(), checks: { requiredSections: true, dshRefsTotal: 2, dshRefsResolved: 2 } };
    await store.patch(candidate.id, c => ({ ...c, status: 'reported', report, classification: { category: 'cli-core', relevance: 'high', rationale: 'r' } }));
    await store.transition(candidate.id, 'started');
    await store.patch(candidate.id, c => ({ ...c, started: { sessionId: 's1', at: clock.advance() } }));
    const owned = (c: Candidate) => ({ status: c.status, classification: c.classification, report: c.report, started: c.started });
    const before = owned(await store.get(candidate.id));
    assert.ok(before.classification && before.report && before.started);

    clock.advance();
    assert.deepEqual(owned((await store.upsert(feedItem)).candidate), before);
    assert.deepEqual(owned((await store.upsert({ ...feedItem, summary: 'S2' })).candidate), before);
    await store.transition(candidate.id, 'ignored');
    assert.equal((await store.upsert({ ...feedItem, title: 'T2' })).candidate.status, 'ignored'); // a changed feed does not bring an ignored item back
    assert.deepEqual(owned(await store.get(candidate.id)), { ...before, status: 'ignored' });
  });
});

test('the write queue serializes concurrent upserts, read-modify-writes and checkpoint writes', async () => {
  await inTempDir(async dir => {
    const store = new CandidateStore(dir);
    const results = await Promise.all([store.upsert(seed('pr:40')), store.upsert(seed('pr:40')), store.upsert(seed('pr:40'))]);
    assert.deepEqual(results.map(r => r.created), [true, false, false]);
    assert.equal((await readdir(join(dir, 'candidates'))).length, 1);

    const id = results[0].candidate.id;
    await Promise.all([
      store.upsert({ ...seed('pr:40'), title: 'new title' }),
      store.transition(id, 'ignored'),
      store.patch(id, c => ({ ...c, summary: 'p' })),
    ]);
    const final = await store.get(id);
    assert.equal(final.title, 'new title');
    assert.equal(final.status, 'ignored');
    assert.equal(final.summary, 'p');

    await Promise.all([store.setCheckpoint('a', '1'), store.setCheckpoint('b', '2'), store.setCheckpoint('c', '3')]);
    assert.deepEqual(await store.checkpoints(), { a: '1', b: '2', c: '3' });
  });
});

test('list sorts by updatedAt, newest first, and filters by source and status', async () => {
  await inTempDir(async dir => {
    const clock = steppedClock();
    const store = new CandidateStore(dir, clock.now);
    const add = async (source: UpsertInput['source'], key: string, title = key) => { clock.advance(); return (await store.upsert({ source, key, title, summary: '', evidence: [] })).candidate.id; };
    const a = await add('codex-release', 'a');
    const b = await add('rss', 'b');
    const c = await add('desktop', 'c');
    const d = await add('rss', 'd');
    assert.deepEqual((await store.list()).map(x => x.id), [d, c, b, a]);
    assert.deepEqual((await store.list({ source: 'rss' })).map(x => x.id), [d, b]);

    await add('codex-release', 'a', 'a, edited'); // a refresh moves a candidate to the top
    assert.deepEqual((await store.list()).map(x => x.id), [a, d, c, b]);
    await store.transition(b, 'ignored');
    assert.deepEqual((await store.list({ source: 'rss', status: 'ignored' })).map(x => x.id), [b]);
    assert.deepEqual((await store.list({ source: 'desktop', status: 'ignored' })).map(x => x.id), []);
  });
});

test('list reads every file across its read batches and keeps the newest-first order', async () => {
  await inTempDir(async dir => {
    const directory = join(dir, 'candidates');
    await mkdir(directory, { recursive: true });
    const ids: string[] = [];
    for (let i = 0; i < 129; i++) { // two full batches of 64 and a tail of one
      const id = randomUUID();
      ids.push(id);
      const candidate: Candidate = { id, fingerprint: `rss:${i}`, source: 'rss', title: `Item ${i}`, summary: '', status: 'new', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: new Date(Date.UTC(2026, 9, 15, 0, 0, i)).toISOString(), evidence: [] };
      await writeFile(join(directory, `${id}.json`), JSON.stringify(candidate));
    }
    assert.deepEqual((await new CandidateStore(dir).list()).map(c => c.id), ids.reverse());
  });
});

test('patch refuses a callback that does not return a candidate', async () => {
  await inTempDir(async dir => {
    const store = new CandidateStore(dir);
    const { candidate } = await store.upsert(seed('pr:50'));
    const wrong: Array<[string, (c: Candidate) => Candidate]> = [
      ['undefined', () => undefined as unknown as Candidate],
      ['null', () => null as unknown as Candidate],
      ['an array', () => [] as unknown as Candidate],
      ['a promise', (async (c: Candidate) => c) as unknown as (c: Candidate) => Candidate],
    ];
    for (const [label, update] of wrong) {
      await assert.rejects(store.patch(candidate.id, update), { name: 'ValidationError', message: 'patch callback must return the updated candidate synchronously' }, label);
    }
    assert.deepEqual(await store.get(candidate.id), candidate);
  });
});
