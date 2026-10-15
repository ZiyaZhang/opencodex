import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandidateStore } from '../src/core/store.ts';
import type { GitHubClient, PullRequest, Release } from '../src/host/github.ts';
import { collectReleases, parseReleaseBody, stableWindow } from '../src/host/sources/codex-releases.ts';

const readFixture = () => readFile(new URL('./fixtures/release-0.162.0.md', import.meta.url), 'utf8');

test('parse only New Features bullets with their PR numbers', async () => {
  const body = await readFixture();
  const features = parseReleaseBody(body);
  assert.equal(features.length, 6);
  assert.equal(features[0]!.prs[0], 50148);
  assert.match(features[0]!.text, /managed Git worktrees/);
  assert.deepEqual(features[2]!.prs, [50434, 50215, 50209]);
});

test('the 0.162.0 notes give one feature per bullet, and the PR list stays out of the text', async () => {
  const features = parseReleaseBody(await readFixture());
  assert.deepEqual(features.map(f => f.prs[0]), [50148, 51500, 50434, 51439, 50459, 51126]);
  assert.deepEqual(features.map(f => f.prs.length), [1, 1, 3, 6, 1, 2]);
  assert.equal(features[0]!.text, 'Add tools for creating and listing managed Git worktrees from trusted local projects when the worktrees feature is enabled.');
  assert.equal(features[4]!.text, 'Configure live web access and remote compaction capabilities for custom Responses-compatible model providers.');
  assert.ok(features.every(f => !/\(#|#\d{3}/.test(f.text)));
  // Bug Fixes, Chores and the Changelog list are not features: 50013 is in Bug Fixes and the Changelog, 51158 in Chores.
  assert.ok(!features.some(f => f.prs.includes(50013) || f.prs.includes(51158)));
});

test('CRLF line endings parse like LF (the 0.158.0 notes ship with CRLF)', async () => {
  const body = await readFixture();
  const crlf = parseReleaseBody(body.replace(/\n/g, '\r\n'));
  assert.equal(crlf.length, 6);
  assert.deepEqual(crlf, parseReleaseBody(body));
});

test('a release without a New Features section gives no features', () => {
  // Patch releases are often bug-fix only (0.162.1, 0.160.1).
  assert.deepEqual(parseReleaseBody('## Bug Fixes\n\n- Fix a crash. (#51203)\n\n## Changelog\n\n- #51203 Fix a crash @someone\n'), []);
  assert.deepEqual(parseReleaseBody(''), []);
});

test('the PR list leaves the text in the other shapes older notes used', () => {
  // A period after the closing parenthesis (0.123.0, 0.137.0) and markdown links (0.153.0).
  const body = [
    '## New Features',
    '',
    '- Add a sample provider (#18744).',
    '- Support more keybindings in the composer (#25329, #25400, #25504).',
    '- Support undo in Vim mode. ([#41941](https://github.com/openai/codex/pull/41941), [#42140](https://github.com/openai/codex/pull/42140))',
    '',
  ].join('\n');
  assert.deepEqual(parseReleaseBody(body), [
    { text: 'Add a sample provider', prs: [18744] },
    { text: 'Support more keybindings in the composer', prs: [25329, 25400, 25504] },
    { text: 'Support undo in Vim mode.', prs: [41941, 42140] },
  ]);
});

test('a bullet wrapped onto indented continuation lines is read whole, trailing PR list included', () => {
  const body = [
    '## New Features',
    '',
    '- Add tools for creating and listing',
    '  managed Git worktrees from trusted',
    '\tlocal projects. (#50148,',
    '  #50149)',
    '- Pin tasks in the Command Center. (#51500)',
    '',
    'A paragraph after the list is not part of the last bullet. (#50000)',
    '',
  ].join('\n');
  assert.deepEqual(parseReleaseBody(body), [
    { text: 'Add tools for creating and listing managed Git worktrees from trusted local projects.', prs: [50148, 50149] },
    { text: 'Pin tasks in the Command Center.', prs: [51500] },
  ]);
});

test('an un-indented line under a bullet is not part of it, whether it ends the list or sits between bullets', () => {
  // The changelog link right under the last bullet, with no blank line before it.
  const changelog = '**Full Changelog**: https://github.com/openai/codex/compare/rust-v0.161.0...rust-v0.162.0';
  assert.deepEqual(parseReleaseBody(['## New Features', '', '- Pin tasks in the Command Center. (#51500)', changelog, ''].join('\n')), [
    { text: 'Pin tasks in the Command Center.', prs: [51500] },
  ]);
  assert.deepEqual(parseReleaseBody(['## New Features', '', '- Pin tasks in the Command Center. (#51500)', changelog, '- Add worktree tools. (#50148)', ''].join('\n')), [
    { text: 'Pin tasks in the Command Center.', prs: [51500] },
    { text: 'Add worktree tools.', prs: [50148] },
  ]);
});

test('a nested sub-bullet is a feature of its own only when it carries its own PR number', () => {
  const body = [
    '## New Features',
    '',
    '- Add worktree tools. (#50148)',
    '  - list tool (#50150)',
    '  - create tool',
    '- Pin tasks. (#51500)',
    '',
  ].join('\n');
  assert.deepEqual(parseReleaseBody(body), [
    { text: 'Add worktree tools.', prs: [50148] },
    { text: 'list tool', prs: [50150] },
    { text: 'Pin tasks.', prs: [51500] },
  ]);
});

test('bullets without a PR number are dropped, and a PR number repeated in one bullet counts once', () => {
  const body = '## New Features\n\n- A note without any reference.\n- Tune the cache. (#50434, #50215, #50434)\n- (#50999)\n';
  assert.deepEqual(parseReleaseBody(body), [{ text: 'Tune the cache.', prs: [50434, 50215] }]);
});

test('a sub-heading stays inside New Features, the next level-2 heading ends it', () => {
  const body = [
    '## New Features',
    '',
    '### CLI',
    '',
    '- One. (#10001)',
    '',
    '### Desktop',
    '- Two. (#10002)',
    '## Bug Fixes',
    '',
    '- Three. (#10003)',
    '',
  ].join('\n');
  assert.deepEqual(parseReleaseBody(body).map(f => f.prs), [[10001], [10002]]);
});

test('a level-1 heading ends the New Features section', () => {
  const body = ['## New Features', '', '- One. (#10001)', '', '# Appendix', '', '- Two. (#10002)', ''].join('\n');
  assert.deepEqual(parseReleaseBody(body).map(f => f.prs), [[10001]]);
});

test('window starts at the checkpoint, or at the previous minor on first run', () => {
  const tags = ['rust-v0.163.0', 'rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0', 'rust-v0.160.1', 'rust-v0.160.0'];
  assert.deepEqual(stableWindow(tags), { from: 'rust-v0.162.1', to: 'rust-v0.163.0', releases: ['rust-v0.163.0'] });
  assert.deepEqual(stableWindow(tags, 'rust-v0.161.0'), { from: 'rust-v0.161.0', to: 'rust-v0.163.0', releases: ['rust-v0.163.0', 'rust-v0.162.1', 'rust-v0.162.0'] });
  assert.deepEqual(stableWindow(tags, 'rust-v0.163.0'), undefined);
  assert.deepEqual(stableWindow(tags.slice(1)), { from: 'rust-v0.161.0', to: 'rust-v0.162.1', releases: ['rust-v0.162.1', 'rust-v0.162.0'] });
});

test('window edge cases: a checkpoint missing from the list, a single minor, no tags', () => {
  const tags = ['rust-v0.163.0', 'rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'];
  assert.deepEqual(stableWindow(tags, 'rust-v0.100.0'), stableWindow(tags));
  assert.equal(stableWindow(['rust-v0.162.1', 'rust-v0.162.0']), undefined);
  assert.equal(stableWindow([]), undefined);
});

// --- collectReleases: a temp-dir store and a stub GitHub client, no network ---

const PULL_URL = 'https://github.com/openai/codex/pull';
const release = (tag: string, body: string, prerelease = false): Release => ({ tag, publishedAt: '2026-10-08T00:00:00Z', body, prerelease });
/** Release notes shaped like the real ones: New Features first, then sections whose bullets must not become candidates. */
const notes = (...bullets: string[]): string =>
  `## New Features\n\n${bullets.map(b => `- ${b}`).join('\n')}\n\n## Bug Fixes\n\n- Fix a crash. (#99999)\n\n## Changelog\n\n- #99998 Unrelated change @someone\n`;
const pathsOf = (n: number, count: number): string[] => Array.from({ length: count }, (_, i) => `codex-rs/pr${n}/file${i}.rs`);
const pullRequest = (n: number, fileCount: number): PullRequest => ({
  number: n, title: `PR ${n} title`, body: '', url: `${PULL_URL}/${n}`, additions: 3, deletions: 1,
  files: pathsOf(n, fileCount).map(path => ({ path, additions: 1, deletions: 0 })),
});
/** The evidence excerpt of a stub pull request with its default two files: the title, then one path per line. */
const excerptOf = (n: number): string => [`PR ${n} title`, ...pathsOf(n, 2)].join('\n');
/** `n` characters that tell their position apart, so a cut in the wrong place shows. */
const digits = (n: number): string => Array.from({ length: n }, (_, i) => String(i % 10)).join('');

type ReleasesGitHub = Pick<GitHubClient, 'stableTags' | 'release' | 'pullRequest'>;
type Signals = Array<AbortSignal | undefined>;
/** `state` can be changed between runs (a new release, a failing PR, a large PR); `calls` records what the collector asked for and `signals` the signal it passed along. */
function stubGitHub(tags: string[], releases: Release[]) {
  const state = { tags, releases: new Map(releases.map(r => [r.tag, r])), failing: new Set<number>(), fileCount: 2 };
  const calls = { stableTags: [] as number[], release: [] as string[], pullRequest: [] as number[] };
  const signals = { stableTags: [] as Signals, release: [] as Signals, pullRequest: [] as Signals };
  const github: ReleasesGitHub = {
    stableTags: async (limit, signal) => { calls.stableTags.push(limit); signals.stableTags.push(signal); return state.tags.slice(0, limit); },
    release: async (tag, signal) => {
      calls.release.push(tag); signals.release.push(signal);
      const found = state.releases.get(tag);
      if (!found) throw new Error(`no release ${tag}`);
      return found;
    },
    pullRequest: async (n, signal) => {
      calls.pullRequest.push(n); signals.pullRequest.push(signal);
      if (state.failing.has(n)) throw new Error(`GitHub HTTP 404 for repos/openai/codex/pulls/${n}`);
      return pullRequest(n, state.fileCount);
    },
  };
  return { github, state, calls, signals };
}

/** A store whose clock advances one second per write, so `updatedAt` order is the order of the writes. */
async function withStore(run: (store: CandidateStore, snapshotDir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'oc-releases-'));
  try {
    let seconds = 0;
    await run(new CandidateStore(join(dir, 'data'), () => new Date(Date.UTC(2026, 9, 15, 0, 0, seconds++))), join(dir, 'snapshots'));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const snapshotPath = (snapshotDir: string, tag: string) => join(snapshotDir, 'codex-releases', `${tag}.json`);

test('collectReleases: the first run covers the releases since the previous minor, oldest first; a second run does nothing', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.1', notes('Add alpha tool. (#60001)')),
      release('rust-v0.162.0', notes('Add beta view. (#60010, #60011)', 'Add gamma flag. (#60020)')),
      release('rust-v0.161.0', notes('Add an old thing. (#59000)')),
    ]);

    const first = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(first, { window: { from: 'rust-v0.161.0', to: 'rust-v0.162.1', releases: ['rust-v0.162.1', 'rust-v0.162.0'] }, added: 3, gap: false, prLookupFailures: 0 });
    assert.deepEqual(stub.calls.stableTags, [12]);
    // Oldest first, and the starting point 0.161.0 was seen before the window opened: it is neither fetched nor collected.
    assert.deepEqual(stub.calls.release, ['rust-v0.162.0', 'rust-v0.162.1']);

    const stored = await store.list({ source: 'codex-release' });
    assert.equal(stored.length, 3);
    assert.equal(stored[0]!.title, 'Add alpha tool.'); // the newest release was written last, so it is on top
    const beta = stored.find(c => c.fingerprint === 'codex-release:pr:60010')!;
    assert.equal(beta.status, 'new');
    assert.equal(beta.title, 'Add beta view.');
    assert.equal(beta.summary, 'Add beta view.');
    assert.deepEqual(beta.window, { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.0' });
    assert.deepEqual(beta.evidence, [
      { kind: 'pr', ref: '#60010', url: `${PULL_URL}/60010`, excerpt: excerptOf(60010) },
      { kind: 'pr', ref: '#60011', url: `${PULL_URL}/60011`, excerpt: excerptOf(60011) },
    ]);
    const alpha = stored.find(c => c.fingerprint === 'codex-release:pr:60001')!;
    assert.deepEqual(alpha.window, { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.1' });
    assert.deepEqual(alpha.evidence[0], { kind: 'pr', ref: '#60001', url: `${PULL_URL}/60001`, excerpt: excerptOf(60001) });
    // Bug Fixes and Changelog bullets are not features.
    assert.ok(!stored.some(c => c.fingerprint.endsWith(':pr:99999') || c.fingerprint.endsWith(':pr:99998')));

    for (const tag of ['rust-v0.162.1', 'rust-v0.162.0']) {
      assert.deepEqual(JSON.parse(await readFile(snapshotPath(snapshotDir, tag), 'utf8')), stub.state.releases.get(tag));
    }
    await assert.rejects(stat(snapshotPath(snapshotDir, 'rust-v0.161.0')), { code: 'ENOENT' });
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.162.1');

    // Nothing new: the tag list is read, nothing else is fetched and nothing is written.
    const releaseCalls = stub.calls.release.length, pullCalls = stub.calls.pullRequest.length;
    const second = await collectReleases(store, stub.github, snapshotDir);
    assert.equal(second.window, undefined);
    assert.equal(second.added, 0);
    assert.equal(second.gap, false);
    assert.equal(second.prLookupFailures, 0);
    assert.deepEqual(stub.calls.stableTags, [12, 12]);
    assert.equal(stub.calls.release.length, releaseCalls);
    assert.equal(stub.calls.pullRequest.length, pullCalls);
    assert.deepEqual(await store.list({ source: 'codex-release' }), stored);

    // A new stable release opens a window that starts at the checkpoint.
    stub.state.tags.unshift('rust-v0.163.0');
    stub.state.releases.set('rust-v0.163.0', release('rust-v0.163.0', notes('Add delta pane. (#60030)')));
    const third = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(third, { window: { from: 'rust-v0.162.1', to: 'rust-v0.163.0', releases: ['rust-v0.163.0'] }, added: 1, gap: false, prLookupFailures: 0 });
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.163.0');
    assert.equal((await store.list({ source: 'codex-release' }))[0]!.title, 'Add delta pane.');
  });
});

test('collectReleases: a checkpoint covers every stable release since it, across minors, and the list shows the newest release first', async () => {
  await withStore(async (store, snapshotDir) => {
    await store.setCheckpoint('lastStableTag', 'rust-v0.162.0');
    const stub = stubGitHub(['rust-v0.164.0', 'rust-v0.163.0', 'rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.164.0', notes('Add epsilon. (#60040)')),
      release('rust-v0.163.0', notes('Add delta. (#60030)')),
      release('rust-v0.162.1', notes('Add alpha. (#60001)')),
      release('rust-v0.162.0', notes('Already seen. (#60010)')),
    ]);
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(result, { window: { from: 'rust-v0.162.0', to: 'rust-v0.164.0', releases: ['rust-v0.164.0', 'rust-v0.163.0', 'rust-v0.162.1'] }, added: 3, gap: false, prLookupFailures: 0 });
    assert.deepEqual(stub.calls.release, ['rust-v0.162.1', 'rust-v0.163.0', 'rust-v0.164.0']);
    const stored = await store.list({ source: 'codex-release' });
    assert.deepEqual(stored.map(c => c.window?.toTag), ['rust-v0.164.0', 'rust-v0.163.0', 'rust-v0.162.1']);
    assert.ok(stored.every(c => c.window?.fromTag === 'rust-v0.162.0'));
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.164.0');
  });
});

test('collectReleases: a release the API marks as prerelease is skipped whole', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.1', notes('Add alpha tool. (#60001)'), true),
      release('rust-v0.162.0', notes('Add beta view. (#60010)')),
    ]);
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.equal(result.added, 1);
    assert.deepEqual((await store.list({ source: 'codex-release' })).map(c => c.fingerprint), ['codex-release:pr:60010']);
    assert.ok(!stub.calls.pullRequest.includes(60001));
    await assert.rejects(stat(snapshotPath(snapshotDir, 'rust-v0.162.1')), { code: 'ENOENT' });
    await stat(snapshotPath(snapshotDir, 'rust-v0.162.0'));
  });
});

