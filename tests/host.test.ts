import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, LlmRuntime, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';
import OpenCodex from '../src/host/index.js';
import { OpenCodexStore } from '../src/core/index.js';
import type { OpenCodexRequest } from '../src/host/remote.js';
import { MAX_REFERENCE_IMAGE_BYTES } from '../src/host/reference-image.js';

const PNG_REFERENCE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ8sAAAAASUVORK5CYII=';
const WEBP_REFERENCE = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
const JPEG_REFERENCE = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';

async function fixture(sandbox = true, existingDirectory?: string) {
  const directory = existingDirectory ?? await mkdtemp(join(tmpdir(), 'opencodex-host-'));
  const ctx = new Context();
  const tools = new Map<string, ToolDefinition>();
  const descriptors: InvocationDescriptor[] = [];
  const sessions = new Map<string, { id: ReturnType<typeof SessionId>; header: { cwd: string; origin?: string; parentSession?: ReturnType<typeof SessionId> }; append: (type: string, data: { mode: string }) => void; mode?: string }>();
  const agents = new Map<string, { session: object; status?: 'idle' | 'running'; cancel: () => void; whenIdle: () => Promise<void> }>();
  const prompts: unknown[] = [];
  let createCount = 0, cancels = 0;
  ctx.provide('typert', { register(value: { invocations: InvocationDescriptor[] }) { descriptors.push(...value.invocations); return async () => {}; } } as never);
  ctx.provide('tools', { schemas: () => [], register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } as never);
  ctx.provide('sessions', { get: (id: string) => sessions.get(id) } as never);
  ctx.provide('agents', { get: (id: string) => agents.get(id), currentInitiator: () => undefined } as never);
  ctx.provide('sessionController', {
    async create({ cwd }: { cwd: string }) {
      createCount++;
      const sessionId = SessionId(`research-${createCount}`);
      const session = { id: sessionId, header: { cwd }, mode: '', append(_type: string, data: { mode: string }) { this.mode = data.mode; } };
      sessions.set(sessionId, session); agents.set(sessionId, { session, cancel() { cancels++; }, async whenIdle() {} });
      return { sessionId };
    },
    async rename() {},
    async resolveAgent(id: string) { return { agent: agents.get(id) }; },
    async prompt(request: unknown) { prompts.push(request); return { accepted: true }; },
  } as never);
  if (sandbox) {
    ctx.provide('sandbox', {} as never);
    ctx.provide('sandboxPolicy', { resolve: ({ session }: { session: { header: { cwd: string }; mode: string } }) => ({ mode: session.mode, workspaceRoot: session.header.cwd }) } as never);
  }
  const plugin = new OpenCodex(ctx, { dataDirectory: directory, monitorTickMs: 1000 });
  const call = (request: OpenCodexRequest) => plugin.call(request, new AbortController().signal);
  const close = async () => { await ctx.fiber.dispose(); if (!existingDirectory) await rm(directory, { recursive: true, force: true }); };
  return { plugin, ctx, call, tools, descriptors, sessions, agents, prompts, counts: () => ({ createCount, cancels }), directory, close };
}

