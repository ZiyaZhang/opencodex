import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValidationError } from '../src/core/check.ts';
import { LockedError, acquireLock, createLockFile, lockHolder, type LockOptions, type LockRecord } from '../src/core/lock.ts';
import { GONE_PID, NOW, fakeClock, fakeTimers, foreignLock, until } from './helpers/host-fixture.ts';

const MINUTE = 60_000;
const exists = (path: string) => stat(path).then(() => true, () => false);

/** A data directory, and a clock and timers the test moves by hand. */
async function bench() {
  const directory = await mkdtemp(join(tmpdir(), 'oc-lock-'));
  const clock = fakeClock();
  const timers = fakeTimers();
  const file = join(directory, 'lock.json');
  return {
    directory, clock, timers, file, stale: join(directory, 'lock.stale.json'),
    options: { now: clock.now, timers: timers.timers, rereadMs: 1 } satisfies LockOptions,
    read: async (path = file) => JSON.parse(await readFile(path, 'utf8')) as LockRecord,
    write: (record: LockRecord) => writeFile(file, JSON.stringify(record)),
    /** The time `ms` before the clock. */
    ago: (ms: number) => new Date(clock.now().getTime() - ms).toISOString(),
  };
}
type Bench = Awaited<ReturnType<typeof bench>>;
const inBench = (run: (b: Bench) => Promise<void>) => async () => {
  const b = await bench();
  try { await run(b); } finally { await rm(b.directory, { recursive: true, force: true }); }
};

test('a free data directory is locked for this process, and the release deletes the file and stops the heartbeat', inBench(async b => {
  const lock = await acquireLock(b.directory, 'check', b.options);
  assert.ok(lock.held);
  assert.deepEqual(await b.read(), { pid: process.pid, kind: 'check', startedAt: NOW.toISOString(), heartbeatAt: NOW.toISOString(), hostname: hostname() });
  assert.deepEqual(await readdir(b.directory), ['lock.json'], 'no temp file is left');
  assert.deepEqual(b.timers.log.map(entry => entry.ms), [30_000], 'the heartbeat is armed');
  await lock.release();
  assert.equal(await exists(b.file), false);
  assert.equal(b.timers.armed.size, 0);
}));

test('this process takes the lock again for either kind, and only the last release deletes the file', inBench(async b => {
  const [check, research] = await Promise.all([acquireLock(b.directory, 'check', b.options), acquireLock(b.directory, 'research', b.options)]);
  assert.ok(check.held && research.held);
  assert.equal((await b.read()).kind, 'check', 'the file names the run that took it');
  assert.equal(b.timers.log.length, 1, 'one heartbeat for both');
  await check.release();
  await check.release();
  assert.equal(await exists(b.file), true, 'a second release of the same hold counts once');
  await research.release();
  assert.equal(await exists(b.file), false);
  assert.equal(b.timers.armed.size, 0);
}));

test('another live process whose heartbeat is under 5 minutes old keeps the lock', inBench(async b => {
  const holder = foreignLock({ kind: 'research', heartbeatAt: b.ago(4 * MINUTE) });
  await b.write(holder);
  assert.deepEqual(await acquireLock(b.directory, 'check', b.options), { held: false, by: { pid: process.ppid, kind: 'research', startedAt: holder.startedAt } });
  assert.deepEqual(await b.read(), holder, 'its file is left as it is');
  assert.equal(b.timers.log.length, 0, 'nothing waits');
}));

test('a live holder whose heartbeat is over 5 minutes old is looked at again 30 seconds later, and keeps the lock if it beat meanwhile', inBench(async b => {
  await b.write(foreignLock({ heartbeatAt: b.ago(6 * MINUTE) }));
  const taking = acquireLock(b.directory, 'check', b.options);
  await until(() => b.timers.armed.size === 1, 'the wait for a second look');
  assert.deepEqual(b.timers.log.map(entry => entry.ms), [30_000]);
  b.clock.advance(30_000);
  const awake = foreignLock({ heartbeatAt: b.clock.now().toISOString() });
  await b.write(awake);
  b.timers.fire();
  assert.deepEqual(await taking, { held: false, by: { pid: process.ppid, kind: 'check', startedAt: awake.startedAt } });
  assert.deepEqual(await b.read(), awake);
}));

