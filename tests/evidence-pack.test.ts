import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candidate, Evidence } from '../src/core/candidate.ts';
import { ValidationError } from '../src/core/check.ts';
import { GitHubError } from '../src/host/github.ts';
import { buildDshIndex, searchIndex, type DshIndex, type IndexEntry } from '../src/host/index/dsh-index.ts';
import { buildEvidencePack, diffsFor, dshHitsFor, queryForCandidate, rankDiffFiles, type DiffFile } from '../src/host/report/evidence-pack.ts';

const mirror = fileURLToPath(new URL('./fixtures/mirror/', import.meta.url));
const GAP = String.fromCharCode(0x3000);
const candidateOf = (fields: Partial<Candidate>): Candidate => ({
  id: 'c', fingerprint: 'codex-release:x', source: 'codex-release', title: 'T', summary: 'S', status: 'new',
  createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', evidence: [], ...fields,
});
/** A GitHub client that must not be asked: only release candidates fetch diffs. */
const offline = { pullRequestDiff: async (): Promise<string> => { throw new Error('unexpected GitHub request'); } };
async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'oc-pack-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
/** One `diff --git` section that adds `lines` to `path`. */
const section = (path: string, ...lines: string[]) =>
  [`diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`, `@@ -1 +1,${lines.length + 1} @@`, ' context', ...lines.map(line => `+${line}`), ''].join('\n');
/** The `- ` lines of one INDEX.md section, up to the next heading. */
function listOf(index: string, heading: string): string[] {
  const start = index.indexOf(`\n${heading}\n`);
  if (start < 0) return [];
  const body = index.slice(start + heading.length + 2);
  const end = body.search(/^## /m);
  return (end < 0 ? body : body.slice(0, end)).split('\n').filter(line => line.startsWith('- '));
}

test('rankDiffFiles prefers source over tests and caps total size', () => {
  const files = [{ path: 'codex-rs/tui/src/app/tests/x.rs', diff: 'a'.repeat(50_000) }, { path: 'codex-rs/tui/src/managed_worktree_tools.rs', diff: 'b'.repeat(40_000) }, { path: 'docs/config.md', diff: 'c'.repeat(30_000) }];
  const { kept, dropped } = rankDiffFiles(files, 60_000);
  assert.deepEqual(kept.map(f => f.path), ['codex-rs/tui/src/managed_worktree_tools.rs']);
  assert.equal(dropped.length, 2);
});

test('buildEvidencePack writes INDEX.md, sources and dsh hits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-pack-'));
  try {
    const candidate = { id: 'c', fingerprint: 'codex-release:pr:1', source: 'codex-release', title: 'T', summary: 'S', status: 'new', createdAt: '', updatedAt: '', evidence: [{ kind: 'pr', ref: '#1', url: 'https://github.com/openai/codex/pull/1', excerpt: 'PR body' }] };
    await buildEvidencePack({ directory: dir, candidate: candidate as never, diffs: [{ path: 'a.rs', diff: '+x' }], dshHits: [{ kind: 'package', id: 'p', title: 'P', path: 'packages/x/README.md', text: 'summary' }] });
    const index = await readFile(join(dir, 'evidence', 'INDEX.md'), 'utf8');
    assert.match(index, /sources\/pr-1\.md/);
    assert.match(index, /dsh\/01-packages-x-README\.md ←/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rankDiffFiles passes over a file that does not fit and keeps trying, smaller files first within a weight', () => {
  const file = (path: string, size: number): DiffFile => ({ path, diff: 'x'.repeat(size) });
  const { kept, dropped } = rankDiffFiles([file('a.rs', 50), file('b.rs', 30), file('c.rs', 80), file('d.md', 15), file('e.md', 40)], 100);
  assert.deepEqual(kept.map(f => f.path), ['b.rs', 'a.rs', 'd.md']); // c.rs does not fit after b.rs and a.rs; d.md still does
  assert.deepEqual(dropped.map(f => f.path), ['c.rs', 'e.md']);
});

test('rankDiffFiles never keeps tests: test directories, Rust test modules, __tests__, spec files and snapshots', () => {
  const tests = [
    'codex-rs/tui/src/app/tests.rs', 'codex-rs/core/src/exec_test.rs', 'codex-rs/core/src/exec_tests.rs', 'codex-rs/core/tests/suite/exec.rs',
    'codex-cli/src/__tests__/cli.ts', 'sdk/typescript/src/thread.spec.ts', 'sdk/typescript/src/thread.test.ts',
    'codex-rs/tui/src/snapshots/codex_tui__app.snap', 'codex-rs/tui/src/chat.snap',
  ];
  const sources = ['codex-rs/tui/src/managed_worktree_tools.rs', 'codex-rs/core/src/contests.rs'];
  const { kept, dropped } = rankDiffFiles([...tests, ...sources].map(path => ({ path, diff: '+x' })), 1_000);
  assert.deepEqual(kept.map(f => f.path), sources);
  assert.deepEqual(dropped.map(f => f.path), tests);
  // PRs #50434 and #50209 change the sibling test module app/tests.rs: it must not take the place of the source next to it.
  assert.deepEqual(rankDiffFiles([{ path: tests[0]!, diff: 'a'.repeat(10) }, { path: sources[0]!, diff: 'b'.repeat(20) }], 25).kept.map(f => f.path), [sources[0]]);
});

test('rankDiffFiles cuts a line list that does not fit at a line boundary, and drops it when not even its first line fits', () => {
  const list: DiffFile = { path: 'codex-rs/features/src/lib.rs', diff: ['+one', '+two', '+three'].join('\n') };
  const { kept, cut, dropped } = rankDiffFiles([list], 10, { cutLines: true });
  assert.deepEqual(kept, [{ ...list, diff: '+one\n+two' }]);
  assert.deepEqual(cut, [list]);
  assert.deepEqual(dropped, []);
  assert.deepEqual(rankDiffFiles([list], 3, { cutLines: true }).dropped, [list]);
  assert.deepEqual(rankDiffFiles([list], 10).dropped, [list]); // a diff is never cut
});

test('queryForCandidate takes title, summary and every evidence ref except pull request numbers', () => {
  const query = queryForCandidate(candidateOf({
    title: 'Quick chat window', summary: 'codex.quickChat.open: 打开快速聊天',
    evidence: [
      { kind: 'pr', ref: '#50148', url: 'https://github.com/openai/codex/pull/50148', excerpt: 'Add quick chat\ncodex-rs/tui/src/quick_chat.rs' },
      { kind: 'i18n', ref: 'codex.quickChat.open', excerpt: '打开快速聊天' },
      { kind: 'doc', ref: 'docs/quick-chat.md', excerpt: 'Quick chat opens with Ctrl+K' },
    ],
  }));
  assert.equal(query, 'Quick chat window quickChat.open: quickChat.open docs/quick-chat.md'); // no #50148, no Chinese the English index cannot match
  assert.equal(queryForCandidate(candidateOf({ title: 'Quick chat', summary: 'Quick chat' })), 'Quick chat'); // a release title is its summary
});

