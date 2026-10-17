import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candidate, Classification } from '../src/core/candidate.ts';
import { LockedError, acquireLock } from '../src/core/lock.ts';
import { DEFAULT_SETTINGS, mergeSettings, type SettingsPatch } from '../src/core/settings.ts';
import { CandidateStore } from '../src/core/store.ts';
import type { HostContext } from '../src/host/actions/context.ts';
import { DailyLimitError } from '../src/host/actions/report.ts';
import { ResearchQueue, enqueueResearch, type Researcher } from '../src/host/actions/research-queue.ts';
import { NOW, fakeClock, fakeTimers, foreignLock, until } from './helpers/fakes.ts';

const MINUTE = 60_000;
const MIRROR_PATH = '/Users/me/deepseek-harness';
/** NOW is 08:00 UTC: an hour earlier is the same UTC day, a day earlier is not. */
const EARLIER_TODAY = new Date(NOW.getTime() - 60 * MINUTE).toISOString();
const YESTERDAY = new Date(NOW.getTime() - 24 * 60 * MINUTE).toISOString();

/**
 * The part of the HostContext automatic research works with, over a temporary data directory, with `research` standing in for the report
 * action; the data-directory lock is the real one, its heartbeat on timers the test fires.
 */
async function bench(research: Researcher = async () => {}, settings: SettingsPatch = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'oc-research-'));
  const clock = fakeClock();
  const lifetime = new AbortController();
  const lockTimers = fakeTimers();
  let current = mergeSettings(DEFAULT_SETTINGS, { dshMirrorPath: MIRROR_PATH, ...settings });
  const used: Pick<HostContext, 'directory' | 'store' | 'now' | 'signal' | 'settings' | 'lock' | 'busy' | 'research'> = {
    directory, store: new CandidateStore(directory, clock.now), now: clock.now, signal: lifetime.signal, settings: () => current,
    lock: kind => acquireLock(directory, kind, { now: clock.now, timers: lockTimers.timers, signal: lifetime.signal }),
    busy: new Map(), research: new ResearchQueue(research),
  };
  return {
    ctx: used as HostContext, directory, clock, lifetime, lockTimers,
    set(patch: SettingsPatch) { current = mergeSettings(current, patch); },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

/** A new candidate created `minutes` before NOW, classified with `relevance` (unclassified without one), `fields` laid over it. */
function candidate(minutes: number, relevance: Classification['relevance'] | undefined, fields: Partial<Candidate> = {}): Candidate {
  const at = new Date(NOW.getTime() - minutes * MINUTE).toISOString();
  const id = randomUUID();
  return {
    id, fingerprint: `codex-release:pr:${id}`, source: 'codex-release', title: `Feature ${minutes}`, summary: '', status: 'new', createdAt: at, updatedAt: at, evidence: [],
    ...(relevance && { classification: { category: 'cli-core', relevance, headline: '', gist: '', rationale: '测试' } }),
    ...fields,
  };
}
/** Writes candidate files straight into the data directory. */
async function write(directory: string, ...candidates: Candidate[]): Promise<void> {
  await mkdir(join(directory, 'candidates'), { recursive: true });
  await Promise.all(candidates.map(item => writeFile(join(directory, 'candidates', `${item.id}.json`), JSON.stringify(item))));
}
const ids = (...candidates: Candidate[]) => candidates.map(item => item.id);
const exists = (path: string) => stat(path).then(() => true, () => false);
/** A promise the test settles by hand. */
function gate() {
  let open = () => {};
  const closed = new Promise<void>(resolve => { open = resolve; });
  return { closed, open: () => open() };
}

test('the queue takes new candidates of high relevance that merge into none and were not tried today, and only with a mirror path', async () => {
  const b = await bench();
  try {
    const picked = candidate(1, 'high');
    const triedYesterday = candidate(2, 'high', { research: { autoAttemptedAt: YESTERDAY, lastError: '昨天超时' } });
    const medium = candidate(3, 'medium');
    const merged = candidate(10, 'high');
    merged.classification!.mergedInto = picked.id;
    const left = [
      candidate(4, 'low'), candidate(5, undefined),
      candidate(6, 'high', { status: 'reported' }), candidate(7, 'high', { status: 'started' }), candidate(8, 'high', { status: 'ignored' }),
      candidate(9, 'high', { research: { autoAttemptedAt: EARLIER_TODAY } }),
    ];
    await write(b.directory, picked, triedYesterday, medium, merged, ...left);
    await enqueueResearch(b.ctx);
    assert.deepEqual(b.ctx.research.queued, ids(picked, triedYesterday));
    b.set({ autoResearch: 'medium' });
    await enqueueResearch(b.ctx);
    assert.deepEqual(b.ctx.research.queued, ids(picked, triedYesterday, medium), 'medium takes medium relevance too, after the high ones');
    b.set({ autoResearch: 'off' });
    await enqueueResearch(b.ctx);
    assert.deepEqual(b.ctx.research.queued, [], 'off queues nothing');
    b.set({ autoResearch: 'high', dshMirrorPath: '' });
    await enqueueResearch(b.ctx);
    assert.deepEqual(b.ctx.research.queued, [], 'no mirror path, no queue');
  } finally { await b.close(); }
});

test('the queue runs high before medium, newest first, never holds an id twice, and takes what is queued while it runs', async () => {
  const first = gate();
  const ran: string[] = [];
  const b = await bench(async (_ctx, id) => { ran.push(id); if (ran.length === 1) await first.closed; }, { autoResearch: 'medium' });
  try {
    const [m1, h1, m2, h2] = [candidate(1, 'medium'), candidate(2, 'high'), candidate(3, 'medium'), candidate(4, 'high')];
    await write(b.directory, m1, h1, m2, h2);
    await enqueueResearch(b.ctx);
    assert.deepEqual(b.ctx.research.queued, ids(h1, h2, m1, m2));
    await enqueueResearch(b.ctx);
    assert.deepEqual(b.ctx.research.queued, ids(h1, h2, m1, m2), 'queued again, nothing is there twice');

    b.ctx.research.start(b.ctx);
    await until(() => ran.length === 1, 'the first candidate to run');
    // While h1 runs a check finds one more; h1 is not queued again, and neither is a candidate with a task running.
    const late = candidate(0, 'high');
    await write(b.directory, late);
    b.ctx.busy.set(m2.id, 'status');
    await enqueueResearch(b.ctx);
    assert.deepEqual(b.ctx.research.queued, ids(late, h2, m1));
    b.ctx.busy.delete(m2.id);
    first.open();
    await b.ctx.research.idle();
    assert.deepEqual(ran, ids(h1, late, h2, m1));
    assert.deepEqual(b.ctx.research.results, ids(h1, late, h2, m1).map(id => ({ id, ok: true })), 'one run took them all');
  } finally { await b.close(); }
});

test('the worker marks each try, records a failure on the candidate, and goes on with the next', async () => {
  const long = `分析会话超时：${'很长的原因'.repeat(100)}`;
  const ran: string[] = [];
  const b = await bench(async (_ctx, id) => { ran.push(id); if (ran.length === 2) throw new Error(long); });
  try {
    const earlier = candidate(1, 'high', { research: { autoAttemptedAt: YESTERDAY, lastError: '昨天超时' } });
    const failing = candidate(2, 'high'), last = candidate(3, 'high');
    await write(b.directory, earlier, failing, last);
    await enqueueResearch(b.ctx);
    assert.ok(b.ctx.research.start(b.ctx));
    await b.ctx.research.idle();
    assert.deepEqual(ran, ids(earlier, failing, last));
    const at = NOW.toISOString();
    assert.deepEqual((await b.ctx.store.get(earlier.id)).research, { autoAttemptedAt: at }, 'a new try drops the error of the one before');
    const failed = (await b.ctx.store.get(failing.id)).research!;
    assert.equal(failed.autoAttemptedAt, at);
    assert.equal(Array.from(failed.lastError!).length, 300, 'cut to 300 code points');
    assert.ok(failed.lastError!.startsWith('分析会话超时：很长的原因') && failed.lastError!.endsWith('…'));
    assert.deepEqual((await b.ctx.store.get(last.id)).research, { autoAttemptedAt: at });
    assert.deepEqual(b.ctx.research.results, [{ id: earlier.id, ok: true }, { id: failing.id, ok: false, error: failed.lastError }, { id: last.id, ok: true }]);
    assert.deepEqual(b.ctx.research.queued, []);
    assert.equal(b.ctx.research.notice, undefined);
    assert.equal(await exists(join(b.directory, 'lock.json')), false, 'the lock is let go');
  } finally { await b.close(); }
});

test('each candidate is looked at again just before it runs, and one no longer to take is left exactly as it is', async () => {
  const ran: string[] = [];
  const b = await bench(async (_ctx, id) => { ran.push(id); });
  try {
    const [ignored, reported, busy, lowered, merged, tried, kept] = Array.from({ length: 7 }, (_, n) => candidate(n + 1, 'high'));
    await write(b.directory, ignored, reported, busy, lowered, merged, tried, kept);
    await enqueueResearch(b.ctx);
    assert.equal(b.ctx.research.queued.length, 7);
    // Between the queueing and the run: the user ignores one, a manual report finishes another, one has a task running, a classification
    // lowers one and merges another, and another Host process tried one today.
    await b.ctx.store.transition(ignored.id, 'ignored');
    await b.ctx.store.transition(reported.id, 'reported');
    b.ctx.busy.set(busy.id, 'report');
    await b.ctx.store.patch(lowered.id, current => ({ ...current, classification: { ...current.classification!, relevance: 'low' } }));
    await b.ctx.store.patch(merged.id, current => ({ ...current, classification: { ...current.classification!, mergedInto: kept.id } }));
    await b.ctx.store.patch(tried.id, current => ({ ...current, research: { autoAttemptedAt: EARLIER_TODAY } }));
    b.clock.advance(MINUTE);
    const before = await Promise.all([ignored, reported, busy, lowered, merged, tried].map(item => b.ctx.store.get(item.id)));
    b.ctx.research.start(b.ctx);
    await b.ctx.research.idle();
    assert.deepEqual(ran, [kept.id]);
    assert.deepEqual(await Promise.all(before.map(item => b.ctx.store.get(item.id))), before, 'no mark, no error, the same updatedAt');
    assert.deepEqual(b.ctx.research.results, [{ id: kept.id, ok: true }], 'what was left alone is no result');
  } finally { await b.close(); }
});

test('turning automatic research off or clearing the mirror path after the queueing leaves the queued candidates alone', async () => {
  const ran: string[] = [];
  const b = await bench(async (_ctx, id) => { ran.push(id); });
  try {
    const queued = candidate(1, 'high');
    await write(b.directory, queued);
    for (const patch of [{ autoResearch: 'off' }, { dshMirrorPath: '' }] as const) {
      b.set({ autoResearch: 'high', dshMirrorPath: MIRROR_PATH });
      await enqueueResearch(b.ctx);
      assert.deepEqual(b.ctx.research.queued, [queued.id]);
      b.set(patch);
      b.ctx.research.start(b.ctx);
      await b.ctx.research.idle();
      assert.deepEqual(ran, [], JSON.stringify(patch));
      assert.equal((await b.ctx.store.get(queued.id)).research, undefined, JSON.stringify(patch));
    }
  } finally { await b.close(); }
});

test('the daily limit stops the run, clears the queue, and says how many wait for tomorrow', async () => {
  const ran: string[] = [];
  const b = await bench(async (_ctx, id) => { ran.push(id); if (ran.length === 2) throw new DailyLimitError(10, 10); });
  try {
    const queued = Array.from({ length: 4 }, (_, n) => candidate(n + 1, 'high'));
    await write(b.directory, ...queued);
    await enqueueResearch(b.ctx);
    b.ctx.research.start(b.ctx);
    await b.ctx.research.idle();
    const [done, limited, ...waiting] = queued as [Candidate, Candidate, ...Candidate[]];
    assert.deepEqual(ran, ids(done, limited));
    assert.equal(b.ctx.research.notice, '今天的报告额度用完，还有 3 条明天继续', 'the one that met the limit waits too');
    assert.deepEqual(b.ctx.research.queued, []);
    assert.deepEqual((await b.ctx.store.get(limited.id)).research, { autoAttemptedAt: NOW.toISOString() }, 'the limit is no error of the candidate');
    for (const item of waiting) assert.equal((await b.ctx.store.get(item.id)).research, undefined);
    assert.deepEqual(b.ctx.research.results.map(result => [result.id, result.ok]), [[done.id, true], [limited.id, false]]);
    assert.match(b.ctx.research.results[1]!.error!, /达到每日上限 10 份/);
  } finally { await b.close(); }
});

test('a data directory another process holds clears the queue, with the refusal a refused check shows', async () => {
  const ran: string[] = [];
  const b = await bench(async (_ctx, id) => { ran.push(id); });
  try {
    const queued = candidate(1, 'high');
    await write(b.directory, queued);
    const holder = foreignLock();
    await writeFile(join(b.directory, 'lock.json'), JSON.stringify(holder));
    await enqueueResearch(b.ctx);
    b.ctx.research.start(b.ctx);
    await b.ctx.research.idle();
    assert.deepEqual(ran, []);
    assert.equal(b.ctx.research.notice, new LockedError({ pid: holder.pid, kind: holder.kind, startedAt: holder.startedAt }).message);
    assert.match(b.ctx.research.notice ?? '', /^另一个 DSH 进程正在检查（pid \d+，开始于 .+）$/);
    assert.deepEqual(b.ctx.research.queued, []);
    assert.equal((await b.ctx.store.get(queued.id)).research, undefined);
    assert.deepEqual(JSON.parse(await readFile(join(b.directory, 'lock.json'), 'utf8')), holder, 'the other process keeps its lock');
    // Once the other process has let go, the next run goes ahead and its start clears the notice.
    await rm(join(b.directory, 'lock.json'));
    await enqueueResearch(b.ctx);
    b.ctx.research.start(b.ctx);
    await b.ctx.research.idle();
    assert.deepEqual(ran, [queued.id]);
    assert.equal(b.ctx.research.notice, undefined);
  } finally { await b.close(); }
});

test('a lock another process takes over stops the run before the next candidate', async () => {
  const first = gate();
  const ran: string[] = [];
  const b = await bench(async (_ctx, id) => { ran.push(id); await first.closed; });
  try {
    const [running, next] = [candidate(1, 'high'), candidate(2, 'high')];
    await write(b.directory, running, next);
    await enqueueResearch(b.ctx);
    b.ctx.research.start(b.ctx);
    await until(() => ran.length === 1, 'the first candidate to run');
    // This process stood still past the stale limit and another one took the lock over: the next heartbeat finds out.
    const successor = foreignLock({ kind: 'research' });
    await writeFile(join(b.directory, 'lock.json'), JSON.stringify(successor));
    b.lockTimers.fire();
    // Lock operations on a directory run one at a time, so this refusal comes after the heartbeat's look.
    assert.equal((await acquireLock(b.directory, 'check', { now: b.clock.now, timers: b.lockTimers.timers })).held, false);
    first.open();
    await b.ctx.research.idle();
    assert.deepEqual(ran, [running.id]);
    assert.equal(b.ctx.research.notice, '数据目录锁被另一个 DSH 进程接管，已停止');
    assert.deepEqual(b.ctx.research.queued, []);
    assert.equal((await b.ctx.store.get(next.id)).research, undefined);
    assert.deepEqual(JSON.parse(await readFile(join(b.directory, 'lock.json'), 'utf8')), successor, 'the other process keeps its lock');
  } finally { await b.close(); }
});

test('an unload stops the run: the one running records no error, the rest stay as they are, and the lock is let go', async () => {
  const ran: string[] = [];
  const b = await bench(async (ctx, id) => {
    ran.push(id);
    await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }));
  });
  try {
    const [running, next] = [candidate(1, 'high'), candidate(2, 'high')];
    await write(b.directory, running, next);
    await enqueueResearch(b.ctx);
    b.ctx.research.start(b.ctx);
    await until(() => ran.length === 1, 'the first candidate to run');
    assert.equal(JSON.parse(await readFile(join(b.directory, 'lock.json'), 'utf8')).kind, 'research');
    b.lifetime.abort(new DOMException('OpenCodex 已卸载', 'AbortError'));
    await b.ctx.research.idle();
    assert.deepEqual(ran, [running.id]);
    assert.deepEqual((await b.ctx.store.get(running.id)).research, { autoAttemptedAt: NOW.toISOString() });
    assert.equal((await b.ctx.store.get(next.id)).research, undefined);
    assert.deepEqual(b.ctx.research.queued, []);
    assert.equal(await exists(join(b.directory, 'lock.json')), false);
    await enqueueResearch(b.ctx);
    assert.equal(b.ctx.research.start(b.ctx), undefined, 'nothing starts once unloading');
  } finally { await b.close(); }
});

test('idle() resolves at once when no run is going and after the run otherwise; each run starts with empty results', async () => {
  const b = await bench();
  try {
    await b.ctx.research.idle();
    assert.equal(b.ctx.research.start(b.ctx), undefined, 'nothing queued, nothing started');
    const first = candidate(1, 'high');
    await write(b.directory, first);
    await enqueueResearch(b.ctx);
    assert.ok(b.ctx.research.start(b.ctx));
    assert.equal(b.ctx.research.start(b.ctx), undefined, 'one worker at a time');
    await b.ctx.research.idle();
    assert.deepEqual(b.ctx.research.results, [{ id: first.id, ok: true }]);
    await b.ctx.research.idle();
    const second = candidate(2, 'high');
    await write(b.directory, second);
    await enqueueResearch(b.ctx);
    b.ctx.research.start(b.ctx);
    await b.ctx.research.idle();
    assert.deepEqual(b.ctx.research.results, [{ id: second.id, ok: true }]);
  } finally { await b.close(); }
});