test('a holder still over 5 minutes behind at the second look is taken over, its file kept as lock.stale.json', inBench(async b => {
  const frozen = foreignLock({ heartbeatAt: b.ago(6 * MINUTE) });
  await b.write(frozen);
  const taking = acquireLock(b.directory, 'research', b.options);
  await until(() => b.timers.armed.size === 1, 'the wait for a second look');
  b.clock.advance(30_000);
  b.timers.fire();
  const lock = await taking;
  assert.ok(lock.held);
  const at = b.clock.now().toISOString();
  assert.deepEqual(await b.read(), { pid: process.pid, kind: 'research', startedAt: at, heartbeatAt: at, hostname: hostname() });
  assert.deepEqual(await b.read(b.stale), frozen);
  await lock.release();
}));

test('a lock whose process is gone, or that this process left without holding it, is taken over at once', inBench(async b => {
  for (const left of [foreignLock({ pid: GONE_PID }), foreignLock({ pid: process.pid })]) {
    await b.write(left);
    const lock = await acquireLock(b.directory, 'check', b.options);
    assert.ok(lock.held, `pid ${left.pid}`);
    assert.equal((await b.read()).pid, process.pid);
    assert.deepEqual(await b.read(b.stale), left);
    await lock.release();
  }
  assert.deepEqual(b.timers.log.map(entry => entry.ms), [30_000, 30_000], 'no wait, only a heartbeat each');
}));

test('a takeover that reads back another process\'s lock has lost the race to it', inBench(async b => {
  await b.write(foreignLock({ pid: GONE_PID }));
  const rival = foreignLock({ startedAt: b.clock.now().toISOString() });
  // The rival moves this process's new file aside and writes its own before this process reads it back.
  const create: LockOptions['create'] = async (path, text) => { await writeFile(path, text, { flag: 'wx' }); await writeFile(path, JSON.stringify(rival)); };
  assert.deepEqual(await acquireLock(b.directory, 'check', { ...b.options, create }), { held: false, by: { pid: process.ppid, kind: 'check', startedAt: rival.startedAt } });
  assert.deepEqual(await b.read(), rival, 'the rival keeps its lock');
  assert.equal(b.timers.armed.size, 0, 'no heartbeat for a lock not held');
}));

test('a create that meets another process\'s lock already in place has lost the race, and the refusal names that process', inBench(async b => {
  const rival = foreignLock({ startedAt: b.clock.now().toISOString() });
  // The rival's file lands between this process's look and its create.
  const create: LockOptions['create'] = async (path, text) => { await writeFile(path, JSON.stringify(rival)); await createLockFile(path, text); };
  assert.deepEqual(await acquireLock(b.directory, 'check', { ...b.options, create }), { held: false, by: { pid: process.ppid, kind: 'check', startedAt: rival.startedAt } });
  assert.deepEqual(await b.read(), rival);
  assert.deepEqual(await readdir(b.directory), ['lock.json'], 'nothing is moved aside, and no temp file is left');
}));

test('a race lost to a file that never reads whole is a refusal by an unknown process, and nothing is taken over', inBench(async b => {
  let creates = 0;
  // The rival replaced this process's new file and has not written its record yet.
  const create: LockOptions['create'] = async (path, text) => { creates++; await createLockFile(path, text); await writeFile(path, '{"pid":'); };
  assert.deepEqual(await acquireLock(b.directory, 'check', { ...b.options, create }), { held: false, by: { pid: 0, kind: 'check', startedAt: b.clock.now().toISOString() } });
  assert.equal(creates, 1, 'no second takeover');
  assert.equal(await readFile(b.file, 'utf8'), '{"pid":', 'the rival keeps its file');
  assert.equal(await exists(b.stale), false);
  assert.equal(b.timers.armed.size, 0, 'no heartbeat for a lock not held');
}));

