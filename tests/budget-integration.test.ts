import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import OpenCodex from '../src/host/index.js';
import { billableUsage, estimateRequestTokens, requestShape, calibratedRequestTokens } from '../src/host/budget.js';
import { OpenCodexStore } from '../src/core/index.js';

class FixtureAdapter extends LlmAdapter {
  dispatches = 0;
  responses: Array<() => AsyncIterable<StreamChunk>> = [];
  async *stream(): AsyncIterable<StreamChunk> {
    this.dispatches++;
    const scripted = this.responses.shift();
    if (scripted) { yield* scripted(); return; }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
async function consume(stream: AsyncIterable<StreamChunk>) { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-budget-hooks-'));
  let date = new Date('2026-10-13T10:00:00.000Z');
  const store = await OpenCodexStore.open({ directory, now: () => date });
  const job = await store.createJob({ title: 'Metered research', budget: { tokenLimit: 50_000, maxDurationMs: 1_000 } });
  await store.transitionJob(job.id, 'queued'); await store.transitionJob(job.id, 'researching');
  const workdir = join(store.artifactRoot, job.id); await mkdir(workdir);
  await store.bindSession(job.id, { sessionId: 'research-root', workdir });
  const ctx = new Context();
  let initiator: string | undefined;
  const sessions = new Map<string, { id: string; header: Record<string, unknown>; append: () => void }>();
  const cancellations: string[] = [];
  const disposers = [ctx.provide('sessions', { get: (id: string) => sessions.get(id) }), ctx.provide('agents', { currentInitiator: () => initiator ? { session: { id: initiator } } : undefined, get: (id: string) => ({ cancel: () => cancellations.push(id) }) })];
  const runtime = new LlmRuntime(ctx); const adapter = new FixtureAdapter(); disposers.push(runtime.registerAdapter(['test-fixture'], adapter));
  // Exercise the actual plugin's hooks through the real Cordis waterfall and
  // LlmRuntime adapter dispatch. Only session registry/provider I/O is synthetic.
  const host = Object.create(OpenCodex.prototype) as { installHooks(): void };
  Object.assign(host, { ctx, store: Promise.resolve(store), acceptance: Promise.resolve({ cancel() {} }), maxOutputTokens: 4096, allowSubagents: true, researchProgress: new Map(), requestCalibrations: new Map() });
  host.installHooks();
  t.after(async () => { for (const dispose of disposers.reverse()) dispose(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const options = (sessionId: string | undefined = 'research-root', maxTokens = 256): GenerateOptions => ({ provider: 'test-fixture', model: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'Research the composer interaction' }] }], maxTokens, ...(sessionId ? { sessionId: SessionId(sessionId) } : {}) });
  return { store, jobId: job.id, runtime, adapter, options, sessions, workdir, cancellations, setInitiator(id?: string) { initiator = id; }, setTime(at: string) { date = new Date(at); } };
}

test('calibration reuses settled input while changed content and route changes remain conservatively reserved', () => {
  const options: GenerateOptions = { provider: 'fixture', model: 'one', system: 'stable context '.repeat(3000), messages: [{ role: 'user', content: [{ type: 'text', text: 'Original' }] }], maxTokens: 1000 };
  const previous = { shape: requestShape(options), inputTokens: 8000 };
  assert.equal(calibratedRequestTokens(previous.shape), previous.shape.upper);
  assert.equal(calibratedRequestTokens(previous.shape, previous), 11024);
  const appended = requestShape({ ...options, messages: [...options.messages, { role: 'user', content: [{ type: 'text', text: '新增信息'.repeat(100) }] }] });
  assert.ok(calibratedRequestTokens(appended, previous) >= 11024 + Buffer.byteLength('新增信息'.repeat(100)));
  const switched = requestShape({ ...options, model: 'two' });
  assert.equal(calibratedRequestTokens(switched, previous), switched.upper);
  const replaced = requestShape({ ...options, system: 'replacement '.repeat(3000) });
  assert.equal(calibratedRequestTokens(replaced, previous), replaced.upper);
});

test('real LlmRuntime retries enter separate reservations and retain unknown failed-attempt usage', async t => {
  const f = await fixture(t);
  f.adapter.responses.push(async function* () { throw new Error('Synthetic transport failure before usage'); });
  const failed = await consume(f.runtime.stream(f.options()));
  assert.equal(failed.at(-1)?.type, 'finish');
  await consume(f.runtime.stream(f.options()));
  const reservations = f.store.snapshot().reservations;
  assert.equal(reservations.length, 2); assert.notEqual(reservations[0].requestId, reservations[1].requestId);
  assert.equal(reservations[0].status, 'unknown'); assert.equal(reservations[1].status, 'settled');
  assert.equal(f.store.budgetSummary(f.jobId).job.confirmedTokens, 15);
  assert.equal(f.store.budgetSummary(f.jobId).job.reservedTokens, estimateRequestTokens(f.options()) + 256);
});

test('cached input and output are reconciled from authoritative counters, not token estimates', async t => {
  const f = await fixture(t);
  f.adapter.responses.push(async function* () { yield { type: 'usage', usage: { inputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 10, outputTokens: 20, reasoningTokens: 8, totalTokens: 65 } }; yield { type: 'finish', reason: { kind: 'stop' } }; });
  await consume(f.runtime.stream(f.options()));
  assert.deepEqual(f.store.snapshot().reservations[0].usage, { inputTokens: 45, outputTokens: 20 });
  assert.equal(f.store.budgetSummary(f.jobId).job.reservedTokens, 0);
  assert.deepEqual(billableUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 100 }), { inputTokens: 95, outputTokens: 5 });
});

