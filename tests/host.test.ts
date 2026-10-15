import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type { FinishReason, GenerateOptions, LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionCancelRequest, SessionCreateRequest, SessionPromptRequest, SessionRenameRequest, SessionSelectModelRequest } from '@deepseek-ai/dsh-api-session-controller/types';
import { remoteErrorOf, type InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';
import { transition, type Candidate, type Evidence } from '../src/core/candidate.ts';
import { ValidationError } from '../src/core/check.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings.ts';
import { CandidateStore } from '../src/core/store.ts';
import { GitHubClient, type GhRunner } from '../src/host/github.ts';
import OpenCodex, { type Config, type Dependencies, type Timers } from '../src/host/index.ts';
import { MAX_PAYLOAD, OPEN_CODEX_DESCRIPTOR, parseRequest, type OpenCodexRequest, type OpenCodexResponse } from '../src/host/remote.ts';

const MIRROR = fileURLToPath(new URL('./fixtures/mirror/', import.meta.url));
const RELEASE = await readFile(new URL('./fixtures/release-0.162.0.md', import.meta.url), 'utf8');
const FEED = await readFile(new URL('./fixtures/changelog-rss-sample.xml', import.meta.url), 'utf8');
// The RSS fixture's items are dated Aug-Oct 2026; the clock is pinned so the parser's 120-day window never drifts.
const NOW = new Date('2026-10-15T08:00:00.000Z');
const COUNTER = 'reportsOn-2026-10-15';
const HOUR = 3_600_000;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

/** A report as an analyst session leaves it, citing a file of the fixture mirror. */
const REPORT = [
  '# Managed worktrees', '',
  '## 结论', '做第 1 级。', '',
  '## Codex 怎么做的', '- PR #50148', '',
  '## DSH 现在有没有', '- `packages/experimental/worktree/README.md:1` 有 worktree 插件', '',
  '## 差哪些扩展点', '- 无', '',
  '## 分级', '| 级别 |', '',
  '## 建议', '做 1', '',
].join('\n');
const DIFF = [
  'diff --git a/codex-rs/core/src/worktree.rs b/codex-rs/core/src/worktree.rs',
  'index 1111111..2222222 100644',
  '--- a/codex-rs/core/src/worktree.rs',
  '+++ b/codex-rs/core/src/worktree.rs',
  '@@ -1,1 +1,2 @@',
  ' pub struct Worktree;',
  '+pub fn create_worktree() {}',
  '',
].join('\n');

// GitHub: openai/codex with two stable tags, the 0.162.0 notes, one pull request shape for every number, and trees in which only the feature registry differs.
const TAGS = ['rust-v0.162.0', 'rust-v0.161.0'];
const FLAGS = 'codex-rs/features/src/lib.rs';
const FLAGS_AT: Record<string, string> = {
  'rust-v0.161.0': 'pub enum Feature {\n    Worktrees,\n}\n',
  'rust-v0.162.0': 'pub enum Feature {\n    Worktrees,\n    RemoteCompaction,\n}\n',
};
/** What `gh` prints, as JSON, for each request the client makes. */
function fixtureFor(args: string[]): unknown {
  const target = args.at(-1)!;
  if (args[0] === 'release' && args[1] === 'view') return { tagName: target, body: RELEASE, publishedAt: '2026-10-08T18:55:59Z', isPrerelease: false };
  if (args[0] === 'pr' && args[1] === 'view') {
    return {
      number: Number(target), title: `PR ${target}`, body: `What ${target} changes.`, url: `https://github.com/openai/codex/pull/${target}`,
      additions: 3, deletions: 1, changedFiles: 1, files: [{ path: 'codex-rs/core/src/worktree.rs', additions: 3, deletions: 1 }],
    };
  }
  if (args[0] === 'api') {
    if (target.startsWith('repos/openai/codex/tags?')) return target.endsWith('&page=1') ? TAGS.map(name => ({ name })) : [];
    const tree = /^repos\/openai\/codex\/git\/trees\/([^?]+)\?recursive=1$/.exec(target);
    if (tree) return { truncated: false, tree: [{ path: FLAGS, type: 'blob', sha: `flags-${decodeURIComponent(tree[1]!)}` }] };
    const file = /^repos\/openai\/codex\/contents\/(.+)\?ref=(.+)$/.exec(target);
    const text = file && FLAGS_AT[decodeURIComponent(file[2]!)];
    if (text) return { encoding: 'base64', content: Buffer.from(text).toString('base64') };
  }
  throw new Error(`unexpected gh call: ${args.join(' ')}`);
}
/** Serves `fixtureFor`, the diff of any pull request as text, and records every call. */
function codexGh(calls: string[][] = []): GhRunner {
  return async args => {
    calls.push(args);
    return args[0] === 'pr' && args[1] === 'diff' ? DIFF : JSON.stringify(fixtureFor(args));
  };
}
const offlineGh: GhRunner = async () => { throw Object.assign(new Error('Command failed: gh'), { code: 1, stderr: 'gh: offline' }); };
/** Rejects once `signal` fires. */
const whenAborted = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
/** A gh that answers nothing until the request is aborted. */
const stalledGh: GhRunner = (_args, signal) => whenAborted(signal!);
/** A fetch that answers every request with `body`, counting the requests. */
function serve(body: string, status = 200, calls: { count: number } = { count: 0 }): typeof fetch {
  return async () => { calls.count++; return new Response(body, { status }); };
}
/** Waits until `condition` holds, and fails the test after `ms`. */
async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

/** A timer table the test fires by hand. */
function fakeTimers() {
  const armed = new Map<number, { run: () => void; ms: number }>();
  const log: Array<{ handle: number; ms: number }> = [];
  const cleared: number[] = [];
  let last = 0;
  const timers: Timers = {
    set(run, ms) { const handle = ++last; armed.set(handle, { run, ms }); log.push({ handle, ms }); return handle; },
    clear(handle) { cleared.push(handle as number); armed.delete(handle as number); },
  };
  return {
    timers, armed, log, cleared,
    /** Runs the one armed timer. */
    fire() {
      assert.equal(armed.size, 1, 'exactly one timer is armed');
      const [[handle, entry]] = [...armed];
      armed.delete(handle);
      entry.run();
    },
  };
}

/** The ids of the candidate blocks in a classification request. */
function idsOf(request: GenerateOptions): string[] {
  const part = request.messages[0]?.content[0];
  return part?.type === 'text' ? [...part.text.matchAll(/<candidate id="([^"]+)"/g)].map(match => match[1]!) : [];
}
const classifyAll = (ids: string[]) => JSON.stringify(ids.map(id => ({ id, category: 'cli-core', relevance: 'high', rationale: '测试' })));
type Answer = (ids: string[]) => string | FinishReason | 'stall';
/** A stand-in for `ctx.llm`: the n-th call answers with `answers[n]` (classify everything when there is none): text, a finish reason, or nothing until the call is aborted. */
function fakeLlm(answers: Answer[] = []) {
  const requests: GenerateOptions[] = [];
  return {
    requests,
    async prepareCall(config: LlmCallConfig) {
      return {
        config,
        stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
          requests.push(request);
          const answer = (answers[requests.length - 1] ?? classifyAll)(idsOf(request));
          return (async function* (): AsyncGenerator<StreamChunk> {
            if (answer === 'stall') await whenAborted(request.signal!);
            if (typeof answer !== 'string') { yield { type: 'finish', reason: answer as FinishReason }; return; }
            yield { type: 'text-delta', index: 0, text: answer };
            yield { type: 'finish', reason: { kind: 'stop' } };
          })();
        },
      };
    },
  };
}

