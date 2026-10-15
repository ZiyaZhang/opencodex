import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candidate } from '../src/core/candidate.ts';
import { CandidateStore } from '../src/core/store.ts';
import type { GitHubClient } from '../src/host/github.ts';
import type { StableWindow } from '../src/host/sources/codex-releases.ts';
import { addedLines, changedWatched, collectFileChanges, groupWatchedFiles, WATCHED, type ChangedFile } from '../src/host/sources/codex-files.ts';

test('WATCHED matches the four path families only', () => {
  for (const p of ['codex-rs/features/src/lib.rs', 'codex-rs/app-server-protocol/schema/typescript/TurnStartParams.ts', 'docs/config.md', 'codex-rs/config.md']) assert.ok(WATCHED(p), p);
  for (const p of ['codex-rs/core/src/x.rs', 'docs/images/a.png', 'docs/sub/dir.md', 'codex-rs/features/src/tests.rs', 'codex-rs/features/Cargo.toml']) assert.ok(!WATCHED(p), p);
});

test('WATCHED is anchored: look-alike paths are not watched, only Rust sources of the features crate are', () => {
  for (const p of ['xcodex-rs/features/src/a.rs', 'codex-rs/featuresx/src/a.rs', 'codex-rs/features/src/a.rs.orig', 'codex-rs/features/src/README.md', 'codex-rs/app-server-protocol/schema/json/A.json', 'docs/config.json', 'docs/a.md/b', 'codex-rs/config.md.bak', 'codex-rs/sub/config.md', 'README.md']) assert.ok(!WATCHED(p), p);
  for (const p of ['codex-rs/features/src/legacy.rs', 'codex-rs/features/src/feature_configs.rs', 'codex-rs/features/src/registry/flags.rs', 'codex-rs/features/src/contests.rs', 'codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts', 'docs/README.md']) assert.ok(WATCHED(p), p);
});

test('WATCHED leaves out the build files and the test modules of the features crate', () => {
  for (const p of ['codex-rs/features/Cargo.toml', 'codex-rs/features/BUILD.bazel', 'codex-rs/features/src/tests.rs', 'codex-rs/features/src/registry/tests.rs', 'codex-rs/features/src/legacy_tests.rs', 'codex-rs/features/tests/flags.rs']) assert.ok(!WATCHED(p), p);
});

test('changedWatched reports added, removed and modified blobs', () => {
  const before = new Map([['docs/config.md', 'a'], ['codex-rs/config.md', 'b'], ['codex-rs/features/src/lib.rs', 'c']]);
  const after = new Map([['docs/config.md', 'a'], ['codex-rs/config.md', 'b2'], ['docs/skills.md', 'd']]);
  assert.deepEqual(changedWatched(before, after), [
    { path: 'codex-rs/config.md', status: 'modified' }, { path: 'codex-rs/features/src/lib.rs', status: 'removed' }, { path: 'docs/skills.md', status: 'added' },
  ]);
});

test('changedWatched reports nothing for identical trees', () => {
  const tree = new Map([['docs/a.md', '1'], ['docs/b.md', '2']]);
  assert.deepEqual(changedWatched(tree, new Map(tree)), []);
  assert.deepEqual(changedWatched(new Map(), new Map()), []);
});

test('addedLines keeps only lines new to the second text, in order', () => {
  assert.deepEqual(addedLines('a\nb\nc\n', 'a\nx\nc\ny\n'), ['x', 'y']);
});

test('addedLines compares whole lines as a set: a moved or repeated line is not new, a blank line never is', () => {
  assert.deepEqual(addedLines('a\nb\nc', 'c\na\nb\n\n   \n'), []); // a pure reorder adds nothing
  assert.deepEqual(addedLines('a\n', 'a\na\nb\n'), ['b']); // `a` repeating does not make it new
  assert.deepEqual(addedLines('', 'x\n\ny\n'), ['x', 'y']); // a new file: every non-blank line
  assert.deepEqual(addedLines('x\ny\n', ''), []); // a removed file adds nothing
  assert.deepEqual(addedLines('  a\n', 'a\n'), ['a']); // indentation is part of the line
});

test('addedLines reads CRLF like LF and never leaves a carriage return behind', () => {
  assert.deepEqual(addedLines('a\r\nb\r\n', 'a\nb\nc\n'), ['c']);
  assert.deepEqual(addedLines('a\nb\n', 'a\r\nb\r\nc\r\n'), ['c']);
  assert.deepEqual(addedLines('a\r\n', 'a\r\nx\r\n'), ['x']);
  assert.deepEqual(addedLines('a\r\nb\r\n', 'a\nb\n'), []); // converting the line endings of a whole file adds nothing
});