test('in-process child sessions join only the real parent lineage and ordinary sessions are not billed', async t => {
  const f = await fixture(t);
  f.sessions.set('research-child', { id: 'research-child', header: { origin: 'subagent', parentSession: 'research-root', cwd: f.workdir }, append() {} });
  await consume(f.runtime.stream(f.options('research-child')));
  assert.ok(f.store.getJob(f.jobId).sessionIds.includes('research-child'));
  assert.equal(f.store.snapshot().reservations[0].jobId, f.jobId);
  await consume(f.runtime.stream(f.options('ordinary-chat')));
  assert.equal(f.store.snapshot().reservations.length, 1);
  f.sessions.set('escaped-child', { id: 'escaped-child', header: { origin: 'subagent', parentSession: 'research-root', cwd: '/different-workspace' }, append() {} });
  await assert.rejects(consume(f.runtime.stream(f.options('escaped-child'))), /escaped/);
  assert.equal(f.adapter.dispatches, 2);
});

test('initiated auxiliary calls cannot spill into an unrelated session or omit their output bound', async t => {
  const f = await fixture(t); f.setInitiator('research-root');
  await assert.rejects(consume(f.runtime.stream(f.options('ordinary-chat'))), /unattributed/);
  const unbounded = f.options(); delete unbounded.sessionId; delete unbounded.maxTokens;
  await assert.rejects(consume(f.runtime.stream(unbounded)), /bounded maxTokens/);
  const bounded = f.options(); delete bounded.sessionId;
  await consume(f.runtime.stream(bounded));
  assert.equal(f.store.snapshot().reservations.length, 1); assert.equal(f.adapter.dispatches, 1);
});

test('paused, cancelled and wall-time-expired jobs cannot dispatch another provider request', async t => {
  const f = await fixture(t);
  await f.store.transitionJob(f.jobId, 'paused', { reason: 'User pause' });
  await assert.rejects(consume(f.runtime.stream(f.options())), /paused/);
  await f.store.transitionJob(f.jobId, 'queued'); await f.store.transitionJob(f.jobId, 'researching');
  f.setTime('2026-10-13T10:00:02.000Z');
  await assert.rejects(consume(f.runtime.stream(f.options())), /budget exhausted/);
  assert.equal(f.store.getJob(f.jobId).status, 'paused'); assert.ok(f.cancellations.includes('research-root'));
  await f.store.transitionJob(f.jobId, 'cancelled');
  await assert.rejects(consume(f.runtime.stream(f.options())), /cancelled/);
  assert.equal(f.adapter.dispatches, 0);
});

test('oversized request reservation is rejected before adapter dispatch and persists paused state', async t => {
  const f = await fixture(t); await f.store.updateSettings({ dailyTokenLimit: 10 });
  await assert.rejects(consume(f.runtime.stream(f.options())), new RegExp(`Next request needs ${estimateRequestTokens(f.options()) + 256} reserved tokens; daily budget has 10 remaining`));
  assert.equal(f.adapter.dispatches, 0); assert.equal(f.store.snapshot().reservations.length, 0); assert.equal(f.store.getJob(f.jobId).status, 'paused');
});

test('negative, NaN and fractional output bounds cannot decrease a reservation', async t => {
  const f = await fixture(t);
  for (const maxTokens of [-1, Number.NaN, 0.5]) await assert.rejects(consume(f.runtime.stream(f.options('research-root', maxTokens))), /bounded maxTokens/);
  assert.equal(f.adapter.dispatches, 0); assert.equal(f.store.snapshot().reservations.length, 0);
});

test('malformed provider cache counters retain an unknown reservation and pause further work', async t => {
  const f = await fixture(t);
  f.adapter.responses.push(async function* () {
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: -10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  await assert.rejects(consume(f.runtime.stream(f.options())), /usage|counter|token/i);
  const reservation = f.store.snapshot().reservations[0];
  assert.equal(reservation.status, 'unknown'); assert.equal(f.store.getJob(f.jobId).status, 'paused');
  assert.equal(f.store.budgetSummary(f.jobId).job.reservedTokens, reservation.reservedTokens);
  await assert.rejects(consume(f.runtime.stream(f.options())), /paused/);
  assert.equal(f.adapter.dispatches, 1);
});