/**
 * DSH's session controller, agents, default model and approval, as plain objects. A session in a `reports/` directory writes `report.md`
 * when it is prompted (after `hold()`, only once `open()` is called); a creator session writes nothing.
 */
function fakeDsh() {
  const created: SessionCreateRequest[] = [];
  const renamed: SessionRenameRequest[] = [];
  const selected: SessionSelectModelRequest[] = [];
  const prompts: SessionPromptRequest[] = [];
  const cancelled: string[] = [];
  const statuses = new Map<string, string>();
  const cwd = new Map<string, string>();
  const policies: string[] = [];
  const defaults: ModelSelection[] = [];
  let gate: Promise<void> | undefined;
  let release = () => {};
  const hooks: { creatorPrompted?: (request: SessionPromptRequest) => Promise<void>; activationError?: Error; createError?: Error } = {};
  return {
    created, renamed, selected, prompts, cancelled, statuses, policies, defaults, hooks,
    hold() { gate = new Promise(resolve => { release = resolve; }); },
    open() { release(); gate = undefined; },
    sessionController: {
      async create(request: SessionCreateRequest) {
        if (hooks.createError) throw hooks.createError;
        created.push(request);
        const sessionId = SessionId(`${request.agentPreset || 'analyst'}-${created.length}`);
        cwd.set(sessionId, request.cwd!);
        return { sessionId };
      },
      async rename(request: SessionRenameRequest) { renamed.push(request); return { title: request.title, seq: 1 }; },
      async selectModel(request: SessionSelectModelRequest) { selected.push(request); return { selected: request }; },
      async resolveAgent(sessionId: string) { return hooks.activationError ? { error: hooks.activationError } : { agent: { session: { id: sessionId, append() {} } } }; },
      async prompt(request: SessionPromptRequest, signal: AbortSignal) {
        prompts.push(request);
        const dir = cwd.get(request.sessionId)!;
        if (dir.includes(`${sep}reports${sep}`)) {
          if (gate) await Promise.race([gate, whenAborted(signal)]);
          await writeFile(join(dir, 'report.md'), REPORT);
        } else await hooks.creatorPrompted?.(request);
        return { accepted: true };
      },
      cancel(request: SessionCancelRequest) { cancelled.push(request.sessionId); return { accepted: true }; },
    },
    agents: { get: (sessionId: string) => ({ status: statuses.get(sessionId) ?? 'idle', async whenIdle() {} }) },
    agentDefaultModel: {
      currentSelection: (): ModelSelection => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
      async saveSelection(selection: ModelSelection) { defaults.push(selection); },
    },
    approval: { setPolicy(_agent: unknown, policy: string) { policies.push(policy); } },
  };
}

/** The Host class with test dependencies bound, so Cordis can load it as a plugin with only a config. */
function hostWith(deps: Dependencies) {
  return class TestHost extends OpenCodex { constructor(ctx: Context, config: Config) { super(ctx, config, deps); } };
}

interface FixtureOptions {
  /** Written to settings.json over the defaults, with the desktop source off; `null` writes no file. */
  settings?: Partial<Settings> | null;
  /** An existing data directory (another Host on the same data). */
  directory?: string;
  gh?: GhRunner;
  llm?: ReturnType<typeof fakeLlm>;
  feed?: typeof fetch;
  timeouts?: Dependencies['timeouts'];
  /** 1 ms twice by default, so a retried classification does not wait 25 seconds. */
  classifyRetryDelaysMs?: number[];
}
/**
 * An OpenCodex Host loaded as a Cordis plugin (`ctx.plugin`, so `inject` is enforced as in DSH) on a fresh context that provides every
 * injected service as a plain object, over a temporary data directory. Resolves once the plugin has started; a startup error rejects.
 */
async function fixture(options: FixtureOptions = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'oc-host-'));
  if (options.settings !== null) {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, desktopPlistPath: '', ...options.settings }));
  }
  const ctx = new Context();
  const descriptors: InvocationDescriptor[] = [];
  const dsh = fakeDsh();
  const llm = options.llm ?? fakeLlm();
  ctx.provide('typert', { register(contribution: { invocations: InvocationDescriptor[] }) { descriptors.push(...contribution.invocations); return async () => {}; } } as never);
  ctx.provide('sessionController', dsh.sessionController as never);
  ctx.provide('agents', dsh.agents as never);
  ctx.provide('llm', llm as never);
  ctx.provide('agentDefaultModel', dsh.agentDefaultModel as never);
  ctx.provide('approval', dsh.approval as never);
  const timers = fakeTimers();
  const fiber = ctx.plugin(hostWith({
    github: new GitHubClient({ gh: options.gh ?? codexGh() }), fetcher: options.feed ?? serve(FEED), now: () => NOW, timers: timers.timers, reportPollMs: 2,
    classifyRetryDelaysMs: options.classifyRetryDelaysMs ?? [1, 1], ...(options.timeouts && { timeouts: options.timeouts }),
  }) as never, { dataDirectory: directory } as never);
  const remove = () => rm(directory, { recursive: true, force: true });
  try { await fiber.await(); } catch (error) { await fiber.dispose(); throw error; }
  const plugin = ctx.get('opencodex')!;
  const call = (request: OpenCodexRequest) => plugin.call(request, new AbortController().signal);
  /** Another store on the same directory, for seeding and reading back; use it only while no action runs. */
  const store = new CandidateStore(directory, () => NOW);
  let unloaded = false;
  const unload = async () => { if (!unloaded) { unloaded = true; await fiber.dispose(); } };
  const close = async () => { await unload(); if (!options.directory) await remove(); };
  return { plugin, ctx, directory, call, store, dsh, llm, timers, descriptors, unload, close };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A candidate written straight to the store. */