test('groups by family and bounds the excerpt', () => {
  const groups = groupWatchedFiles([
    { path: 'codex-rs/features/src/lib.rs', status: 'modified', added: ['new flag'] },
    { path: 'codex-rs/app-server-protocol/schema/typescript/TurnStartParams.ts', status: 'modified', added: ['rootTurnId?: string'] },
    { path: 'docs/skills.md', status: 'added', added: Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(40)}`) },
  ]);
  assert.deepEqual(groups.map(g => g.key), ['feature-flags', 'schema', 'doc:docs/skills.md']);
  assert.deepEqual(groups.map(g => g.files.length), [1, 1, 1]); // one evidence entry per changed file
  assert.equal(groups[1]!.title, '协议类型有变化：1 个类型');
  assert.ok(groups.every(g => g.excerpt.length <= 6_000));
});

test('groupWatchedFiles names and classifies each group, puts every protocol type in one and drops unwatched paths', () => {
  const groups = groupWatchedFiles([
    { path: 'codex-rs/features/src/lib.rs', status: 'modified', added: ['pub const A: u8 = 1;'] },
    { path: 'codex-rs/features/src/legacy.rs', status: 'modified', added: ['const OLD: u8 = 2;'] },
    { path: 'codex-rs/app-server-protocol/schema/typescript/TurnStartParams.ts', status: 'modified', added: ['rootTurnId?: string'] },
    { path: 'codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts', status: 'added', added: ['export type ThreadStartParams = {};'] },
    { path: 'codex-rs/config.md', status: 'modified', added: ['## Hooks'] },
    { path: 'codex-rs/core/src/x.rs', status: 'modified', added: ['not watched'] },
    { path: 'codex-rs/features/Cargo.toml', status: 'modified', added: ['serde = "1"'] },
    { path: 'codex-rs/features/src/tests.rs', status: 'modified', added: ['fn a_test() {}'] },
  ]);
  assert.deepEqual(groups.map(g => [g.key, g.kind, g.title, g.files.length]), [
    ['feature-flags', 'feature-flag', '功能开关注册表有变化', 2],
    ['schema', 'schema', '协议类型有变化：2 个类型', 2],
    ['doc:codex-rs/config.md', 'doc', '文档有变化：codex-rs/config.md', 1],
  ]);
  // Excerpt lines are `<basename>: <line>`, or `<TypeName>: <line>` for a protocol type; files in the order given.
  assert.equal(groups[0]!.excerpt, 'lib.rs: pub const A: u8 = 1;\nlegacy.rs: const OLD: u8 = 2;');
  assert.equal(groups[1]!.excerpt, 'TurnStartParams: rootTurnId?: string\nThreadStartParams: export type ThreadStartParams = {};');
  assert.equal(groups[2]!.excerpt, 'config.md: ## Hooks');
});

test('a removed or unreadable file still says so in the excerpt, where its added lines would be', () => {
  const [removed, unreadable, long, type] = groupWatchedFiles([
    { path: 'docs/gone.md', status: 'removed', added: [] },
    { path: 'docs/big.md', status: 'modified', added: [], error: 'docs/big.md@rust-v0.162.1 is larger than the 1 MB\nthe GitHub contents API returns (2500000 bytes)' },
    { path: 'docs/long.md', status: 'modified', added: [], error: 'e'.repeat(500) },
    { path: 'codex-rs/app-server-protocol/schema/typescript/v2/OldType.ts', status: 'removed', added: [] },
  ]);
  assert.equal(removed!.excerpt, 'gone.md: （文件已删除）');
  assert.equal(unreadable!.excerpt, 'big.md: （内容未读取：docs/big.md@rust-v0.162.1 is larger than the 1 MB the GitHub contents API returns (2500000 bytes)）');
  assert.equal(long!.excerpt, `long.md: （内容未读取：${'e'.repeat(199)}…）`); // the reason is cut at 200 characters
  assert.equal(type!.excerpt, 'OldType: （文件已删除）');
});

test('the excerpt ends at a whole line, and one line longer than the cap is cut with an ellipsis', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(30)}`);
  const [many] = groupWatchedFiles([{ path: 'docs/a.md', status: 'added', added: lines }]);
  const kept = many!.excerpt.split('\n');
  assert.ok(many!.excerpt.length <= 6_000);
  assert.ok(kept.length > 100 && kept.length < 300, `kept ${kept.length} lines`);
  assert.deepEqual(kept, lines.slice(0, kept.length).map(line => `a.md: ${line}`));

  const [huge] = groupWatchedFiles([{ path: 'docs/b.md', status: 'added', added: ['y'.repeat(10_000)] }]);
  assert.equal(huge!.excerpt.length, 6_000);
  assert.ok(huge!.excerpt.startsWith('b.md: yyyy') && huge!.excerpt.endsWith('…'));

  // The cut never leaves half of a surrogate pair behind.
  const [emoji] = groupWatchedFiles([{ path: 'docs/c.md', status: 'added', added: ['😀'.repeat(5_000)] }]);
  assert.ok(emoji!.excerpt.length <= 6_000);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(emoji!.excerpt));
});

// --- collectFileChanges: a temp-dir store and a stub GitHub client, no network ---

type FilesGitHub = Pick<GitHubClient, 'treePaths' | 'fileAt'>;
const windowOf = (from: string, to: string): StableWindow => ({ from, to, releases: [to] });
const WINDOW = windowOf('rust-v0.162.0', 'rust-v0.162.1');
const compareUrl = (window: StableWindow) => `https://github.com/openai/codex/compare/${window.from}...${window.to}`;
const COMPARE = compareUrl(WINDOW);
const OVER_BUDGET = 'skipped: over the per-run fetch budget';
const TYPES_DIR = 'codex-rs/app-server-protocol/schema/typescript';
const isAbortError = (error: unknown) => (error as Error).name === 'AbortError';

/** `trees` holds the watched blobs of each tag and `texts` the file bodies by `tag:path`. `calls` records every request in order; `failing` makes `fileAt` throw for a path. */
function stubGitHub(trees: Record<string, Map<string, string>>, texts: Record<string, string>) {
  const calls = { treePaths: [] as string[], fileAt: [] as string[] };
  const failing = new Map<string, string>();
  const github: FilesGitHub = {
    treePaths: async (tag, keep) => {
      calls.treePaths.push(tag);
      const tree = trees[tag];
      if (!tree) throw new Error(`no tree for ${tag}`);
      return new Map([...tree].filter(([path]) => keep(path)));
    },
    fileAt: async (tag, path) => {
      calls.fileAt.push(`${tag}:${path}`);
      const failure = failing.get(path);
      if (failure !== undefined) throw new Error(failure);
      const text = texts[`${tag}:${path}`];
      if (text === undefined) throw new Error(`no text for ${tag}:${path}`);
      return text;
    },
  };
  return { github, calls, failing };
}

