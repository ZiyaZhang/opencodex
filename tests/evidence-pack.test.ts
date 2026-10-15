import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candidate } from '../src/core/candidate.ts';
import { GitHubError } from '../src/host/github.ts';
import { buildDshIndex, type DshIndex, type IndexEntry } from '../src/host/index/dsh-index.ts';
import { buildEvidencePack, diffsFor, dshHitsFor, queryForCandidate, rankDiffFiles, type DiffFile } from '../src/host/report/evidence-pack.ts';

const mirror = fileURLToPath(new URL('./fixtures/mirror/', import.meta.url));
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

test('queryForCandidate takes title, summary and every evidence ref except pull request numbers', () => {
  const query = queryForCandidate(candidateOf({
    title: 'Quick chat window', summary: 'codex.quickChat.open: 打开快速聊天',
    evidence: [
      { kind: 'pr', ref: '#50148', url: 'https://github.com/openai/codex/pull/50148', excerpt: 'Add quick chat\ncodex-rs/tui/src/quick_chat.rs' },
      { kind: 'i18n', ref: 'codex.quickChat.open', excerpt: '打开快速聊天' },
      { kind: 'doc', ref: 'docs/quick-chat.md', excerpt: 'Quick chat opens with Ctrl+K' },
    ],
  }));
  assert.match(query, /^Quick chat window codex\.quickChat\.open/);
  assert.doesNotMatch(query, /50148/);
  assert.match(query, / codex\.quickChat\.open docs\/quick-chat\.md$/);
  assert.doesNotMatch(query, /\p{Script=Han}/u); // the index is English: Chinese text cannot match and would only take room under the cap
  assert.equal(queryForCandidate(candidateOf({ title: 'Quick chat', summary: 'Quick chat' })), 'Quick chat'); // a release title is its summary
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

test('diffsFor splits each pull request diff into files and reports a pull request whose diff fails', async () => {
  const asked: number[] = [];
  const github = {
    async pullRequestDiff(number: number): Promise<string> {
      asked.push(number);
      if (number === 2) throw new GitHubError('GitHub HTTP 404 for repos/openai/codex/pulls/2: Not Found', 'repos/openai/codex/pulls/2', { status: 404 });
      return QUICK_CHAT_DIFF;
    },
  };
  const errors: string[] = [];
  const candidate = candidateOf({ evidence: [{ kind: 'pr', ref: '#1', excerpt: 'Quick chat' }, { kind: 'pr', ref: '#2' }] });
  const files = await diffsFor(candidate, { github, snapshotDir: '/nonexistent', onError: message => errors.push(message) });
  assert.deepEqual(asked, [1, 2]);
  assert.deepEqual(files.map(f => f.path), ['codex-rs/tui/src/quick_chat.rs', 'docs/config.md']);
  assert.ok(files[0]!.diff.startsWith('diff --git a/codex-rs/tui/src/quick_chat.rs '));
  assert.match(files[0]!.diff, /^\+pub fn open_quick_chat/m);
  assert.match(files[1]!.diff, /^\+quick_chat = true$/m);
  assert.equal(files.map(f => f.diff).join(''), QUICK_CHAT_DIFF); // whole sections: nothing lost, nothing repeated
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /#2.*404/);
});

test('diffsFor names a renamed file by its new path and keeps a path with spaces whole', async () => {
  const diff = [
    'diff --git a/codex-rs/core/src/old_name.rs b/codex-rs/core/src/new_name.rs',
    'similarity index 92%',
    'rename from codex-rs/core/src/old_name.rs',
    'rename to codex-rs/core/src/new_name.rs',
    'index 1111111..2222222 100644',
    '--- a/codex-rs/core/src/old_name.rs',
    '+++ b/codex-rs/core/src/new_name.rs',
    '@@ -1 +1 @@',
    '-old',
    '+new',
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
  assert.deepEqual(files.map(f => f.path), ['codex-rs/core/src/new_name.rs', 'docs/a b/c.md']);
});

const LIB = 'codex-rs/features/src/lib.rs', LEGACY = 'codex-rs/features/src/legacy.rs';
async function writeSnapshot(dir: string, from: string, to: string, files: object[]): Promise<void> {
  await mkdir(join(dir, 'codex-files'), { recursive: true });
  await writeFile(join(dir, 'codex-files', `${from}__${to}.json`), JSON.stringify({ window: { from, to, releases: [to] }, files }));
}
const filesCandidate = (fields: Partial<Candidate>) => candidateOf({
  source: 'codex-files', fingerprint: 'codex-files:feature-flags:0.161', evidence: [LIB, LEGACY, 'codex-rs/features/src/old.rs'].map(ref => ({ kind: 'feature-flag' as const, ref })), ...fields,
});

test('diffsFor gives a codex-files candidate the added lines of its own files and reports a file whose content is unknown', async () => {
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
    assert.deepEqual(await diffsFor(candidate, deps), [{ path: LIB, diff: '+    QuickChat,\n+    ManagedWorktrees,' }]);
    assert.deepEqual(errors, [`unknown content: ${LEGACY}`]); // unread is unknown, not empty
    errors.length = 0;
    assert.deepEqual(await diffsFor(candidate, { ...deps, snapshotDir: join(dir, 'missing') }), []); // no snapshot directory yet
    assert.deepEqual(errors, []);
  });
});

test('diffsFor merges the snapshots of every window in the candidate range in version order, each line once', async () => {
  await withTempDir(async dir => {
    await writeSnapshot(dir, 'rust-v0.161.1', 'rust-v0.161.2', [{ path: LIB, status: 'modified', added: ['Before,'] }]); // ends where the candidate starts
    await writeSnapshot(dir, 'rust-v0.161.2', 'rust-v0.161.9', [
      { path: LIB, status: 'modified', added: ['A,', 'B,'] },
      { path: LEGACY, status: 'modified', added: [], error: 'GitHub HTTP 500' },
    ]);
    await writeSnapshot(dir, 'rust-v0.161.9', 'rust-v0.161.10', [{ path: LIB, status: 'modified', added: ['B,', 'C,'] }, { path: LEGACY, status: 'modified', added: ['L,'] }]);
    await writeSnapshot(dir, 'rust-v0.161.10', 'rust-v0.162.0', [{ path: LIB, status: 'modified', added: ['Next,'] }]);
    await writeFile(join(dir, 'codex-files', 'notes.json'), '{}'); // not a snapshot name
    const errors: string[] = [];
    const deps = { github: offline, snapshotDir: dir, onError: (message: string) => errors.push(message) };
    // 0.161.10 sorts before 0.161.9 as text; by version it is the later window.
    const candidate = filesCandidate({ window: { fromTag: 'rust-v0.161.2', toTag: 'rust-v0.161.10' } });
    assert.deepEqual(await diffsFor(candidate, deps), [{ path: LIB, diff: '+A,\n+B,\n+C,' }, { path: LEGACY, diff: '+L,' }]);
    assert.deepEqual(errors, [`unknown content: ${LEGACY}`]);
    // Without a window the fingerprint's minor version picks the snapshots: every window that ends in 0.161.
    errors.length = 0;
    assert.deepEqual(await diffsFor({ ...candidate, window: undefined }, deps), [{ path: LIB, diff: '+Before,\n+A,\n+B,\n+C,' }, { path: LEGACY, diff: '+L,' }]);
    assert.deepEqual(errors, [`unknown content: ${LEGACY}`]);
  });
});

test('diffsFor gives desktop and RSS candidates no diff', async () => {
  for (const source of ['desktop', 'rss'] as const) {
    assert.deepEqual(await diffsFor(candidateOf({ source, evidence: [{ kind: 'i18n', ref: 'codex.quickChat.open' }] }), { github: offline, snapshotDir: '/nonexistent' }), []);
  }
});

test('buildEvidencePack names each note status, keeps colliding evidence names apart and writes private files', async () => {
  await withTempDir(async dir => {
    const candidate = candidateOf({ source: 'desktop', title: '桌面端新文案组 quickChat', evidence: [
      { kind: 'i18n', ref: 'quick/chat', excerpt: '快速聊天' },
      { kind: 'i18n', ref: 'quick-chat', excerpt: '快速聊天窗口' },
      { kind: 'i18n', ref: 'Quick-Chat' },
    ] });
    const proposed = '.agents/notes/proposed/2026-09-10-quick-chat.md', implemented = '.agents/notes/implemented/feature/2026-01-01-sample.md';
    const config = '@deepseek-ai/dsh-experimental-worktree';
    const root = await buildEvidencePack({ directory: dir, candidate, diffs: [], mirror: '/srv/deepseek-harness', dshHits: [
      { kind: 'note', id: proposed, title: 'Quick chat', path: proposed, text: 'A proposal.' },
      { kind: 'note', id: implemented, title: 'Sample decision record', path: implemented, text: 'Done.' },
      { kind: 'config', id: config, title: config, path: 'docs/config-catalog.md', text: 'Where retained checkouts are created.' },
    ] });
    assert.equal(root, join(dir, 'evidence'));
    assert.deepEqual((await readdir(join(root, 'sources'))).sort(), ['i18n-Quick-Chat-3.md', 'i18n-quick-chat-2.md', 'i18n-quick-chat.md']);
    assert.match(await readFile(join(root, 'sources', 'i18n-quick-chat-2.md'), 'utf8'), /快速聊天窗口/);
    assert.match(await readFile(join(root, 'dsh', '01-agents-notes-proposed-2026-09-10-quick-chat.md'), 'utf8'), /状态：proposed（DSH 尚未实现）/);
    assert.match(await readFile(join(root, 'dsh', '02-agents-notes-implemented-feature-2026-01-01-sample.md'), 'utf8'), /状态：implemented（DSH 已有）/);
    assert.match(await readFile(join(root, 'dsh', '03-docs-config-catalog-deepseek-ai-dsh-experimental-worktree.md'), 'utf8'), /docs\/config-catalog\.md/);
    const index = await readFile(join(root, 'INDEX.md'), 'utf8');
    assert.match(index, /DSH 镜像根目录：\/srv\/deepseek-harness/);
    assert.ok(index.includes(`\n- dsh/01-agents-notes-proposed-2026-09-10-quick-chat.md ← ${proposed}\u3000状态：proposed（DSH 尚未实现）\n`), index);
    assert.ok(index.includes(`\n- dsh/02-agents-notes-implemented-feature-2026-01-01-sample.md ← ${implemented}\u3000状态：implemented（DSH 已有）\n`), index);
    assert.ok(index.includes(`\n- dsh/03-docs-config-catalog-deepseek-ai-dsh-experimental-worktree.md ← docs/config-catalog.md\u3000条目：${config}\n`), index);
    for (const name of ['i18n-quick-chat.md', 'i18n-quick-chat-2.md', 'i18n-Quick-Chat-3.md']) assert.ok(index.includes(`\n- sources/${name} ← `), name);
    for (const path of ['.', 'sources', 'dsh']) assert.equal((await stat(join(root, path))).mode & 0o777, 0o700, path);
    for (const path of ['INDEX.md', 'candidate.json', 'sources/i18n-quick-chat.md', 'dsh/01-agents-notes-proposed-2026-09-10-quick-chat.md']) assert.equal((await stat(join(root, path))).mode & 0o777, 0o600, path);
  });
});

test('a diff larger than the whole budget is dropped whole and listed under 未读文件', async () => {
  const huge: DiffFile = { path: 'codex-rs/core/src/huge.rs', diff: `+${'x'.repeat(60_000)}` };
  const small: DiffFile = { path: 'codex-rs/core/src/small.rs', diff: '+y' };
  const testFile: DiffFile = { path: 'codex-rs/core/tests/suite/quick_chat.rs', diff: '+t' };
  const { kept, dropped } = rankDiffFiles([huge, small], 60_000);
  assert.deepEqual(kept, [small]);
  assert.deepEqual(dropped, [huge]); // whole: a diff is never cut to fit
  await withTempDir(async dir => {
    const excerpt = 'Add quick chat\ncodex-rs/core/src/huge.rs\ncodex-rs/core/src/small.rs';
    const candidate = candidateOf({ evidence: [{ kind: 'pr', ref: '#50148', url: 'https://github.com/openai/codex/pull/50148', excerpt }] });
    const gaps = ['no diff for #50150: GitHub HTTP 404 for repos/openai/codex/pulls/50150: Not Found'];
    const root = await buildEvidencePack({ directory: dir, candidate, diffs: [huge, small, testFile], dshHits: [], gaps });
    assert.deepEqual((await readdir(join(root, 'sources'))).sort(), ['diff-codex-rs-core-src-small.rs.diff', 'pr-50148.md']);
    assert.ok((await readFile(join(root, 'sources', 'pr-50148.md'), 'utf8')).includes(excerpt)); // the title and file list as they are
    assert.equal(await readFile(join(root, 'sources', 'diff-codex-rs-core-src-small.rs.diff'), 'utf8'), '+y');
    const index = await readFile(join(root, 'INDEX.md'), 'utf8');
    assert.ok(index.includes(`\n## 没取到的内容\n\n- ${gaps[0]}\n`), index);
    const [listed = '', unread = ''] = index.split('\n## 未读文件');
    assert.match(unread, /^- codex-rs\/core\/src\/huge\.rs（/m);
    assert.match(unread, /^- codex-rs\/core\/tests\/suite\/quick_chat\.rs（/m);
    assert.doesNotMatch(listed, /huge|suite/);
  });
});

test('buildEvidencePack rebuilds the directory from scratch on a rerun', async () => {
  await withTempDir(async dir => {
    const first = candidateOf({ evidence: [{ kind: 'pr', ref: '#1' }] });
    await buildEvidencePack({ directory: dir, candidate: first, diffs: [{ path: 'a.rs', diff: '+a' }], dshHits: [{ kind: 'package', id: 'packages/g/x', title: 'X', path: 'packages/g/x/README.md', text: 'x' }] });
    const root = await buildEvidencePack({ directory: dir, candidate: { ...first, evidence: [{ kind: 'pr', ref: '#2' }] }, diffs: [], dshHits: [] });
    assert.deepEqual(await readdir(join(root, 'sources')), ['pr-2.md']);
    assert.deepEqual(await readdir(join(root, 'dsh')), []);
    const index = await readFile(join(root, 'INDEX.md'), 'utf8');
    assert.doesNotMatch(index, /pr-1|a\.rs|packages\/g\/x/);
    assert.match(index, /索引没有命中/);
  });
});
