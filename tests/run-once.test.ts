import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candidate } from '../src/core/candidate.ts';
import type { CheckLogEntry } from '../src/core/run-log.ts';
import { CandidateStore } from '../src/core/store.ts';
import { LAST_RUN, type LastRun } from '../src/host/run-once.ts';
import { NOW, fakeClock, foreignLock, until } from './helpers/fakes.ts';
import { MIRROR, fixture, offlineGh, serve, stalledGh, type Fixture } from './helpers/host-fixture.ts';

const MINUTE = 60_000;
const FINISHED = 'opencodex: run-once finished';

/** A data directory with what `seed` puts in it, for a Host whose check runs as soon as it starts. */
async function dataDirectory(seed: (directory: string) => Promise<unknown> = async () => {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'oc-run-once-'));
  await seed(directory);
  return directory;
}
/** RSS candidates written straight to the store, a minute apart, oldest first: automatic research takes them without GitHub. */
async function rssItems(directory: string, ...keys: string[]): Promise<Candidate[]> {
  const clock = fakeClock(new Date(NOW.getTime() - 10 * MINUTE));
  const store = new CandidateStore(directory, clock.now);
  const seeded: Candidate[] = [];
  for (const key of keys) {
    const { candidate } = await store.upsert({ source: 'rss', key, title: `Codex app update ${key}`, summary: `Summary of ${key}`, evidence: [{ kind: 'rss', ref: key, excerpt: 'Worktrees in the app.' }] });
    seeded.push(candidate);
    clock.advance(MINUTE);
  }
  return seeded;
}
/** last-run.json once it is there; fails the test after 5 seconds. */
async function lastRun(directory: string): Promise<LastRun> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { return JSON.parse(await readFile(join(directory, LAST_RUN), 'utf8')) as LastRun; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() > deadline) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
const logLines = async (directory: string) => (await readFile(join(directory, 'checks.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as CheckLogEntry);
const exists = (path: string) => stat(path).then(() => true, () => false);
/** The info lines logged through Cordis, which keeps the latest ones. */
const infoLines = (f: Fixture) => f.ctx.logger.buffer.filter(message => message.type === 'info').map(message => String(message.args[0]));

test('run-once checks at start without the minute\'s wait, waits for the research it queued, writes last-run.json and never arms a timer', async () => {
  let seeded: Candidate[] = [];
  const directory = await dataDirectory(async dir => { seeded = await rssItems(dir, 'rss-a', 'rss-b'); });
  const [older, newer] = seeded as [Candidate, Candidate];
  const f = await fixture({ directory, settings: { dshMirrorPath: MIRROR }, gh: offlineGh, feed: serve('gone', 404), runOnce: true, holdReports: true });
  try {
    await until(() => f.dsh.prompts.length === 1, 'the first automatic report');
    const [line, ...more] = await logLines(directory);
    assert.deepEqual([line!.trigger, more.length], ['run-once', 0], 'the check has ended');
    assert.deepEqual(f.timers.log, [], 'it ran without a timer');
    assert.equal(await exists(join(directory, LAST_RUN)), false, 'last-run.json waits for the research');
    f.clock.advance(MINUTE);
    f.dsh.open();
    const run = await lastRun(directory);
    assert.deepEqual(run, {
      startedAt: NOW.toISOString(), finishedAt: new Date(NOW.getTime() + MINUTE).toISOString(), pid: process.pid, check: line,
      reports: [{ id: newer.id, ok: true }, { id: older.id, ok: true }],
    });
    for (const candidate of [newer, older]) assert.equal((await f.store.get(candidate.id)).status, 'reported');
    assert.ok(infoLines(f).some(text => text.startsWith(FINISHED)), 'the DSH log has the end');
    // Nothing arms a timer later either: not a check asked for by hand, not a settings change.
    await f.call({ action: 'check' });
    await f.call({ action: 'settings', patch: { checkIntervalHours: 6 } });
    assert.deepEqual(f.timers.log, []);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a run-once check refused by another process\'s lock leaves check null with the refusal as the notice, and is not tried again', async () => {
  const holder = foreignLock();
  const directory = await dataDirectory(dir => writeFile(join(dir, 'lock.json'), JSON.stringify(holder)));
  const f = await fixture({ directory, runOnce: true });
  try {
    const { notice, ...run } = await lastRun(directory);
    assert.deepEqual(run, { startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), pid: process.pid, check: null, reports: [] });
    assert.match(notice ?? '', new RegExp(`^另一个 DSH 进程正在检查（pid ${process.ppid}，开始于 .+）$`));
    assert.equal(await exists(join(directory, 'checks.jsonl')), false, 'a refused check writes no line');
    assert.deepEqual(f.timers.log, [], 'no retry in 10 minutes');
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'lock.json'), 'utf8')), holder, 'the other process keeps its lock');
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a run-once check that fails as a whole is in last-run.json as the failed line it appended', async () => {
  const f = await fixture({ gh: stalledGh, timeouts: { check: 20 }, runOnce: true });
  try {
    const run = await lastRun(f.directory);
    const [line, ...more] = await logLines(f.directory);
    assert.deepEqual([line!.trigger, line!.errors, more.length], ['run-once', ['check: 检查超过 0 分钟还没结束，已停止'], 0]);
    assert.deepEqual(run, { startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), pid: process.pid, check: line, reports: [] });
    assert.deepEqual(f.timers.log, [], 'a failed check re-arms nothing either');
  } finally { await f.close(); }
});

test('a run-once check whose line cannot be written leaves check null and says why', async () => {
  const directory = await dataDirectory(dir => mkdir(join(dir, 'checks.jsonl')));
  const f = await fixture({ directory, gh: offlineGh, feed: serve('gone', 404), runOnce: true });
  try {
    const run = await lastRun(directory);
    assert.equal(run.check, null);
    assert.match(run.notice ?? '', /^这次检查没能记进 checks\.jsonl：EISDIR/);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a run-once Host that cannot start writes last-run.json with the reason, before its unload ends', async () => {
  const directory = await dataDirectory(dir => writeFile(join(dir, 'settings.json'), '{ not json'));
  try {
    await assert.rejects(fixture({ directory, settings: null, runOnce: true }), /不是合法的 JSON/);
    // Read without waiting: the unload that followed the failed start waited for the file.
    const { notice, ...run } = JSON.parse(await readFile(join(directory, LAST_RUN), 'utf8')) as LastRun;
    assert.deepEqual(run, { startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), pid: process.pid, check: null, reports: [] });
    assert.ok(notice?.includes(join(directory, 'settings.json')), notice);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an unload in the middle of the run-once research writes no last-run.json', async () => {
  const directory = await dataDirectory(dir => rssItems(dir, 'rss-a'));
  const f = await fixture({ directory, settings: { dshMirrorPath: MIRROR }, gh: offlineGh, feed: serve('gone', 404), runOnce: true, holdReports: true });
  try {
    await until(() => f.dsh.prompts.length === 1, 'the automatic report');
    await f.unload();
    assert.equal(await exists(join(directory, LAST_RUN)), false, 'a run cut short is no finished one');
    assert.equal(infoLines(f).some(text => text.startsWith(FINISHED)), false);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});