/** The three-file window of the plan: one file modified, one removed, one added; `docs/config.md` is unchanged. */
function scenario() {
  return stubGitHub(
    {
      'rust-v0.162.0': new Map([['docs/config.md', 'a'], ['codex-rs/config.md', 'b'], ['codex-rs/features/src/lib.rs', 'c']]),
      'rust-v0.162.1': new Map([['docs/config.md', 'a'], ['codex-rs/config.md', 'b2'], ['docs/skills.md', 'd']]),
    },
    {
      'rust-v0.162.0:codex-rs/config.md': '# Config\n\nBasics.\n',
      'rust-v0.162.1:codex-rs/config.md': '# Config\n\nBasics.\n\n## Hooks\n\nRun a command on tool use.\n',
      'rust-v0.162.0:codex-rs/features/src/lib.rs': 'pub const ALPHA: &str = "alpha";\n',
      'rust-v0.162.1:docs/skills.md': '# Skills\n\nA skill is a folder with a SKILL.md.\n',
    },
  );
}

/** A store whose clock advances one second per write. */
async function withStore(run: (store: CandidateStore, snapshotDir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'oc-files-'));
  try {
    let seconds = 0;
    await run(new CandidateStore(join(dir, 'data'), () => new Date(Date.UTC(2026, 9, 15, 0, 0, seconds++))), join(dir, 'snapshots'));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const snapshotPath = (snapshotDir: string, window: StableWindow) => join(snapshotDir, 'codex-files', `${window.from}__${window.to}.json`);
const readSnapshot = async (snapshotDir: string, window: StableWindow) =>
  JSON.parse(await readFile(snapshotPath(snapshotDir, window), 'utf8')) as { window: StableWindow; files: ChangedFile[] };
const byFingerprint = (candidates: Candidate[]) => [...candidates].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
const filesCandidates = async (store: CandidateStore) => byFingerprint(await store.list({ source: 'codex-files' }));
/** Nothing was stored: no candidate and no snapshot file for the window. */
async function assertNothingWritten(store: CandidateStore, snapshotDir: string, window = WINDOW): Promise<void> {
  assert.deepEqual(await store.list(), []);
  await assert.rejects(stat(snapshotPath(snapshotDir, window)), { code: 'ENOENT' });
}

test('collectFileChanges: one candidate per group, the snapshot keeps every changed file, a second run changes nothing', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = scenario();
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, WINDOW), 3);
    assert.deepEqual(stub.calls.treePaths, ['rust-v0.162.0', 'rust-v0.162.1']);
    // Feature flags first, then config.md, then docs. A removed file is read at `from` only, an added one at `to` only.
    assert.deepEqual(stub.calls.fileAt, [
      'rust-v0.162.0:codex-rs/features/src/lib.rs', 'rust-v0.162.0:codex-rs/config.md', 'rust-v0.162.1:codex-rs/config.md', 'rust-v0.162.1:docs/skills.md',
    ]);

    const snapshot = await readSnapshot(snapshotDir, WINDOW);
    assert.deepEqual(snapshot, {
      window: WINDOW,
      files: [
        { path: 'codex-rs/config.md', status: 'modified', added: ['## Hooks', 'Run a command on tool use.'] },
        { path: 'codex-rs/features/src/lib.rs', status: 'removed', added: [] },
        { path: 'docs/skills.md', status: 'added', added: ['# Skills', 'A skill is a folder with a SKILL.md.'] },
      ],
    });

    const stored = await filesCandidates(store);
    assert.deepEqual(stored.map(c => c.fingerprint), ['codex-files:doc:codex-rs/config.md:0.162', 'codex-files:doc:docs/skills.md:0.162', 'codex-files:feature-flags:0.162']);
    assert.ok(stored.every(c => c.source === 'codex-files' && c.status === 'new'));
    assert.ok(stored.every(c => c.window?.fromTag === 'rust-v0.162.0' && c.window?.toTag === 'rust-v0.162.1' && Object.keys(c.window).length === 2));
    const [config, skills, flags] = stored;
    assert.equal(config!.title, '文档有变化：codex-rs/config.md');
    assert.equal(config!.summary, 'config.md: ## Hooks\nconfig.md: Run a command on tool use.');
    assert.deepEqual(config!.evidence, [{ kind: 'doc', ref: 'codex-rs/config.md', url: COMPARE, excerpt: '## Hooks\nRun a command on tool use.' }]);
    assert.equal(skills!.title, '文档有变化：docs/skills.md');
    assert.deepEqual(skills!.evidence, [{ kind: 'doc', ref: 'docs/skills.md', url: COMPARE, excerpt: '# Skills\nA skill is a folder with a SKILL.md.' }]);
    assert.equal(flags!.title, '功能开关注册表有变化');
    assert.equal(flags!.summary, 'lib.rs: （文件已删除）');
    assert.deepEqual(flags!.evidence, [{ kind: 'feature-flag', ref: 'codex-rs/features/src/lib.rs', url: COMPARE, excerpt: '' }]);

    // The same window again: nothing is created and no candidate is rewritten.
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, WINDOW), 0);
    assert.deepEqual(await filesCandidates(store), stored);
    assert.deepEqual(await readSnapshot(snapshotDir, WINDOW), snapshot);
  });
});