test('queryForCandidate leaves out the word codex, so the DSH hits follow the feature and not the Codex adapters', async () => {
  const query = queryForCandidate(candidateOf({
    title: 'Codex adds managed worktrees', summary: 'CodexThread and openCodexApp keep CODEX_HOME in codex_core',
    evidence: [{ kind: 'i18n', ref: 'codex.quickChat.open' }, { kind: 'doc', ref: 'codex-rs/tui/src/managed_worktree_tools.rs' }],
  }));
  assert.equal(query, 'adds managed worktrees Thread and openApp keep _HOME in _core quickChat.open tui/src/managed_worktree_tools.rs');
  const index = await buildDshIndex(mirror);
  assert.equal(searchIndex(index, 'Codex adds managed worktrees', 1, 'package')[0]?.path, 'packages/subagent/subagent-codex/README.md'); // what the word did
  assert.equal(dshHitsFor(index, candidateOf({ title: 'Codex adds managed worktrees' }))[0]?.path, 'packages/experimental/worktree/README.md');
});

test('queryForCandidate stops at 2,000 characters on a word boundary', () => {
  const query = queryForCandidate(candidateOf({ summary: 'worktree '.repeat(400) }));
  assert.ok(query.length <= 2_000, String(query.length));
  assert.match(query, /^T( worktree)+$/);
});

