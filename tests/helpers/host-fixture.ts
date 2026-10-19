/**
 * The Host test bench: an OpenCodex Host loaded as a Cordis plugin over a temporary data directory, with DSH, the model, GitHub, the RSS
 * feed, the timers and the clock replaced by fakes the tests drive (the Host-free ones are in fakes.ts).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type { FinishReason, GenerateOptions, LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionCancelRequest, SessionCreateRequest, SessionPromptRequest, SessionRenameRequest, SessionSelectModelRequest } from '@deepseek-ai/dsh-api-session-controller/types';
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings.ts';
import { CandidateStore } from '../../src/core/store.ts';
import { GitHubClient, type GhRunner } from '../../src/host/github.ts';
import OpenCodex, { type Config, type Dependencies } from '../../src/host/index.ts';
import type { OpenCodexRequest } from '../../src/host/remote.ts';
import { fakeClock, fakeTimers } from './fakes.ts';

export const MIRROR = fileURLToPath(new URL('../fixtures/mirror/', import.meta.url));
const RELEASE = await readFile(new URL('../fixtures/release-0.162.0.md', import.meta.url), 'utf8');
const FEED = await readFile(new URL('../fixtures/changelog-rss-sample.xml', import.meta.url), 'utf8');

/** A report as an analyst session leaves it, citing a file of the fixture mirror. */
export const REPORT = [
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
export const FLAGS = 'codex-rs/features/src/lib.rs';
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
export function codexGh(calls: string[][] = []): GhRunner {
  return async args => {
    calls.push(args);
    return args[0] === 'pr' && args[1] === 'diff' ? DIFF : JSON.stringify(fixtureFor(args));
  };
}
export const offlineGh: GhRunner = async () => { throw Object.assign(new Error('Command failed: gh'), { code: 1, stderr: 'gh: offline' }); };
/** Rejects once `signal` fires. */
const whenAborted = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
/** A gh that answers nothing until the request is aborted. */
export const stalledGh: GhRunner = (_args, signal) => whenAborted(signal!);
/** A fetch that answers every request with `body`, counting the requests. */
export function serve(body: string, status = 200, calls: { count: number } = { count: 0 }): typeof fetch {
  return async () => { calls.count++; return new Response(body, { status }); };
}

/** The ids of the candidate blocks in a classification request. */
function idsOf(request: GenerateOptions): string[] {
  const part = request.messages[0]?.content[0];
  return part?.type === 'text' ? [...part.text.matchAll(/<candidate id="([^"]+)"/g)].map(match => match[1]!) : [];
}
export const classifyAll = (ids: string[]) => JSON.stringify(ids.map(id => ({ id, category: 'cli-core', relevance: 'high', rationale: '测试' })));
export type Answer = (ids: string[]) => string | FinishReason | 'stall';
/** A stand-in for `ctx.llm`: the n-th call answers with `answers[n]` (classify everything when there is none): text, a finish reason, or nothing until the call is aborted. */
export function fakeLlm(answers: Answer[] = []) {
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
export function fakeDsh() {
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

export interface FixtureOptions {
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
  /** Run-once mode; off unless a test turns it on, whatever OPENCODEX_RUN_ONCE is in the environment the tests run in. */
  runOnce?: boolean;
  /** Holds report sessions from the start (`dsh.hold()`), for a Host whose check, and the research after it, run as soon as it starts. */
  holdReports?: boolean;
}
/**
 * An OpenCodex Host loaded as a Cordis plugin (`ctx.plugin`, so `inject` is enforced as in DSH) on a fresh context that provides every
 * injected service as a plain object, over a temporary data directory. Resolves once the plugin has started; a startup error rejects. The
 * Host clock is `clock`, which stands at NOW until a test moves it; the lock's heartbeat runs on `lockTimers`, apart from the check timer.
 */
export async function fixture(options: FixtureOptions = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'oc-host-'));
  if (options.settings !== null) {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, desktopPlistPath: '', ...options.settings }));
  }
  const ctx = new Context();
  const descriptors: InvocationDescriptor[] = [];
  const dsh = fakeDsh();
  if (options.holdReports) dsh.hold();
  const llm = options.llm ?? fakeLlm();
  ctx.provide('typert', { register(contribution: { invocations: InvocationDescriptor[] }) { descriptors.push(...contribution.invocations); return async () => {}; } } as never);
  ctx.provide('sessionController', dsh.sessionController as never);
  ctx.provide('agents', dsh.agents as never);
  ctx.provide('llm', llm as never);
  ctx.provide('agentDefaultModel', dsh.agentDefaultModel as never);
  ctx.provide('approval', dsh.approval as never);
  const timers = fakeTimers();
  const lockTimers = fakeTimers();
  const clock = fakeClock();
  const fiber = ctx.plugin(hostWith({
    github: new GitHubClient({ gh: options.gh ?? codexGh() }), fetcher: options.feed ?? serve(FEED), now: clock.now, timers: timers.timers, lockTimers: lockTimers.timers, reportPollMs: 2,
    classifyRetryDelaysMs: options.classifyRetryDelaysMs ?? [1, 1], runOnce: options.runOnce ?? false, ...(options.timeouts && { timeouts: options.timeouts }),
  }) as never, { dataDirectory: directory } as never);
  const remove = () => rm(directory, { recursive: true, force: true });
  try { await fiber.await(); } catch (error) { await fiber.dispose(); throw error; }
  const plugin = ctx.get('opencodex')!;
  const call = (request: OpenCodexRequest) => plugin.call(request, new AbortController().signal);
  /** Another store on the same directory, for seeding and reading back; use it only while no action runs. */
  const store = new CandidateStore(directory, clock.now);
  let unloaded = false;
  const unload = async () => { if (!unloaded) { unloaded = true; await fiber.dispose(); } };
  const close = async () => { await unload(); if (!options.directory) await remove(); };
  return { plugin, ctx, directory, call, store, dsh, llm, timers, lockTimers, clock, descriptors, unload, close };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
