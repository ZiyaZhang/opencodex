import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildDshIndex, searchIndex, type DshIndex, type IndexEntry } from '../src/host/index/dsh-index.ts';

const mirror = new URL('./fixtures/mirror/', import.meta.url).pathname;

/** Builds a throwaway mirror from `{ relative path: contents }`, runs `check` on it and always removes it. */
async function withMirror(files: Record<string, string>, check: (dir: string) => Promise<void>, prefix = 'oc-index-'): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    for (const [path, body] of Object.entries(files)) { await mkdir(dirname(join(dir, path)), { recursive: true }); await writeFile(join(dir, path), body); }
    await check(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const note = (id: string, title: string, text: string, path = id): IndexEntry => ({ kind: 'note', id, title, path, text });
const indexOf = (...entries: IndexEntry[]): DshIndex => ({ builtAt: '2026-10-15T00:00:00.000Z', commit: 'unknown', mirror: '/mirror', entries });

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
    'packages/g/plain/README.md': '---\ndescription: "front matter is not text"\n---\n\n# plain\n\nFirst   line\twith  gaps.\n\nSecond paragraph.\n\n## Usage\n\nBody text that stays out.\n',
    'packages/g/empty/README.md': '# empty\n\nLead text.\n\n## Summary\n\n## Usage\n\nBody.\n',
    'packages/g/prefix/README.md': '# prefix\n\nLead.\n\n## Summary of changes\n\nNot the summary.\n',
    'packages/g/long/README.md': `# long\n\n## Summary\n\n${'x'.repeat(3_000)}\n`,
    'packages/g/emoji/README.md': `# emoji\n\n## Summary\n\n${'x'.repeat(1_199)}\u{1F600}tail\n`,
  }, async dir => {
    const text = Object.fromEntries((await buildDshIndex(dir)).entries.map(e => [e.id, e.text]));
    assert.equal(text.plain, 'First line with gaps. Second paragraph.');
    assert.equal(text.empty, 'Lead text.');
    assert.equal(text.prefix, 'Lead.'); // `## Summary of changes` is another section
    assert.equal(text.long, 'x'.repeat(1_200));
    assert.equal(text.emoji, 'x'.repeat(1_199)); // the cut would fall inside the emoji's surrogate pair, so the half pair goes
  });
});

test('searchIndex splits camelCase, ignores one-character tokens and returns nothing without a hit', async () => {
  const index = await buildDshIndex(mirror);
  assert.deepEqual(searchIndex(index, 'zzzz qqqq'), []);
  assert.deepEqual(searchIndex(index, ''), []);
  assert.deepEqual(searchIndex(index, 'a e x'), []); // each of these letters occurs in the fixture, so a one-character token would score
  assert.deepEqual(searchIndex(index, 'x a worktree'), searchIndex(index, 'worktree'));
  assert.equal(searchIndex(index, 'SubagentCodex')[0]?.path, 'packages/subagent/subagent-codex/README.md'); // a naive tokenizer sees one unknown word
  assert.deepEqual(searchIndex(index, '中文 x').map(e => e.kind), ['note']); // a run of CJK characters is one word, found in the sample note's language link
});

test('package text is the Summary only; config and note text drop their own heading and any generated markers', async () => {
  const { entries } = await buildDshIndex(mirror);
  const find = (kind: IndexEntry['kind'], id: string) => entries.find(e => e.kind === kind && e.id === id)!;
  assert.equal(find('package', '@deepseek-ai/dsh-experimental-worktree').text, 'Create an isolated checkout from a local commit and continue the same Session in it.');
  const config = find('config', '@deepseek-ai/dsh-experimental-worktree');
  assert.equal(config.path, 'docs/config-catalog.md');
  assert.deepEqual(entries.filter(e => e.kind === 'config').map(e => e.id), ['@deepseek-ai/dsh-experimental-worktree', '@deepseek-ai/dsh-agent-loop']); // the catalog's own title is no entry
  assert.doesNotMatch(config.text, /<!--|<a id|dsh-agent-loop/); // the next section's BEGIN marker trails this one in the file
  assert.match(config.text, /^- `inject`: `fs` · `sandbox` - `source`: \[`packages\/experimental\/worktree\/src\/index\.ts:30`\]/);
  const sample = find('note', '.agents/notes/implemented/feature/2026-01-01-sample.md');
  assert.equal(sample.title, 'Agent Note: Sample decision record [implemented]');
  assert.equal(sample.text, 'Status: implemented English | [中文](2026-01-01-sample.zh.md) ## Problem A sample note for the index tests.');
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
      ['bom', 'bom', 'With BOM.'],
      ['packages/g/fenced/README.md', 'packages/g/fenced/README.md', 'Intro. ```bash # not a title ## Summary ```'],
      ['@deepseek-ai/dsh-ticks', '@deepseek-ai/dsh-ticks', 'Ticked.'],
      ['.agents/notes/proposed/feature/untitled.md', '.agents/notes/proposed/feature/untitled.md [proposed]', 'No heading here.'],
    ]);
  });
});

test('only packages/<group>/<name>/README.md is a package, listed in path order', async () => {
  await withMirror({
    'packages/README.md': '# Packages\n',
    'packages/z/b/README.md': '# zb\n',
    'packages/a/README.md': '# Group a\n',
    'packages/a/z/README.md': '# az\n',
    'packages/a/b/README.md': '# ab\n',
    'packages/a/b/tests/fuzz/README.md': '# Fuzz notes\n', // a README inside a package, not a package
    'packages/m/m/README.zh.md': '# translated\n',
    'packages/m/m/README.md': '# mm\n',
    'packages/node_modules/dep/README.md': '# dep\n', // installed dependencies are not part of the mirror's own packages
  }, async dir => {
    assert.deepEqual((await buildDshIndex(dir)).entries.map(e => e.path), ['packages/a/b/README.md', 'packages/a/z/README.md', 'packages/m/m/README.md', 'packages/z/b/README.md']);
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
    assert.deepEqual(entries.map(e => [e.kind, e.title]), [['note', 'A [implemented]'], ['note', 'B [proposed]']]);
  }, 'oc-AGENTS-CLAUDE-');
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

test('the mirror is only read, and a commit is reported only when the mirror is its own git checkout', async () => {
  const snapshot = async (root: string) => Promise.all((await readdir(root, { recursive: true })).sort().map(async name => { const s = await lstat(join(root, name)); return [name, s.size, s.mtimeMs]; }));
  const before = await snapshot(mirror);
  const index = await buildDshIndex(mirror);
  assert.equal(index.mirror, mirror); // stored exactly as given; entry paths are relative to it
  assert.equal(index.commit, 'unknown'); // the fixture sits inside this repository's checkout, not in a checkout of its own
  assert.deepEqual(await snapshot(mirror), before);
  await withMirror({ 'packages/g/n/README.md': '# n\n' }, async dir => {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const head = git('rev-parse', 'HEAD').trim();
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.equal((await buildDshIndex(dir)).commit, head);
  });
});