async function seed(store: CandidateStore, key: string, fields: { source?: Candidate['source']; title?: string; evidence?: Evidence[] } = {}): Promise<Candidate> {
  const { candidate } = await store.upsert({
    source: fields.source ?? 'codex-release', key, title: fields.title ?? `Feature ${key}`, summary: `Summary of ${key}`,
    evidence: fields.evidence ?? [{ kind: 'pr', ref: '#50148', url: 'https://github.com/openai/codex/pull/50148', excerpt: 'PR 50148\n\nWhat it changes.' }],
  });
  return candidate;
}
const rssItem = (store: CandidateStore, key = 'rss-item') => seed(store, key, { source: 'rss', title: 'Codex app update', evidence: [{ kind: 'rss', ref: 'Codex app update', excerpt: 'Worktrees in the app.' }] });
/** `candidate` moved to reported with a report file on disk, as a finished report action leaves it. */
async function asReported(f: Fixture, candidate: Candidate): Promise<Candidate> {
  await mkdir(join(f.directory, 'reports', candidate.id), { recursive: true });
  await writeFile(join(f.directory, 'reports', candidate.id, 'report.md'), REPORT);
  const report = { path: `reports/${candidate.id}/report.md`, sessionId: 'analyst-0', generatedAt: NOW.toISOString(), checks: { requiredSections: true, dshRefsTotal: 1, dshRefsResolved: 1 } };
  return f.store.patch(candidate.id, current => ({ ...transition(current, 'reported', NOW.toISOString()), report }));
}
const find = (response: OpenCodexResponse, id: string) => response.candidates.find(candidate => candidate.id === id);
const exists = (path: string) => stat(path).then(() => true, () => false);
/** A matcher for a RemoteError of `code` whose message matches `message`. */
const remoteError = (code: string, message: RegExp) => (error: unknown) => {
  const remote = remoteErrorOf(error);
  assert.equal(remote?.code, code);
  assert.match(remote.message, message);
  return true;
};

test('the Host registers its Remote descriptor and a first snapshot writes the default settings', async () => {
  const f = await fixture({ settings: null });
  try {
    assert.deepEqual(f.descriptors.map(descriptor => descriptor.id), [OPEN_CODEX_DESCRIPTOR.id]);
    await f.store.setCheckpoint('lastStableTag', 'rust-v0.161.0');
    const response = await f.call({ action: 'snapshot' });
    assert.deepEqual(response.settings, DEFAULT_SETTINGS);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'settings.json'), 'utf8')), DEFAULT_SETTINGS);
    assert.deepEqual(response.checkpoints, { lastStableTag: 'rust-v0.161.0' }, 'checkpoints come from the store');
    assert.deepEqual([response.candidates, response.totalCandidates, response.omittedCandidates], [[], 0, 0]);
    assert.deepEqual(response.busy, { check: false, candidates: {} });
    for (const key of ['lastCheck', 'lastCheckAt', 'indexSummary', 'notice'] as const) assert.equal(response[key], undefined, key);
  } finally { await f.close(); }
});

test('a damaged settings.json stops the plugin from starting and names the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-host-'));
  try {
    await writeFile(join(directory, 'settings.json'), '{ not json');
    await assert.rejects(fixture({ directory, settings: null }), (error: Error) => error.message.includes(join(directory, 'settings.json')));
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, dailyReportLimit: 0 }));
    await assert.rejects(fixture({ directory, settings: null }), /dailyReportLimit/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a check collects the sources, classifies the new candidates and keeps its result as lastCheck', async () => {
  // The model leaves the first candidate of the batch out: that becomes a classify line among the check errors.
  const f = await fixture({ llm: fakeLlm([ids => classifyAll(ids.slice(1))]) });
  try {
    const response = await f.call({ action: 'check' });
    const check = response.lastCheck!;
    assert.deepEqual([check.releases.added, check.files.added], [6, 1]);
    assert.ok(check.rss > 0);
    const total = 6 + 1 + check.rss;
    assert.equal(response.totalCandidates, total);
    assert.ok(response.candidates.every(candidate => candidate.status === 'new'));
    assert.equal(f.llm.requests.length, Math.ceil(total / 30));
    assert.equal(response.candidates.filter(candidate => candidate.classification).length, total - 1);
    assert.deepEqual(check.errors, [`classify: batch 1 of 1: 1 of ${total} candidates were not in the answer`]);
    assert.equal(response.lastCheckAt, NOW.toISOString());
    assert.deepEqual((await f.call({ action: 'snapshot' })).lastCheck, check, 'lastCheck stays for later snapshots');
  } finally { await f.close(); }
});

test('classification runs every batch, saves what it got and reports failed batches, missing candidates and unreadable answers', async () => {
  const llm = fakeLlm([
    () => ({ kind: 'error', failure: { code: 'RATE_LIMITED', message: 'slow down' } }),
    classifyAll,
    () => `抱歉，这批我无法归类。${'理由'.repeat(400)}`,
    ids => classifyAll(ids.slice(1)),
  ]);
  const f = await fixture({ llm });
  try {
    for (let n = 0; n < 31; n++) await seed(f.store, `pr:${50000 + n}`);
    const classified = async () => (await f.call({ action: 'snapshot' })).candidates.filter(candidate => candidate.classification).length;
    // Two batches: the first fails, the second (one candidate) is saved, and the call says what went wrong.
    await assert.rejects(f.call({ action: 'classify' }), /batch 1 of 2 failed, so its 30 candidates stay unclassified: classify: model finished with error RATE_LIMITED: slow down/);
    assert.equal(await classified(), 1);
    // The 30 left: an answer without a JSON array saves nothing and is quoted, the line cut to 300 characters.
    await assert.rejects(f.call({ action: 'classify' }), (error: Error) => {
      const line = error.message.replace(/^归类没有全部完成：/, '');
      assert.match(line, /^batch 1 of 1: the answer held no JSON array, so its 30 candidates stay unclassified; it began: 抱歉，这批我无法归类。/);
      assert.equal(Array.from(line).length, 300);
      return true;
    });
    assert.equal(await classified(), 1);
    await assert.rejects(f.call({ action: 'classify' }), /batch 1 of 1: 1 of 30 candidates were not in the answer/);
    assert.equal(await classified(), 30);
    const last = await f.call({ action: 'classify' });
    assert.equal(last.candidates.filter(candidate => candidate.classification).length, 31);
    assert.equal(llm.requests.length, 5);
    assert.deepEqual([...new Set(last.candidates.map(candidate => candidate.status))], ['new'], 'classification never moves a status');
  } finally { await f.close(); }
});