test('manual research starts one ordinary DSH session in a confined workdir and resume retains it', async () => {
  const f = await fixture();
  try {
    const made = await f.call({ action: 'create', input: { title: 'Nonblocking questions' } });
    const id = made.state.jobs[0]!.id;
    assert.equal(f.counts().createCount, 0);
    await f.call({ action: 'start', jobId: id, note: 'Use the saved specification and produce the package.' });
    await Promise.all([f.call({ action: 'start', jobId: id }), f.call({ action: 'start', jobId: id })]);
    assert.equal(f.prompts.length, 1);
    assert.equal(f.counts().cancels, 0);
    const running = (await f.call({ action: 'snapshot' })).state.jobs[0]!;
    assert.equal(running.status, 'researching');
    assert.equal(running.sessionId, 'research-1');
    assert.equal(running.workdir, await realpath(join(f.directory, 'jobs', id)));
    assert.equal(f.sessions.get('research-1')?.mode, 'workspace-write');
    assert.match(JSON.stringify(f.prompts[0]), /opencodex_read_resource/);
    assert.match(JSON.stringify(f.prompts[0]), /OpenCodex execution protocol/);
    assert.match(JSON.stringify(f.prompts[0]), /<opencodex-entry-skill>/);
    assert.match(JSON.stringify(f.prompts[0]), /## Make bounded progress/);
    assert.match(JSON.stringify(f.prompts[0]), /Use the saved specification and produce the package/);
    assert.match(running.history.at(-1)!.reason, /Use the saved specification/);
    await f.call({ action: 'pause', jobId: id });
    await f.call({ action: 'start', jobId: id });
    assert.equal(f.counts().createCount, 1);
    assert.equal(f.prompts.length, 2);
    assert.ok(f.counts().cancels >= 1);
    assert.equal(f.descriptors[0]?.namespace, 'opencodex');
  } finally { await f.close(); }
});

for (const phase of ['specifying', 'building'] as const) {
  test(`explicit resume restores ${phase} from saved specifications without resetting accounting`, async () => {
    const f = await fixture();
    try {
      const made = await f.call({ action: 'create', input: { title: `Resume ${phase}` } });
      const id = made.state.jobs[0]!.id;
      await f.call({ action: 'start', jobId: id });
      const store = await (f.plugin as unknown as { store: Promise<OpenCodexStore> }).store;
      const evidence = await store.addEvidence(id, { kind: 'observed', claim: 'Synthetic public extension point', sourceUrl: 'https://example.com/fixture' });
      const spec = await store.saveSpec(id, { title: 'Saved feature contract', behavior: ['Preserve the composer'], visual: ['Retain the question card'], lifecycle: ['Restore on unload'], existingCapabilities: [], gaps: ['Runtime test pending'], evidenceIds: [evidence.id] });
      await store.transitionJob(id, 'specifying');
      if (phase === 'building') await store.transitionJob(id, 'building');
      await meteredProvider(f).request();
      for (const interrupted of ['paused', 'blocked', 'failed'] as const) {
        await store.transitionJob(id, interrupted, { reason: `Synthetic ${interrupted} checkpoint` });
        const before = await f.call({ action: 'snapshot' });
        await f.call({ action: 'start', jobId: id });
        const after = await f.call({ action: 'snapshot' });
        assert.equal(after.state.jobs[0]!.status, phase);
        assert.equal(after.state.jobs[0]!.elapsedMs, before.state.jobs[0]!.elapsedMs);
        assert.deepEqual(after.state.jobs[0]!.budget, before.state.jobs[0]!.budget);
        assert.deepEqual(after.budgets[id]!.job, before.budgets[id]!.job);
        assert.deepEqual(after.state.reservations, before.state.reservations);
        assert.equal(after.state.specs.length, 1); assert.equal(after.state.specs[0]!.id, spec.id);
        assert.equal(after.state.jobs[0]!.sessionId, 'research-1');
        assert.match(JSON.stringify(f.prompts.at(-1)), new RegExp(`Current stage: ${phase}`));
        assert.match(JSON.stringify(f.prompts.at(-1)), /do not repeat its stage transition/);
      }
      assert.equal(f.counts().createCount, 1);
    } finally { await f.close(); }
  });
}

test('resume does not invent a saved specification or silently enter verification repair', async () => {
  const f = await fixture();
  try {
    const made = await f.call({ action: 'create', input: { title: 'Incomplete phase checkpoint' } });
    const id = made.state.jobs[0]!.id;
    await f.call({ action: 'start', jobId: id });
    const store = await (f.plugin as unknown as { store: Promise<OpenCodexStore> }).store;
    await store.transitionJob(id, 'specifying'); await store.transitionJob(id, 'building');
    await f.call({ action: 'pause', jobId: id }); await f.call({ action: 'start', jobId: id });
    assert.equal(store.getJob(id).status, 'researching'); assert.equal(store.snapshot().specs.length, 0);
    const evidence = await store.addEvidence(id, { kind: 'observed', claim: 'Synthetic interface', sourceUrl: 'https://example.com/fixture' });
    await store.saveSpec(id, { title: 'Valid fixture', behavior: ['Behavior'], visual: ['Visual'], lifecycle: ['Lifecycle'], existingCapabilities: [], gaps: [], evidenceIds: [evidence.id] });
    for (const stage of ['specifying', 'building', 'verifying'] as const) await store.transitionJob(id, stage);
    await f.call({ action: 'pause', jobId: id }); await f.call({ action: 'start', jobId: id });
    assert.equal(store.getJob(id).status, 'researching'); assert.equal(store.getJob(id).repairRounds, 0);
    assert.match(JSON.stringify(f.prompts.at(-1)), /previous phase was verifying/);
    assert.match(JSON.stringify(f.prompts.at(-1)), /No repair round was started/);
  } finally { await f.close(); }
});

async function setAgentStatus(f: Awaited<ReturnType<typeof fixture>>, sessionId: string, status: 'idle' | 'running') {
  const agent = f.agents.get(sessionId)!;
  agent.status = status;
  await f.ctx.parallel('agent/status', { agent, status } as never);
}

async function endAgentTurn(f: Awaited<ReturnType<typeof fixture>>, sessionId: string, kind: string) {
  await f.ctx.parallel('session/event', f.sessions.get(sessionId)! as never, { type: 'turn/end', data: { turn: 1, reason: { kind } } } as never);
}

for (const phase of ['researching', 'specifying', 'building'] as const) {
  test(`an idle unfinished ${phase} turn pauses without changing its budget or saved work`, async () => {
    const f = await fixture();
    try {
      const made = await f.call({ action: 'create', input: { title: `Idle ${phase}` } });
      const id = made.state.jobs[0]!.id;
      await f.call({ action: 'start', jobId: id });
      const store = await (f.plugin as unknown as { store: Promise<OpenCodexStore> }).store;
      if (phase !== 'researching') await store.transitionJob(id, 'specifying');
      if (phase === 'building') await store.transitionJob(id, 'building');
      const evidence = await store.addEvidence(id, { kind: 'unknown', claim: 'The task is incomplete.' });
      const before = store.getJob(id);
      await setAgentStatus(f, 'research-1', 'running');
      await endAgentTurn(f, 'research-1', 'max-tokens');
      assert.equal(store.getJob(id).status, phase, 'turn/end alone is not driver quiescence');
      await setAgentStatus(f, 'research-1', 'idle');
      const after = store.getJob(id);
      assert.equal(after.status, 'paused');
      assert.match(after.history.at(-1)!.reason, /single-call output token limit.*OpenCodex maxOutputTokens/);
      assert.deepEqual(after.budget, before.budget);
      assert.equal(after.sessionId, before.sessionId);
      assert.equal(store.snapshot().evidence[0]!.id, evidence.id);
      assert.equal(f.prompts.length, 1, 'the plugin must not automatically spend on a new turn');
      await f.call({ action: 'start', jobId: id });
      await setAgentStatus(f, 'research-1', 'running');
      await endAgentTurn(f, 'research-1', 'completed');
      await setAgentStatus(f, 'research-1', 'idle');
      assert.equal(store.getJob(id).status, 'paused');
      assert.match(store.getJob(id).history.at(-1)!.reason, /idle without handing off/);
      assert.doesNotMatch(store.getJob(id).history.at(-1)!.reason, /output token limit/, 'resume must clear the old turn reason');
    } finally { await f.close(); }
  });
}

test('idle notifications do not overwrite explicit verification or blocked handoffs', async () => {
  const f = await fixture();
  try {
    const made = await f.call({ action: 'create', input: { title: 'Explicit handoff' } });
    const id = made.state.jobs[0]!.id;
    await f.call({ action: 'start', jobId: id });
    const store = await (f.plugin as unknown as { store: Promise<OpenCodexStore> }).store;
    await setAgentStatus(f, 'research-1', 'running');
    for (const stage of ['specifying', 'building', 'verifying'] as const) await store.transitionJob(id, stage);
    await endAgentTurn(f, 'research-1', 'completed');
    await setAgentStatus(f, 'research-1', 'idle');
    assert.equal(store.getJob(id).status, 'verifying');
    await store.transitionJob(id, 'blocked', { reason: 'Target unavailable' });
    await setAgentStatus(f, 'research-1', 'idle');
    assert.equal(store.getJob(id).status, 'blocked');
    assert.equal(store.getJob(id).history.at(-1)!.reason, 'Target unavailable');
  } finally { await f.close(); }
});

test('idle reconciliation waits for every tracked parent and child agent', async () => {
  const f = await fixture();
  try {
    const made = await f.call({ action: 'create', input: { title: 'Parent and child' } });
    const id = made.state.jobs[0]!.id;
    await f.call({ action: 'start', jobId: id });
    const store = await (f.plugin as unknown as { store: Promise<OpenCodexStore> }).store;
    const child = { id: SessionId('child-1'), header: { cwd: store.getJob(id).workdir!, origin: 'subagent', parentSession: SessionId('research-1') }, append() {} };
    f.sessions.set(child.id, child);
    f.agents.set(child.id, { session: child, status: 'idle', cancel() {}, async whenIdle() {} });
    await setAgentStatus(f, 'research-1', 'running');
    await setAgentStatus(f, child.id, 'running');
    await endAgentTurn(f, child.id, 'completed');
    await setAgentStatus(f, child.id, 'idle');
    assert.equal(store.getJob(id).status, 'researching', 'a finished child cannot pause its running parent');
    await setAgentStatus(f, child.id, 'running');
    await endAgentTurn(f, 'research-1', 'completed');
    await setAgentStatus(f, 'research-1', 'idle');
    assert.equal(store.getJob(id).status, 'researching', 'an idle parent cannot pause its running child');
    await endAgentTurn(f, child.id, 'completed');
    await setAgentStatus(f, child.id, 'idle');
    assert.equal(store.getJob(id).status, 'paused');
    assert.deepEqual(store.getJob(id).sessionIds, ['research-1', 'child-1']);
  } finally { await f.close(); }
});

test('an undriven session stays queued for work and inflight usage defers idle reconciliation', async () => {
  const f = await fixture();
  try {
    const made = await f.call({ action: 'create', input: { title: 'Deferred usage' } });
    const id = made.state.jobs[0]!.id;
    await f.call({ action: 'start', jobId: id });
    const store = await (f.plugin as unknown as { store: Promise<OpenCodexStore> }).store;
    await setAgentStatus(f, 'research-1', 'idle');
    assert.equal(store.getJob(id).status, 'researching', 'session activation is not a completed run');
    await setAgentStatus(f, 'research-1', 'running');
    await store.reserveTokens(id, { requestId: 'inflight-auxiliary', reservedTokens: 1000 });
    await endAgentTurn(f, 'research-1', 'completed');
    await setAgentStatus(f, 'research-1', 'idle');
    assert.equal(store.getJob(id).status, 'researching');
    await store.reconcileUsage('inflight-auxiliary', { inputTokens: 10, outputTokens: 5 });
    await (f.plugin as unknown as { maintenance(): Promise<void> }).maintenance();
    assert.equal(store.getJob(id).status, 'paused', 'maintenance catches an auxiliary settlement with no later idle event');
  } finally { await f.close(); }
});

test('agent errors and disposal pause unfinished jobs without affecting unrelated sessions', async () => {
  const f = await fixture();
  try {
    const made = await f.call({ action: 'create', input: { title: 'Stopped driver' } });
    const id = made.state.jobs[0]!.id;
    await f.call({ action: 'start', jobId: id });
    const agent = f.agents.get('research-1')!;
    await setAgentStatus(f, 'research-1', 'running');
    await f.ctx.parallel('agent/error', { agent, turn: 1, step: 1, error: new Error('Synthetic error') } as never);
    assert.equal((await f.call({ action: 'snapshot' })).state.jobs[0]!.status, 'researching');
    await setAgentStatus(f, 'research-1', 'idle');
    let job = (await f.call({ action: 'snapshot' })).state.jobs[0]!;
    assert.equal(job.status, 'paused');
    assert.match(job.history.at(-1)!.reason, /agent failed/);
    await f.call({ action: 'start', jobId: id });
    await setAgentStatus(f, 'research-1', 'running');
    f.agents.delete('research-1');
    await f.ctx.parallel('agent/disposed', { agent } as never);
    job = (await f.call({ action: 'snapshot' })).state.jobs[0]!;
    assert.equal(job.status, 'paused');
    assert.match(job.history.at(-1)!.reason, /agent stopped/);
    await f.ctx.parallel('agent/status', { agent: { session: { id: SessionId('ordinary') } }, status: 'idle' } as never);
    assert.equal((await f.call({ action: 'snapshot' })).state.jobs[0]!.history.length, job.history.length);
  } finally { await f.close(); }
});

test('create RPC saves pasted images in isolated fixed paths before any research starts', async () => {
  const f = await fixture();
  try {
    const image = { mimeType: 'image/png' as const, dataBase64: PNG_REFERENCE };
    const first = await f.call({ action: 'create', input: { title: 'Suggestion screenshot', description: 'Reconstruct the accepted suggestion behavior' }, referenceImage: image });
    const second = await f.call({ action: 'create', input: { title: 'Separate screenshot task' }, referenceImage: image });
    const jobs = second.state.jobs;
    assert.notEqual(jobs[0]!.id, jobs[1]!.id);
    for (const job of jobs) {
      const directory = join(f.directory, 'jobs', job.id);
      assert.deepEqual(await readdir(directory), ['reference.png']);
      assert.deepEqual(await readFile(join(directory, 'reference.png')), Buffer.from(PNG_REFERENCE, 'base64'));
      assert.match(job.description, /reference\.png/); assert.match(job.description, /read_image/);
      assert.doesNotMatch(JSON.stringify(job), /iVBORw0KGgo|dataBase64/);
      assert.equal(job.sessionId, undefined);
    }
    assert.equal(f.prompts.length, 0);
    await f.call({ action: 'start', jobId: first.state.jobs[0]!.id });
    const started = (await f.call({ action: 'snapshot' })).state.jobs[0]!;
    assert.equal(started.workdir, await realpath(join(f.directory, 'jobs', started.id)));
    assert.deepEqual(await readFile(join(started.workdir!, 'reference.png')), Buffer.from(PNG_REFERENCE, 'base64'));
    assert.match(JSON.stringify(f.prompts[0]), /reference\.png/);
  } finally { await f.close(); }
});

test('create RPC rejects oversized, forged, mismatched, SVG and noncanonical images before creating a job', async () => {
  const f = await fixture();
  try {
    const invalid = [
      { mimeType: 'image/png', dataBase64: Buffer.alloc(MAX_REFERENCE_IMAGE_BYTES + 1).toString('base64') },
      { mimeType: 'image/png', dataBase64: Buffer.from('This is not an image').toString('base64') },
      { mimeType: 'image/jpeg', dataBase64: PNG_REFERENCE },
      { mimeType: 'image/webp', dataBase64: PNG_REFERENCE },
      { mimeType: 'image/svg+xml', dataBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') },
      { mimeType: 'image/png', dataBase64: PNG_REFERENCE.slice(0, -1) },
      { mimeType: 'image/png', dataBase64: `data:image/png;base64,${PNG_REFERENCE}` },
      { mimeType: 'image/png', dataBase64: `${PNG_REFERENCE}\n` },
      { mimeType: 'image/png', dataBase64: PNG_REFERENCE, path: '../../outside.png' },
    ];
    for (const referenceImage of invalid) await assert.rejects(f.call({ action: 'create', input: { title: 'Invalid upload' }, referenceImage } as OpenCodexRequest), /Reference image|referenceImage/);
    assert.equal((await f.call({ action: 'snapshot' })).state.jobs.length, 0);
    assert.deepEqual(await readdir(join(f.directory, 'jobs')), []);
    assert.equal(f.prompts.length, 0);
  } finally { await f.close(); }
});

test('create RPC recognizes real JPEG and WebP fixtures and chooses their fixed extensions', async () => {
  const f = await fixture();
  try {
    for (const [mimeType, dataBase64, filename] of [['image/jpeg', JPEG_REFERENCE, 'reference.jpeg'], ['image/webp', WEBP_REFERENCE, 'reference.webp']] as const) {
      const result = await f.call({ action: 'create', input: { title: `Reference ${mimeType}` }, referenceImage: { mimeType, dataBase64 } });
      const job = result.state.jobs.at(-1)!;
      assert.deepEqual(await readdir(join(f.directory, 'jobs', job.id)), [filename]);
      assert.deepEqual(await readFile(join(f.directory, 'jobs', job.id, filename)), Buffer.from(dataBase64, 'base64'));
      assert.ok(job.description.includes(filename));
    }
  } finally { await f.close(); }
});

test('reference write failure preserves pre-existing files and records an explicit failed job', async () => {
  const f = await fixture();
  try {
    const store = await (f.plugin as unknown as { store: Promise<OpenCodexStore> }).store;
    const create = store.createJob.bind(store);
    store.createJob = async input => {
      const job = await create(input);
      await mkdir(join(f.directory, 'jobs', job.id));
      await writeFile(join(f.directory, 'jobs', job.id, 'reference.png'), 'pre-existing file');
      return job;
    };
    await assert.rejects(f.call({ action: 'create', input: { title: 'Occupied destination' }, referenceImage: { mimeType: 'image/png', dataBase64: PNG_REFERENCE } }), /EEXIST/);
    const job = (await f.call({ action: 'snapshot' })).state.jobs[0]!;
    assert.equal(job.status, 'failed');
    assert.deepEqual(await readdir(join(f.directory, 'jobs', job.id)), ['reference.png']);
    assert.equal(await readFile(join(f.directory, 'jobs', job.id, 'reference.png'), 'utf8'), 'pre-existing file');
    assert.equal(f.prompts.length, 0);
  } finally { await f.close(); }
});

function meteredProvider(f: Awaited<ReturnType<typeof fixture>>) {
  let dispatches = 0;
  let failNext = false;
  class Adapter extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      dispatches++;
      if (failNext) { failNext = false; throw new Error('Synthetic provider retry'); }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const runtime = new LlmRuntime(f.ctx); runtime.registerAdapter(['progress-fixture'], new Adapter());
  return { failNext() { failNext = true; }, dispatches: () => dispatches, async request(session = 'research-1') {
    for await (const _chunk of runtime.stream({ provider: 'progress-fixture', model: 'fixture', sessionId: SessionId(session), messages: [], maxTokens: 256 })) { /* Exercise actual scoped provider admission. */ }
  } };
}

test('four research attempts including failed retries pause before the fifth; explicit resume resets the gate', async () => {
  const f = await fixture();
  try {
    const made = await f.call({ action: 'create', input: { title: 'Bounded investigation' } });
    const id = made.state.jobs[0]!.id;
    await f.call({ action: 'start', jobId: id });
    const provider = meteredProvider(f);
    provider.failNext();
    for (let i = 0; i < 4; i++) await provider.request();
    await assert.rejects(provider.request(), /4 model attempts without new dossier/);
    let state = (await f.call({ action: 'snapshot' })).state;
    assert.equal(provider.dispatches(), 4);
    assert.equal(state.jobs[0]!.status, 'paused');
    assert.equal(state.reservations.length, 4);
    assert.equal(state.reservations[0]!.status, 'unknown');
    for (let i = 0; i < 6; i++) await provider.request('ordinary-unrelated-session');
    assert.equal(provider.dispatches(), 10);
    assert.equal((await f.call({ action: 'snapshot' })).state.reservations.length, 4);
    await f.call({ action: 'start', jobId: id, note: 'Preserve the unknown checkpoint before more reading.' });
    for (let i = 0; i < 4; i++) await provider.request();
    await assert.rejects(provider.request(), /4 model attempts without new dossier/);
    state = (await f.call({ action: 'snapshot' })).state;
    assert.equal(provider.dispatches(), 14);
    assert.equal(state.jobs[0]!.history.filter(event => event.reason.includes('4 model attempts')).length, 2);
  } finally { await f.close(); }
});

test('registered evidence and specifications reset research progress; building has no research gate', async () => {
  const f = await fixture();
  try {
    const made = await f.call({ action: 'create', input: { title: 'Persist findings before building' } });
    await f.call({ action: 'start', jobId: made.state.jobs[0]!.id });
    const provider = meteredProvider(f);
    const tool = f.tools.get('opencodex_job')!;
    const execute = async (args: object) => JSON.parse((await tool.execute(args, { signal: new AbortController().signal, agent: f.agents.get('research-1') } as never) as { result: string }).result);
    for (let i = 0; i < 4; i++) await provider.request();
    const evidence = await execute({ action: 'evidence', payload: { kind: 'observed', claim: 'Synthetic interface fixture exposes a composer slot.', sourceUrl: 'https://example.com/fixture' } });
    for (let i = 0; i < 4; i++) await provider.request();
    await execute({ action: 'spec', payload: { title: 'Minimal composer extension', behavior: ['Retain input'], visual: ['Retain question'], lifecycle: ['Restore on unload'], existingCapabilities: [], gaps: ['Runtime proof pending'], evidenceIds: [evidence.id] } });
    for (let i = 0; i < 4; i++) await provider.request();
    await execute({ action: 'stage', payload: { status: 'specifying', reason: 'Minimal spec recorded' } });
    await execute({ action: 'stage', payload: { status: 'building', reason: 'Implement the observed extension point' } });
    for (let i = 0; i < 6; i++) await provider.request();
    assert.equal(provider.dispatches(), 18);
    assert.equal((await f.call({ action: 'snapshot' })).state.jobs[0]!.status, 'building');
    const args = { action: 'stage', payload: { status: 'verifying', reason: 'Package handed off for independent acceptance' } };
    const result = await f.ctx.waterfall('tools/execute', { name: 'opencodex_job', arguments: args, agent: f.agents.get('research-1'), signal: new AbortController().signal } as never, async () => ({ content: [], isError: false, value: await execute(args) }));
    assert.equal(result.concludesTurn, true);
    assert.equal((await f.call({ action: 'snapshot' })).state.jobs[0]!.status, 'verifying');
  } finally { await f.close(); }
});

test('missing sandbox blocks before creating a session or sending a paid prompt', async () => {
  const f = await fixture(false);
  try {
    const made = await f.call({ action: 'create', input: { title: 'Session chip' } });
    await assert.rejects(f.call({ action: 'start', jobId: made.state.jobs[0]!.id }), /sandbox/);
    assert.equal((await f.call({ action: 'snapshot' })).state.jobs[0]!.status, 'blocked');
    assert.equal(f.counts().createCount, 0);
    assert.equal(f.prompts.length, 0);
  } finally { await f.close(); }
});

test('foreground requests pause and only the separate user API resumes; agent cannot self-approve', async () => {
  const f = await fixture();
  try {
    const made = await f.call({ action: 'create', input: { title: 'Visual research' } });
    const id = made.state.jobs[0]!.id;
    await f.call({ action: 'start', jobId: id });
    const tool = f.tools.get('opencodex_job')!;
    const execute = (args: object) => tool.execute(args, { signal: new AbortController().signal, agent: f.agents.get('research-1') } as never);
    await execute({ action: 'request_foreground', payload: { target: 'DSH test window', scope: 'Inspect question layout', steps: ['Open synthetic test session', 'Capture question card'] } });
    let job = (await f.call({ action: 'snapshot' })).state.jobs[0]!;
    assert.equal(job.status, 'paused');
    await assert.rejects(execute({ action: 'approveForeground', payload: {} }), /must be one of/);
    await assert.rejects(f.call({ action: 'start', jobId: id }), /foreground request/);
    await f.call({ action: 'approveForeground', jobId: id, requestId: job.foreground!.id });
    job = (await f.call({ action: 'snapshot' })).state.jobs[0]!;
    assert.equal(job.status, 'researching');
    assert.ok(job.foreground?.approvedAt);
    await f.call({ action: 'pause', jobId: id });
    assert.ok((await f.call({ action: 'snapshot' })).state.jobs[0]!.foreground?.releasedAt);
    await assert.rejects(f.call({ action: 'start', jobId: id }), /foreground request/);
    await f.call({ action: 'approveForeground', jobId: id, requestId: job.foreground!.id });
    await assert.rejects(execute({ action: 'stage', payload: { status: 'ready', reason: 'I tested it' } }), /Agents may only/);
  } finally { await f.close(); }
});

test('resource reads are allowlisted and agent dossiers reject arbitrary sessions', async () => {
  const f = await fixture();
  try {
    const guide = await f.call({ action: 'readResource', id: 'opencodex' });
    assert.match(guide.resource!.content, /OpenCodex/);
    await assert.rejects(f.call({ action: 'readResource', id: '../../package.json' }), /Unknown/);
    await assert.rejects(f.tools.get('opencodex_job')!.execute({ action: 'status' }, { signal: new AbortController().signal } as never), /dedicated/);
    const tool = f.tools.get('opencodex_read_resource')!;
    const execute = async (args: object) => JSON.parse((await tool.execute(args, { signal: new AbortController().signal } as never) as { result: string }).result);
    const index = await execute({ id: 'opencodex' });
    assert.equal(index.action, 'index'); assert.ok(index.headings.length > 0); assert.match(index.sha256, /^[0-9a-f]{64}$/);
    if (index.totalCharacters > 3000) assert.equal(index.excerpt, undefined);
    else { assert.equal(index.excerpt, guide.resource!.content); assert.equal(index.complete, true); }
    const page = await execute({ id: 'opencodex', action: 'read', offset: 0, maxCharacters: 123 });
    assert.equal(page.action, 'read'); assert.equal(page.excerpt, guide.resource!.content.slice(0, 123)); assert.equal(page.nextOffset, 123);
    await assert.rejects(execute({ id: 'opencodex', action: 'read', maxCharacters: 6001 }), /maxCharacters/);
  } finally { await f.close(); }
});

test('scaffold tool writes the dedicated plugin folder and rejects investigation-only sessions', async () => {
  const f = await fixture();
  try {
    const made = await f.call({ action: 'create', input: { title: 'Scaffold through the registered tool' } });
    await f.call({ action: 'start', jobId: made.state.jobs[0]!.id });
    const execute = async (session: string) => JSON.parse((await f.tools.get('opencodex_job')!.execute({ action: 'scaffold', payload: { packageName: 'dsh-scaffold-fixture' } }, { signal: new AbortController().signal, agent: f.agents.get(session) } as never) as { result: string }).result);
    const result = await execute('research-1');
    assert.equal(result.path, 'plugin'); assert.equal(result.packageName, 'dsh-scaffold-fixture');
    assert.ok(result.files.includes('src/client/index.tsx'));
    await f.call({ action: 'create', input: { title: 'Inventory only', mode: 'investigate' } });
    const investigation = (await f.call({ action: 'snapshot' })).state.jobs[1]!;
    await f.call({ action: 'start', jobId: investigation.id });
    await assert.rejects(execute('research-2'), /reconstruction/);
  } finally { await f.close(); }
});

test('resumed research can retrieve its saved dossier without exposing another job', async () => {
  const f = await fixture();
  try {
    const made = await f.call({ action: 'create', input: { title: 'Saved question research' } });
    await f.call({ action: 'start', jobId: made.state.jobs[0]!.id });
    const tool = f.tools.get('opencodex_job')!;
    const execute = async (args: object, session = 'research-1') => JSON.parse((await tool.execute(args, { signal: new AbortController().signal, agent: f.agents.get(session) } as never) as { result: string }).result);
    const evidence = await execute({ action: 'evidence', payload: { kind: 'observed', claim: 'Question remains visible while the composer accepts input.', sourceUrl: 'https://example.com/fixture' } });
    const spec = await execute({ action: 'spec', payload: { title: 'Question and composer', behavior: ['Keep draft editable'], visual: ['Question card above composer'], lifecycle: ['Persist pending question'], existingCapabilities: [], gaps: ['Separate presentation'], evidenceIds: [evidence.id] } });
    await f.call({ action: 'pause', jobId: made.state.jobs[0]!.id });
    await f.call({ action: 'start', jobId: made.state.jobs[0]!.id });
    const status = await execute({ action: 'status' });
    assert.equal(status.dossier.evidence.items[0].id, evidence.id);
    assert.equal(status.dossier.specs.items[0].id, spec.id);
    const detail = await execute({ action: 'record', payload: { id: spec.id } });
    assert.deepEqual(JSON.parse(detail.content).behavior, ['Keep draft editable']);
    await assert.rejects(execute({ action: 'status', payload: { offset: -1 } }), /nonnegative/);
    await f.call({ action: 'create', input: { title: 'Unrelated research' } });
    const second = (await f.call({ action: 'snapshot' })).state.jobs[1]!;
    await f.call({ action: 'start', jobId: second.id });
    await assert.rejects(execute({ action: 'record', payload: { id: spec.id } }, 'research-2'), /same-job/);
  } finally { await f.close(); }
});

test('agent status and transitions stay compact while the UI retains complete descriptions and resume history', async () => {
  const f = await fixture();
  try {
    const description = 'LONG_DESCRIPTION_ONLY_IN_AUDIT '.repeat(200);
    const oldNote = 'OLD_RESUME_NOTE_ONLY_IN_AUDIT '.repeat(100);
    const recentNote = 'LATEST_GUIDANCE '.repeat(200);
    const made = await f.call({ action: 'create', input: { title: 'Compact tool acknowledgements', description } });
    const id = made.state.jobs[0]!.id;
    await f.call({ action: 'start', jobId: id, note: oldNote });
    for (let i = 0; i < 3; i++) {
      await f.call({ action: 'pause', jobId: id });
      await f.call({ action: 'start', jobId: id, note: i === 2 ? recentNote : oldNote });
    }
    const execute = async (args: object) => JSON.parse((await f.tools.get('opencodex_job')!.execute(args, { signal: new AbortController().signal, agent: f.agents.get('research-1') } as never) as { result: string }).result);
    const status = await execute({ action: 'status' });
    assert.equal(status.job.id, id); assert.equal(status.job.mode, 'reconstruct');
    assert.equal(status.job.sessionId, 'research-1'); assert.ok(status.job.workdir);
    assert.equal(status.job.budget.tokenLimit, made.state.jobs[0]!.budget.tokenLimit);
    assert.ok(status.job.lastHistory.reason.length <= 512);
    assert.equal(status.job.description, undefined); assert.equal(status.job.history, undefined);
    assert.doesNotMatch(JSON.stringify(status), /LONG_DESCRIPTION_ONLY_IN_AUDIT|OLD_RESUME_NOTE_ONLY_IN_AUDIT/);
    const foreground = await execute({ action: 'request_foreground', payload: { target: 'Synthetic DSH window', scope: 'Inspect only this fixture', steps: ['Inspect the fixture composer'] } });
    await f.call({ action: 'approveForeground', jobId: id, requestId: foreground.id });
    const completed = await execute({ action: 'foreground_done', payload: { requestId: foreground.id } });
    assert.equal(completed.id, id); assert.equal(completed.foreground.id, foreground.id);
    assert.ok(completed.foreground.completedAt); assert.equal(completed.history, undefined);
    for (const stage of ['specifying', 'building', 'verifying']) {
      const ack = await execute({ action: 'stage', payload: { status: stage, reason: 'Advance bounded fixture' } });
      assert.equal(ack.id, id); assert.equal(ack.status, stage); assert.equal(ack.mode, 'reconstruct');
      assert.equal(ack.description, undefined); assert.equal(ack.history, undefined);
      assert.ok(JSON.stringify(ack).length < 1500);
    }
    const repair = await execute({ action: 'repair' });
    assert.equal(repair.id, id); assert.equal(repair.status, 'building'); assert.equal(repair.repairRounds, 1);
    assert.equal(repair.history, undefined); assert.equal(repair.description, undefined);
    const full = (await f.call({ action: 'snapshot' })).state.jobs[0]!;
    assert.equal(full.description, description);
    assert.ok(full.history.some(event => event.reason.includes(oldNote.trim())));
    assert.ok(full.history.some(event => event.reason.includes(recentNote.trim())));
  } finally { await f.close(); }
});

test('locked store initialization is contained before any RPC instead of rejecting unhandled', async () => {
  const owner = await fixture();
  await owner.call({ action: 'snapshot' });
  const second = await fixture(true, owner.directory);
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    await assert.rejects(second.call({ action: 'snapshot' }), /lock|already/i);
    let dispatches = 0;
    class Adapter extends LlmAdapter { async *stream(): AsyncIterable<StreamChunk> { dispatches++; yield { type: 'finish', reason: { kind: 'stop' } }; } }
    const runtime = new LlmRuntime(second.ctx); runtime.registerAdapter(['fixture'], new Adapter());
    const ordinary = { id: SessionId('ordinary'), header: { cwd: '/ordinary-workspace' }, append() {} };
    second.sessions.set('ordinary', ordinary);
    for await (const _chunk of runtime.stream({ provider: 'fixture', model: 'fixture', sessionId: ordinary.id, messages: [] })) { /* Drain the real runtime dispatch. */ }
    assert.equal(dispatches, 1);
    let toolRan = false;
    await second.ctx.waterfall('tools/execute', { name: 'bash', arguments: {}, agent: { session: ordinary }, signal: new AbortController().signal } as never, async () => { toolRan = true; return { content: [], isError: false, value: null }; });
    assert.equal(toolRan, true);
    const research = { id: SessionId('orphaned-research'), header: { cwd: await realpath(join(owner.directory, 'jobs')) }, append() {} };
    second.sessions.set(research.id, research);
    await assert.rejects((async () => { for await (const _chunk of runtime.stream({ provider: 'fixture', model: 'fixture', sessionId: research.id, messages: [], maxTokens: 256 })) { /* Drain until admission denies. */ } })(), /research state is unavailable/);
    assert.equal(dispatches, 1);
  } finally { await second.close(); await owner.close(); }
});


test('selected local updates notify by default; opted-in changes queue investigation-only sessions once', async t => {
  // A local-version event now refreshes public announcements. Keep this lifecycle
  // test deterministic and offline; feature parsing has its own source fixtures.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<rss><channel><item><title>Codex CLI fixture</title><pubDate>Wed, 14 Oct 2026 00:00:00 GMT</pubDate><description>Non-desktop fixture</description></item></channel></rss>', { headers: { 'content-type': 'application/rss+xml' } });
  t.after(() => { globalThis.fetch = originalFetch; });
  const f = await fixture();
  try {
    const versionFile = join(f.directory, 'version-input.json');
    await writeFile(versionFile, JSON.stringify({ version: '1.0.0', build: '1' }));
    await f.call({ action: 'settings', patch: { localVersionFile: versionFile } });
    assert.equal((await f.call({ action: 'snapshot' })).state.candidates.length, 0);
    await writeFile(versionFile, JSON.stringify({ version: '1.1.0', build: '2' }));
    await f.call({ action: 'scanLocalVersion' });
    let state = (await f.call({ action: 'snapshot' })).state;
    assert.equal(state.candidates.filter(candidate => candidate.sourceType === 'local-version').length, 1); assert.equal(state.jobs.length, 0);
    await f.call({ action: 'settings', patch: { updateResearchMode: 'investigate' } });
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal((await f.call({ action: 'snapshot' })).state.jobs.length, 0, 'Notify-era candidates must not become automatic work after opting in');
    await writeFile(versionFile, JSON.stringify({ version: '1.2.0', build: '3' }));
    await f.call({ action: 'scanLocalVersion' });
    await f.call({ action: 'scanLocalVersion' });
    state = (await f.call({ action: 'snapshot' })).state;
    assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0]!.mode, 'investigate');
    assert.equal(state.jobs[0]!.status, 'researching'); assert.equal(f.prompts.length, 1);
    assert.match(JSON.stringify(f.prompts[0]), /Do not implement, package or install/);
    await writeFile(versionFile, JSON.stringify({ version: '1.3.0', build: '4' }));
    await f.call({ action: 'scanLocalVersion' });
    state = (await f.call({ action: 'snapshot' })).state;
    assert.equal(state.jobs.length, 2); assert.equal(state.jobs[1]!.status, 'queued');
    assert.equal(f.prompts.length, 1);
    const execute = (args: object) => f.tools.get('opencodex_job')!.execute(args, { signal: new AbortController().signal, agent: f.agents.get('research-1') } as never);
    await assert.rejects(execute({ action: 'stage', payload: { status: 'building', reason: 'Try implementing anyway' } }), /investigation|investigate/i);
    await f.call({ action: 'cancel', jobId: state.jobs[0]!.id });
    await new Promise(resolve => setTimeout(resolve, 1100));
    state = (await f.call({ action: 'snapshot' })).state;
    assert.equal(state.jobs[1]!.status, 'researching'); assert.equal(f.prompts.length, 2);
    assert.equal(state.artifacts.length, 0);
  } finally { await f.close(); }
});

