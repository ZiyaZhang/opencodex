import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLimitError, OpenCodexStore, STATE_FILE } from '../src/core/index.js';

async function fixture(t: TestContext, date = '2026-10-13T23:59:00.000Z') {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-core-'));
  let at = new Date(date); const now = () => at;
  let store = await OpenCodexStore.open({ directory, now });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, get store() { return store; }, setTime(value: string) { at = new Date(value); }, async reopen() { await store.close(); store = await OpenCodexStore.open({ directory, now }); return store; } };
}
async function active(store: OpenCodexStore, tokenLimit = 100) {
  const job = await store.createJob({ title: 'Nonblocking question research', budget: { tokenLimit } });
  await store.transitionJob(job.id, 'queued'); await store.transitionJob(job.id, 'researching'); return job.id;
}

test('concurrent reservations never oversubscribe a job and failed allocation durably pauses it', async t => {
  const f = await fixture(t); const id = await active(f.store);
  const results = await Promise.allSettled([
    f.store.reserveTokens(id, { requestId: 'attempt-1', reservedTokens: 60 }),
    f.store.reserveTokens(id, { requestId: 'attempt-2', reservedTokens: 60 }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof BudgetLimitError);
  assert.equal(rejected.reason.message, 'Next request needs 60 reserved tokens; job has 40 remaining');
  assert.equal(f.store.getJob(id).status, 'paused');
  assert.equal(f.store.budgetSummary(id).job.reservedTokens, 60);
  const disk = JSON.parse(await readFile(join(f.directory, STATE_FILE), 'utf8'));
  assert.equal(disk.jobs[0].status, 'paused'); assert.equal(disk.reservations.length, 1);
});

test('daily quota is shared atomically across jobs and usage is never clipped to estimates', async t => {
  const f = await fixture(t); await f.store.updateSettings({ dailyTokenLimit: 100 });
  const a = await active(f.store, 200); const b = await active(f.store, 200);
  const results = await Promise.allSettled([
    f.store.reserveTokens(a, { requestId: 'a-1', reservedTokens: 70 }),
    f.store.reserveTokens(b, { requestId: 'b-1', reservedTokens: 70 }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.message, 'Next request needs 70 reserved tokens; daily budget has 30 remaining');
  const reservation = f.store.snapshot().reservations[0];
  await f.store.reconcileUsage(reservation.requestId, { inputTokens: 105, outputTokens: 20 });
  assert.equal(f.store.budgetSummary(a).daily.confirmedTokens, 125);
  assert.equal(f.store.budgetSummary(a).daily.remainingTokens, 0);
  assert.ok(f.store.snapshot().jobs.every(j => j.status === 'paused'));
});

test('a conservative next-request estimate explains a pause while confirmed usage remains below the limit', async t => {
  const f = await fixture(t); const id = await active(f.store, 120_000);
  await f.store.reserveTokens(id, { requestId: 'completed-request', reservedTokens: 40_000 });
  await f.store.reconcileUsage('completed-request', { inputTokens: 30_000, outputTokens: 2_000 });
  await assert.rejects(f.store.reserveTokens(id, { requestId: 'estimated-next-request', reservedTokens: 90_000 }), error => {
    assert.ok(error instanceof BudgetLimitError);
    assert.equal(error.message, 'Next request needs 90000 reserved tokens; job has 88000 remaining');
    return true;
  });
  const budget = f.store.budgetSummary(id);
  assert.equal(budget.job.confirmedTokens, 32_000); assert.equal(budget.job.reservedTokens, 0); assert.equal(budget.job.remainingTokens, 88_000);
  assert.equal(f.store.snapshot().reservations.length, 1);
  assert.equal(f.store.getJob(id).status, 'paused');
  assert.equal(f.store.getJob(id).history.at(-1)?.reason, 'Next request needs 90000 reserved tokens; job has 88000 remaining');
});

test('missing usage retains quota across restart and midnight; later authoritative reconciliation is idempotent', async t => {
  const f = await fixture(t); await f.store.updateSettings({ dailyTokenLimit: 100 }); const id = await active(f.store, 200);
  await f.store.reserveTokens(id, { requestId: 'unknown-1', reservedTokens: 70 });
  await f.store.reconcileUsage('unknown-1', null);
  f.setTime('2026-10-14T00:01:00.000Z'); await f.reopen();
  assert.equal(f.store.getJob(id).status, 'paused');
  assert.equal(f.store.budgetSummary(id).daily.reservedTokens, 70);
  assert.equal(f.store.budgetSummary(id).job.unknownRequests, 1);
  await f.store.reconcileUsage('unknown-1', { inputTokens: 40, outputTokens: 5 });
  await f.store.reconcileUsage('unknown-1', { inputTokens: 40, outputTokens: 5 });
  assert.equal(f.store.budgetSummary(id).daily.confirmedTokens, 45);
  assert.equal(f.store.budgetSummary(id).daily.reservedTokens, 0);
  await assert.rejects(f.store.reconcileUsage('unknown-1', { inputTokens: 0, outputTokens: 0 }), /immutable/);
  f.setTime('2026-10-15T00:01:00.000Z');
  assert.equal(f.store.budgetSummary(id).daily.confirmedTokens, 0);
  assert.equal(f.store.budgetSummary(id).job.confirmedTokens, 45);
});

test('inflight recovery becomes unknown and retries have distinct immutable request identities', async t => {
  const f = await fixture(t); const id = await active(f.store, 200);
  await f.store.reserveTokens(id, { requestId: 'request-1', reservedTokens: 70 }); await f.reopen();
  assert.equal(f.store.snapshot().reservations[0].status, 'unknown');
  await assert.rejects(f.store.reserveTokens(id, { requestId: 'request-1', reservedTokens: 70 }), /new request id/);
  await f.store.transitionJob(id, 'queued'); await f.store.transitionJob(id, 'researching');
  await f.store.reserveTokens(id, { requestId: 'request-2', reservedTokens: 60 });
  await f.store.reconcileUsage('request-2', { inputTokens: 20, outputTokens: 10 });
  assert.equal(f.store.budgetSummary(id).job.confirmedTokens, 30);
  assert.equal(f.store.budgetSummary(id).job.reservedTokens, 70);
  await f.store.transitionJob(id, 'cancelled');
  assert.equal(f.store.budgetSummary(id).job.reservedTokens, 70);
  await assert.rejects(f.store.transitionJob(id, 'queued'), /Invalid transition/);
});

test('time and repair limits pause durably and extensions preserve ledger and budget history', async t => {
  const f = await fixture(t); const job = await f.store.createJob({ title: 'Duration case', budget: { tokenLimit: 100, maxDurationMs: 1_000, maxRepairRounds: 0 } });
  await f.store.transitionJob(job.id, 'queued'); await f.store.transitionJob(job.id, 'researching');
  f.setTime('2026-10-13T23:59:02.000Z');
  await assert.rejects(f.store.reserveTokens(job.id, { requestId: 'too-late', reservedTokens: 1 }), /time budget/);
  assert.equal(f.store.getJob(job.id).elapsedMs, 2_000);
  await f.store.extendBudget(job.id, { maxDurationMs: 5_000, tokenLimit: 150 });
  await f.store.transitionJob(job.id, 'queued'); await f.store.transitionJob(job.id, 'researching');
  await f.store.transitionJob(job.id, 'specifying'); await f.store.transitionJob(job.id, 'building'); await f.store.transitionJob(job.id, 'verifying');
  await assert.rejects(f.store.transitionJob(job.id, 'building'), /Invalid transition/);
  await assert.rejects(f.store.startRepair(job.id), /Repair round/);
  assert.equal(f.store.getJob(job.id).status, 'paused'); assert.equal(f.store.getJob(job.id).budgetHistory.length, 1);
  await assert.rejects(f.store.extendBudget(job.id, { tokenLimit: 20 }), /cannot erase/);
});

test('malformed persisted state is preserved and an active store excludes a second writer', async t => {
  const f = await fixture(t);
  await assert.rejects(OpenCodexStore.open({ directory: f.directory }), /already open/);
  await f.store.close(); const path = join(f.directory, STATE_FILE); const corrupt = '{"schemaVersion":1,"secret":"do-not-replace"}';
  await writeFile(path, corrupt);
  await assert.rejects(OpenCodexStore.open({ directory: f.directory }), /missing fields/);
  assert.equal(await readFile(path, 'utf8'), corrupt);
});

test('mutation failures do not corrupt subsequent writes; snapshots cannot mutate durable settings', async t => {
  const f = await fixture(t); const copy = f.store.snapshot(); copy.settings.dailyTokenLimit = 1;
  assert.notEqual(f.store.snapshot().settings.dailyTokenLimit, 1);
  await assert.rejects(f.store.updateSettings({ dailyTokenLimit: -1 }), /integer/);
  await f.store.updateSettings({ dailyTokenLimit: 123 });
  assert.equal(JSON.parse(await readFile(join(f.directory, STATE_FILE), 'utf8')).settings.dailyTokenLimit, 123);
  await assert.rejects(f.store.updateSettings({ apiKey: 'secret' } as never), /unsupported fields/);
});

test('schema-1 migration adds only absent investigation defaults and preserves the complete usage ledger', async t => {
  const f = await fixture(t); const id = await active(f.store, 500);
  await f.store.reserveTokens(id, { requestId: 'settled-before-migration', reservedTokens: 80 });
  await f.store.reconcileUsage('settled-before-migration', { inputTokens: 40, outputTokens: 10 });
  await f.store.transitionJob(id, 'paused');
  const before = f.store.snapshot(); await f.store.close();
  const legacy = JSON.parse(JSON.stringify(before));
  delete legacy.settings.localVersionFile; delete legacy.settings.updateResearchMode;
  for (const job of legacy.jobs) delete job.mode;
  await writeFile(join(f.directory, STATE_FILE), JSON.stringify(legacy));
  await f.reopen();
  const after = f.store.snapshot();
  assert.equal(after.settings.localVersionFile, ''); assert.equal(after.settings.updateResearchMode, 'notify');
  assert.equal(after.jobs[0].mode, 'reconstruct'); assert.deepEqual(after.reservations, before.reservations);
  assert.deepEqual(after.jobs[0].history, before.jobs[0].history); assert.deepEqual(after.jobs[0].budget, before.jobs[0].budget);
  assert.equal(f.store.budgetSummary(id).job.confirmedTokens, 50);
  const disk = JSON.parse(await readFile(join(f.directory, STATE_FILE), 'utf8'));
  assert.equal(disk.settings.updateResearchMode, 'notify'); assert.equal(disk.jobs[0].mode, 'reconstruct');
});

test('automatic investigation is opt-in and a configured version file must be absolute', async t => {
  const f = await fixture(t);
  assert.equal(f.store.snapshot().settings.updateResearchMode, 'notify'); assert.equal(f.store.snapshot().settings.localVersionFile, '');
  await assert.rejects(f.store.updateSettings({ localVersionFile: 'relative/version.json' }), /absolute file path/);
  await assert.rejects(f.store.updateSettings({ updateResearchMode: 'auto-install' } as never), /updateResearchMode/);
  const versionPath = join(f.directory, 'synthetic-version.json'); await writeFile(versionPath, '{"version":"0.0.1-test"}');
  await f.store.updateSettings({ localVersionFile: versionPath, updateResearchMode: 'investigate' });
  assert.equal(f.store.snapshot().settings.localVersionFile, versionPath); assert.equal(f.store.snapshot().settings.updateResearchMode, 'investigate');
  assert.equal(f.store.snapshot().jobs.length, 0);
});