/** A model finish that broke off on the connection, as DSH's DeepSeek adapter reports it. */
const transport = (failure: Partial<{ status: number; requestId: string }> = {}): Answer =>
  () => ({ kind: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed', ...failure } }) as FinishReason;

test('a classification batch that broke off on the connection is tried again', async () => {
  const llm = fakeLlm([transport(), transport(), classifyAll]);
  const f = await fixture({ llm });
  try {
    await seed(f.store, 'pr:50148');
    // The action rejects on any problem line, so resolving means none.
    const response = await f.call({ action: 'classify' });
    assert.equal(response.candidates.filter(candidate => candidate.classification).length, 1);
    assert.equal(llm.requests.length, 3);
  } finally { await f.close(); }
});

test('a classification failure off the connection is not tried again, and one that keeps failing shows its cause', async () => {
  const llm = fakeLlm([
    () => ({ kind: 'error', failure: { code: 'RATE_LIMITED', message: 'slow down' } }),
    transport({ status: 502, requestId: 'req-7' }), transport({ status: 502, requestId: 'req-7' }), transport({ status: 502, requestId: 'req-7' }),
  ]);
  const f = await fixture({ llm });
  try {
    await seed(f.store, 'pr:50148');
    await assert.rejects(f.call({ action: 'classify' }), /batch 1 of 1 failed, so its 1 candidates stay unclassified: classify: model finished with error RATE_LIMITED: slow down$/);
    assert.equal(llm.requests.length, 1, 'a refusal is not a dropped connection');
    await assert.rejects(f.call({ action: 'classify' }),
      /batch 1 of 1 failed \(3 tries\), so its 1 candidates stay unclassified: classify: model finished with error TRANSPORT: DeepSeek Messages transport failed ← HTTP 502 ← request req-7$/);
    assert.equal(llm.requests.length, 4);
  } finally { await f.close(); }
});

test('the wait before another classification try ends at an unload', async () => {
  const llm = fakeLlm([transport()]);
  const f = await fixture({ llm, classifyRetryDelaysMs: [60_000] });
  try {
    await seed(f.store, 'pr:50148');
    const classifying = f.call({ action: 'classify' });
    await until(() => llm.requests.length === 1, 'the first try');
    const unloading = Date.now();
    await f.unload();
    await assert.rejects(classifying, { name: 'AbortError' });
    assert.ok(Date.now() - unloading < 5_000, 'the minute-long wait did not hold the unload');
  } finally { await f.close(); }
});

test('a check waiting for a running classification gives up at its own deadline, and a failed check is recorded as lastCheck', async () => {
  const f = await fixture({ llm: fakeLlm([() => 'stall']), gh: offlineGh, feed: serve('gone', 404), timeouts: { check: 100 } });
  try {
    await seed(f.store, 'pr:50148');
    const classifying = f.call({ action: 'classify' });
    await until(() => f.llm.requests.length === 1, 'the classification to start');
    await assert.rejects(f.call({ action: 'check' }), /检查超过 0 分钟还没结束，已停止/);
    const after = await f.call({ action: 'snapshot' });
    assert.match(after.lastCheck!.errors[0]!, /^check: 检查超过 0 分钟还没结束，已停止$/);
    assert.equal(after.lastCheckAt, NOW.toISOString());
    assert.equal(after.busy.check, false);
    await f.unload();
    await assert.rejects(classifying, { name: 'AbortError' });
  } finally { await f.close(); }
});

test('the list carries trimmed records, candidate(id) the whole one, and a damaged record is listed with a notice', async () => {
  const f = await fixture();
  try {
    const seeded = await seed(f.store, 'pr:50148', { evidence: [
      { kind: 'pr', ref: '#50148', url: 'https://github.com/openai/codex/pull/50148', excerpt: 'PR 50148\n\nWhat it changes.' },
      { kind: 'file', ref: 'docs/config.md', excerpt: '+ worktrees = true' },
    ] });
    const long = await f.store.patch(seeded.id, current => ({ ...current, summary: 'word '.repeat(200), classification: { category: 'cli-core', relevance: 'high', rationale: '理'.repeat(200) } }));
    const listed = find(await f.call({ action: 'snapshot' }), seeded.id)!;
    assert.deepEqual(listed.evidence, [{ kind: 'pr', ref: '#50148', url: 'https://github.com/openai/codex/pull/50148' }, { kind: 'file', ref: 'docs/config.md' }]);
    assert.ok(Array.from(listed.summary).length <= 300 && listed.summary.endsWith('…'));
    assert.equal(Array.from(listed.classification!.rationale).length, 120);
    const detail = await f.call({ action: 'candidate', id: seeded.id });
    assert.deepEqual(detail.candidate, long);
    await assert.rejects(f.call({ action: 'candidate', id: UNKNOWN_ID }), remoteError('gateway/bad-request', /Unknown candidate/));

    const broken = await seed(f.store, 'pr:51500');
    await writeFile(join(f.directory, 'candidates', `${broken.id}.json`), JSON.stringify({ ...broken, evidence: 'not a list' }));
    const response = await f.call({ action: 'snapshot' });
    assert.deepEqual(find(response, broken.id)!.evidence, []);
    assert.match(response.notice ?? '', new RegExp(`记录有损坏.*${broken.id}`));
  } finally { await f.close(); }
});

/** A candidate file as the sources write them, for the size test: realistic text in each source's shape. */
function realistic(n: number): Candidate {
  const kinds = ['rss', 'desktop', 'codex-release', 'codex-files'] as const;
  const source = kinds[n % kinds.length]!;
  const prose = (length: number) => '新增功能说明 Codex adds a feature to the TUI and the app server. '.repeat(Math.ceil(length / 60)).slice(0, length);
  const evidence: Evidence[] = source === 'rss' ? [{ kind: 'rss', ref: `Codex changelog ${n}`, url: `https://developers.openai.com/codex/changelog#${n}`, excerpt: prose(1_500) }]
    : source === 'desktop' ? Array.from({ length: 25 }, (_, k) => ({ kind: 'i18n' as const, ref: `codex.feature${n}.section.label${k}`, excerpt: prose(80) }))
    : source === 'codex-release' ? [50148, 51500, 51439].map(pr => ({ kind: 'pr' as const, ref: `#${pr}`, url: `https://github.com/openai/codex/pull/${pr}`, excerpt: prose(1_500) }))
    : [{ kind: 'feature-flag', ref: FLAGS, url: `https://github.com/openai/codex/blob/rust-v0.162.0/${FLAGS}`, excerpt: prose(2_000) }];
  const updatedAt = new Date(NOW.getTime() - n * 60_000).toISOString();
  return {
    id: randomUUID(), fingerprint: `${source}:item-${n}`, source, title: `${source} item ${n}: ${prose(80)}`, summary: prose(source === 'desktop' ? 1_000 : 600),
    status: n % 7 === 0 ? 'ignored' : n % 5 === 0 ? 'reported' : 'new', createdAt: updatedAt, updatedAt, evidence,
    window: { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.0' },
    classification: { category: 'cli-core', relevance: 'medium', rationale: prose(120) },
    ...(n % 5 === 0 && { report: { path: 'reports/x/report.md', sessionId: `analyst-${n}`, generatedAt: updatedAt, checks: { requiredSections: true, dshRefsTotal: 4, dshRefsResolved: 3 } } }),
  };
}

/** Writes candidate files straight into the data directory: thousands of upserts would each read the whole store. */
async function writeCandidates(directory: string, candidates: Candidate[]): Promise<void> {
  await mkdir(join(directory, 'candidates'), { recursive: true });
  await Promise.all(candidates.map(candidate => writeFile(join(directory, 'candidates', `${candidate.id}.json`), JSON.stringify(candidate))));
}

test('2,000 realistic candidates list 800 and the answer stays under 4 MB', async () => {
  const f = await fixture();
  try {
    const all = Array.from({ length: 2_000 }, (_, n) => realistic(n));
    const raw = all.reduce((sum, candidate) => sum + JSON.stringify(candidate).length, 0);
    assert.ok(raw > MAX_PAYLOAD, `the records themselves (${raw} characters) would not fit`);
    await writeCandidates(f.directory, all);
    const response = await f.call({ action: 'snapshot' });
    assert.deepEqual([response.candidates.length, response.totalCandidates, response.omittedCandidates], [800, 2_000, 1_200]);
    const active = all.filter(candidate => candidate.status === 'reported'), fresh = all.filter(candidate => candidate.status === 'new');
    assert.deepEqual(response.candidates.map(candidate => candidate.id), [...active, ...fresh].slice(0, 800).map(candidate => candidate.id),
      'reported first, then the newest new ones; ignored ones only when there is room');
    const { result } = OPEN_CODEX_DESCRIPTOR;
    assert.ok(result.mode === 'strict' && result.encode);
    const size = JSON.stringify(result.encode(response, () => null)).length;
    assert.ok(size < MAX_PAYLOAD, `${size} characters`);
    assert.equal(response.notice, undefined);
  } finally { await f.close(); }
});

test('the list keeps every reported and started candidate, and ignored ones go last', async () => {
  const f = await fixture();
  try {
    // The oldest are active and the newest were just ignored: a list of the newest 800 would lose every active one.
    const all = Array.from({ length: 900 }, (_, n): Candidate => ({ ...realistic(n), status: n < 100 ? 'ignored' : n >= 850 ? (n % 2 === 0 ? 'reported' : 'started') : 'new' }));
    await writeCandidates(f.directory, all);
    const response = await f.call({ action: 'snapshot' });
    const active = all.filter(candidate => candidate.status === 'reported' || candidate.status === 'started');
    const fresh = all.filter(candidate => candidate.status === 'new');
    assert.deepEqual([active.length, fresh.length], [50, 750]);
    assert.deepEqual(response.candidates.map(candidate => candidate.id), [...active, ...fresh].map(candidate => candidate.id));
    assert.deepEqual([response.totalCandidates, response.omittedCandidates], [900, 100]);
    assert.ok(response.candidates.every(candidate => candidate.status !== 'ignored'));
  } finally { await f.close(); }
});

test('a finished action is answered as finished when the list cannot be read or would pass 4 MB', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR } });
  try {
    const target = await seed(f.store, 'pr:50148');
    const reported = await asReported(f, await seed(f.store, 'pr:51500'));
    await writeFile(join(f.directory, 'candidates', `${randomUUID()}.json`), '{ damaged');
    const ignored = await f.call({ action: 'ignore', id: target.id });
    assert.deepEqual([ignored.candidates, ignored.totalCandidates], [[], 0]);
    assert.match(ignored.notice ?? '', /^候选列表没能读出来：Corrupt JSON/);
    assert.equal((await f.store.get(target.id)).status, 'ignored', 'the action itself went through');
    const started = await f.call({ action: 'start', id: reported.id });
    assert.equal(started.startedSessionId, 'cordis-1', 'the opened session is not lost');

    await rm(join(f.directory, 'candidates'), { recursive: true });
    const huge = await seed(f.store, 'huge', { evidence: [{ kind: 'file', ref: 'x'.repeat(MAX_PAYLOAD) }] });
    const read = await f.call({ action: 'readReport', id: huge.id });
    assert.deepEqual(read.report, { id: huge.id, markdown: '', notice: '这条候选还没有报告' });
    assert.deepEqual([read.candidates, read.totalCandidates, read.omittedCandidates], [[], 1, 1]);
    assert.match(read.notice ?? '', /候选列表超过 4 MB，这次没有带上/);
  } finally { await f.close(); }
});