test('startup recovers eligible detected updates and half-created jobs without retroactive opt-in', async t => {
  const originalFetch = globalThis.fetch;
  // Public-source failure must not prevent an already eligible local investigation.
  globalThis.fetch = async () => new Response('Synthetic source unavailable', { status: 503 });
  t.after(() => { globalThis.fetch = originalFetch; });
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-recover-'));
  const store = await OpenCodexStore.open({ directory, artifactRoot: join(directory, 'jobs') });
  const candidate = (fingerprint: string) => ({ title: fingerprint, description: 'Synthetic local update', sourceUrl: 'https://example.com/fixture', fingerprint, sourceType: 'local-version' as const });
  const old = await store.saveCandidate(candidate('notify-era'));
  await store.updateSettings({ updateResearchMode: 'investigate' });
  const first = await store.saveCandidate(candidate('eligible-before-job'));
  const second = await store.saveCandidate(candidate('eligible-half-created'));
  await store.createJob({ title: 'Half-created investigation', source: 'discovery', candidateId: second.id, mode: 'investigate' });
  assert.equal(old.autoInvestigate, false);
  assert.equal(first.autoInvestigate, true);
  assert.equal((await store.saveCandidate(candidate('notify-era'))).autoInvestigate, false, 'Deduplication cannot opt an old candidate in');
  await assert.rejects(store.saveCandidate({ ...candidate('forged'), autoInvestigate: true } as never), /eligibility/);
  await store.close();
  const f = await fixture(true, directory);
  try {
    await new Promise(resolve => setTimeout(resolve, 1100));
    let state = (await f.call({ action: 'snapshot' })).state;
    assert.equal(state.jobs.length, 2);
    assert.ok(!state.jobs.some(job => job.candidateId === old.id));
    assert.equal(f.prompts.length, 1);
    assert.equal(state.jobs.filter(job => job.status === 'researching').length, 1);
    assert.equal(state.jobs.filter(job => job.status === 'queued').length, 1);
    await new Promise(resolve => setTimeout(resolve, 1100));
    state = (await f.call({ action: 'snapshot' })).state;
    assert.equal(state.jobs.length, 2); assert.equal(f.prompts.length, 1);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a failed public checkpoint cannot block an opted-in local version investigation', async () => {
  const f = await fixture();
  try {
    const store = await (f.plugin as unknown as { store: Promise<OpenCodexStore> }).store;
    await store.updateSettings({ updateResearchMode: 'investigate' });
    const candidate = await store.saveCandidate({ title: 'Local version fixture', description: 'Synthetic update already detected locally', sourceUrl: 'https://example.com/fixture', fingerprint: 'local-checkpoint-failure', sourceType: 'local-version' });
    await writeFile(join(f.directory, 'discovery.json'), '{ malformed checkpoint');
    await (f.plugin as unknown as { localVersionCandidate: (id: string) => Promise<void> }).localVersionCandidate(candidate.id);
    const state = store.snapshot();
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0]!.mode, 'investigate');
    assert.equal(state.jobs[0]!.status, 'researching');
    assert.equal(f.prompts.length, 1);
    assert.equal(await readFile(join(f.directory, 'discovery.json'), 'utf8'), '{ malformed checkpoint', 'Failure is reported, not silently reset');
  } finally { await f.close(); }
});
