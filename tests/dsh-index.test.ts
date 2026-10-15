import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDshIndex, isDshIndex, searchIndex, type DshIndex, type IndexEntry } from '../src/host/index/dsh-index.ts';

const mirror = fileURLToPath(new URL('./fixtures/mirror/', import.meta.url));

/** Builds a throwaway mirror from `{ relative path: contents }`, runs `check` on it and always removes it. */
async function withMirror(files: Record<string, string>, check: (dir: string) => Promise<void>, prefix = 'oc-index-'): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    for (const [path, body] of Object.entries(files)) { await mkdir(dirname(join(dir, path)), { recursive: true }); await writeFile(join(dir, path), body); }
    await check(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
/** Sets environment variables for the duration of `run` and puts the previous values back. */
async function withEnv(patch: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(patch).map(key => [key, process.env[key]]));
  Object.assign(process.env, patch);
  try { await run(); } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const entry = (kind: IndexEntry['kind'], id: string, title: string, text: string, path = id): IndexEntry => ({ kind, id, title, path, text });
const note = (id: string, title: string, text: string, path = id) => entry('note', id, title, text, path);
const indexOf = (...entries: IndexEntry[]): DshIndex => ({ version: 1, builtAt: '2026-10-15T00:00:00.000Z', commit: 'unknown', mirror: '/mirror', entries });
/** Git run the way the tests need it: no GIT_* variable from the caller (a hook would export GIT_DIR) and a HOME of its own, so no user configuration. */
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
  cwd, encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), HOME: cwd },
});
function commitIn(dir: string): string {
  git(dir, 'init', '-q');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return git(dir, 'rev-parse', 'HEAD').trim();
}

test('index collects package summaries, config entries and notes with relative paths', async () => {
  const index = await buildDshIndex(mirror);
  assert.ok(index.entries.some(e => e.kind === 'package' && e.path === 'packages/subagent/subagent-codex/README.md'));
  assert.ok(index.entries.some(e => e.kind === 'config'));
  assert.ok(index.entries.some(e => e.kind === 'note' && e.title.length > 0));
});

test('search ranks title hits above body hits', async () => {
  const index = await buildDshIndex(mirror);
  const hits = searchIndex(index, 'codex subagent worktree', 3);
  assert.equal(hits[0]!.path, 'packages/subagent/subagent-codex/README.md');
});

test('a README without a Summary section falls back to its leading text, collapsed and capped at 1,200 characters', async () => {
  await withMirror({
    'packages/g/plain/README.md': '---\nkind: "package-reference"\n---\n\n# plain\n\nFirst   line\twith  gaps.\n\nSecond paragraph.\n\n## Usage\n\nBody text that stays out.\n',
    'packages/g/lang/README.md': '# lang\n\nEnglish | [中文](README.zh.md)\n\nLead after the language line.\n\n## Usage\n',
    'packages/g/empty/README.md': '# empty\n\nLead text.\n\n## Summary\n\n## Usage\n\nBody.\n',
    'packages/g/prefix/README.md': '# prefix\n\nLead.\n\n## Summary of changes\n\nNot the summary.\n',
    'packages/g/long/README.md': `# long\n\n## Summary\n\n${'x'.repeat(3_000)}\n`,
    'packages/g/emoji/README.md': `# emoji\n\n## Summary\n\n${'x'.repeat(1_199)}\u{1F600}tail\n`,
  }, async dir => {
    const text = Object.fromEntries((await buildDshIndex(dir)).entries.map(e => [e.title, e.text]));
    assert.equal(text.plain, 'First line with gaps. Second paragraph.');
    assert.equal(text.lang, 'Lead after the language line.');
    assert.equal(text.empty, 'Lead text.');
    assert.equal(text.prefix, 'Lead.'); // `## Summary of changes` is another section
    assert.equal(text.long, 'x'.repeat(1_200));
    assert.equal(text.emoji, 'x'.repeat(1_199)); // the cut would fall inside the emoji's surrogate pair, so the half pair goes
  });
});

