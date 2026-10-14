import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertFixtureHome, controlPort } from './home.mjs';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'opencodex-output-qa-fixture';
export const inject = ['llm', 'tools', 'userQuestions', 'sessionController', 'sessions', 'agents', 'sessionProjections'];
const PROVIDER = 'output-qa-local';
const MODEL = 'deterministic-ui-fixture';
const KINDS = new Set(['ordinary', 'timed', 'plan']);
const PRESETS = { ordinary: 'output-qa-ordinary', timed: 'output-qa-timed', plan: 'output-qa-ordinary' };
const PLAN = '# Synthetic QA plan\n\n1. Keep the ordinary composer available.\n2. Preserve the draft and attachments while this review is pending.\n3. Record approval or rejection through the real UserQuestions service.\n\nNo files, accounts, messages, or external services are changed by approving this fixture plan.';

function* textChunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/** A deterministic local source of tool calls; it never emulates or replaces the UI. */
export class QaAdapter extends LlmAdapter {
  constructor(pending, receipts) { super(); this.pending = pending; this.receipts = receipts; }
  providerInfo() { return { id: PROVIDER, name: 'QA fixture · no external model' }; }
  async listModels() { return [{ id: MODEL, provider: PROVIDER, name: 'Deterministic UI fixture', inputModalities: ['text', 'image'] }]; }
  async resolveModel(provider, model) { return { id: model, provider, name: model, inputModalities: ['text', 'image'], context: { contextWindow: 1_000_000 } }; }
  async *stream(options) {
    options.signal?.throwIfAborted();
    const stimulus = this.pending.get(options.sessionId);
    if (stimulus) {
      this.pending.delete(options.sessionId);
      const toolName = stimulus.kind === 'plan' ? 'output_qa_plan_review' : 'ask_user_question';
      if (!options.tools?.some(tool => tool.name === toolName)) throw new Error(`QA fixture requires the real registered tool ${toolName}; check the selected fixture preset`);
      const args = stimulus.kind === 'plan'
        ? { plan: PLAN }
        : { questions: [{ id: `qa-${stimulus.kind}-${stimulus.id}`, header: 'OpenCodex output QA', question: stimulus.kind === 'timed' ? 'Five-second timed question: wait for the late-answer state, then answer.' : 'Ordinary blocking question: verify that the composer remains available.', options: [{ label: 'Option A', description: 'Synthetic option for user-interface acceptance.' }, { label: 'Option B', description: 'Another synthetic option.' }] }], ...(stimulus.kind === 'timed' ? { timeout: 5 } : {}) };
      const block = { type: 'tool-call', id: `qa-call-${stimulus.id}`, name: toolName, arguments: JSON.stringify(args) };
      this.receipts.push({ at: new Date().toISOString(), sessionId: options.sessionId, kind: 'local-adapter-tool', toolName, callId: block.id });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    const last = [...options.messages].reverse().find(message => message.role === 'user' && ['user', 'user-question-reply'].includes(message.source?.kind));
    const visible = last?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
    const hasAttachment = last?.content?.some(block => ['image', 'file'].includes(block.type)) ?? false;
    this.receipts.push({ at: new Date().toISOString(), sessionId: options.sessionId, kind: 'local-adapter-receipt', text: visible.slice(0, 2_000), hasAttachment });
    yield* textChunks(`QA fixture received the real DSH turn. No external model was called.\n\n${visible.slice(0, 2_000)}${hasAttachment ? '\n[Attachment reached the request]' : ''}`);
  }
}

export function apply(ctx, config = {}) {
  const expectedHome = assertFixtureHome();
  const port = controlPort(config.controlPort);
  const workspace = join(expectedHome, 'fixture-workspace');
  const lifetime = new AbortController();
  const sessions = new Map(); const pending = new Map(); const receipts = [];
  const adapter = new QaAdapter(pending, receipts);
  ctx.llm.registerAdapter([PROVIDER], adapter);

  // Prevent every provider dispatch in this isolated instance from reaching an
  // external model, including auxiliary title/compaction requests.
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== PROVIDER) throw new Error('Output QA forbids external model calls');
    yield* next();
  }, { global: true });
  ctx.on('agent/request', async (_payload, next) => {
    const { reasoningEffort: _unusedEffort, ...current } = await next();
    return { ...current, provider: PROVIDER, model: MODEL, maxTokens: 256 };
  }, { global: true });
  ctx.on('session/event', (session, event) => {
    if (!sessions.has(session.id)) return;
    if (['user/message', 'tool/call', 'tool/result', 'turn/end'].includes(event.type)) receipts.push({ at: new Date().toISOString(), sessionId: session.id, kind: event.type, data: event.data });
    if (receipts.length > 300) receipts.splice(0, receipts.length - 300);
  }, { global: true });
  ctx.tools.register(defineTool({
    name: 'output_qa_plan_review', description: 'QA-only: present a synthetic plan through the real DSH UserQuestions service.',
    parameters: { plan: { type: 'string', required: true } },
    output: { schema: { type: 'object', properties: { answer: { type: 'string', required: true } }, additionalProperties: false }, render: (_args, result) => [{ type: 'text', text: result.answer }] },
    execute: async (args, exec) => {
      if (!exec.agent || !sessions.has(exec.agent.session.id)) throw new Error('Plan fixture is available only in a fixture-created session');
      const answer = await ctx.userQuestions.ask({ agent: exec.agent, signal: exec.signal, questions: [{ id: 'qa-plan-review', question: 'Review the synthetic acceptance plan', detail: args.plan, header: 'Plan review', options: [{ label: 'Approve fixture plan' }, { label: 'Request changes' }], intent: { kind: 'plan-review', approve: 'Approve fixture plan', callId: exec.callId } }] });
      return { answer: JSON.stringify(answer) };
    },
  }));

  const snapshot = () => ({ provider: PROVIDER, model: MODEL, noExternalModel: true, sessions: [...sessions.values()].map(row => {
    const session = ctx.sessions.get(row.sessionId); const agent = ctx.agents.get(row.sessionId);
    return { ...row, questions: session ? ctx.sessionProjections.stateOf(session, 'userQuestions')?.questions : undefined, inbox: agent ? { nextTurn: agent.inbox.nextTurn.length, nextStep: agent.inbox.nextStep.length } : undefined };
  }), receipts: receipts.slice(-80) });
  const server = createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value, null, 2)); };
    if (req.headers.origin || req.headers['x-output-qa'] !== 'local-fixture') { reply(403, { error: 'Local fixture control header required; cross-origin requests are disabled' }); return; }
    try {
      if (req.method === 'GET' && req.url === '/status') { reply(200, snapshot()); return; }
      if (req.method !== 'POST') { reply(405, { error: 'Use the supplied control.mjs' }); return; }
      let size = 0; const buffers = [];
      for await (const chunk of req) { size += chunk.length; if (size > 16_384) throw new Error('Fixture request too large'); buffers.push(chunk); }
      const body = JSON.parse(Buffer.concat(buffers).toString('utf8') || '{}');
      if (req.url === '/create') {
        const kind = body.kind ?? 'ordinary'; if (!KINDS.has(kind)) throw new Error('kind must be ordinary, timed or plan');
        await mkdir(workspace, { recursive: true });
        const created = await ctx.sessionController.create({ cwd: workspace, agentPreset: PRESETS[kind] });
        await ctx.sessionController.selectModel({ sessionId: created.sessionId, provider: PROVIDER, model: MODEL });
        await ctx.sessionController.rename({ sessionId: created.sessionId, title: `Output QA · ${kind} · ${new Date().toISOString().slice(11, 19)}` });
        const row = { sessionId: created.sessionId, kind, preset: PRESETS[kind], createdAt: new Date().toISOString() }; sessions.set(created.sessionId, row);
        // The real sidebar hides blank sessions. Admit one harmless local turn
        // before returning so users can select the session and type a draft
        // before the separate question stimulus is triggered.
        let stopListening; let timer;
        const warmed = new Promise((done, fail) => {
          stopListening = ctx.on('session/event', (session, event) => {
            if (session.id !== created.sessionId || event.type !== 'turn/end') return;
            if (event.data.reason.kind === 'error') fail(new Error(`Fixture warmup failed: ${event.data.reason.error?.message ?? 'unknown error'}`));
            else done();
          }, { global: true });
          timer = setTimeout(() => fail(new Error('Fixture warmup did not finish within 15 seconds')), 15_000);
        });
        try {
          await ctx.sessionController.prompt({ sessionId: created.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'QA fixture ready. This local initialization turn makes the real session visible. The question starts only after the separate trigger command.' }] }, lifetime.signal);
          await warmed;
        } finally { stopListening?.(); clearTimeout(timer); }
        reply(200, row); return;
      }
      const row = sessions.get(body.sessionId); if (!row) throw new Error('Use a session created by this fixture process');
      if (req.url === '/trigger') {
        if (pending.has(row.sessionId)) throw new Error('A fixture stimulus is already queued');
        const id = randomUUID(); pending.set(row.sessionId, { id, kind: row.kind });
        try { await ctx.sessionController.prompt({ sessionId: row.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: `QA stimulus ${id}: ${row.kind}. This synthetic input exercises the real DSH question/composer flow.` }] }, lifetime.signal); }
        catch (error) { pending.delete(row.sessionId); throw error; }
        reply(200, { accepted: true, stimulusId: id, ...row }); return;
      }
      if (req.url === '/cancel') { pending.delete(row.sessionId); ctx.sessionController.cancel({ sessionId: row.sessionId }); reply(200, { cancelled: true, sessionId: row.sessionId }); return; }
      reply(404, { error: 'Unknown fixture command' });
    } catch (error) { reply(400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  server.listen(port, '127.0.0.1', () => ctx.logger.info(`Output QA fixture control: http://127.0.0.1:${port}; external model dispatch disabled`));
  server.on('error', error => ctx.logger.error(error));
  ctx.effect(() => () => { lifetime.abort(new Error('QA fixture unloaded')); for (const id of sessions.keys()) ctx.agents.get(id)?.cancel({ kind: 'user' }); server.close(); });
}