test('collectFileChanges: every changed protocol type of the window is one candidate, one evidence entry per type file', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(
      {
        'rust-v0.162.0': new Map([[`${TYPES_DIR}/Turn.ts`, '1'], [`${TYPES_DIR}/v2/SkillSummary.ts`, '1'], [`${TYPES_DIR}/ClientRequest.ts`, '1']]),
        'rust-v0.162.1': new Map([[`${TYPES_DIR}/Turn.ts`, '2'], [`${TYPES_DIR}/v2/SkillSummary.ts`, '2'], [`${TYPES_DIR}/v2/RequestHeader.ts`, '1'], [`${TYPES_DIR}/ClientRequest.ts`, '1']]),
      },
      {
        [`rust-v0.162.0:${TYPES_DIR}/Turn.ts`]: 'export type Turn = {\n  id: string,\n};\n',
        [`rust-v0.162.1:${TYPES_DIR}/Turn.ts`]: 'export type Turn = {\n  id: string,\n  rootTurnId?: string,\n};\n',
        [`rust-v0.162.0:${TYPES_DIR}/v2/SkillSummary.ts`]: 'export type SkillSummary = {\n  name: string,\n};\n',
        [`rust-v0.162.1:${TYPES_DIR}/v2/SkillSummary.ts`]: 'export type SkillSummary = {\n  name: string,\n  scope: string,\n};\n',
        [`rust-v0.162.1:${TYPES_DIR}/v2/RequestHeader.ts`]: 'export type RequestHeader = { name: string };\n',
      },
    );
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, WINDOW), 1); // ClientRequest.ts did not change
    const stored = await filesCandidates(store);
    assert.deepEqual(stored.map(c => c.fingerprint), ['codex-files:schema:0.162']);
    const [schema] = stored;
    assert.equal(schema!.title, '协议类型有变化：3 个类型');
    assert.deepEqual(schema!.evidence, [ // in path order
      { kind: 'schema', ref: `${TYPES_DIR}/Turn.ts`, url: COMPARE, excerpt: '  rootTurnId?: string,' },
      { kind: 'schema', ref: `${TYPES_DIR}/v2/RequestHeader.ts`, url: COMPARE, excerpt: 'export type RequestHeader = { name: string };' },
      { kind: 'schema', ref: `${TYPES_DIR}/v2/SkillSummary.ts`, url: COMPARE, excerpt: '  scope: string,' },
    ]);
    assert.equal(schema!.summary, 'Turn:   rootTurnId?: string,\nRequestHeader: export type RequestHeader = { name: string };\nSkillSummary:   scope: string,');
  });
});

test('collectFileChanges: the build files and test modules of the features crate are neither read nor recorded', async () => {
  await withStore(async (store, snapshotDir) => {
    const changed = (sha: string) => new Map(['src/lib.rs', 'src/tests.rs', 'src/legacy_tests.rs', 'Cargo.toml', 'BUILD.bazel'].map(name => [`codex-rs/features/${name}`, sha]));
    const stub = stubGitHub(
      { 'rust-v0.162.0': changed('1'), 'rust-v0.162.1': changed('2') },
      { 'rust-v0.162.0:codex-rs/features/src/lib.rs': 'A,\n', 'rust-v0.162.1:codex-rs/features/src/lib.rs': 'A,\nB,\n' },
    );
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, WINDOW), 1);
    assert.deepEqual(stub.calls.fileAt, ['rust-v0.162.0:codex-rs/features/src/lib.rs', 'rust-v0.162.1:codex-rs/features/src/lib.rs']);
    assert.deepEqual((await readSnapshot(snapshotDir, WINDOW)).files.map(f => f.path), ['codex-rs/features/src/lib.rs']);
  });
});