test('ignore and restore move the status, and a restored candidate keeps its old report', async () => {
  const f = await fixture();
  try {
    const candidate = await asReported(f, await seed(f.store, 'pr:50148'));
    const ignored = find(await f.call({ action: 'ignore', id: candidate.id }), candidate.id)!;
    assert.equal(ignored.status, 'ignored');
    await assert.rejects(f.call({ action: 'ignore', id: candidate.id }), /已经忽略/);
    await assert.rejects(f.call({ action: 'report', id: candidate.id }), /已忽略/);
    await assert.rejects(f.call({ action: 'start', id: candidate.id }), /已忽略/);
    const restored = find(await f.call({ action: 'restore', id: candidate.id }), candidate.id)!;
    assert.equal(restored.status, 'new');
    assert.deepEqual(restored.report, candidate.report);
    await assert.rejects(f.call({ action: 'restore', id: candidate.id }), /只有已忽略的候选可以恢复/);
  } finally { await f.close(); }
});

test('settings are saved and read back on the next start; a refused request is a bad-request error with a readable reason', async () => {
  const f = await fixture();
  try {
    const response = await f.call({ action: 'settings', patch: { dailyReportLimit: 3, reportModel: { provider: 'p', model: 'm' } } });
    assert.equal(response.settings.dailyReportLimit, 3);
    assert.deepEqual(response.settings.reportModel, { provider: 'p', model: 'm' });
    assert.equal((JSON.parse(await readFile(join(f.directory, 'settings.json'), 'utf8')) as Settings).dailyReportLimit, 3);
    await assert.rejects(f.call({ action: 'settings', patch: { dailyReportLimit: '3' } } as never), remoteError('gateway/bad-request', /^设置项 dailyReportLimit 必须是数字$/));
    await assert.rejects(f.call({ action: 'settings', patch: { bogus: 1 } } as never), remoteError('gateway/bad-request', /^没有这个设置项："bogus"$/));
    await assert.rejects(f.call({ action: 'settings', patch: { dailyReportLimit: 0 } }), remoteError('gateway/bad-request', /^dailyReportLimit must be an integer >= 1$/));
    await assert.rejects(f.call({ action: 'report', id: 'abc' }), remoteError('gateway/bad-request', /^report 需要候选 id（小写 UUID）$/));
    await assert.rejects(f.call({ action: 'scan' } as never), remoteError('gateway/bad-request', /^未知的 OpenCodex 操作："scan"$/));
    assert.equal((JSON.parse(await readFile(join(f.directory, 'settings.json'), 'utf8')) as Settings).dailyReportLimit, 3, 'a refused patch writes nothing');
    await f.unload();
    const next = await fixture({ directory: f.directory, settings: null });
    try { assert.equal((await next.call({ action: 'snapshot' })).settings.dailyReportLimit, 3); } finally { await next.close(); }
  } finally { await f.close(); }
});

