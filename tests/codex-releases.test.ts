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

test('a bullet wrapped onto continuation lines is read whole, trailing PR list included', () => {
  const body = [
    '## New Features',
    '',
    '- Add tools for creating and listing',
    '  managed Git worktrees from trusted',
    'local projects. (#50148,',
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
const pullRequest = (n: number): PullRequest => ({
  number: n, title: `PR ${n} title`, body: '', url: `${PULL_URL}/${n}`, additions: 3, deletions: 1,
  files: [{ path: `codex-rs/tui/src/pr${n}.rs`, additions: 2, deletions: 1 }, { path: `docs/pr${n}.md`, additions: 1, deletions: 0 }],
});
const excerptOf = (n: number): string => `PR ${n} title\ncodex-rs/tui/src/pr${n}.rs\ndocs/pr${n}.md`;

type ReleasesGitHub = Pick<GitHubClient, 'stableTags' | 'release' | 'pullRequest'>;
/** `state` can be changed between runs (a new release, a failing PR); `calls` records what the collector asked for. */
function stubGitHub(tags: string[], releases: Release[]) {
  const state = { tags, releases: new Map(releases.map(r => [r.tag, r])), failing: new Set<number>() };
  const calls = { stableTags: [] as number[], release: [] as string[], pullRequest: [] as number[] };
  const github: ReleasesGitHub = {
    stableTags: async limit => { calls.stableTags.push(limit); return state.tags.slice(0, limit); },
    release: async tag => {
      calls.release.push(tag);
      const found = state.releases.get(tag);
      if (!found) throw new Error(`no release ${tag}`);
      return found;
    },
    pullRequest: async n => {
      calls.pullRequest.push(n);
      if (state.failing.has(n)) throw new Error(`GitHub HTTP 404 for repos/openai/codex/pulls/${n}`);
      return pullRequest(n);
    },
  };
  return { github, state, calls };
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
    assert.deepEqual(first, { window: { from: 'rust-v0.161.0', to: 'rust-v0.162.1', releases: ['rust-v0.162.1', 'rust-v0.162.0'] }, added: 3, gap: false });
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
    assert.deepEqual(stub.calls.stableTags, [12, 12]);
    assert.equal(stub.calls.release.length, releaseCalls);
    assert.equal(stub.calls.pullRequest.length, pullCalls);
    assert.deepEqual(await store.list({ source: 'codex-release' }), stored);

    // A new stable release opens a window that starts at the checkpoint.
    stub.state.tags.unshift('rust-v0.163.0');
    stub.state.releases.set('rust-v0.163.0', release('rust-v0.163.0', notes('Add delta pane. (#60030)')));
    const third = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(third, { window: { from: 'rust-v0.162.1', to: 'rust-v0.163.0', releases: ['rust-v0.163.0'] }, added: 1, gap: false });
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
    assert.deepEqual(result, { window: { from: 'rust-v0.162.0', to: 'rust-v0.164.0', releases: ['rust-v0.164.0', 'rust-v0.163.0', 'rust-v0.162.1'] }, added: 3, gap: false });
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
    assert.deepEqual(result, { window: { from: 'rust-v0.161.0', to: 'rust-v0.162.1', releases: ['rust-v0.162.1', 'rust-v0.162.0'] }, added: 2, gap: true });
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
    const [beta] = await store.list({ source: 'codex-release' });
    assert.deepEqual(beta!.evidence, [
      { kind: 'pr', ref: '#60010', url: `${PULL_URL}/60010`, excerpt: excerptOf(60010) },
      { kind: 'pr', ref: '#60011' },
      { kind: 'pr', ref: '#60012', url: `${PULL_URL}/60012`, excerpt: excerptOf(60012) },
    ]);
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