test('searchIndex returns nothing without a hit and ignores one-character words', async () => {
  const index = await buildDshIndex(mirror);
  for (const query of ['zzzz qqqq', '', '   ']) assert.deepEqual(searchIndex(index, query), [], JSON.stringify(query));
  assert.deepEqual(searchIndex(indexOf(note('n', 'a', 'a b c')), 'a b c'), []); // whole words of the entry, but one character carries no signal
  assert.deepEqual(searchIndex(index, 'x a worktree'), searchIndex(index, 'worktree'));
});

test('package text is its description plus Summary; config and note text drop their heading, markers and leading boilerplate', async () => {
  const { entries } = await buildDshIndex(mirror);
  const find = (kind: IndexEntry['kind'], id: string) => entries.find(e => e.kind === kind && e.id === id)!;
  // The Summary alone never says worktree; the description does.
  assert.equal(find('package', 'packages/experimental/worktree').text, 'Create and enter a retained Git worktree under the calling Session file policy. Create an isolated checkout from a local commit and continue the same Session in it.');
  assert.equal(find('package', 'packages/core/tools').text, 'Declare the capabilities a Session offers. Declares every capability once and lists the visible ones for the model.');
  const config = find('config', '@deepseek-ai/dsh-experimental-worktree');
  assert.equal(config.path, 'docs/config-catalog.md');
  assert.doesNotMatch(config.text, /<!--|<a id|dsh-agent-loop/); // the next section's BEGIN marker trails this one in the file
  assert.match(config.text, /^- `inject`: `fs` · `sandbox` - `source`: \[`packages\/experimental\/worktree\/src\/index\.ts:30`\]/);
  const sample = find('note', '.agents/notes/implemented/feature/2026-01-01-sample.md');
  assert.equal(sample.title, 'Agent Note: Sample decision record'); // implemented or proposed is in the path, not in the title
  assert.equal(sample.text, '## Problem A sample note for the index tests.');
});

test('only the status and language lines a note opens with are dropped; later ones and scope notes stay', async () => {
  await withMirror({
    '.agents/notes/implemented/feature/a.md': '# T\n\nStatus: implemented\n\nEnglish | [中文](a.zh.md)\n\n> Scope: kept.\n\n## Problem\n\nStatus: shipped later.\n',
  }, async dir => {
    assert.equal((await buildDshIndex(dir)).entries[0]!.text, '> Scope: kept. ## Problem Status: shipped later.');
  });
});

test('a README description leads its text unless the Summary already says it', async () => {
  await withMirror({
    'packages/g/lead/README.md': '---\ndescription: "Short pitch."\n---\n\n# lead\n\n## Summary\n\nLong form.\n',
    'packages/g/same/README.md': '---\ndescription: "Short pitch."\n---\n\n# same\n\n## Summary\n\nShort pitch. Then more.\n',
    'packages/g/lone/README.md': "---\ndescription: 'It''s single quoted'\n---\n\n# lone\n\nIntro.\n\n## Usage\n",
    'packages/g/escaped/README.md': '---\ndescription: "Web \\"Open In...\\" controls"\n---\n\n# escaped\n\n## Summary\n\nBody.\n',
    'packages/g/block/README.md': '---\ndescription: >-\n  folded\n---\n\n# block\n\n## Summary\n\nBody.\n',
    'packages/g/long/README.md': `---\ndescription: "Head."\n---\n\n# long\n\n## Summary\n\n${'x'.repeat(3_000)}\n`,
  }, async dir => {
    const text = Object.fromEntries((await buildDshIndex(dir)).entries.map(e => [e.title, e.text]));
    assert.equal(text.lead, 'Short pitch. Long form.');
    assert.equal(text.same, 'Short pitch. Then more.');
    assert.equal(text.lone, "It's single quoted Intro."); // no Summary: the description leads the leading text
    assert.equal(text.escaped, 'Web "Open In..." controls Body.');
    assert.equal(text.block, 'Body.'); // block scalars are not read
    assert.equal(text.long, `Head. ${'x'.repeat(1_194)}`); // the 1,200 cap covers description and Summary together
  });
});

