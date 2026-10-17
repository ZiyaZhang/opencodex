import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fsp, { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCheckLog, readLastCheckLog, type CheckLogEntry } from '../src/core/run-log.ts';

const MB = 1024 * 1024;

/** The line a timer check that ran at minute `n` and found the 0.162.0 window writes. */
function entry(n: number, fields: Partial<CheckLogEntry> = {}): CheckLogEntry {
  return {
    at: `2026-10-15T08:0${n}:30.000Z`, startedAt: `2026-10-15T08:0${n}:00.000Z`, trigger: 'timer', pid: 4321,
    window: { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.0' }, added: { releases: n, files: 1, desktop: 0, rss: 2 }, errors: [], ...fields,
  };
}

async function inDirectory(run: (directory: string, log: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'oc-log-'));
  try { await run(directory, join(directory, 'checks.jsonl')); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('each check appends one JSON line, and the last line is read back', () => inDirectory(async (directory, log) => {
  assert.deepEqual(await readLastCheckLog(directory), {}, 'no log yet: no entry and no problem');
  // A line break inside a field stays inside the line.
  const first = entry(1, { trigger: 'startup', window: null, errors: ['rss: HTTP 404\nnot found'] });
  const second = entry(2, { trigger: 'manual', index: { entries: 120, commit: 'abc123' } });
  await appendCheckLog(directory, first);
  await appendCheckLog(directory, second);
  assert.equal(await readFile(log, 'utf8'), `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
  assert.deepEqual(await readLastCheckLog(directory), { entry: second });
}));

test('a log over 2 MB is turned over to checks.1.jsonl, replacing the older one, before the next line', () => inDirectory(async (directory, log) => {
  const turned = join(directory, 'checks.1.jsonl');
  await writeFile(turned, 'the turnover before\n');
  await writeFile(log, `${'x'.repeat(2 * MB - 1)}\n`);
  await appendCheckLog(directory, entry(1));
  assert.equal(await readFile(turned, 'utf8'), 'the turnover before\n', 'at exactly 2 MB the log is not over yet');
  const full = await readFile(log, 'utf8');
  await appendCheckLog(directory, entry(2));
  assert.equal(await readFile(turned, 'utf8'), full);
  assert.equal(await readFile(log, 'utf8'), `${JSON.stringify(entry(2))}\n`);
  assert.deepEqual(await readLastCheckLog(directory), { entry: entry(2) });
}));

test('a turnover that another append made first is no failure', () => inDirectory(async (directory, log) => {
  await writeFile(log, `${'x'.repeat(2 * MB)}\n`);
  mock.method(fsp, 'rename', async () => { throw Object.assign(new Error('ENOENT: no such file or directory, rename'), { code: 'ENOENT' }); });
  syncBuiltinESMExports();
  try { await appendCheckLog(directory, entry(1)); } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readLastCheckLog(directory), { entry: entry(1) });
}));

test('a line left half written is ended before the next one, so the next one reads back', () => inDirectory(async (directory, log) => {
  // A write that broke off (a full disk) leaves half a line, which would otherwise swallow the next one.
  await writeFile(log, `${JSON.stringify(entry(1))}\n{"at":"2026-10-15T08:02`);
  await appendCheckLog(directory, entry(3));
  assert.equal(await readFile(log, 'utf8'), `${JSON.stringify(entry(1))}\n{"at":"2026-10-15T08:02\n${JSON.stringify(entry(3))}\n`);
  assert.deepEqual(await readLastCheckLog(directory), { entry: entry(3) });
}));

test('a damaged last line gives way to the newest whole one, and a log with none says so', () => inDirectory(async (directory, log) => {
  const [first, second] = [entry(1), entry(2)].map(line => JSON.stringify(line));
  // A process that died while writing leaves half a line.
  await writeFile(log, `${first}\n${second}\n{"at":"2026-10-15T08:03`);
  assert.deepEqual(await readLastCheckLog(directory), { entry: entry(2) });
  // JSON that is no check line counts as damaged too.
  await writeFile(log, `${first}\n${JSON.stringify({ ...entry(2), added: { releases: '2' } })}\n${JSON.stringify({ ...entry(2), trigger: 'cron' })}\n[]\nnull\n\n`);
  assert.deepEqual(await readLastCheckLog(directory), { entry: entry(1) });
  await writeFile(log, '{ not json\n{"at":"2026-10-15T08:00:00.000Z"}\n');
  const { entry: none, problem } = await readLastCheckLog(directory);
  assert.equal(none, undefined);
  assert.equal(problem, 'checks.jsonl 的最后 64 KB 里没有一行完整的记录');
}));

test('only the last 64 KB of the log are read', () => inDirectory(async (directory, log) => {
  const whole = JSON.stringify(entry(1));
  await writeFile(log, `${whole}\n${'{ damaged }\n'.repeat(6_000)}`);
  assert.ok((await stat(log)).size > 64 * 1024 + whole.length);
  const { entry: none, problem } = await readLastCheckLog(directory);
  assert.equal(none, undefined, 'the whole line at the start is out of reach');
  assert.match(problem ?? '', /最后 64 KB 里没有一行完整的记录$/);
  // The line the 64 KB edge cuts through is left out, even where its end alone would read as a whole line.
  await writeFile(log, `{"damaged":${' '.repeat(70 * 1024)}${JSON.stringify(entry(2))}\n`);
  const cut = await readLastCheckLog(directory);
  assert.equal(cut.entry, undefined);
  assert.match(cut.problem ?? '', /最后 64 KB 里没有一行完整的记录$/);
}));

test('a log that cannot be read is a problem, and one that cannot be written rejects', () => inDirectory(async (directory, log) => {
  await mkdir(log);
  const { entry: none, problem } = await readLastCheckLog(directory);
  assert.equal(none, undefined);
  assert.match(problem ?? '', /^checks\.jsonl 没能读出来：EISDIR/);
  await assert.rejects(appendCheckLog(directory, entry(1)), { code: 'EISDIR' });
}));