test('collectReleases: a checkpoint older than the fetched tags reports a gap and falls back to the previous minor', async () => {
  await withStore(async (store, snapshotDir) => {
    await store.setCheckpoint('lastStableTag', 'rust-v0.100.0');
    const stub = stubGitHub(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.1', notes('Add alpha tool. (#60001)')),
      release('rust-v0.162.0', notes('Add beta view. (#60010)')),
    ]);
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(result, { window: { from: 'rust-v0.161.0', to: 'rust-v0.162.1', releases: ['rust-v0.162.1', 'rust-v0.162.0'] }, added: 2, gap: true, prLookupFailures: 0 });
    // The checkpoint moves into the list, so the next run no longer reports a gap.
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.162.1');
    assert.equal((await collectReleases(store, stub.github, snapshotDir)).gap, false);
  });
});

test('collectReleases: a pull request that cannot be fetched still gives a candidate, with a bare reference for it', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.0', 'rust-v0.161.0'], [release('rust-v0.162.0', notes('Add beta view. (#60010, #60011, #60012)'))]);
    stub.state.failing.add(60011);
    // A signal that is not aborted changes nothing: a failed lookup is still just a missing pull request.
    const result = await collectReleases(store, stub.github, snapshotDir, new AbortController().signal);
    assert.equal(result.added, 1);
    assert.equal(result.prLookupFailures, 1);
    const [beta] = await store.list({ source: 'codex-release' });
    assert.deepEqual(beta!.evidence, [
      { kind: 'pr', ref: '#60010', url: `${PULL_URL}/60010`, excerpt: excerptOf(60010) },
      { kind: 'pr', ref: '#60011' },
      { kind: 'pr', ref: '#60012', url: `${PULL_URL}/60012`, excerpt: excerptOf(60012) },
    ]);
  });
});