test('titles lose inline-code ticks and a leading BOM, ignore headings inside code fences and fall back to the path', async () => {
  await withMirror({
    'packages/g/bom/README.md': `${String.fromCharCode(0xfeff)}# bom\n\n## Summary\n\nWith BOM.\n`,
    'packages/g/ticks/README.md': '# `@deepseek-ai/dsh-ticks`\n\n## Summary\n\nTicked.\n',
    'packages/g/fenced/README.md': 'Intro.\n\n```bash\n# not a title\n## Summary\n```\n',
    '.agents/notes/proposed/feature/untitled.md': 'No heading here.\n',
  }, async dir => {
    const { entries } = await buildDshIndex(dir);
    assert.deepEqual(entries.map(e => [e.id, e.title, e.text]), [
      ['packages/g/bom', 'bom', 'With BOM.'],
      ['packages/g/fenced', 'packages/g/fenced/README.md', 'Intro. ```bash # not a title ## Summary ```'],
      ['packages/g/ticks', '@deepseek-ai/dsh-ticks', 'Ticked.'],
      ['.agents/notes/proposed/feature/untitled.md', '.agents/notes/proposed/feature/untitled.md', 'No heading here.'],
    ]);
  });
});

test('only packages/<group>/<name>/README.md is a package, listed in path order; its id is the directory, so equal titles do not collide', async () => {
  await withMirror({
    'packages/README.md': '# Packages\n',
    'packages/z/b/README.md': '# same\n',
    'packages/a/README.md': '# Group a\n',
    'packages/a/z/README.md': '# az\n',
    'packages/a/b/README.md': '# ab\n',
    'packages/a/b/tests/fuzz/README.md': '# Fuzz notes\n', // a README inside a package, not a package
    'packages/m/m/README.zh.md': '# translated\n',
    'packages/m/m/README.md': '# same\n',
    'packages/node_modules/dep/README.md': '# dep\n', // installed dependencies are not part of the mirror's own packages
  }, async dir => {
    assert.deepEqual((await buildDshIndex(dir)).entries.map(e => [e.id, e.path, e.title]), [
      ['packages/a/b', 'packages/a/b/README.md', 'ab'],
      ['packages/a/z', 'packages/a/z/README.md', 'az'],
      ['packages/m/m', 'packages/m/m/README.md', 'same'],
      ['packages/z/b', 'packages/z/b/README.md', 'same'],
    ]);
  });
});

test('every fixture entry has its own (kind, id): package directory, catalog package name, note path', async () => {
  const { entries } = await buildDshIndex(mirror);
  assert.deepEqual(entries.map(e => `${e.kind} ${e.id}`), [
    'package packages/core/tools',
    'package packages/experimental/worktree',
    'package packages/subagent/subagent-codex',
    'config @deepseek-ai/dsh-experimental-worktree',
    'config @deepseek-ai/dsh-agent-loop',
    'note .agents/notes/implemented/feature/2026-01-01-sample.md',
  ]);
});

test('only package sections of the catalog are config entries; the appendix tables are not', async () => {
  const index = await buildDshIndex(mirror);
  const configs = index.entries.filter(e => e.kind === 'config');
  assert.deepEqual(configs.map(e => e.id), ['@deepseek-ai/dsh-experimental-worktree', '@deepseek-ai/dsh-agent-loop']);
  assert.deepEqual(searchIndex(index, 'widget'), []); // occurs only in the appendix table
  assert.deepEqual(searchIndex(index, 'library'), []); // occurs only in the appendix heading
  assert.doesNotMatch(configs[1]!.text, /widget|Library/); // the last package section ends at the appendix heading
});

test('a mirror path that is not a directory is an error; an empty mirror is fine', async () => {
  await withMirror({ 'a-file': 'x' }, async dir => {
    for (const bad of [join(dir, 'missing'), join(dir, 'a-file'), '']) await assert.rejects(buildDshIndex(bad), { name: 'ValidationError', message: /existing directory/ }, bad);
    assert.deepEqual((await buildDshIndex(dir)).entries, []);
  });
});

test('a missing packages directory, dangling symlinks and symlinked directories neither fail nor duplicate the index', async () => {
  await withMirror({}, async empty => {
    const index = await buildDshIndex(empty);
    assert.deepEqual(index.entries, []);
    assert.equal(index.mirror, empty);
  });
  await withMirror({
    'packages/g/ok/README.md': '# ok\n\n## Summary\n\nFine.\n',
    'packages/g/broken/.keep': '',
    '.agents/notes/implemented/feature/real.md': '# Real\n',
  }, async dir => {
    await symlink('missing.md', join(dir, 'packages/g/broken/README.md')); // dangling, cannot be stat'ed
    await symlink('../ok', join(dir, 'packages/g/linked')); // would list ok/README.md a second time under another name
    await symlink('missing.md', join(dir, '.agents/notes/implemented/feature/dangling.md'));
    const { entries } = await buildDshIndex(dir);
    assert.deepEqual(entries.map(e => e.path), ['packages/g/ok/README.md', '.agents/notes/implemented/feature/real.md']);
  });
});