test('dshHitsFor on the fixture mirror takes at most 3 packages, 2 config entries and 2 notes, in that order, each once', async () => {
  const index = await buildDshIndex(mirror);
  const hits = dshHitsFor(index, candidateOf({
    title: 'Codex subagent in its own git worktree', summary: 'Worktree config and agent loop limits, as the sample decision record describes.',
    evidence: [{ kind: 'pr', ref: '#7' }, { kind: 'doc', ref: 'docs/worktree.md' }],
  }));
  const order = ['package', 'config', 'note'];
  const kinds = hits.map(hit => hit.kind);
  for (const [kind, limit] of [['package', 3], ['config', 2], ['note', 2]] as const) {
    const count = kinds.filter(k => k === kind).length;
    assert.ok(count >= 1 && count <= limit, `${kind}: ${count}`);
  }
  assert.deepEqual(kinds, [...kinds].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  assert.equal(new Set(hits.map(hit => `${hit.kind} ${hit.id}`)).size, hits.length);
});

test('dshHitsFor fills each quota with distinct entries even when the index holds one twice', () => {
  const entry = (kind: IndexEntry['kind'], id: string, path: string): IndexEntry => ({ kind, id, title: `Worktree ${id}`, path, text: 'worktree' });
  const index: DshIndex = { version: 1, builtAt: '2026-10-15T00:00:00.000Z', commit: 'unknown', mirror: '/mirror', entries: [
    ...[1, 2, 3, 4, 5].map(n => entry('package', `packages/g/p${n}`, `packages/g/p${n}/README.md`)),
    ...['@s/a', '@s/a', '@s/b', '@s/c'].map(id => entry('config', id, 'docs/config-catalog.md')),
    ...[1, 2, 3].map(n => entry('note', `.agents/notes/proposed/n${n}.md`, `.agents/notes/proposed/n${n}.md`)),
  ] };
  assert.deepEqual(dshHitsFor(index, candidateOf({ title: 'worktree' })).map(hit => `${hit.kind} ${hit.id}`), [
    'package packages/g/p1', 'package packages/g/p2', 'package packages/g/p3',
    'config @s/a', 'config @s/b',
    'note .agents/notes/proposed/n1.md', 'note .agents/notes/proposed/n2.md',
  ]);
});

const QUICK_CHAT_DIFF = [
  'diff --git a/codex-rs/tui/src/quick_chat.rs b/codex-rs/tui/src/quick_chat.rs',
  'new file mode 100644',
  'index 0000000..1a2b3c4',
  '--- /dev/null',
  '+++ b/codex-rs/tui/src/quick_chat.rs',
  '@@ -0,0 +1,2 @@',
  '+pub fn open_quick_chat() {}',
  '+// see diff --git a/x b/x in the docs',
  'diff --git a/docs/config.md b/docs/config.md',
  'index 5d6e7f8..9a0b1c2 100644',
  '--- a/docs/config.md',
  '+++ b/docs/config.md',
  '@@ -1 +1,2 @@',
  ' # Config',
  '+quick_chat = true',
  '',
].join('\n');

test('diffsFor splits each pull request diff into files tagged with the pull request, asks each once and reports one that fails', async () => {
  const asked: number[] = [];
  const github = {
    async pullRequestDiff(number: number): Promise<string> {
      asked.push(number);
      if (number === 2) throw new GitHubError('GitHub HTTP 404 for repos/openai/codex/pulls/2: Not Found', 'repos/openai/codex/pulls/2', { status: 404 });
      return QUICK_CHAT_DIFF;
    },
  };
  const errors: string[] = [];
  const candidate = candidateOf({ evidence: [{ kind: 'pr', ref: '#1', excerpt: 'Quick chat' }, { kind: 'pr', ref: '#2' }, { kind: 'pr', ref: '#1' }] });
  const files = await diffsFor(candidate, { github, snapshotDir: '/nonexistent', onError: message => errors.push(message) });
  assert.deepEqual(asked, [1, 2]);
  assert.deepEqual(files.map(f => [f.path, f.source]), [['codex-rs/tui/src/quick_chat.rs', '#1'], ['docs/config.md', '#1']]);
  assert.ok(files[0]!.diff.startsWith('diff --git a/codex-rs/tui/src/quick_chat.rs '));
  assert.match(files[0]!.diff, /^\+pub fn open_quick_chat/m);
  assert.match(files[1]!.diff, /^\+quick_chat = true$/m);
  assert.equal(files.map(f => f.diff).join(''), QUICK_CHAT_DIFF); // whole sections: nothing lost, nothing repeated
  assert.deepEqual(errors, ['no diff for #2: GitHub HTTP 404 for repos/openai/codex/pulls/2: Not Found']);
});

test('diffsFor reports a pull request whose answer holds no diff', async () => {
  const errors: string[] = [];
  const files = await diffsFor(candidateOf({ evidence: [{ kind: 'pr', ref: '#5' }] }), { github: { pullRequestDiff: async () => '' }, snapshotDir: '/nonexistent', onError: message => errors.push(message) });
  assert.deepEqual(files, []);
  assert.deepEqual(errors, ['no diff for #5: the response holds no "diff --git" header']);
});

test('diffsFor asks no more pull requests after a rate limit and reports each one left', async () => {
  const asked: number[] = [];
  const github = {
    async pullRequestDiff(number: number): Promise<string> {
      asked.push(number);
      if (number === 2) throw new GitHubError('GitHub HTTP 403 for repos/openai/codex/pulls/2: API rate limit exceeded', 'repos/openai/codex/pulls/2', { status: 403, rateLimited: true });
      return section(`docs/${number}.md`, 'x');
    },
  };
  const errors: string[] = [];
  const candidate = candidateOf({ evidence: [1, 2, 3, 4].map(n => ({ kind: 'pr' as const, ref: `#${n}` })) });
  const files = await diffsFor(candidate, { github, snapshotDir: '/nonexistent', onError: message => errors.push(message) });
  assert.deepEqual(asked, [1, 2]);
  assert.deepEqual(files.map(f => f.path), ['docs/1.md']);
  assert.deepEqual(errors, [
    'no diff for #2: GitHub HTTP 403 for repos/openai/codex/pulls/2: API rate limit exceeded',
    'no diff for #3: not asked after the GitHub rate limit',
    'no diff for #4: not asked after the GitHub rate limit',
  ]);
});

test('diffsFor rethrows an abort instead of reporting it', async () => {
  const controller = new AbortController();
  const errors: string[] = [];
  const github = {
    async pullRequestDiff(_number: number, signal?: AbortSignal): Promise<string> {
      controller.abort();
      signal?.throwIfAborted();
      return '';
    },
  };
  const candidate = candidateOf({ evidence: [{ kind: 'pr', ref: '#1' }, { kind: 'pr', ref: '#2' }] });
  await assert.rejects(diffsFor(candidate, { github, snapshotDir: '/nonexistent', onError: message => errors.push(message) }, controller.signal), { name: 'AbortError' });
  assert.deepEqual(errors, []);
});

test('diffsFor takes a renamed file from its rename line and reads git-quoted paths', async () => {
  const diff = [
    'diff --git a/docs/a b/x.md b/docs/new.md', // the old path holds " b/", so the header alone splits wrong
    'similarity index 90%',
    'rename from docs/a b/x.md',
    'rename to docs/new.md',
    'diff --git "a/docs/\\344\\270\\255.md" "b/docs/\\344\\270\\255.md"',
    'index 1111111..2222222 100644',
    '--- "a/docs/\\344\\270\\255.md"',
    '+++ "b/docs/\\344\\270\\255.md"',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git "a/docs/\\346\\226\\207.md" b/docs/plain.md',
    'similarity index 100%',
    'rename from "docs/\\346\\226\\207.md"',
    'rename to docs/plain.md',
    'diff --git a/docs/plain.md "b/docs/\\346\\226\\207 \\"2\\".md"',
    'similarity index 100%',
    'rename from docs/plain.md',
    'rename to "docs/\\346\\226\\207 \\"2\\".md"',
    'diff --git a/docs/a b/c.md b/docs/a b/c.md',
    'index 3333333..4444444 100644',
    '--- a/docs/a b/c.md',
    '+++ b/docs/a b/c.md',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    '',
  ].join('\n');
  const files = await diffsFor(candidateOf({ evidence: [{ kind: 'pr', ref: '#3' }] }), { github: { pullRequestDiff: async () => diff }, snapshotDir: '/nonexistent' });
  assert.deepEqual(files.map(f => f.path), ['docs/new.md', 'docs/中.md', 'docs/plain.md', 'docs/文 "2".md', 'docs/a b/c.md']);
});

const LIB = 'codex-rs/features/src/lib.rs', LEGACY = 'codex-rs/features/src/legacy.rs', CONFIGS = 'codex-rs/features/src/feature_configs.rs';
async function writeSnapshot(dir: string, from: string, to: string, files: object[]): Promise<void> {
  await mkdir(join(dir, 'codex-files'), { recursive: true });
  await writeFile(join(dir, 'codex-files', `${from}__${to}.json`), JSON.stringify({ window: { from, to, releases: [to] }, files }));
}
const filesCandidate = (fields: Partial<Candidate>) => candidateOf({
  source: 'codex-files', fingerprint: 'codex-files:feature-flags:0.161', evidence: [LIB, LEGACY, 'codex-rs/features/src/old.rs'].map(ref => ({ kind: 'feature-flag' as const, ref })), ...fields,
});

test('diffsFor gives a codex-files candidate the added lines of its own files, tagged with their window, and reports what it could not read', async () => {
  await withTempDir(async dir => {
    await writeSnapshot(dir, 'rust-v0.160.0', 'rust-v0.161.0', [
      { path: LIB, status: 'modified', added: ['    QuickChat,', '    ManagedWorktrees,'] },
      { path: LEGACY, status: 'modified', added: [], error: 'GitHub HTTP 500 for repos/openai/codex/contents/codex-rs/features/src/legacy.rs' },
      { path: 'codex-rs/features/src/old.rs', status: 'removed', added: [] },
      { path: 'docs/config.md', status: 'modified', added: ['quick_chat = true'] }, // the doc candidate of the same window, not this one
    ]);
    const candidate = filesCandidate({ window: { fromTag: 'rust-v0.160.0', toTag: 'rust-v0.161.0' } });
    const errors: string[] = [];
    const deps = { github: offline, snapshotDir: dir, onError: (message: string) => errors.push(message) };
    assert.deepEqual(await diffsFor(candidate, deps), [{ path: LIB, diff: '+    QuickChat,\n+    ManagedWorktrees,', source: 'rust-v0.160.0__rust-v0.161.0' }]);
    // unread is unknown, not empty: the reason goes with it
    assert.deepEqual(errors, [`unknown content: ${LEGACY} in rust-v0.160.0__rust-v0.161.0: GitHub HTTP 500 for repos/openai/codex/contents/codex-rs/features/src/legacy.rs`]);
    errors.length = 0;
    assert.deepEqual(await diffsFor(candidate, { ...deps, snapshotDir: join(dir, 'missing') }), []);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /^no added lines for c: no snapshot directory /);
  });
});