test('collectReleases: prLookupFailures counts every lookup that fell back to a bare reference, across bullets and releases', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.1', notes('Add alpha tool. (#60001, #60002)')),
      release('rust-v0.162.0', notes('Add beta view. (#60010)', 'Add gamma flag. (#60020, #60021)')),
    ]);
    for (const n of [60001, 60002, 60021]) stub.state.failing.add(n);
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.equal(result.added, 3); // a failed lookup never costs a candidate
    assert.equal(result.prLookupFailures, 3);
    const bare = (await store.list({ source: 'codex-release' })).flatMap(c => c.evidence).filter(e => e.url === undefined).map(e => e.ref).sort();
    assert.deepEqual(bare, ['#60001', '#60002', '#60021']);
    // Nothing is left to collect, so nothing can fail.
    assert.equal((await collectReleases(store, stub.github, snapshotDir)).prLookupFailures, 0);
  });
});

test('collectReleases: an abort is not swallowed as a missing pull request', async () => {
  await withStore(async (store, snapshotDir) => {
    const controller = new AbortController();
    const stub = stubGitHub(['rust-v0.162.0', 'rust-v0.161.0'], [release('rust-v0.162.0', notes('Add beta view. (#60010, #60011)'))]);
    stub.github.pullRequest = async () => { controller.abort(); throw new DOMException('This operation was aborted', 'AbortError'); };
    await assert.rejects(collectReleases(store, stub.github, snapshotDir, controller.signal), (error: unknown) => (error as Error).name === 'AbortError');
    assert.equal(await store.checkpoint('lastStableTag'), undefined);
    assert.deepEqual(await store.list(), []);
  });
});