test('roots behind a symlink are skipped, whether the root itself or a directory above it is linked', async () => {
  await withMirror({
    'packages/g/n/README.md': '# n\n\n## Summary\n\nLinked.\n',
    'catalog.md': '## `@deepseek-ai/dsh-x`\n\nLinked.\n',
    'notes/feature/a.md': '# A\n',
    '.agents/notes/implemented/feature/b.md': '# B\n',
  }, async target => {
    await withMirror({ '.agents/notes/proposed/feature/own.md': '# Own\n' }, async dir => {
      await symlink(join(target, 'packages'), join(dir, 'packages')); // the packages root
      await mkdir(join(dir, 'docs'));
      await symlink(join(target, 'catalog.md'), join(dir, 'docs/config-catalog.md')); // the catalog file
      await symlink(join(target, 'notes'), join(dir, '.agents/notes/implemented')); // one notes root
      assert.deepEqual((await buildDshIndex(dir)).entries.map(e => e.title), ['Own']);
    });
    await withMirror({}, async dir => {
      await symlink(join(target, '.agents'), join(dir, '.agents')); // a directory above the notes roots
      assert.deepEqual((await buildDshIndex(dir)).entries, []);
    });
  });
});

test('notes are filtered by file name and status folder, not by the mirror path', async () => {
  await withMirror({
    '.agents/notes/implemented/AGENTS.md': '# Rules for agents\n',
    '.agents/notes/implemented/feature/2026-01-01-a.md': '# A\n\nBody.\n',
    '.agents/notes/implemented/feature/2026-01-01-a.zh.md': '# 甲\n',
    '.agents/notes/implemented/feature/2026-01-01-a.i18n.yaml': 'title: A\n',
    '.agents/notes/proposed/process/2026-01-02-b.md': '# B\n',
    '.agents/notes/rejected/feature/2026-01-03-c.md': '# C\n',
  }, async dir => {
    await symlink('AGENTS.md', join(dir, '.agents/notes/implemented/CLAUDE.md'));
    const { entries } = await buildDshIndex(dir);
    // The mirror's own path contains both AGENTS and CLAUDE; matching them against the whole path would drop every note.
    assert.deepEqual(entries.map(e => [e.kind, e.path, e.title]), [
      ['note', '.agents/notes/implemented/feature/2026-01-01-a.md', 'A'],
      ['note', '.agents/notes/proposed/process/2026-01-02-b.md', 'B'],
    ]);
  }, 'oc-AGENTS-CLAUDE-');
});

test('query words match whole words only; stopwords, numbers and the package scope never score', async () => {
  const index = await buildDshIndex(mirror);
  // The catalog text mentions `sandbox`, and every package title starts with @deepseek-ai/.
  for (const query of ['and', 'sand', 'box', 'ai', 'deepseek', 'to the in', '2026']) assert.deepEqual(searchIndex(index, query), [], query);
  assert.deepEqual(searchIndex(index, 'sandbox').map(e => e.id), ['@deepseek-ai/dsh-experimental-worktree']); // the whole word is found
  assert.deepEqual(searchIndex(index, 'tool').map(e => e.id), ['packages/core/tools']); // a trailing s is tolerated: tool finds the title "tools"
  assert.deepEqual(searchIndex(index, 'worktrees', 10, 'package').map(e => e.id), ['packages/experimental/worktree', 'packages/subagent/subagent-codex']); // and the other way round
  const dated = indexOf(note('n', 'x', '2026 release'));
  assert.deepEqual(searchIndex(dated, '2026'), []);
  assert.deepEqual(searchIndex(dated, '2026 release').map(e => e.id), ['n']);
});