test('diffsFor merges the snapshots of the windows in the candidate range by version, not by name, each line once', async () => {
  await withTempDir(async dir => {
    await writeSnapshot(dir, 'rust-v0.161.8', 'rust-v0.161.9', [{ path: LIB, status: 'modified', added: ['Before,'] }]); // ends where the candidate starts
    await writeSnapshot(dir, 'rust-v0.161.9', 'rust-v0.161.10', [
      { path: LIB, status: 'modified', added: ['A,', 'B,'] },
      { path: LEGACY, status: 'modified', added: [], error: 'GitHub HTTP 500' },
    ]);
    await writeSnapshot(dir, 'rust-v0.161.10', 'rust-v0.161.11', [{ path: LIB, status: 'modified', added: ['B,', 'C,'] }, { path: LEGACY, status: 'modified', added: ['L,'] }]);
    await writeSnapshot(dir, 'rust-v0.161.11', 'rust-v0.162.0', [{ path: LIB, status: 'modified', added: ['Next,'] }]);
    await writeFile(join(dir, 'codex-files', 'notes.json'), '{}'); // not a snapshot name
    assert.ok('rust-v0.161.10__rust-v0.161.11.json' < 'rust-v0.161.9__rust-v0.161.10.json'); // by name the later window comes first
    const errors: string[] = [];
    const deps = { github: offline, snapshotDir: dir, onError: (message: string) => errors.push(message) };
    const candidate = filesCandidate({ window: { fromTag: 'rust-v0.161.9', toTag: 'rust-v0.161.11' } });
    assert.deepEqual(await diffsFor(candidate, deps), [
      { path: LIB, diff: '+A,\n+B,\n+C,', source: 'rust-v0.161.9__rust-v0.161.11' },
      { path: LEGACY, diff: '+L,', source: 'rust-v0.161.10__rust-v0.161.11' },
    ]);
    assert.deepEqual(errors, [`unknown content: ${LEGACY} in rust-v0.161.9__rust-v0.161.10: GitHub HTTP 500`]);
    // Without a window the version that ends the fingerprint picks: a minor every window ending in it, a full version the one window ending at it.
    const linesOf = (files: DiffFile[]) => files.map(f => [f.path, f.diff]);
    assert.deepEqual(linesOf(await diffsFor({ ...candidate, window: undefined }, deps)), [[LIB, '+Before,\n+A,\n+B,\n+C,'], [LEGACY, '+L,']]);
    assert.deepEqual(linesOf(await diffsFor({ ...candidate, window: undefined, fingerprint: 'codex-files:feature-flags:0.161.11' }, deps)), [[LIB, '+B,\n+C,'], [LEGACY, '+L,']]);
  });
});

test('diffsFor reports a damaged snapshot, a candidate it cannot place and a range no snapshot covers', async () => {
  await withTempDir(async dir => {
    await writeSnapshot(dir, 'rust-v0.160.0', 'rust-v0.161.0', [{ path: LIB, status: 'modified', added: ['A,'] }]);
    await writeFile(join(dir, 'codex-files', 'rust-v0.161.0__rust-v0.161.1.json'), '{ not json');
    const errors: string[] = [];
    const deps = { github: offline, snapshotDir: dir, onError: (message: string) => errors.push(message) };
    assert.deepEqual((await diffsFor(filesCandidate({ window: { fromTag: 'rust-v0.160.0', toTag: 'rust-v0.161.1' } }), deps)).map(f => f.path), [LIB]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /^damaged codex-files snapshot rust-v0\.161\.0__rust-v0\.161\.1\.json: /);
    errors.length = 0;
    assert.deepEqual(await diffsFor(filesCandidate({ fingerprint: 'codex-files:feature-flags' }), deps), []);
    assert.deepEqual(await diffsFor(filesCandidate({ window: { fromTag: 'rust-v0.162.0', toTag: 'rust-v0.162.1' } }), deps), []);
    assert.equal(errors.length, 2);
    assert.match(errors[0]!, /^no added lines for c: it has neither a tag window nor a version/);
    assert.match(errors[1]!, /^no added lines for c: no snapshot of the windows after rust-v0\.162\.0 up to rust-v0\.162\.1$/);
  });
});

test('diffsFor gives a feature-flag candidate of each file only the lines of its evidence excerpt, not every line the file gained', async () => {
  await withTempDir(async dir => {
    // The window added two flags to each file, and the snapshot keeps the lines of both.
    await writeSnapshot(dir, 'rust-v0.162.1', 'rust-v0.163.0', [
      { path: CONFIGS, status: 'modified', added: ['    /// Mask credentials.', '    pub credential_masking: Option<bool>,', '    /// Hide native tools.', '    pub disable_native_tools: Option<bool>,'] },
      { path: LIB, status: 'modified', added: ['        key: "credential_masking",', '        key: "code_mode_host_grpc",', '        stage: Stage::UnderDevelopment,', '        default_enabled: false,', '        stage: Stage::Stable,'] },
    ]);
    // A patch release that gave this flag no line: it does not go into the tag.
    await writeSnapshot(dir, 'rust-v0.163.0', 'rust-v0.163.1', [{ path: LIB, status: 'modified', added: ['        key: "output_token_replay",'] }]);
    const candidate = filesCandidate({
      fingerprint: 'codex-files:feature-flag:credential_masking:0.163', window: { fromTag: 'rust-v0.162.1', toTag: 'rust-v0.163.1' },
      evidence: [
        { kind: 'feature-flag', ref: CONFIGS, excerpt: '    /// Mask credentials.\n    pub credential_masking: Option<bool>,' },
        { kind: 'feature-flag', ref: LIB, excerpt: '        key: "credential_masking",\n        stage: Stage::UnderDevelopment,\n        default_enabled: false,' },
      ],
    });
    const deps = { github: offline, snapshotDir: dir };
    assert.deepEqual(await diffsFor(candidate, deps), [
      { path: CONFIGS, diff: '+    /// Mask credentials.\n+    pub credential_masking: Option<bool>,', source: 'rust-v0.162.1__rust-v0.163.0' },
      { path: LIB, diff: '+        key: "credential_masking",\n+        stage: Stage::UnderDevelopment,\n+        default_enabled: false,', source: 'rust-v0.162.1__rust-v0.163.0' },
    ]);
    // The registry candidate keeps every line its files gained.
    assert.deepEqual((await diffsFor({ ...candidate, fingerprint: 'codex-files:feature-flags:0.163' }, deps)).map(f => [f.path, f.diff.split('\n').length, f.source]), [
      [CONFIGS, 4, 'rust-v0.162.1__rust-v0.163.0'], [LIB, 6, 'rust-v0.162.1__rust-v0.163.1'],
    ]);
  });
});

test('diffsFor gives desktop and RSS candidates no diff', async () => {
  for (const source of ['desktop', 'rss'] as const) {
    assert.deepEqual(await diffsFor(candidateOf({ source, evidence: [{ kind: 'i18n', ref: 'codex.quickChat.open' }] }), { github: offline, snapshotDir: '/nonexistent' }), []);
  }
});