test('collectReleases: a failed release fetch fails the run and keeps the checkpoint, so the next run retries the window', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.1', notes('Add alpha tool. (#60001)')),
      release('rust-v0.162.0', notes('Add beta view. (#60010)')),
    ]);
    const missing = stub.state.releases.get('rust-v0.162.1')!;
    stub.state.releases.delete('rust-v0.162.1');
    await assert.rejects(collectReleases(store, stub.github, snapshotDir), /no release rust-v0\.162\.1/);
    assert.equal(await store.checkpoint('lastStableTag'), undefined);
    assert.equal((await store.list({ source: 'codex-release' })).length, 1); // 0.162.0 went first and is already stored

    stub.state.releases.set('rust-v0.162.1', missing);
    const retry = await collectReleases(store, stub.github, snapshotDir);
    assert.equal(retry.added, 1); // only 0.162.1 is new; the stored 0.162.0 candidate is refreshed to the same content
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.162.1');
    assert.equal((await store.list({ source: 'codex-release' })).length, 2);
  });
});

test('collectReleases: the newest release is on top of the list and, within a release, the first bullet of the notes', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.1', notes('Alpha one. (#60001)', 'Alpha two. (#60002)')),
      release('rust-v0.162.0', notes('Beta one. (#60010)', 'Beta two. (#60011)')),
    ]);
    await collectReleases(store, stub.github, snapshotDir);
    const stored = await store.list({ source: 'codex-release' });
    assert.deepEqual(stored.map(c => c.title), ['Alpha one.', 'Alpha two.', 'Beta one.', 'Beta two.']);
    // list() sorts by updatedAt, newest first: each candidate was written after the one listed below it.
    for (let i = 1; i < stored.length; i++) {
      assert.ok(stored[i - 1]!.updatedAt > stored[i]!.updatedAt, `${stored[i - 1]!.title} should have been written after ${stored[i]!.title}`);
    }
  });
});