test('a create that keeps meeting a file is a refusal, never an error', inBench(async b => {
  const create: LockOptions['create'] = async path => { await writeFile(path, '{'); throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' }); };
  const result = await acquireLock(b.directory, 'research', { ...b.options, create });
  assert.deepEqual(result, { held: false, by: { pid: 0, kind: 'check', startedAt: b.clock.now().toISOString() } });
  assert.equal(await readFile(b.file, 'utf8'), '{');
}));

test('createLockFile puts the whole file in place only where there is none, and leaves no temp file either way', inBench(async b => {
  await createLockFile(b.file, 'first\n');
  await assert.rejects(createLockFile(b.file, 'second\n'), { code: 'EEXIST' });
  assert.equal(await readFile(b.file, 'utf8'), 'first\n');
  assert.deepEqual(await readdir(b.directory), ['lock.json']);
}));

test('a damaged lock file counts as none', inBench(async b => {
  for (const text of ['{ not json', '[]', JSON.stringify(foreignLock({ pid: 0 })), JSON.stringify(foreignLock({ heartbeatAt: 'soon' }))]) {
    await writeFile(b.file, text);
    const lock = await acquireLock(b.directory, 'check', b.options);
    assert.ok(lock.held, text);
    assert.equal(await readFile(b.stale, 'utf8'), text);
    await lock.release();
  }
}));

test('the heartbeat moves heartbeatAt every 30 seconds, and leaves alone a lock another process took over', inBench(async b => {
  const lock = await acquireLock(b.directory, 'check', b.options);
  assert.ok(lock.held);
  b.clock.advance(30_000);
  b.timers.fire();
  await until(() => b.timers.armed.size === 1, 'the next heartbeat');
  const beaten = await b.read();
  assert.deepEqual([beaten.startedAt, beaten.heartbeatAt], [NOW.toISOString(), b.clock.now().toISOString()]);
  // This process stood still long enough for another one to take over: neither its heartbeat nor its release touches that lock.
  const successor = foreignLock({ heartbeatAt: b.clock.now().toISOString() });
  await b.write(successor);
  b.clock.advance(30_000);
  b.timers.fire();
  await lock.release();
  assert.deepEqual(await b.read(), successor);
  assert.equal(b.timers.armed.size, 0, 'the heartbeat stopped');
}));

test('lockHolder names another live process with a fresh heartbeat, and takes nothing over', inBench(async b => {
  const options = { now: b.clock.now };
  assert.equal(await lockHolder(b.directory, options), undefined, 'no lock file');
  const ignored: Array<[string, string]> = [
    [JSON.stringify(foreignLock({ pid: process.pid })), 'this process'],
    [JSON.stringify(foreignLock({ pid: GONE_PID })), 'a process that is gone'],
    [JSON.stringify(foreignLock({ heartbeatAt: b.ago(6 * MINUTE) })), 'a heartbeat over 5 minutes old'],
    ['{ damaged', 'a damaged file'],
  ];
  for (const [text, why] of ignored) {
    await writeFile(b.file, text);
    assert.equal(await lockHolder(b.directory, options), undefined, why);
  }
  const holder = foreignLock({ kind: 'research', heartbeatAt: b.ago(4 * MINUTE) });
  await b.write(holder);
  assert.deepEqual(await lockHolder(b.directory, options), { pid: process.ppid, kind: 'research', startedAt: holder.startedAt });
  assert.deepEqual(await b.read(), holder);
}));

test('an abort ends the wait for a second look', inBench(async b => {
  await b.write(foreignLock({ heartbeatAt: b.ago(6 * MINUTE) }));
  const controller = new AbortController();
  const taking = acquireLock(b.directory, 'check', { ...b.options, signal: controller.signal });
  await until(() => b.timers.armed.size === 1, 'the wait for a second look');
  controller.abort(new Error('unloaded'));
  await assert.rejects(taking, /unloaded/);
  assert.equal(b.timers.armed.size, 0, 'the wait is cleared');
  assert.equal(await exists(b.stale), false, 'nothing was taken over');
}));

test('LockedError names the process, what it runs and since when in local time, as a ValidationError', () => {
  const startedAt = '2026-10-15T08:00:00.000Z';
  const local = new Date(startedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const checking = new LockedError({ pid: 4321, kind: 'check', startedAt });
  assert.ok(checking instanceof ValidationError);
  assert.equal(checking.name, 'LockedError');
  assert.equal(checking.message, `另一个 DSH 进程正在检查（pid 4321，开始于 ${local}）`);
  assert.deepEqual(checking.by, { pid: 4321, kind: 'check', startedAt });
  assert.equal(new LockedError({ pid: 4321, kind: 'research', startedAt }).message, `另一个 DSH 进程正在调研（pid 4321，开始于 ${local}）`);
  assert.equal(new LockedError({ pid: 0, kind: 'check', startedAt }).message, '另一个 DSH 进程正在检查（pid 未知）', 'a lost race whose winner never read whole');
});