test('a new mirror path is indexed right away; a mirror that gives no index leaves the settings saved and says so', async () => {
  const f = await fixture();
  const empty = await mkdtemp(join(tmpdir(), 'oc-empty-mirror-'));
  try {
    const indexed = await f.call({ action: 'settings', patch: { dshMirrorPath: MIRROR } });
    assert.ok(indexed.indexSummary && indexed.indexSummary.entries > 0);
    await assert.rejects(f.call({ action: 'settings', patch: { dshMirrorPath: empty } }), /设置已保存，但用新的镜像路径建 DSH 索引失败：DSH index is empty/);
    const after = await f.call({ action: 'snapshot' });
    assert.equal(after.settings.dshMirrorPath, empty);
    assert.deepEqual(after.indexSummary, indexed.indexSummary, 'the previous index stays in use');
  } finally { await f.close(); await rm(empty, { recursive: true, force: true }); }
});

test('a check builds the index from the mirror path in force when its turn comes, not from the one it started with', async () => {
  const other = await mkdtemp(join(tmpdir(), 'oc-other-mirror-'));
  await cp(MIRROR, other, { recursive: true });
  await mkdir(join(other, 'packages', 'core', 'extra'), { recursive: true });
  await writeFile(join(other, 'packages', 'core', 'extra', 'README.md'), '# @deepseek-ai/dsh-extra\n\n## Summary\n\nOne more package.\n');
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[][] = [];
  const served = codexGh();
  const f = await fixture({ settings: { dshMirrorPath: MIRROR }, gh: async (args, signal) => { calls.push(args); await gate; return served(args, signal); } });
  try {
    const first = await f.call({ action: 'rebuildIndex' });
    const running = f.call({ action: 'check' });
    await until(() => calls.length > 0, 'the check to reach GitHub');
    assert.equal((await f.call({ action: 'snapshot' })).busy.check, true);
    // The mirror path changes while the check waits on GitHub: the change builds the other mirror's index at once.
    const moved = await f.call({ action: 'settings', patch: { dshMirrorPath: other } });
    assert.equal(moved.indexSummary!.entries, first.indexSummary!.entries + 1);
    release();
    const checked = await running;
    assert.equal(checked.lastCheck!.index?.entries, first.indexSummary!.entries + 1, 'the check refreshed the index of the mirror now in the settings');
    assert.equal(checked.indexSummary!.entries, first.indexSummary!.entries + 1);
  } finally { await f.close(); await rm(other, { recursive: true, force: true }); }
});

test('a check that stalls gives up at its deadline, is recorded, and does not hold the next one', async () => {
  let calls = 0;
  const f = await fixture({ gh: (args, signal) => { calls++; return stalledGh(args, signal); }, timeouts: { check: 20 } });
  try {
    await assert.rejects(f.call({ action: 'check' }), /检查超过 0 分钟还没结束，已停止/);
    const first = calls;
    await assert.rejects(f.call({ action: 'check' }), /已停止/);
    assert.ok(calls > first, 'the second check ran on its own instead of joining the stalled one');
    assert.match((await f.call({ action: 'snapshot' })).lastCheck!.errors[0]!, /^check: 检查超过/);
    assert.equal(f.timers.log.at(-1)!.ms, 24 * HOUR, 'a check that gave up still re-arms the timer');
  } finally { await f.close(); }
});

test('parseRequest accepts the listed actions only, with candidate UUIDs and settings of the right shape; the wire codec only wants an object', () => {
  const id = '9b2f3c1e-5d4a-4b6c-8e7f-0a1b2c3d4e5f';
  assert.deepEqual(parseRequest({ action: 'snapshot' }), { action: 'snapshot' });
  assert.deepEqual(parseRequest({ action: 'report', id }), { action: 'report', id });
  assert.deepEqual(parseRequest({ action: 'settings', patch: { checkIntervalHours: 6, classifyModel: { provider: 'p', model: 'm' } } }),
    { action: 'settings', patch: { checkIntervalHours: 6, classifyModel: { provider: 'p', model: 'm' } } });
  const refused: unknown[] = [
    null, [], 'snapshot', {}, { action: 'scan' }, { action: 'toString' }, { action: 'snapshot', id },
    { action: 'report' }, { action: 'report', id: 'abc' }, { action: 'report', id: id.toUpperCase() }, { action: 'report', id: 7 },
    { action: 'start', id: `${id}/../x` }, { action: 'readReport', id, path: '/etc/passwd' },
    { action: 'settings' }, { action: 'settings', patch: [] }, { action: 'settings', patch: { bogus: 1 } }, { action: 'settings', patch: { __proto__: { x: 1 } } },
    { action: 'settings', patch: JSON.parse('{"__proto__":{"dailyReportLimit":1}}') },
    { action: 'settings', patch: { dailyReportLimit: '3' } }, { action: 'settings', patch: { dshMirrorPath: 7 } }, { action: 'settings', patch: { checkIntervalHours: Number.NaN } },
    { action: 'settings', patch: { reportModel: { provider: 'p' } } }, { action: 'settings', patch: { reportModel: { provider: 'p', model: 'm', key: 'x' } } },
    { action: 'settings', patch: { reportModel: 'p/m' } }, { action: 'settings', patch: {}, extra: 1 },
  ];
  for (const value of refused) assert.throws(() => parseRequest(value), ValidationError, JSON.stringify(value));
  const [parameter] = OPEN_CODEX_DESCRIPTOR.parameters;
  assert.ok(parameter?.codec.mode === 'strict');
  const wire = parameter.codec.create();
  assert.deepEqual(wire.parse({ action: 'scan' }), { action: 'scan' }, 'content errors are left to call, whose messages reach the page');
  assert.throws(() => wire.parse('snapshot'), ValidationError);
});

test('the result codec sends plain JSON and refuses more than 4 MB', () => {
  const { result } = OPEN_CODEX_DESCRIPTOR;
  assert.ok(result.mode === 'strict' && result.encode, 'the gateway calls encode on the Host; it never calls the result parse');
  const writeBytes = () => null;
  assert.deepEqual(result.encode({ at: new Date(0), gone: undefined }, writeBytes), { at: '1970-01-01T00:00:00.000Z' });
  assert.throws(() => result.encode!({ text: 'x'.repeat(MAX_PAYLOAD) }, writeBytes), /4 MB/);
});