test('collectReleases: a title of up to 160 code points is the bullet itself, a longer one is cut to 160 with a trailing ellipsis', async () => {
  await withStore(async (store, snapshotDir) => {
    const exact = digits(160), over = digits(161);
    const emoji = `${'x'.repeat(158)}😀😀😀`; // 161 code points but 164 UTF-16 units: a cut by units would split the first emoji
    const stub = stubGitHub(['rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.0', notes(`${exact} (#60001)`, `${over} (#60002)`, `${emoji} (#60003)`)),
    ]);
    await collectReleases(store, stub.github, snapshotDir);
    const stored = await store.list({ source: 'codex-release' });
    const byPr = (n: number) => stored.find(c => c.fingerprint === `codex-release:pr:${n}`)!;

    assert.equal(byPr(60001).title, exact);
    assert.equal(byPr(60002).title, `${digits(159)}…`);
    assert.equal(byPr(60003).title, `${'x'.repeat(158)}😀…`);
    for (const n of [60001, 60002, 60003]) assert.equal([...byPr(n).title].length, 160);
    assert.doesNotMatch(byPr(60003).title, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/); // no half of a surrogate pair
    // The summary keeps the whole bullet.
    assert.equal(byPr(60001).summary, exact);
    assert.equal(byPr(60002).summary, over);
    assert.equal(byPr(60003).summary, emoji);
  });
});