test('buildEvidencePack names each note status, keeps colliding evidence names apart and writes private files', async () => {
  await withTempDir(async dir => {
    const candidate = candidateOf({ source: 'rss', title: 'Quick chat', evidence: [
      { kind: 'rss', ref: '2026-10-01 Quick/chat', excerpt: '2026-10-01\nQuick chat arrives.' },
      { kind: 'rss', ref: '2026-10-01 Quick chat', excerpt: '2026-10-01\nQuick chat window.' },
      { kind: 'rss', ref: '2026-10-01 quick-chat' },
    ] });
    const proposed = '.agents/notes/proposed/2026-09-10-quick-chat.md', implemented = '.agents/notes/implemented/feature/2026-01-01-sample.md';
    const config = '@deepseek-ai/dsh-experimental-worktree';
    const root = await buildEvidencePack({ directory: dir, candidate, diffs: [], mirror: '/srv/deepseek-harness', dshHits: [
      { kind: 'note', id: proposed, title: 'Quick chat', path: proposed, text: 'A proposal.' },
      { kind: 'note', id: implemented, title: 'Sample decision record', path: implemented, text: 'Done.' },
      { kind: 'config', id: config, title: config, path: 'docs/config-catalog.md', text: 'Where retained checkouts are created.' },
    ] });
    assert.equal(root, join(dir, 'evidence'));
    // The default macOS file system ignores case, so Quick-chat and quick-chat are one name there.
    assert.deepEqual((await readdir(join(root, 'sources'))).sort(), ['rss-2026-10-01-Quick-chat-2.md', 'rss-2026-10-01-Quick-chat.md', 'rss-2026-10-01-quick-chat-3.md']);
    assert.match(await readFile(join(root, 'sources', 'rss-2026-10-01-Quick-chat-2.md'), 'utf8'), /Quick chat window\./);
    assert.match(await readFile(join(root, 'dsh', '01-agents-notes-proposed-2026-09-10-quick-chat.md'), 'utf8'), /状态：proposed（DSH 尚未实现）/);
    assert.match(await readFile(join(root, 'dsh', '02-agents-notes-implemented-feature-2026-01-01-sample.md'), 'utf8'), /状态：implemented（DSH 已有）/);
    assert.match(await readFile(join(root, 'dsh', '03-docs-config-catalog-deepseek-ai-dsh-experimental-worktree.md'), 'utf8'), /docs\/config-catalog\.md/);
    const index = await readFile(join(root, 'INDEX.md'), 'utf8');
    assert.match(index, /DSH 镜像根目录：\/srv\/deepseek-harness/);
    assert.deepEqual(listOf(index, '## dsh/（官方镜像索引命中，路径相对镜像根目录）'), [
      `- dsh/01-agents-notes-proposed-2026-09-10-quick-chat.md ← ${proposed}${GAP}状态：proposed（DSH 尚未实现）`,
      `- dsh/02-agents-notes-implemented-feature-2026-01-01-sample.md ← ${implemented}${GAP}状态：implemented（DSH 已有）`,
      `- dsh/03-docs-config-catalog-deepseek-ai-dsh-experimental-worktree.md ← docs/config-catalog.md${GAP}条目：${config}`,
    ]);
    for (const name of ['rss-2026-10-01-Quick-chat.md', 'rss-2026-10-01-Quick-chat-2.md', 'rss-2026-10-01-quick-chat-3.md']) assert.ok(index.includes(`\n- sources/${name} ← `), name);
    for (const path of ['.', 'sources', 'dsh']) assert.equal((await stat(join(root, path))).mode & 0o777, 0o700, path);
    for (const path of ['INDEX.md', 'candidate.json', 'sources/rss-2026-10-01-Quick-chat.md', 'dsh/01-agents-notes-proposed-2026-09-10-quick-chat.md']) {
      assert.equal((await stat(join(root, path))).mode & 0o777, 0o600, path);
    }
  });
});

test('buildEvidencePack writes codex-files line lists as added-*.txt under 新增行, points the evidence at them and cuts one that does not fit', async () => {
  await withTempDir(async dir => {
    const evidence: Evidence[] = [
      { kind: 'feature-flag', ref: LIB, url: 'https://github.com/openai/codex/compare/rust-v0.161.9...rust-v0.161.11', excerpt: '    QuickChat,' },
      { kind: 'feature-flag', ref: LEGACY, excerpt: '（内容未读取：GitHub HTTP 500）' },
    ];
    const lib: DiffFile = { path: LIB, diff: ['+    QuickChat,', '+    ManagedWorktrees,', '+    Overflow,'].join('\n'), source: 'rust-v0.161.9__rust-v0.161.11' };
    const root = await buildEvidencePack({ directory: dir, candidate: filesCandidate({ evidence }), diffs: [lib], dshHits: [], budget: 40 });
    const added = 'added-0.161.9__0.161.11-codex-rs-features-src-lib.rs.txt';
    assert.deepEqual((await readdir(join(root, 'sources'))).sort(), [added, 'feature-flag-codex-rs-features-src-legacy.rs.md', 'feature-flag-codex-rs-features-src-lib.rs.md']);
    const text = await readFile(join(root, 'sources', added), 'utf8');
    assert.equal(text.split('\n')[0], `# ${LIB}${GAP}rust-v0.161.9 → rust-v0.161.11 新增的行`);
    assert.match(text, /只放了前 2 行，共 3 行/);
    assert.ok(text.includes('\n+    QuickChat,\n+    ManagedWorktrees,\n') && !text.includes('Overflow'), text); // cut at a line boundary
    const libEvidence = await readFile(join(root, 'sources', 'feature-flag-codex-rs-features-src-lib.rs.md'), 'utf8');
    assert.ok(libEvidence.includes(`sources/${added}`), libEvidence);
    assert.doesNotMatch(libEvidence, /QuickChat/); // the lines are in the .txt, not repeated
    assert.match(await readFile(join(root, 'sources', 'feature-flag-codex-rs-features-src-legacy.rs.md'), 'utf8'), /内容未读取/);
    const index = await readFile(join(root, 'INDEX.md'), 'utf8');
    assert.deepEqual(listOf(index, '## 新增行（sources/，不是 diff）'), [`- sources/${added} ← ${LIB}（rust-v0.161.9 → rust-v0.161.11，只放了前 2 行，共 3 行）`]);
    assert.deepEqual(listOf(index, '## 未读文件'), []);
  });
});