test('collectFileChanges: the summary and the evidence excerpts are bounded at whole lines, the snapshot keeps every added line', async () => {
  await withStore(async (store, snapshotDir) => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(40)}`);
    const stub = stubGitHub({ 'rust-v0.162.0': new Map(), 'rust-v0.162.1': new Map([['docs/long.md', '1']]) }, { 'rust-v0.162.1:docs/long.md': `${lines.join('\n')}\n` });
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, WINDOW), 1);
    const { files } = await readSnapshot(snapshotDir, WINDOW);
    assert.deepEqual(files[0]!.added, lines);

    const [long] = await filesCandidates(store);
    const summary = long!.summary.split('\n');
    assert.ok(long!.summary.length <= 1_000 && summary.length >= 10 && summary.length < 300, `summary has ${summary.length} lines, ${long!.summary.length} characters`);
    assert.deepEqual(summary, lines.slice(0, summary.length).map(line => `long.md: ${line}`));
    const excerpt = long!.evidence[0]!.excerpt!.split('\n');
    assert.ok(long!.evidence[0]!.excerpt!.length <= 2_000 && excerpt.length >= 20 && excerpt.length < 300, `excerpt has ${excerpt.length} lines`);
    assert.deepEqual(excerpt, lines.slice(0, excerpt.length));
  });
});

test('collectFileChanges: a file that cannot be read is recorded with its error and the other groups are still produced', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = scenario();
    const tooBig = 'codex-rs/config.md@rust-v0.162.1 is larger than the 1 MB the GitHub contents API returns (2500000 bytes)';
    stub.failing.set('codex-rs/config.md', tooBig);
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, WINDOW), 3);

    const { files } = await readSnapshot(snapshotDir, WINDOW);
    assert.deepEqual(files.find(f => f.path === 'codex-rs/config.md'), { path: 'codex-rs/config.md', status: 'modified', added: [], error: tooBig });
    assert.deepEqual(files.find(f => f.path === 'docs/skills.md'), { path: 'docs/skills.md', status: 'added', added: ['# Skills', 'A skill is a folder with a SKILL.md.'] });
    assert.ok(files.filter(f => f.error).length === 1);

    // The unreadable file still gives a candidate: its content is unknown, which is not the same as nothing new.
    const stored = await filesCandidates(store);
    assert.deepEqual(stored.map(c => c.fingerprint), ['codex-files:doc:codex-rs/config.md:0.162', 'codex-files:doc:docs/skills.md:0.162', 'codex-files:feature-flags:0.162']);
    assert.match(stored[0]!.summary, /^config\.md: （内容未读取：codex-rs\/config\.md@rust-v0\.162\.1 is larger than the 1 MB/);
    assert.deepEqual(stored[0]!.evidence, [{ kind: 'doc', ref: 'codex-rs/config.md', url: COMPARE, excerpt: '' }]);
    assert.equal(stored[1]!.summary, 'skills.md: # Skills\nskills.md: A skill is a folder with a SKILL.md.');
  });
});

test('collectFileChanges: a failure that is not an abort is not mistaken for one', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = scenario();
    stub.failing.set('docs/skills.md', 'GitHub HTTP 403 for repos/openai/codex/contents/docs/skills.md: API rate limit exceeded');
    // A signal that is not aborted changes nothing.
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, WINDOW, new AbortController().signal), 3);
    const { files } = await readSnapshot(snapshotDir, WINDOW);
    assert.match(files.find(f => f.path === 'docs/skills.md')!.error!, /HTTP 403/);
  });
});

test('collectFileChanges: whatever a request fails with is recorded as text, and a call that throws instead of rejecting is one more failure', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = scenario();
    // Plain functions, not async ones: `config.md` is rejected at `from` and thrown at `to`; the other two files fail with values that are not Errors.
    stub.github.fileAt = ((tag, path) => {
      if (path === 'codex-rs/config.md') {
        if (tag === 'rust-v0.162.0') return Promise.reject(new Error('rejected'));
        throw new Error('threw synchronously');
      }
      if (path === 'docs/skills.md') return Promise.reject('plain text failure');
      return Promise.reject(new Error(''));
    }) as FilesGitHub['fileAt'];
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, WINDOW), 3);
    const { files } = await readSnapshot(snapshotDir, WINDOW);
    assert.match(files.find(f => f.path === 'codex-rs/config.md')!.error!, /^(rejected|threw synchronously)$/);
    assert.equal(files.find(f => f.path === 'docs/skills.md')!.error, 'plain text failure');
    assert.equal(files.find(f => f.path === 'codex-rs/features/src/lib.rs')!.error, 'unknown error');
    assert.ok(files.every(f => f.added.length === 0));
  });
});

test('collectFileChanges: an abort propagates and leaves no snapshot or candidate behind', async () => {
  await withStore(async (store, snapshotDir) => {
    const controller = new AbortController();
    const stub = scenario();
    stub.github.fileAt = async () => { controller.abort(); throw new DOMException('This operation was aborted', 'AbortError'); };
    await assert.rejects(collectFileChanges(store, stub.github, snapshotDir, WINDOW, controller.signal), isAbortError);
    await assertNothingWritten(store, snapshotDir);
  });
});

test('collectFileChanges: the error of a request that failed during an abort is the one that propagates, not a file error', async () => {
  await withStore(async (store, snapshotDir) => {
    const controller = new AbortController();
    const stub = scenario();
    stub.github.fileAt = async () => { controller.abort(); throw new Error('client failed while aborting'); };
    await assert.rejects(collectFileChanges(store, stub.github, snapshotDir, WINDOW, controller.signal), /client failed while aborting/);
    await assertNothingWritten(store, snapshotDir);
  });
});

test('collectFileChanges: a client that ignores the signal is still stopped by it', async () => {
  await withStore(async (store, snapshotDir) => {
    // Aborted before the call: not even the trees are requested.
    const stub = scenario();
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(collectFileChanges(store, stub.github, snapshotDir, WINDOW, aborted.signal), isAbortError);
    assert.deepEqual(stub.calls.treePaths, []);
    assert.deepEqual(stub.calls.fileAt, []);

    // Aborted while the first file is read, and the client returns normally anyway: no second file is started.
    const midway = new AbortController();
    const inFlight = scenario();
    const fileAt = inFlight.github.fileAt;
    inFlight.github.fileAt = async (tag, path, signal) => { midway.abort(); return fileAt(tag, path, signal); };
    await assert.rejects(collectFileChanges(store, inFlight.github, snapshotDir, WINDOW, midway.signal), isAbortError);
    assert.equal(inFlight.calls.fileAt.length, 1); // the removed feature file, read first: one request
    await assertNothingWritten(store, snapshotDir);

    // Aborted while the last file is read: nothing is written either.
    const last = new AbortController();
    const single = stubGitHub({ 'rust-v0.162.0': new Map(), 'rust-v0.162.1': new Map([['docs/a.md', '1']]) }, { 'rust-v0.162.1:docs/a.md': 'x\n' });
    const read = single.github.fileAt;
    single.github.fileAt = async (tag, path, signal) => { last.abort(); return read(tag, path, signal); };
    await assert.rejects(collectFileChanges(store, single.github, snapshotDir, WINDOW, last.signal), isAbortError);
    await assertNothingWritten(store, snapshotDir);
  });
});

test('collectFileChanges: a failed tree request fails the run and writes nothing', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = scenario();
    stub.github.treePaths = async () => { throw new Error('GitHub tree for rust-v0.162.1 is truncated'); };
    await assert.rejects(collectFileChanges(store, stub.github, snapshotDir, WINDOW), /truncated/);
    await assertNothingWritten(store, snapshotDir);
  });
});

test('collectFileChanges: at most 60 files are read, feature flags first, then schema, config.md and docs', async () => {
  await withStore(async (store, snapshotDir) => {
    const after = new Map<string, string>();
    const texts: Record<string, string> = {};
    const put = (path: string) => { after.set(path, `sha:${path}`); texts[`rust-v0.162.1:${path}`] = `body of ${path}\n`; };
    // Added in a deliberately unhelpful order: docs first.
    for (let i = 59; i >= 0; i--) put(`docs/d${String(i).padStart(2, '0')}.md`);
    put('codex-rs/config.md');
    for (const name of ['C', 'B', 'A']) put(`${TYPES_DIR}/${name}.ts`);
    for (const name of ['c', 'b', 'a']) put(`codex-rs/features/src/${name}.rs`);
    const stub = stubGitHub({ 'rust-v0.162.0': new Map(), 'rust-v0.162.1': after }, texts);

    // The 3 feature files make one group, the 3 protocol types one, config.md one and the 60 docs sixty: 63 candidates.
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, WINDOW), 63);
    const fetched = stub.calls.fileAt.map(call => call.slice('rust-v0.162.1:'.length));
    assert.equal(fetched.length, 60);
    assert.deepEqual(fetched.slice(0, 7), [
      'codex-rs/features/src/a.rs', 'codex-rs/features/src/b.rs', 'codex-rs/features/src/c.rs',
      `${TYPES_DIR}/A.ts`, `${TYPES_DIR}/B.ts`, `${TYPES_DIR}/C.ts`,
      'codex-rs/config.md',
    ]);
    assert.deepEqual(fetched.slice(7), Array.from({ length: 53 }, (_, i) => `docs/d${String(i).padStart(2, '0')}.md`)); // alphabetical within a family

    const { files } = await readSnapshot(snapshotDir, WINDOW);
    assert.equal(files.length, 67);
    assert.deepEqual(files.map(f => f.path), [...files.map(f => f.path)].sort()); // the snapshot keeps the order of the tree diff
    const skipped = files.filter(f => f.error);
    assert.deepEqual(skipped.map(f => f.path), Array.from({ length: 7 }, (_, i) => `docs/d${53 + i}.md`));
    assert.ok(skipped.every(f => f.status === 'added' && f.added.length === 0 && f.error === OVER_BUDGET));
    assert.ok(files.filter(f => !f.error).every(f => f.added.length === 1));

    const schema = await store.findByFingerprint('codex-files:schema:0.162');
    assert.equal(schema!.title, '协议类型有变化：3 个类型');
    assert.deepEqual(schema!.evidence.map(e => e.ref), [`${TYPES_DIR}/A.ts`, `${TYPES_DIR}/B.ts`, `${TYPES_DIR}/C.ts`]);
    // A file past the budget is unread, not unchanged: it still gets a candidate that says so.
    const last = await store.findByFingerprint('codex-files:doc:docs/d59.md:0.162');
    assert.match(last!.summary, new RegExp(`^d59\\.md: （内容未读取：${OVER_BUDGET}）$`));
  });
});

test('collectFileChanges: the caller sets the budget; a file past it is unread but still a candidate', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = scenario();
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, WINDOW, undefined, { budget: 2 }), 3);
    // Priority order: the feature file, then config.md (two requests); docs/skills.md is the third file.
    assert.deepEqual(stub.calls.fileAt, ['rust-v0.162.0:codex-rs/features/src/lib.rs', 'rust-v0.162.0:codex-rs/config.md', 'rust-v0.162.1:codex-rs/config.md']);
    const { files } = await readSnapshot(snapshotDir, WINDOW);
    assert.deepEqual(files.filter(f => f.error), [{ path: 'docs/skills.md', status: 'added', added: [], error: OVER_BUDGET }]);
    assert.match((await store.findByFingerprint('codex-files:doc:docs/skills.md:0.162'))!.summary, /^skills\.md: （内容未读取：skipped: over/);
  });
});

test('collectFileChanges: a budget of zero reads nothing, an omitted one is the default, and one that is not a count is refused before any request', async () => {
  await withStore(async (store, snapshotDir) => {
    const none = scenario();
    assert.equal(await collectFileChanges(store, none.github, snapshotDir, WINDOW, undefined, { budget: 0 }), 3);
    assert.deepEqual(none.calls.fileAt, []);
    assert.equal((await readSnapshot(snapshotDir, WINDOW)).files.filter(f => f.error === OVER_BUDGET).length, 3);
  });
  await withStore(async (store, snapshotDir) => {
    const stub = scenario();
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, WINDOW, undefined, {}), 3);
    assert.equal(stub.calls.fileAt.length, 4); // all three files read: 1 + 2 + 1 requests
    assert.equal((await readSnapshot(snapshotDir, WINDOW)).files.filter(f => f.error).length, 0);
  });
  await withStore(async (store, snapshotDir) => {
    for (const budget of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const stub = scenario();
      await assert.rejects(collectFileChanges(store, stub.github, snapshotDir, WINDOW, undefined, { budget }), (error: unknown) => (error as Error).name === 'ValidationError' && /budget/.test((error as Error).message));
      assert.deepEqual(stub.calls.treePaths, []);
    }
    await assertNothingWritten(store, snapshotDir);
  });
});

test('collectFileChanges: an edit that adds nothing is not a candidate, a removal is', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(
      {
        'rust-v0.162.0': new Map([['docs/ws.md', '1'], ['docs/moved.md', '1'], ['docs/gone.md', '1'], ['docs/real.md', '1'], ['codex-rs/features/src/lib.rs', '1']]),
        'rust-v0.162.1': new Map([['docs/ws.md', '2'], ['docs/moved.md', '2'], ['docs/real.md', '2'], ['codex-rs/features/src/lib.rs', '2']]),
      },
      {
        'rust-v0.162.0:docs/ws.md': 'a\nb\n', 'rust-v0.162.1:docs/ws.md': 'a\nb\n\n   \n', // blank lines only
        'rust-v0.162.0:docs/moved.md': 'x\ny\n', 'rust-v0.162.1:docs/moved.md': 'y\nx\n', // reordered
        'rust-v0.162.0:docs/gone.md': 'old\n',
        'rust-v0.162.0:docs/real.md': 'a\n', 'rust-v0.162.1:docs/real.md': 'a\nnew\n',
        'rust-v0.162.0:codex-rs/features/src/lib.rs': 'a\nb\n', 'rust-v0.162.1:codex-rs/features/src/lib.rs': 'a\n', // lines only removed
      },
    );
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, WINDOW), 2);
    assert.deepEqual((await filesCandidates(store)).map(c => c.fingerprint), ['codex-files:doc:docs/gone.md:0.162', 'codex-files:doc:docs/real.md:0.162']);
    // The snapshot still lists the files that gave no candidate.
    const { files } = await readSnapshot(snapshotDir, WINDOW);
    assert.deepEqual(files.map(f => [f.path, f.status, f.added.length]), [
      ['codex-rs/features/src/lib.rs', 'modified', 0], ['docs/gone.md', 'removed', 0], ['docs/moved.md', 'modified', 0], ['docs/real.md', 'modified', 1], ['docs/ws.md', 'modified', 0],
    ]);
  });
});

test('collectFileChanges: Windows line endings are normalised before the lines are compared', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(
      { 'rust-v0.162.0': new Map([['docs/win.md', '1'], ['docs/eol.md', '1']]), 'rust-v0.162.1': new Map([['docs/win.md', '2'], ['docs/eol.md', '2']]) },
      {
        'rust-v0.162.0:docs/win.md': 'a\r\nb\r\n', 'rust-v0.162.1:docs/win.md': 'a\r\nb\r\nc\r\n',
        'rust-v0.162.0:docs/eol.md': 'a\r\nb\r\n', 'rust-v0.162.1:docs/eol.md': 'a\nb\n', // only the line endings changed
      },
    );
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, WINDOW), 1);
    const [win] = await filesCandidates(store);
    assert.equal(win!.fingerprint, 'codex-files:doc:docs/win.md:0.162');
    assert.equal(win!.summary, 'win.md: c');
    assert.deepEqual(win!.evidence, [{ kind: 'doc', ref: 'docs/win.md', url: COMPARE, excerpt: 'c' }]);
  });
});

test('collectFileChanges: a window with no watched change gives a snapshot and no candidate', async () => {
  await withStore(async (store, snapshotDir) => {
    const same = new Map([['docs/a.md', '1']]);
    const stub = stubGitHub({ 'rust-v0.162.0': same, 'rust-v0.162.1': new Map(same) }, {});
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, WINDOW), 0);
    assert.deepEqual(await readSnapshot(snapshotDir, WINDOW), { window: WINDOW, files: [] });
    assert.deepEqual(stub.calls.fileAt, []);
    assert.deepEqual(await store.list(), []);
  });
});

test('collectFileChanges: 0.162.0 and 0.162.1 land on one candidate, 0.163.0 on another', async () => {
  await withStore(async (store, snapshotDir) => {
    const sha = (n: number) => new Map([['docs/skills.md', `sha${n}`]]);
    const stub = stubGitHub(
      { 'rust-v0.161.0': sha(1), 'rust-v0.162.0': sha(2), 'rust-v0.162.1': sha(3), 'rust-v0.163.0': sha(4) },
      {
        'rust-v0.161.0:docs/skills.md': 'one\n', 'rust-v0.162.0:docs/skills.md': 'one\ntwo\n',
        'rust-v0.162.1:docs/skills.md': 'one\ntwo\nthree\n', 'rust-v0.163.0:docs/skills.md': 'one\ntwo\nthree\nfour\n',
      },
    );
    const first = windowOf('rust-v0.161.0', 'rust-v0.162.0'), second = windowOf('rust-v0.162.0', 'rust-v0.162.1'), third = windowOf('rust-v0.162.1', 'rust-v0.163.0');

    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, first), 1);
    const [firstSeen] = await filesCandidates(store);
    assert.equal(firstSeen!.fingerprint, 'codex-files:doc:docs/skills.md:0.162');
    assert.equal(firstSeen!.summary, 'skills.md: two');

    // The patch release refreshes the same candidate: nothing is created. The same file found again takes the newer entry; the window still starts where the first one did.
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, second), 0);
    const stored = await filesCandidates(store);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.id, firstSeen!.id);
    assert.equal(stored[0]!.summary, 'skills.md: three');
    assert.deepEqual(stored[0]!.evidence, [{ kind: 'doc', ref: 'docs/skills.md', url: compareUrl(second), excerpt: 'three' }]);
    assert.deepEqual(stored[0]!.window, { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.1' });

    // The next minor starts a candidate of its own, from its own window.
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, third), 1);
    const all = await filesCandidates(store);
    assert.deepEqual(all.map(c => c.fingerprint), ['codex-files:doc:docs/skills.md:0.162', 'codex-files:doc:docs/skills.md:0.163']);
    assert.deepEqual(all[1]!.window, { fromTag: 'rust-v0.162.1', toTag: 'rust-v0.163.0' });
    assert.deepEqual(all[0]!.window, { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.1' });
  });
});

test('collectFileChanges: a patch release adds its protocol types to the candidate of the minor, which keeps the first window start', async () => {
  await withStore(async (store, snapshotDir) => {
    const type = (name: string) => `${TYPES_DIR}/${name}.ts`;
    const stub = stubGitHub(
      {
        'rust-v0.161.0': new Map([[type('A'), '1'], [type('B'), '1']]),
        'rust-v0.162.0': new Map([[type('A'), '2'], [type('B'), '1']]), // 0.162.0 changes A
        'rust-v0.162.1': new Map([[type('A'), '2'], [type('B'), '2']]), // 0.162.1 changes B
      },
      {
        [`rust-v0.161.0:${type('A')}`]: 'type A = {\n  one,\n};\n', [`rust-v0.162.0:${type('A')}`]: 'type A = {\n  one,\n  two,\n};\n',
        [`rust-v0.162.0:${type('B')}`]: 'type B = {\n  one,\n};\n', [`rust-v0.162.1:${type('B')}`]: 'type B = {\n  one,\n  three,\n};\n',
      },
    );
    const first = windowOf('rust-v0.161.0', 'rust-v0.162.0'), second = windowOf('rust-v0.162.0', 'rust-v0.162.1');

    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, first), 1);
    const [before] = await filesCandidates(store);
    assert.equal(before!.fingerprint, 'codex-files:schema:0.162');
    assert.equal(before!.title, '协议类型有变化：1 个类型');

    // The patch release finds another type: the candidate is refreshed, not duplicated, and holds both.
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, second), 0);
    const stored = await filesCandidates(store);
    assert.equal(stored.length, 1);
    const [merged] = stored;
    assert.equal(merged!.id, before!.id);
    assert.equal(merged!.status, 'new');
    assert.equal(merged!.title, '协议类型有变化：2 个类型'); // counts the types of the whole candidate
    assert.equal(merged!.summary, 'B:   three,'); // the newest window's excerpt
    assert.deepEqual(merged!.evidence, [
      { kind: 'schema', ref: type('A'), url: compareUrl(first), excerpt: '  two,' },
      { kind: 'schema', ref: type('B'), url: compareUrl(second), excerpt: '  three,' },
    ]);
    assert.deepEqual(merged!.window, { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.1' });
  });
});

test('collectFileChanges: a type found again replaces its entry, types found only before stay in front, a rerun changes nothing', async () => {
  await withStore(async (store, snapshotDir) => {
    const type = (name: string) => `${TYPES_DIR}/${name}.ts`;
    const stub = stubGitHub(
      {
        'rust-v0.161.0': new Map([[type('Y'), '1'], [type('Z'), '1']]),
        'rust-v0.162.0': new Map([[type('Y'), '2'], [type('Z'), '2']]), // 0.162.0 changes Y and Z
        'rust-v0.162.1': new Map([[type('X'), '1'], [type('Y'), '3'], [type('Z'), '2']]), // 0.162.1 adds X and changes Y again
        'rust-v0.163.0': new Map([[type('X'), '1'], [type('Y'), '3'], [type('Z'), '3']]), // 0.163.0 changes Z
      },
      {
        [`rust-v0.161.0:${type('Y')}`]: 'y1\n', [`rust-v0.161.0:${type('Z')}`]: 'z1\n',
        [`rust-v0.162.0:${type('Y')}`]: 'y1\ny2\n', [`rust-v0.162.0:${type('Z')}`]: 'z1\nz2\n',
        [`rust-v0.162.1:${type('X')}`]: 'x1\n', [`rust-v0.162.1:${type('Y')}`]: 'y1\ny2\ny3\n', [`rust-v0.162.1:${type('Z')}`]: 'z1\nz2\n',
        [`rust-v0.163.0:${type('Z')}`]: 'z1\nz2\nz3\n',
      },
    );
    const first = windowOf('rust-v0.161.0', 'rust-v0.162.0'), second = windowOf('rust-v0.162.0', 'rust-v0.162.1'), third = windowOf('rust-v0.162.1', 'rust-v0.163.0');

    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, first), 1);
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, second), 0);
    const [merged] = await filesCandidates(store);
    // Z was found only by the first window and stays in front; Y was found again and takes the second window's entry; X is new.
    assert.deepEqual(merged!.evidence, [
      { kind: 'schema', ref: type('Z'), url: compareUrl(first), excerpt: 'z2' },
      { kind: 'schema', ref: type('X'), url: compareUrl(second), excerpt: 'x1' },
      { kind: 'schema', ref: type('Y'), url: compareUrl(second), excerpt: 'y3' },
    ]);
    assert.equal(merged!.title, '协议类型有变化：3 个类型');
    assert.equal(merged!.summary, 'X: x1\nY: y3');
    assert.deepEqual(merged!.window, { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.1' });

    // The same window again changes nothing, not even the time of the last write.
    const settled = await filesCandidates(store);
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, second), 0);
    assert.deepEqual(await filesCandidates(store), settled);

    // The next minor does not merge into it.
    assert.equal(await collectFileChanges(store, stub.github, snapshotDir, third), 1);
    const all = await filesCandidates(store);
    assert.deepEqual(all.map(c => c.fingerprint), ['codex-files:schema:0.162', 'codex-files:schema:0.163']);
    assert.deepEqual(all[0], settled[0]);
    assert.deepEqual(all[1]!.evidence, [{ kind: 'schema', ref: type('Z'), url: compareUrl(third), excerpt: 'z3' }]);
    assert.equal(all[1]!.title, '协议类型有变化：1 个类型');
    assert.deepEqual(all[1]!.window, { fromTag: 'rust-v0.162.1', toTag: 'rust-v0.163.0' });
  });
});