test('report: refused while one runs and past the daily limit; otherwise it writes the evidence pack and records the report', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR, dailyReportLimit: 2 } });
  try {
    // A pull request reference without a URL is what a failed lookup leaves behind; the report repairs it first.
    const bare = await seed(f.store, 'pr:50148', { title: 'Create a Git worktree for a task', evidence: [{ kind: 'pr', ref: '#50148' }] });
    const rss = await rssItem(f.store);
    const index = await f.call({ action: 'rebuildIndex' });
    assert.ok(index.indexSummary && index.indexSummary.entries > 0);

    f.dsh.hold();
    const running = f.call({ action: 'report', id: bare.id });
    await until(() => f.dsh.prompts.length === 1, 'the analyst prompt');
    await assert.rejects(f.call({ action: 'report', id: bare.id }), /正在生成报告/);
    await assert.rejects(f.call({ action: 'start', id: bare.id }), /正在生成报告/);
    await assert.rejects(f.call({ action: 'ignore', id: bare.id }), /正在生成报告/);
    f.dsh.open();
    const done = find(await running, bare.id)!;

    assert.equal(done.status, 'reported');
    assert.equal(done.report?.path, `reports/${bare.id}/report.md`);
    assert.equal(done.report?.sessionId, 'analyst-1');
    assert.deepEqual(done.report?.checks, { requiredSections: true, dshRefsTotal: 1, dshRefsResolved: 1 });
    const reportDir = join(f.directory, 'reports', bare.id);
    assert.deepEqual(f.dsh.created[0], { cwd: reportDir });
    assert.deepEqual(f.dsh.selected.map(({ provider, model }) => ({ provider, model })), [DEFAULT_SETTINGS.reportModel]);
    assert.deepEqual(f.dsh.defaults, [{ provider: 'deepseek-official', model: 'deepseek-flash' }], 'the user default model is put back');
    assert.deepEqual(f.dsh.policies, ['never'], 'no approval waits for a person');
    assert.equal(await readFile(join(reportDir, 'report.md'), 'utf8'), REPORT);
    const indexMd = await readFile(join(reportDir, 'evidence', 'INDEX.md'), 'utf8');
    assert.ok(indexMd.includes(`DSH 镜像根目录：${MIRROR}`));
    assert.ok((await readdir(join(reportDir, 'evidence', 'sources'))).some(name => name.endsWith('.diff')), 'the pull request diff is in the pack');
    assert.ok((await readdir(join(reportDir, 'evidence', 'dsh'))).length > 0, 'the index hits are in the pack');
    assert.equal(await exists(join(reportDir, 'evidence.prev')), false);
    // The bare reference was repaired on the candidate itself.
    const repaired = (await f.call({ action: 'candidate', id: bare.id })).candidate!;
    assert.deepEqual(repaired.evidence.map(({ kind, ref, url }) => ({ kind, ref, url })), [{ kind: 'pr', ref: '#50148', url: 'https://github.com/openai/codex/pull/50148' }]);
    assert.match(repaired.evidence[0]!.excerpt ?? '', /^PR 50148\n\nWhat 50148 changes\./);
    assert.equal((await f.call({ action: 'snapshot' })).checkpoints[COUNTER], '1');
    assert.deepEqual((await f.call({ action: 'readReport', id: bare.id })).report, { id: bare.id, markdown: REPORT });

    // The second analyst session of the day reaches the limit of two; a third report, even a rerun, is refused before anything is made.
    assert.equal(find(await f.call({ action: 'report', id: rss.id }), rss.id)!.status, 'reported');
    assert.equal((await f.call({ action: 'snapshot' })).checkpoints[COUNTER], '2');
    const sessions = f.dsh.created.length;
    await assert.rejects(f.call({ action: 'report', id: bare.id }), /达到每日上限 2 份/);
    assert.equal(f.dsh.created.length, sessions);
  } finally { await f.close(); }
});

test('reports still running count against the daily limit, and reading a report being generated says so', async () => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[][] = [];
  const served = codexGh();
  const f = await fixture({ settings: { dshMirrorPath: MIRROR, dailyReportLimit: 1 }, gh: async (args, signal) => { calls.push(args); await gate; return served(args, signal); } });
  try {
    const first = await seed(f.store, 'pr:50148', { evidence: [{ kind: 'pr', ref: '#50148' }] });
    const second = await rssItem(f.store);
    f.dsh.hold();
    const running = f.call({ action: 'report', id: first.id });
    // Still at GitHub: admitted, no session yet.
    await until(() => calls.length > 0, 'the GitHub part of the report');
    await assert.rejects(f.call({ action: 'report', id: second.id }), /已有 1 份（含正在生成的），达到每日上限 1 份/);
    release();
    // At its analyst session: counted.
    await until(() => f.dsh.prompts.length === 1, 'the analyst prompt');
    await assert.rejects(f.call({ action: 'report', id: second.id }), /达到每日上限 1 份/);
    const busy = await f.call({ action: 'readReport', id: first.id });
    assert.deepEqual(busy.report, { id: first.id, markdown: '', notice: '报告正在生成，生成完再看' });
    assert.deepEqual(busy.busy, { check: false, candidates: { [first.id]: 'report' } });
    f.dsh.open();
    assert.equal(find(await running, first.id)!.status, 'reported');
    assert.equal(await f.store.checkpoint(COUNTER), '1');
  } finally { await f.close(); }
});

test('a failed report session is named in the error, counts toward the day, and leaves the earlier report and evidence in place', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR } });
  try {
    const candidate = await rssItem(f.store);
    const reportDir = join(f.directory, 'reports', candidate.id);
    await f.call({ action: 'report', id: candidate.id });
    await writeFile(join(reportDir, 'evidence', 'marker.txt'), 'the first pack');
    f.dsh.hooks.activationError = new Error('no agent for the session');
    await assert.rejects(f.call({ action: 'report', id: candidate.id }), /no agent for the session.*analyst-2/);
    assert.equal(await f.store.checkpoint(COUNTER), '2', 'the failed session counts: it may have cost tokens');
    assert.equal(await readFile(join(reportDir, 'evidence', 'marker.txt'), 'utf8'), 'the first pack', 'the earlier evidence is back');
    assert.equal(await exists(join(reportDir, 'evidence.prev')), false);
    assert.equal(await readFile(join(reportDir, 'report.md'), 'utf8'), REPORT);
    const after = await f.store.get(candidate.id);
    assert.deepEqual([after.status, after.report?.sessionId], ['reported', 'analyst-1']);
    // A rerun that succeeds replaces the evidence and drops the backup.
    f.dsh.hooks.activationError = undefined;
    assert.equal(find(await f.call({ action: 'report', id: candidate.id }), candidate.id)!.report?.sessionId, 'analyst-3');
    assert.equal(await exists(join(reportDir, 'evidence', 'marker.txt')), false);
    assert.equal(await exists(join(reportDir, 'evidence.prev')), false);
  } finally { await f.close(); }
});