test('collectReleases: the evidence excerpt names at most 20 files of a large pull request', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.0', 'rust-v0.161.0'], [release('rust-v0.162.0', notes('Add beta view. (#60010)'))]);
    stub.state.fileCount = 25;
    await collectReleases(store, stub.github, snapshotDir);
    const [beta] = await store.list({ source: 'codex-release' });
    const excerpt = beta!.evidence[0]!.excerpt!;
    const lines = excerpt.split('\n');
    assert.equal(lines[0], 'PR 60010 title');
    assert.deepEqual(lines.slice(1), pathsOf(60010, 20)); // the first 20 paths, in the order the pull request lists them
    assert.ok(!excerpt.includes('file20.rs'));
  });
});

test('collectReleases: the signal is passed on to stableTags, release and pullRequest', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.1', notes('Add alpha tool. (#60001)')),
      release('rust-v0.162.0', notes('Add beta view. (#60010, #60011)')),
    ]);
    const { signal } = new AbortController();
    await collectReleases(store, stub.github, snapshotDir, signal);
    // One call for the tag list, one per release in the window, one per pull request; each got the very same signal object.
    assert.equal(stub.signals.stableTags.length, 1);
    assert.equal(stub.signals.release.length, 2);
    assert.equal(stub.signals.pullRequest.length, 3);
    for (const [name, received] of Object.entries(stub.signals)) assert.ok(received.every(s => s === signal), `${name} did not receive the signal`);
  });
});