test('buildEvidencePack says that the lines of a feature-flag candidate are that flag\'s alone', async () => {
  await withTempDir(async dir => {
    const excerpt = '    /// Mask credentials before they reach the model.\n        key: "credential_masking",';
    const evidence: Evidence[] = [{ kind: 'feature-flag', ref: LIB, excerpt }, { kind: 'feature-flag', ref: CONFIGS, excerpt: '    pub credential_masking: Option<bool>,' }];
    const candidate = filesCandidate({ fingerprint: 'codex-files:feature-flag:credential_masking:0.163', title: 'credential_masking', evidence });
    const lib: DiffFile = { path: LIB, diff: excerpt.split('\n').map(line => `+${line}`).join('\n'), source: 'rust-v0.162.1__rust-v0.163.0' };
    const added = 'added-0.162.1__0.163.0-codex-rs-features-src-lib.rs.txt';
    const page = (root: string, ref: string) => readFile(join(root, 'sources', `feature-flag-${ref.replace(/\//g, '-')}.md`), 'utf8');
    const root = await buildEvidencePack({ directory: join(dir, 'flag'), candidate, diffs: [lib], dshHits: [] });
    assert.ok((await page(root, LIB)).includes(`新增行在 sources/${added}，只含这个开关的行，这里不重复。`));
    assert.ok((await readFile(join(root, 'sources', added), 'utf8')).includes('\n不是 diff：没有上下文，也没有删掉的行。只含这个开关的行，文件别的新增行不在这里。\n'));
    // A file without a list of its own shows the excerpt, as the flag's lines.
    assert.ok((await page(root, CONFIGS)).includes('这个开关的行：\n\n    pub credential_masking: Option<bool>,'));
    // The registry candidate's lines are the file's, as before.
    const registry = await buildEvidencePack({ directory: join(dir, 'registry'), candidate: { ...candidate, fingerprint: 'codex-files:feature-flags:0.163' }, diffs: [lib], dshHits: [] });
    assert.ok((await page(registry, LIB)).includes(`新增行在 sources/${added}，这里不重复。`));
    assert.doesNotMatch(await readFile(join(registry, 'sources', added), 'utf8'), /开关/);
    assert.ok((await page(registry, CONFIGS)).includes('新增行：\n\n    pub credential_masking: Option<bool>,'));
  });
});

test('a diff larger than the whole budget is dropped whole and listed under 未读文件, test files only counted', async () => {
  const huge: DiffFile = { path: 'codex-rs/core/src/huge.rs', diff: `+${'x'.repeat(60_000)}`, source: '#50148' };
  const small: DiffFile = { path: 'codex-rs/core/src/small.rs', diff: '+y', source: '#50148' };
  const tests: DiffFile[] = ['codex-rs/core/tests/suite/quick_chat.rs', 'codex-rs/tui/src/app/tests.rs'].map(path => ({ path, diff: '+t', source: '#50148' }));
  const { kept, dropped } = rankDiffFiles([huge, small], 60_000);
  assert.deepEqual(kept, [small]);
  assert.deepEqual(dropped, [huge]); // whole: a diff is never cut to fit
  await withTempDir(async dir => {
    const excerpt = 'Add quick chat\n\nOpens a quick chat window.\n\ncodex-rs/core/src/huge.rs\ncodex-rs/core/src/small.rs';
    const candidate = candidateOf({ evidence: [{ kind: 'pr', ref: '#50148', url: 'https://github.com/openai/codex/pull/50148', excerpt }] });
    const gaps = ['no diff for #50150: GitHub HTTP 404 for repos/openai/codex/pulls/50150: Not Found'];
    const root = await buildEvidencePack({ directory: dir, candidate, diffs: [huge, small, ...tests], dshHits: [], gaps });
    assert.deepEqual((await readdir(join(root, 'sources'))).sort(), ['diff-50148-codex-rs-core-src-small.rs.diff', 'pr-50148.md']);
    const pr = await readFile(join(root, 'sources', 'pr-50148.md'), 'utf8');
    assert.ok(pr.includes(excerpt) && pr.includes('PR 标题、正文摘要和改动文件清单'), pr); // title, body summary and file list as they are
    assert.equal(await readFile(join(root, 'sources', 'diff-50148-codex-rs-core-src-small.rs.diff'), 'utf8'), '+y');
    const index = await readFile(join(root, 'INDEX.md'), 'utf8');
    assert.match(index, /本文件里的路径都相对 `evidence\/` 目录/);
    assert.deepEqual(listOf(index, '## diff（sources/）'), ['- sources/diff-50148-codex-rs-core-src-small.rs.diff ← codex-rs/core/src/small.rs（#50148）']);
    assert.deepEqual(listOf(index, '## 未读文件'), ['- codex-rs/core/src/huge.rs（#50148）', '- 测试文件 2 个未读']);
    assert.deepEqual(listOf(index, '## 没取到的内容'), [`- ${gaps[0]}`]);
  });
});

test('buildEvidencePack applies the budget it is given and keeps the end of a long path in the file name', async () => {
  await withTempDir(async dir => {
    const long = 'codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParamsWithAVeryLongGeneratedTypeName.ts';
    const root = await buildEvidencePack({ directory: dir, candidate: candidateOf({}), dshHits: [], budget: 10, diffs: [
      { path: long, diff: '+short', source: '#7' },
      { path: 'codex-rs/core/src/eleven.rs', diff: '+0123456789', source: '#7' },
    ] });
    const names = await readdir(join(root, 'sources'));
    assert.equal(names.length, 1);
    assert.match(names[0]!, /^diff-7-.*-v2-ThreadStartParamsWithAVeryLongGeneratedTypeName\.ts\.diff$/);
    assert.deepEqual(listOf(await readFile(join(root, 'INDEX.md'), 'utf8'), '## 未读文件'), ['- codex-rs/core/src/eleven.rs（#7）']);
  });
});