test('managed worktree tools ranks the worktree package first among the packages', async () => {
  const index = await buildDshIndex(mirror);
  // The title says worktree and the description repeats it, which lifts the package above the one whose title merely says tools.
  assert.deepEqual(searchIndex(index, 'managed worktree tools', 5, 'package').map(e => e.id), ['packages/experimental/worktree', 'packages/core/tools', 'packages/subagent/subagent-codex']);
});

test('mixed-script queries split at script boundaries, punctuation and CamelCase, and entries are indexed both whole and split', () => {
  const index = indexOf(
    note('title', 'Worktree', ''),
    note('latin', 'x', 'mcp oauth'),
    note('cjk', 'x', '服务器 登录'),
    note('long', 'x', '创建工作树工具'),
  );
  const ids = (query: string) => searchIndex(index, query, 10).map(e => e.id);
  // One changelog sentence: Latin words sit between Chinese ones with no space; the old tokenizer saw two unmatchable lumps.
  assert.deepEqual(ids('支持MCP服务器的OAuth登录，新增Worktree工具'), ['title', 'latin', 'cjk', 'long']);
  assert.deepEqual(ids('ManagedWorktreeTools'), ['title']); // CamelCase
  assert.deepEqual(ids('worktree-tools'), ['title']); // punctuation
  assert.deepEqual(ids('工作树'), ['long']); // a CJK word is found inside a longer run
  assert.deepEqual(ids('auth'), []); // OAuth is one word, not O + Auth
  // An identifier in an entry answers to the whole word and to each of its parts.
  const identifiers = indexOf(note('ident', 'x', 'WorktreeConfig and GitHub'));
  for (const query of ['worktree', 'config', 'WorktreeConfig', 'worktreeconfig', 'github', 'git', 'hub']) assert.deepEqual(searchIndex(identifiers, query).map(e => e.id), ['ident'], query);
});

test('a title hit weighs 3 and a text hit 1; ties break by path, then id, whatever the insertion order', () => {
  const byTitle = note('title', 'Alpha', 'unrelated');
  const byText = note('text', 'Unrelated', 'alpha beta'); // two text hits (2) still lose to one title hit (3)
  assert.deepEqual(searchIndex(indexOf(byText, byTitle), 'alpha beta').map(e => e.id), ['title', 'text']);
  const tied = [note('a', 'Tie', '', 'b.md'), note('z', 'Tie', '', 'a.md'), note('y2', 'Tie', '', 'c.md'), note('y1', 'Tie', '', 'c.md')];
  assert.deepEqual(searchIndex(indexOf(...tied), 'tie').map(e => e.id), ['z', 'a', 'y1', 'y2']); // path first (z is at a.md), id only within one path
  assert.deepEqual(searchIndex(indexOf(...[...tied].reverse()), 'tie').map(e => e.id), ['z', 'a', 'y1', 'y2']);
  assert.equal(searchIndex(indexOf(...tied), 'tie', 2).length, 2);
  for (const limit of [0, -1, Number.NaN]) assert.deepEqual(searchIndex(indexOf(...tied), 'tie', limit), []);
});

test('the kind filter applies before ranking and before the limit', () => {
  const index = indexOf(
    entry('package', 'packages/a/p1', 'Alpha', '', 'packages/a/p1/README.md'),
    note('n1', 'Alpha', 'alpha'), // outscores the package: 4 against 3
    entry('config', 'c1', 'Alpha', '', 'docs/config-catalog.md'),
  );
  assert.deepEqual(searchIndex(index, 'alpha').map(e => e.id), ['n1', 'c1', 'packages/a/p1']);
  assert.deepEqual(searchIndex(index, 'alpha', 1, 'package').map(e => e.id), ['packages/a/p1']); // filtering afterwards would leave nothing
  assert.deepEqual(searchIndex(index, 'alpha', 5, 'doc'), []);
});