test('a report whose session was never created gives its daily place back, and a lone evidence backup is left alone', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR, dailyReportLimit: 1 } });
  try {
    const candidate = await rssItem(f.store);
    // A backup without an evidence/ beside it is the only copy left of that pack.
    const backup = join(f.directory, 'reports', candidate.id, 'evidence.prev');
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'marker.txt'), 'the only copy');
    f.dsh.hooks.createError = new Error('unknown agent preset');
    await assert.rejects(f.call({ action: 'report', id: candidate.id }), { name: 'ReportSessionError', message: '报告会话准备失败：unknown agent preset' });
    assert.equal(await f.store.checkpoint(COUNTER), '0', 'the place is given back');
    assert.equal(await readFile(join(backup, 'marker.txt'), 'utf8'), 'the only copy', 'with no evidence/ to set aside, the backup stays');
    f.dsh.hooks.createError = undefined;
    assert.equal(find(await f.call({ action: 'report', id: candidate.id }), candidate.id)!.status, 'reported', 'the one place of the day was free');
    assert.equal(await f.store.checkpoint(COUNTER), '1');
  } finally { await f.close(); }
});

test('the GitHub part of a report gives up at its deadline before any session is made, and does not count', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR }, gh: stalledGh, timeouts: { github: 20 } });
  try {
    const candidate = await seed(f.store, 'pr:50148', { evidence: [{ kind: 'pr', ref: '#50148' }] });
    await assert.rejects(f.call({ action: 'report', id: candidate.id }), /从 GitHub 取证据超过 0 分钟还没结束，已停止/);
    assert.equal(f.dsh.created.length, 0);
    assert.equal(await f.store.checkpoint(COUNTER), undefined);
    assert.equal((await f.store.get(candidate.id)).status, 'new');
    assert.deepEqual((await f.call({ action: 'snapshot' })).busy.candidates, {}, 'the candidate is free again');
  } finally { await f.close(); }
});

test('report and start need the mirror path, and readReport says why a report is missing', async () => {
  const f = await fixture();
  try {
    const candidate = await seed(f.store, 'pr:50148');
    await assert.rejects(f.call({ action: 'report', id: candidate.id }), /dshMirrorPath/);
    assert.deepEqual((await f.call({ action: 'readReport', id: candidate.id })).report, { id: candidate.id, markdown: '', notice: '这条候选还没有报告' });
    await asReported(f, candidate);
    await assert.rejects(f.call({ action: 'start', id: candidate.id }), /dshMirrorPath/);
    assert.equal((await f.call({ action: 'readReport', id: candidate.id })).report?.markdown, REPORT);
    await unlink(join(f.directory, 'reports', candidate.id, 'report.md'));
    assert.deepEqual((await f.call({ action: 'readReport', id: candidate.id })).report, { id: candidate.id, markdown: '', notice: '报告文件不存在，请重新生成' });
    assert.equal(f.dsh.created.length, 0);
  } finally { await f.close(); }
});

test('start opens a creator session for a reported candidate, records it, and refuses while the last one runs', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR } });
  try {
    const fresh = await seed(f.store, 'pr:51500');
    await assert.rejects(f.call({ action: 'start', id: fresh.id }), /先生成报告再开工/);
    const candidate = await asReported(f, await seed(f.store, 'pr:50148'));
    const response = await f.call({ action: 'start', id: candidate.id });
    assert.equal(response.startedSessionId, 'cordis-1');
    const started = find(response, candidate.id)!;
    assert.equal(started.status, 'started');
    assert.deepEqual(started.started, { sessionId: 'cordis-1', at: NOW.toISOString() });
    assert.deepEqual(f.dsh.created, [{ cwd: join(f.directory, 'work', candidate.id), agentPreset: 'cordis' }]);
    const prompt = f.dsh.prompts[0]!.content[0]!;
    assert.ok(prompt.type === 'text' && prompt.text.includes(REPORT), 'the report is the task');

    f.dsh.statuses.set('cordis-1', 'running');
    await assert.rejects(f.call({ action: 'start', id: candidate.id }), /上一个开工会话还在运行（会话 cordis-1）/);
    f.dsh.statuses.set('cordis-1', 'idle');
    const again = await f.call({ action: 'start', id: candidate.id });
    assert.equal(again.startedSessionId, 'cordis-2', 'started -> started opens another session');
    assert.equal(find(again, candidate.id)!.started?.sessionId, 'cordis-2');
    // A report rerun moves the candidate back to reported; its creator session may still be working.
    await f.store.patch(candidate.id, current => transition(current, 'reported', NOW.toISOString()));
    f.dsh.statuses.set('cordis-2', 'running');
    await assert.rejects(f.call({ action: 'start', id: candidate.id }), /上一个开工会话还在运行（会话 cordis-2）/);
  } finally { await f.close(); }
});

test('a start whose record cannot be saved names the session it opened', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR } });
  try {
    const candidate = await asReported(f, await seed(f.store, 'pr:50148'));
    // The candidate file breaks while the creator session takes its task, so the patch that records the session fails.
    f.dsh.hooks.creatorPrompted = () => writeFile(join(f.directory, 'candidates', `${candidate.id}.json`), '{ damaged');
    await assert.rejects(f.call({ action: 'start', id: candidate.id }), /开工会话 cordis-1 已经开始工作，但没能记到候选上：Corrupt JSON/);
  } finally { await f.close(); }
});

test('the timer runs the first check after a short delay, re-arms after each check and after a settings change, and is cleared on unload', async () => {
  const feed = { count: 0 };
  const f = await fixture({ gh: offlineGh, feed: serve('gone', 404, feed) });
  try {
    await f.call({ action: 'snapshot' });
    assert.deepEqual(f.timers.log.map(entry => entry.ms), [60_000], 'no check at construction, one after a minute');
    f.timers.fire();
    const checked = await f.call({ action: 'check' });
    assert.equal(feed.count, 1, 'the requested check joined the one the timer started');
    assert.ok(checked.lastCheck && checked.lastCheck.errors.length > 0);
    assert.deepEqual([...new Set(f.timers.log.slice(1).map(entry => entry.ms))], [24 * HOUR]);
    assert.equal(f.timers.armed.size, 1);
    await f.call({ action: 'settings', patch: { checkIntervalHours: 6 } });
    assert.equal(f.timers.log.at(-1)!.ms, 6 * HOUR, 'the next check is due one new interval after the last one');
    assert.equal(f.timers.armed.size, 1);
    const armed = [...f.timers.armed.keys()];
    await f.unload();
    assert.equal(f.timers.armed.size, 0);
    assert.ok(armed.every(handle => f.timers.cleared.includes(handle)));
    await assert.rejects(f.call({ action: 'snapshot' }), /已卸载/);
  } finally { await f.close(); }
});

test('unloading aborts a running report and leaves the candidate as it was', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR } });
  try {
    const candidate = await rssItem(f.store);
    f.dsh.hold();
    const running = f.call({ action: 'report', id: candidate.id });
    await until(() => f.dsh.prompts.length === 1, 'the analyst prompt');
    await f.unload();
    await assert.rejects(running, /报告会话已中止（会话 analyst-1）/);
    const after = await f.store.get(candidate.id);
    assert.deepEqual([after.status, after.report], ['new', undefined]);
    assert.equal(await exists(join(f.directory, 'reports', candidate.id, 'report.md')), false);
  } finally { await f.close(); }
});