test('INDEX.md stays under 8,000 characters for a 619-key i18n candidate and a 280-file pull request', async () => {
  await withTempDir(async dir => {
    const keys = Array.from({ length: 619 }, (_, i): Evidence => ({ kind: 'i18n', ref: `codex.app.quickChat.key${i}`, excerpt: `快速聊天文案 ${i}` }));
    const strings = candidateOf({ source: 'desktop', fingerprint: 'desktop:i18n:codex.app.quickChat:26.1009.1', title: '桌面端新文案组 codex.app.quickChat', evidence: keys });
    const root = await buildEvidencePack({ directory: join(dir, 'i18n'), candidate: strings, diffs: [], dshHits: [] });
    assert.deepEqual(await readdir(join(root, 'sources')), ['i18n-codex.app.quickChat.md']);
    const text = await readFile(join(root, 'sources', 'i18n-codex.app.quickChat.md'), 'utf8');
    assert.equal(text.split('\n').filter(line => line.startsWith('codex.app.quickChat.')).length, 619);
    assert.match(text, /^codex\.app\.quickChat\.key0: 快速聊天文案 0$/m);
    const index = await readFile(join(root, 'INDEX.md'), 'utf8');
    assert.ok(index.length < 8_000, String(index.length));
    assert.deepEqual(listOf(index, '## 证据（sources/）'), ['- sources/i18n-codex.app.quickChat.md ← 619 个 i18n key']);

    const paths = [
      ...Array.from({ length: 200 }, (_, i) => `codex-rs/app-server/src/handlers/thread_start_handler_${i}.rs`),
      ...Array.from({ length: 50 }, (_, i) => `codex-rs/app-server/tests/suite/v2/thread_start_${i}.rs`),
      ...Array.from({ length: 30 }, (_, i) => `docs/guides/thread-start-${i}.md`),
    ];
    const diff = paths.map(path => section(path, 'x'.repeat(600))).join('');
    const pr = candidateOf({ evidence: [{ kind: 'pr', ref: '#50434', excerpt: `Thread start\n\nBody.\n\n${paths.slice(0, 20).join('\n')}\n…另有 260 个文件` }] });
    const diffs = await diffsFor(pr, { github: { pullRequestDiff: async () => diff }, snapshotDir: '/nonexistent' });
    assert.equal(diffs.length, 280);
    const prRoot = await buildEvidencePack({ directory: join(dir, 'pr'), candidate: pr, diffs, dshHits: [] });
    const prIndex = await readFile(join(prRoot, 'INDEX.md'), 'utf8');
    assert.ok(prIndex.length < 8_000, String(prIndex.length));
    for (const heading of ['## diff（sources/）', '## 未读文件']) {
      const lines = listOf(prIndex, heading);
      assert.ok(lines.filter(line => !line.startsWith('- 其余') && !line.startsWith('- 测试文件')).length <= 40, heading);
      assert.ok(lines.some(line => /^- 其余 \d+ 个/.test(line)), heading);
    }
    assert.ok(listOf(prIndex, '## 未读文件').includes('- 测试文件 50 个未读'));
    assert.ok(listOf(prIndex, '## 未读文件').some(line => /^- 其余 \d+ 个（完整清单见 unread\.txt）$/.test(line)));
    const sources = await readdir(join(prRoot, 'sources'));
    assert.ok(sources.length > 40); // every kept diff is there; INDEX.md lists some
    const unread = (await readFile(join(prRoot, 'unread.txt'), 'utf8')).split('\n');
    const kept = sources.filter(name => name.startsWith('diff-')).length;
    assert.equal(unread.filter(line => /^(codex-rs|docs)\//.test(line)).length, 280 - kept); // every file left out, tests included
    assert.ok(unread.includes('codex-rs/app-server/tests/suite/v2/thread_start_0.rs（#50434）'));
  });
});

test('buildEvidencePack gives at most 40 evidence entries a file each and puts the rest in more-evidence.md', async () => {
  await withTempDir(async dir => {
    const types = Array.from({ length: 100 }, (_, i) => `codex-rs/app-server-protocol/schema/typescript/v2/Type${i}.ts`);
    const evidence = types.map((ref): Evidence => ({ kind: 'schema', ref, excerpt: `export type ${ref.split('/').at(-1)} = {};` }));
    const diffs = types.slice(0, 50).map((path): DiffFile => ({ path, diff: '+export type T = { field: string };', source: 'rust-v0.160.0__rust-v0.161.0' }));
    const root = await buildEvidencePack({ directory: dir, candidate: filesCandidate({ fingerprint: 'codex-files:schema:0.161', evidence }), diffs, dshHits: [] });
    const names = await readdir(join(root, 'sources'));
    assert.equal(names.filter(name => name.startsWith('schema-')).length, 40);
    assert.equal(names.filter(name => name.startsWith('added-')).length, 50);
    assert.ok(names.includes('more-evidence.md'));
    const more = await readFile(join(root, 'sources', 'more-evidence.md'), 'utf8');
    assert.equal(more.split('\n').filter(line => line.startsWith('## schema ')).length, 60);
    assert.ok(more.includes('export type Type70.ts = {};')); // no .txt of its own: the excerpt stays
    assert.ok(!more.includes('export type Type45.ts = {};')); // its lines are in a .txt
    const index = await readFile(join(root, 'INDEX.md'), 'utf8');
    assert.ok(index.length < 8_000, String(index.length));
    for (const heading of ['## 证据（sources/）', '## 新增行（sources/，不是 diff）']) {
      assert.ok(listOf(index, heading).filter(line => !line.startsWith('- 其余')).length <= 40, heading);
    }
    assert.ok(listOf(index, '## 证据（sources/）').some(line => /^- 其余 \d+ 个（完整清单见 candidate\.json）$/.test(line)));
  });
});

test('buildEvidencePack replaces an earlier pack whole, and a failure midway leaves the earlier pack and no temp directory', async () => {
  await withTempDir(async dir => {
    const first = candidateOf({ evidence: [{ kind: 'pr', ref: '#1' }] });
    await buildEvidencePack({ directory: dir, candidate: first, diffs: [{ path: 'a.rs', diff: '+a' }], dshHits: [{ kind: 'package', id: 'packages/g/x', title: 'X', path: 'packages/g/x/README.md', text: 'x' }] });
    const root = await buildEvidencePack({ directory: dir, candidate: { ...first, evidence: [{ kind: 'pr', ref: '#2' }] }, diffs: [], dshHits: [] });
    assert.deepEqual(await readdir(join(root, 'sources')), ['pr-2.md']);
    assert.deepEqual(await readdir(join(root, 'dsh')), []);
    const index = await readFile(join(root, 'INDEX.md'), 'utf8');
    assert.doesNotMatch(index, /pr-1|a\.rs|packages\/g\/x/);
    assert.match(index, /索引没有命中/);
    const broken = { kind: 'package', id: 'p', title: 'P', path: 'packages/p/README.md', get text(): string { throw new Error('index entry unreadable'); } } as IndexEntry;
    await assert.rejects(buildEvidencePack({ directory: dir, candidate: first, diffs: [], dshHits: [broken] }), /index entry unreadable/);
    assert.equal(await readFile(join(root, 'INDEX.md'), 'utf8'), index);
    assert.deepEqual(await readdir(dir), ['evidence']);
  });
});

test('buildEvidencePack wants an absolute directory and a positive whole budget', async () => {
  const input = { candidate: candidateOf({}), diffs: [], dshHits: [] };
  await withTempDir(async dir => {
    // A relative path that leads into the temp directory, so that a broken check cannot write into the working directory.
    await assert.rejects(buildEvidencePack({ ...input, directory: relative(process.cwd(), join(dir, 'c')) }), ValidationError);
    for (const budget of [0, -1, 1.5, Number.NaN]) await assert.rejects(buildEvidencePack({ ...input, directory: dir, budget }), ValidationError, String(budget));
    assert.deepEqual(await readdir(dir), []); // nothing was written
  });
});

test('a damaged evidence kind can neither leave sources/ nor add a section to INDEX.md', async () => {
  await withTempDir(async dir => {
    const directory = join(dir, 'a', 'b', 'c', 'd'); // deep enough that a ../../../../ that got through would still land inside the temp directory
    const evidence = [
      { kind: '../../../../escaped', ref: 'x', excerpt: 'payload' },
      { kind: 'pr\n\n## 没取到的内容\n\n- fake gap', ref: '#1' },
      { kind: 'constructor', ref: 'y', excerpt: 'plain' },
    ] as unknown as Evidence[];
    const root = await buildEvidencePack({ directory, candidate: candidateOf({ evidence }), diffs: [], dshHits: [] });
    const outside = (await readdir(dir, { recursive: true })).map(String).filter(path => !path.startsWith(join('a', 'b', 'c', 'd', 'evidence')));
    assert.deepEqual(outside.sort(), [join('a'), join('a', 'b'), join('a', 'b', 'c'), join('a', 'b', 'c', 'd')]);
    assert.deepEqual((await readdir(join(root, 'sources'))).sort(), ['constructor-y.md', 'escaped-x.md', 'pr-fake-gap-1.md']);
    const index = await readFile(join(root, 'INDEX.md'), 'utf8');
    assert.ok(!index.split('\n').includes('## 没取到的内容'), index);
    assert.ok(index.includes('\n- sources/escaped-x.md ← ../../../../escaped x\n'), index);
    assert.ok(index.includes('\n- sources/pr-fake-gap-1.md ← pr ## 没取到的内容 - fake gap #1\n'), index);
    assert.match(await readFile(join(root, 'sources', 'constructor-y.md'), 'utf8'), /^# constructor y\n\n摘录：\n\nplain\n$/); // an unknown kind gets the plain label, not a property of Object
  });
});

test('buildEvidencePack removes the temp directory a killed build left behind, and nothing else', async () => {
  await withTempDir(async dir => {
    const stale = join(dir, `evidence.${randomUUID()}.tmp`);
    await mkdir(join(stale, 'sources'), { recursive: true });
    await writeFile(join(stale, 'sources', 'half.md'), 'half');
    await writeFile(join(dir, 'report.md'), '# report');
    await mkdir(join(dir, 'evidence.notes.tmp')); // not a name a build gives its temp directory
    await buildEvidencePack({ directory: dir, candidate: candidateOf({}), diffs: [], dshHits: [] });
    assert.deepEqual((await readdir(dir)).sort(), ['evidence', 'evidence.notes.tmp', 'report.md']);
  });
});

test('INDEX.md points to gaps.txt for a list it cannot hold, and the file is written only then', async () => {
  await withTempDir(async dir => {
    const gaps = Array.from({ length: 100 }, (_, i) => `unknown content: codex-rs/app-server-protocol/schema/typescript/v2/Type${i}.ts in rust-v0.160.0__rust-v0.161.0: 已达 GitHub 速率限制`);
    const root = await buildEvidencePack({ directory: join(dir, 'many'), candidate: candidateOf({}), diffs: [], dshHits: [], gaps });
    const lines = listOf(await readFile(join(root, 'INDEX.md'), 'utf8'), '## 没取到的内容');
    assert.ok(lines.length <= 41, String(lines.length));
    assert.match(lines.at(-1)!, /^- 其余 \d+ 条（完整清单见 gaps\.txt）$/);
    assert.deepEqual((await readFile(join(root, 'gaps.txt'), 'utf8')).split('\n').filter(line => line.startsWith('unknown content: ')), gaps);
    const few = await buildEvidencePack({ directory: join(dir, 'few'), candidate: candidateOf({}), diffs: [], dshHits: [], gaps: gaps.slice(0, 2) });
    assert.deepEqual((await readdir(few)).sort(), ['INDEX.md', 'candidate.json', 'dsh', 'sources']);
  });
});

test('buildEvidencePack puts every chunk of a desktop candidate in chunks.md', async () => {
  await withTempDir(async dir => {
    const candidate = candidateOf({ source: 'desktop', fingerprint: 'desktop:chunk:webview/assets/quick-chat:26.1009.1', title: '桌面端新模块 quick-chat', evidence: [
      { kind: 'chunk', ref: 'webview/assets/quick-chat', excerpt: 'webview/assets/quick-chat-3f2a91.js' },
      { kind: 'chunk', ref: 'webview/assets/quick-chat-panel', excerpt: 'webview/assets/quick-chat-panel-9c1d07.js\nwebview/assets/quick-chat-panel-9c1d07.css' },
    ] });
    const root = await buildEvidencePack({ directory: dir, candidate, diffs: [], dshHits: [] });
    assert.deepEqual(await readdir(join(root, 'sources')), ['chunks.md']);
    const text = await readFile(join(root, 'sources', 'chunks.md'), 'utf8');
    assert.ok(text.includes('\n## webview/assets/quick-chat\n\nwebview/assets/quick-chat-3f2a91.js\n'), text);
    assert.ok(text.includes('\n## webview/assets/quick-chat-panel\n\nwebview/assets/quick-chat-panel-9c1d07.js\nwebview/assets/quick-chat-panel-9c1d07.css\n'), text);
    assert.deepEqual(listOf(await readFile(join(root, 'INDEX.md'), 'utf8'), '## 证据（sources/）'), ['- sources/chunks.md ← 2 个桌面端模块']);
  });
});

test('INDEX.md cuts a list line at 300 characters and the title at 200, and keeps the whole line in gaps.txt', async () => {
  await withTempDir(async dir => {
    const title = 'Quick chat '.repeat(25);
    const gap = `unknown content: ${'codex-rs/very/deep/'.repeat(30)}lib.rs in rust-v0.160.0__rust-v0.161.0: GitHub HTTP 500`;
    const root = await buildEvidencePack({ directory: dir, candidate: candidateOf({ title }), diffs: [], dshHits: [], gaps: [gap] });
    const index = await readFile(join(root, 'INDEX.md'), 'utf8');
    assert.ok(index.split('\n').includes(`候选：${title.trim().slice(0, 199)}…`), index);
    const [line, pointer] = listOf(index, '## 没取到的内容');
    assert.equal(line!.length, 300);
    assert.ok(line!.startsWith('- unknown content: codex-rs/very/deep/') && line!.endsWith('…'), line);
    assert.equal(pointer, '- 有的条目太长，截断了，完整内容见 gaps.txt');
    assert.ok((await readFile(join(root, 'gaps.txt'), 'utf8')).split('\n').includes(gap));
  });
});