test('isDshIndex accepts a built or reloaded index and rejects anything else; searching adds nothing to what is written out', async () => {
  const built = await buildDshIndex(mirror);
  assert.equal(built.version, 1);
  assert.ok(isDshIndex(built));
  assert.ok(isDshIndex(JSON.parse(JSON.stringify(built))));
  const first = built.entries[0]!;
  const patched = (patch: Record<string, unknown>) => ({ ...built, ...patch });
  const rejected = [
    null, undefined, 'x', 1, [], {}, patched({ version: 2 }), patched({ version: undefined }), patched({ builtAt: 1 }), patched({ commit: null }), patched({ mirror: undefined }),
    patched({ entries: {} }), patched({ entries: [null] }), patched({ entries: [{ ...first, kind: 'bogus' }] }), patched({ entries: [{ ...first, text: 5 }] }), patched({ entries: [{ kind: 'note' }] }),
  ];
  rejected.forEach((value, i) => assert.equal(isDshIndex(value), false, `rejected[${i}]`));
  const written = JSON.stringify(built);
  searchIndex(built, 'managed worktree tools');
  assert.equal(JSON.stringify(built), written); // the derived word sets stay in memory
});

test('the mirror is only read, and a commit is reported only for a mirror that is its own git checkout', async () => {
  const snapshot = async (root: string) => Promise.all((await readdir(root, { recursive: true })).sort().map(async name => { const s = await lstat(join(root, name)); return [name, s.size, s.mtimeMs]; }));
  const before = await snapshot(mirror);
  const index = await buildDshIndex(mirror);
  assert.equal(index.mirror, mirror); // stored exactly as given; entry paths are relative to it
  assert.equal(index.commit, 'unknown'); // the fixture sits inside this repository's checkout, not in a checkout of its own
  assert.deepEqual(await snapshot(mirror), before);
  await withMirror({ 'packages/g/n/README.md': '# n\n' }, async dir => {
    const head = commitIn(dir);
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.equal((await buildDshIndex(dir)).commit, head);
  });
});

test('git answers for the mirror even when the caller exports GIT_DIR and GIT_INDEX_FILE, as git hooks do', async () => {
  await withMirror({ 'packages/g/n/README.md': '# n\n' }, async dir => {
    await withMirror({ 'other.txt': 'another repository\n' }, async decoy => {
      const head = commitIn(dir), other = commitIn(decoy);
      assert.notEqual(head, other);
      await withEnv({ GIT_DIR: join(decoy, '.git'), GIT_INDEX_FILE: join(decoy, '.git', 'index') }, async () => {
        assert.equal((await buildDshIndex(dir)).commit, head);
      });
    });
  });
});

test('the commit is unknown when HEAD moved while the index was built', { skip: process.platform === 'win32' }, async () => {
  // A stand-in `git` first on PATH: it logs every call and the GIT_* variables it received, and reports a different HEAD from its second call on.
  const bin = await mkdtemp(join(tmpdir(), 'oc-fake-git-'));
  try {
    const script = `#!/bin/sh\necho "$*" >> '${bin}/calls.log'\nenv | grep '^GIT_' >> '${bin}/env.log'\nn=$(wc -l < '${bin}/calls.log' | tr -d ' ')\nif [ "$n" -le 1 ]; then echo ${'a'.repeat(40)}; else cat '${bin}/second'; fi\n`;
    await writeFile(join(bin, 'git'), script, { mode: 0o755 });
    const build = async (second: string) => {
      await Promise.all([writeFile(join(bin, 'second'), `${second}\n`), writeFile(join(bin, 'calls.log'), ''), writeFile(join(bin, 'env.log'), '')]);
      let commit = '';
      await withMirror({ 'packages/g/n/README.md': '# n\n', '.git/HEAD': 'ref: refs/heads/main\n' }, async dir => {
        await withEnv({ PATH: `${bin}${delimiter}${process.env.PATH}`, GIT_DIR: '/nonexistent/.git', GIT_INDEX_FILE: '/nonexistent/index' }, async () => { commit = (await buildDshIndex(dir)).commit; });
      });
      return { commit, calls: (await readFile(join(bin, 'calls.log'), 'utf8')).trim().split('\n'), env: await readFile(join(bin, 'env.log'), 'utf8') };
    };
    const moved = await build('b'.repeat(40));
    assert.equal(moved.commit, 'unknown');
    assert.equal(moved.calls.length, 2); // HEAD is read before the walk and again after it
    assert.match(moved.calls[0]!, /^-C .+ rev-parse HEAD$/);
    assert.equal(moved.env, ''); // no GIT_* variable reached git
    assert.equal((await build('a'.repeat(40))).commit, 'a'.repeat(40)); // the same HEAD twice is a stable commit
  } finally { await rm(bin, { recursive: true, force: true }); }
});
