import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candidate } from '../src/core/candidate.ts';
import { CandidateStore } from '../src/core/store.ts';
import { GitHubError, type GitHubClient, type PullRequest, type Release } from '../src/host/github.ts';
import { collectReleases, parseReleaseBody, parseReleaseNotes, stableWindow } from '../src/host/sources/codex-releases.ts';

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

test('code fences are skipped whole: a # line in a sample is no heading, and a fence under a bullet is not part of its text', () => {
  const body = [
    '## New Features',
    '',
    '```sh',
    '# a shell comment, not a heading',
    '```',
    '- Add `codex foo` with a list mode:',
    '  ```sh',
    '  # list the worktrees',
    '  - not a bullet either',
    '  codex foo --list',
    '  ```',
    '  (#50148)',
    '- Pin tasks. (#51500)',
    '',
    '## Bug Fixes',
    '',
    '~~~',
    '## New Features',
    '- Not a feature. (#99999)',
    '~~~',
    '',
  ].join('\n');
  assert.deepEqual(parseReleaseBody(body), [
    { text: 'Add `codex foo` with a list mode:', prs: [50148] },
    { text: 'Pin tasks.', prs: [51500] },
  ]);
});

test('a fence ends only at a marker of its own kind that is at least as long as the one that opened it', () => {
  const body = [
    '## New Features',
    '',
    '````md',
    '```',
    '- Inside, with a shorter marker. (#99999)',
    '```',
    '~~~~',
    '- Inside, with another kind of marker. (#99998)',
    '````',
    '- Real. (#10001)',
    '',
  ].join('\n');
  assert.deepEqual(parseReleaseBody(body), [{ text: 'Real.', prs: [10001] }]);
  // A marker line with an info string cannot close a fence, even of the same length.
  const withInfo = ['## New Features', '', '```sh', '```ts', '- Inside. (#99999)', '```', '- Real. (#10001)', ''].join('\n');
  assert.deepEqual(parseReleaseBody(withInfo), [{ text: 'Real.', prs: [10001] }]);
});

test('a bullet is keyed by the first PR of its closing list; a reference in the text only stands in when there is no list', () => {
  const body = [
    '## New Features',
    '',
    '- Building on #50148, add worktree tools. (#52000)',
    '- Follow up on #50150 and #50151 with a new view',
    '- Fix issue #50300 (#52001, #52002)',
    '',
  ].join('\n');
  assert.deepEqual(parseReleaseBody(body), [
    { text: 'Building on #50148, add worktree tools.', prs: [52000, 50148] },
    { text: 'Follow up on #50150 and #50151 with a new view', prs: [50150, 50151] },
    { text: 'Fix issue #50300', prs: [52001, 52002, 50300] },
  ]);
});

test('a colour, an HTML entity, zero or a number inside a word is not a PR reference', () => {
  const body = [
    '## New Features',
    '',
    '- Draw borders in `#000000` by default.',
    '- Use #000 for the cursor',
    '- Keep the apostrophe in Don&#8217;t panic',
    '- Rename the C#12345 binding',
    '- Tint the theme `#123456` (#52010)',
    '- Number 100000 of the series (#100000)',
    '',
  ].join('\n');
  // The first four have no PR left. A six-digit run is a colour in the text, and a PR number in the closing list (PR numbers reach 100000 in 2027).
  assert.deepEqual(parseReleaseBody(body), [
    { text: 'Tint the theme `#123456`', prs: [52010] },
    { text: 'Number 100000 of the series', prs: [100000] },
  ]);
});

test('notes are recognized by any of the usual level-2 sections, however few, matched on the start of the heading in any case', () => {
  const withHeading = (heading: string) => `${heading}\n\n- Something. (#51203)\n`;
  const headings = ['## New Features', '## Bug Fixes', '## Chores', '## Performance Improvements', '## Documentation', '## Changelog', '## Reverts', '## Miscellaneous Chores', '## BUG FIXES', '## bug fixes'];
  for (const heading of headings) assert.equal(parseReleaseNotes(withHeading(heading)).recognized, true, heading);
  // A patch release with nothing but Bug Fixes is normal (0.162.1, 0.160.1): recognized, and no features.
  assert.deepEqual(parseReleaseNotes('## Bug Fixes\n\n- Fix a crash. (#51203)\n\n## Changelog\n\n- #51203 Fix a crash @someone\n'), { features: [], recognized: true });
  // Empty notes, text without sections, other section names, other heading levels and bold pseudo-headings are the notes changing shape.
  const drifted = ['', '   \n\n', 'Release 0.162.1', '### New Features\n\n- Add a thing. (#50148)\n', '# New Features\n\n- Add a thing. (#50148)\n', '**New Features**\n\n- Add a thing. (#50148)\n', '## Highlights\n\n- Add a thing. (#50148)\n', '```\n## Bug Fixes\n```\n'];
  for (const body of drifted) assert.equal(parseReleaseNotes(body).recognized, false, JSON.stringify(body));
});

test('window starts at the checkpoint, or at the previous minor on first run', () => {
  const tags = ['rust-v0.163.0', 'rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0', 'rust-v0.160.1', 'rust-v0.160.0'];
  assert.deepEqual(stableWindow(tags), { from: 'rust-v0.162.1', to: 'rust-v0.163.0', releases: ['rust-v0.163.0'] });
  assert.deepEqual(stableWindow(tags, 'rust-v0.161.0'), { from: 'rust-v0.161.0', to: 'rust-v0.163.0', releases: ['rust-v0.163.0', 'rust-v0.162.1', 'rust-v0.162.0'] });
  assert.deepEqual(stableWindow(tags, 'rust-v0.163.0'), undefined);
  assert.deepEqual(stableWindow(tags.slice(1)), { from: 'rust-v0.161.0', to: 'rust-v0.162.1', releases: ['rust-v0.162.1', 'rust-v0.162.0'] });
});

test('window edge cases: a checkpoint missing from the list, one ahead of every tag, a single minor, no tags', () => {
  const tags = ['rust-v0.163.0', 'rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'];
  assert.deepEqual(stableWindow(tags, 'rust-v0.100.0'), stableWindow(tags));
  assert.deepEqual(stableWindow(tags, 'not a tag'), stableWindow(tags)); // not a version, so nothing to compare: the first-run rule
  // A checkpoint that is a newer version than the newest tag has nothing after it, compared as numbers: 0.10.0 is newer than 0.9.0.
  assert.equal(stableWindow(tags, 'rust-v0.170.0'), undefined);
  assert.equal(stableWindow(['rust-v0.9.0', 'rust-v0.8.0', 'rust-v0.7.0'], 'rust-v0.10.0'), undefined);
  assert.equal(stableWindow(['rust-v0.162.1', 'rust-v0.162.0']), undefined);
  assert.equal(stableWindow([]), undefined);
});

// --- collectReleases: a temp-dir store and a stub GitHub client, no network ---

const PULL_URL = 'https://github.com/openai/codex/pull';
/** When a rate limit lifts, in the tests that know it. */
const RESET = new Date('2026-10-15T13:00:00.000Z');
const release = (tag: string, body: string, prerelease = false): Release => ({ tag, publishedAt: '2026-10-08T00:00:00Z', body, prerelease });
/** Release notes shaped like the real ones: New Features first, then sections whose bullets must not become candidates. */
const notes = (...bullets: string[]): string =>
  `## New Features\n\n${bullets.map(b => `- ${b}`).join('\n')}\n\n## Bug Fixes\n\n- Fix a crash. (#99999)\n\n## Changelog\n\n- #99998 Unrelated change @someone\n`;
const pathsOf = (n: number, count: number): string[] => Array.from({ length: count }, (_, i) => `codex-rs/pr${n}/file${i}.rs`);
const pullRequest = (n: number, fileCount: number): PullRequest => ({
  number: n, title: `PR ${n} title`, body: '', url: `${PULL_URL}/${n}`, additions: 3, deletions: 1,
  files: pathsOf(n, fileCount).map(path => ({ path, additions: 1, deletions: 0 })),
});
/** The evidence excerpt of a stub pull request with its default two files and no description: the title, a blank line, the paths. */
const excerptOf = (n: number): string => `PR ${n} title\n\n${pathsOf(n, 2).join('\n')}`;
/** `n` characters that tell their position apart, so a cut in the wrong place shows. */
const digits = (n: number): string => Array.from({ length: n }, (_, i) => String(i % 10)).join('');
const pullPath = (n: number): string => `repos/openai/codex/pulls/${n}`;
const releasePath = (tag: string): string => `repos/openai/codex/releases/tags/${tag}`;
/** A rate-limit answer. REST gives a status and sometimes a reset time; gh's GraphQL gives neither. */
const limited = (path: string, details: { status?: number; rateLimitResetAt?: Date } = {}): GitHubError =>
  new GitHubError(`GitHub rate limit hit for ${path}: API rate limit exceeded`, path, { ...details, rateLimited: true });

type ReleasesGitHub = Pick<GitHubClient, 'stableTags' | 'release' | 'pullRequest'>;
type Signals = Array<AbortSignal | undefined>;
/**
 * `state` can be changed between runs. `releases` holds the published releases: a tag without one answers `undefined`, like GitHub's 404.
 * `failing` makes the lookup of a pull request fail with a 404, `fileCount` and `pullOverride` shape the stub pull requests, and `tagsError`,
 * `releaseError` and `pullError` pick an error for the tag list, a release (by tag) or a pull request (by number), each with the 1-based number of the call.
 * `calls` records what the collector asked for, `signals` the signal it passed along.
 */
function stubGitHub(tags: string[], releases: Release[]) {
  const state = {
    tags, releases: new Map(releases.map(r => [r.tag, r])), failing: new Set<number>(), fileCount: 2,
    pullOverride: undefined as ((n: number) => Partial<PullRequest>) | undefined,
    tagsError: undefined as ((call: number) => Error | undefined) | undefined,
    releaseError: undefined as ((tag: string, call: number) => Error | undefined) | undefined,
    pullError: undefined as ((n: number, call: number) => Error | undefined) | undefined,
  };
  const calls = { stableTags: [] as number[], release: [] as string[], pullRequest: [] as number[] };
  const signals = { stableTags: [] as Signals, release: [] as Signals, pullRequest: [] as Signals };
  const github: ReleasesGitHub = {
    stableTags: async (limit, signal) => {
      calls.stableTags.push(limit); signals.stableTags.push(signal);
      const error = state.tagsError?.(calls.stableTags.length);
      if (error) throw error;
      return state.tags.slice(0, limit);
    },
    release: async (tag, signal) => {
      calls.release.push(tag); signals.release.push(signal);
      const error = state.releaseError?.(tag, calls.release.length);
      if (error) throw error;
      return state.releases.get(tag);
    },
    pullRequest: async (n, signal) => {
      calls.pullRequest.push(n); signals.pullRequest.push(signal);
      const error = state.pullError?.(n, calls.pullRequest.length);
      if (error) throw error;
      if (state.failing.has(n)) throw new GitHubError(`GitHub HTTP 404 for ${pullPath(n)}`, pullPath(n), { status: 404 });
      return { ...pullRequest(n, state.fileCount), ...state.pullOverride?.(n) };
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
const byPr = (candidates: Candidate[], n: number): Candidate => candidates.find(c => c.fingerprint === `codex-release:pr:${n}`)!;
const hasUrl = (candidate: Candidate): boolean[] => candidate.evidence.map(e => e.url !== undefined);

test('collectReleases: the first run covers the releases since the previous minor, oldest first; a second run does nothing', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.1', notes('Add alpha tool. (#60001)')),
      release('rust-v0.162.0', notes('Add beta view. (#60010, #60011)', 'Add gamma flag. (#60020)')),
      release('rust-v0.161.0', notes('Add an old thing. (#59000)')),
    ]);

    const first = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(first, {
      window: { from: 'rust-v0.161.0', to: 'rust-v0.162.1', releases: ['rust-v0.162.1', 'rust-v0.162.0'] },
      added: 3, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false,
    });
    assert.deepEqual(stub.calls.stableTags, [12]);
    // Oldest first, and the starting point 0.161.0 was seen before the window opened: it is neither fetched nor collected.
    assert.deepEqual(stub.calls.release, ['rust-v0.162.0', 'rust-v0.162.1']);

    const stored = await store.list({ source: 'codex-release' });
    assert.equal(stored.length, 3);
    assert.equal(stored[0]!.title, 'Add alpha tool.'); // the newest release was written last, so it is on top
    const beta = byPr(stored, 60010);
    assert.equal(beta.status, 'new');
    assert.equal(beta.title, 'Add beta view.');
    assert.equal(beta.summary, 'Add beta view.');
    assert.deepEqual(beta.window, { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.0' });
    assert.deepEqual(beta.evidence, [
      { kind: 'pr', ref: '#60010', url: `${PULL_URL}/60010`, excerpt: excerptOf(60010) },
      { kind: 'pr', ref: '#60011', url: `${PULL_URL}/60011`, excerpt: excerptOf(60011) },
    ]);
    const alpha = byPr(stored, 60001);
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
    assert.deepEqual(second, { added: 0, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false });
    assert.deepEqual(stub.calls.stableTags, [12, 12]);
    assert.equal(stub.calls.release.length, releaseCalls);
    assert.equal(stub.calls.pullRequest.length, pullCalls);
    assert.deepEqual(await store.list({ source: 'codex-release' }), stored);

    // A new stable release opens a window that starts at the checkpoint.
    stub.state.tags.unshift('rust-v0.163.0');
    stub.state.releases.set('rust-v0.163.0', release('rust-v0.163.0', notes('Add delta pane. (#60030)')));
    const third = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(third, {
      window: { from: 'rust-v0.162.1', to: 'rust-v0.163.0', releases: ['rust-v0.163.0'] },
      added: 1, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false,
    });
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
    assert.deepEqual(result, {
      window: { from: 'rust-v0.162.0', to: 'rust-v0.164.0', releases: ['rust-v0.164.0', 'rust-v0.163.0', 'rust-v0.162.1'] },
      added: 3, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false,
    });
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

test('collectReleases: a tag without a release yet is skipped and the checkpoint stays before it, until the release is published', async () => {
  await withStore(async (store, snapshotDir) => {
    await store.setCheckpoint('lastStableTag', 'rust-v0.161.0');
    // rust-v0.163.0 is tagged, but its release is not published yet.
    const stub = stubGitHub(['rust-v0.163.0', 'rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.1', notes('Add alpha tool. (#60001)')),
      release('rust-v0.162.0', notes('Add beta view. (#60010)')),
    ]);
    const first = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(first, {
      window: { from: 'rust-v0.161.0', to: 'rust-v0.163.0', releases: ['rust-v0.163.0', 'rust-v0.162.1', 'rust-v0.162.0'] },
      added: 2, gap: false, prLookupFailures: 0, unreleased: ['rust-v0.163.0'], unrecognized: [], rateLimited: false,
    });
    assert.deepEqual(stub.calls.release, ['rust-v0.162.0', 'rust-v0.162.1', 'rust-v0.163.0']);
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.162.1');
    await assert.rejects(stat(snapshotPath(snapshotDir, 'rust-v0.163.0')), { code: 'ENOENT' });
    assert.equal((await store.list({ source: 'codex-release' })).length, 2);

    // Still unpublished: the window is that tag alone, nothing is collected and the checkpoint does not move.
    const second = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(second, {
      window: { from: 'rust-v0.162.1', to: 'rust-v0.163.0', releases: ['rust-v0.163.0'] },
      added: 0, gap: false, prLookupFailures: 0, unreleased: ['rust-v0.163.0'], unrecognized: [], rateLimited: false,
    });
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.162.1');

    // The release is published: the next run collects it, and only it.
    stub.state.releases.set('rust-v0.163.0', release('rust-v0.163.0', notes('Add delta pane. (#60030)')));
    const third = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(third, {
      window: { from: 'rust-v0.162.1', to: 'rust-v0.163.0', releases: ['rust-v0.163.0'] },
      added: 1, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false,
    });
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.163.0');
    await stat(snapshotPath(snapshotDir, 'rust-v0.163.0'));
    assert.equal((await store.list({ source: 'codex-release' }))[0]!.title, 'Add delta pane.');
  });
});

test('collectReleases: when no tag of the window has a release yet, nothing is collected and the checkpoint is left as it was', async () => {
  await withStore(async (store, snapshotDir) => {
    await store.setCheckpoint('lastStableTag', 'rust-v0.162.0');
    const stub = stubGitHub(['rust-v0.163.1', 'rust-v0.163.0', 'rust-v0.162.0'], []);
    const result = await collectReleases(store, stub.github, snapshotDir);
    // `unreleased` lists the tags newest first, like the window.
    assert.deepEqual(result, {
      window: { from: 'rust-v0.162.0', to: 'rust-v0.163.1', releases: ['rust-v0.163.1', 'rust-v0.163.0'] },
      added: 0, gap: false, prLookupFailures: 0, unreleased: ['rust-v0.163.1', 'rust-v0.163.0'], unrecognized: [], rateLimited: false,
    });
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.162.0');
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(stub.calls.pullRequest, []);
  });
  // On a first run there is no checkpoint, and none is invented.
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.163.0', 'rust-v0.162.1', 'rust-v0.162.0'], []);
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(result.unreleased, ['rust-v0.163.0']);
    assert.equal(await store.checkpoint('lastStableTag'), undefined);
  });
});

test('collectReleases: the checkpoint moves to the newest tag that has a release, a prerelease-flagged one included', async () => {
  await withStore(async (store, snapshotDir) => {
    await store.setCheckpoint('lastStableTag', 'rust-v0.161.0');
    // 0.164.0 is flagged as prerelease: seen, not collected. 0.163.0 has no release at all and sits between releases that do.
    const stub = stubGitHub(['rust-v0.164.0', 'rust-v0.163.0', 'rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.164.0', notes('Add epsilon. (#60040)'), true),
      release('rust-v0.162.1', notes('Add alpha tool. (#60001)')),
      release('rust-v0.162.0', notes('Add beta view. (#60010)')),
    ]);
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.equal(result.added, 2);
    assert.deepEqual(result.unreleased, ['rust-v0.163.0']);
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.164.0');
    assert.deepEqual((await store.list({ source: 'codex-release' })).map(c => c.fingerprint).sort(), ['codex-release:pr:60001', 'codex-release:pr:60010']);
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
    assert.deepEqual(result, {
      window: { from: 'rust-v0.161.0', to: 'rust-v0.162.1', releases: ['rust-v0.162.1', 'rust-v0.162.0'] },
      added: 2, gap: true, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false,
    });
    // The checkpoint moves into the list, so the next run no longer reports a gap.
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.162.1');
    assert.equal((await collectReleases(store, stub.github, snapshotDir)).gap, false);
  });
});

test('collectReleases: a checkpoint ahead of every fetched tag has nothing after it: no window, no gap, and it never moves back', async () => {
  await withStore(async (store, snapshotDir) => {
    await store.setCheckpoint('lastStableTag', 'rust-v0.170.0');
    const stub = stubGitHub(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [release('rust-v0.162.1', notes('Add alpha tool. (#60001)'))]);
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(result, { added: 0, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false });
    assert.deepEqual(stub.calls.release, []);
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.170.0');
  });
  // Compared as numbers, not as text: 0.10.0 is newer than 0.9.0.
  await withStore(async (store, snapshotDir) => {
    await store.setCheckpoint('lastStableTag', 'rust-v0.10.0');
    const stub = stubGitHub(['rust-v0.9.0', 'rust-v0.8.0', 'rust-v0.7.0'], [release('rust-v0.9.0', notes('Add alpha tool. (#60001)'))]);
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.equal(result.window, undefined);
    assert.equal(result.gap, false);
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.10.0');
  });
  // A checkpoint between the tags that is not in the list is a gap. Finishing a tag older than it does not move it back.
  await withStore(async (store, snapshotDir) => {
    await store.setCheckpoint('lastStableTag', 'rust-v0.163.1');
    const stub = stubGitHub(['rust-v0.163.2', 'rust-v0.163.0', 'rust-v0.162.1'], [release('rust-v0.163.0', notes('Add alpha tool. (#60001)'))]); // 0.163.2 has no release yet
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.equal(result.gap, true);
    assert.deepEqual(result.unreleased, ['rust-v0.163.2']);
    assert.equal(result.added, 1);
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.163.1');
  });
});

test('collectReleases: a pull request that cannot be fetched still gives a candidate with a bare reference, and holds nothing back', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.0', 'rust-v0.161.0'], [release('rust-v0.162.0', notes('Add beta view. (#60010, #60011, #60012)'))]);
    stub.state.failing.add(60011); // a 404: an issue number, or a deleted pull request
    // A signal that is not aborted changes nothing: a failed lookup is still just a missing pull request.
    const result = await collectReleases(store, stub.github, snapshotDir, new AbortController().signal);
    assert.equal(result.added, 1);
    assert.equal(result.prLookupFailures, 1);
    assert.equal(result.firstLookupError, 'GitHub HTTP 404 for repos/openai/codex/pulls/60011');
    assert.equal(result.rateLimited, false);
    assert.ok(!('rateLimitResetAt' in result));
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.162.0'); // a permanent failure does not hold the checkpoint back
    const [beta] = await store.list({ source: 'codex-release' });
    assert.deepEqual(beta!.evidence, [
      { kind: 'pr', ref: '#60010', url: `${PULL_URL}/60010`, excerpt: excerptOf(60010) },
      { kind: 'pr', ref: '#60011' },
      { kind: 'pr', ref: '#60012', url: `${PULL_URL}/60012`, excerpt: excerptOf(60012) },
    ]);
  });
});

test('collectReleases: prLookupFailures counts each pull request that ended without evidence once, across bullets and releases', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.1', notes('Add alpha tool. (#60001, #60002)')),
      release('rust-v0.162.0', notes('Add beta view. (#60010)', 'Add gamma flag. (#60020, #60021)')),
    ]);
    for (const n of [60001, 60002, 60021]) stub.state.failing.add(n);
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.equal(result.added, 3); // a failed lookup never costs a candidate
    assert.equal(result.prLookupFailures, 3);
    assert.match(result.firstLookupError ?? '', /60021/); // the first lookup that failed: 0.162.0 is read first, and gamma before beta
    const bare = (await store.list({ source: 'codex-release' })).flatMap(c => c.evidence).filter(e => e.url === undefined).map(e => e.ref).sort();
    assert.deepEqual(bare, ['#60001', '#60002', '#60021']);
    // Nothing is left to collect, so nothing can fail.
    assert.equal((await collectReleases(store, stub.github, snapshotDir)).prLookupFailures, 0);
  });
});

test('collectReleases: a pull request that two bullets share is looked up once, whether the lookup works or fails', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.0', notes('First. (#60001, #60030)', 'Second. (#60002, #60030)', 'Third. (#60003, #60031)', 'Fourth. (#60004, #60031)')),
    ]);
    stub.state.failing.add(60031);
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.equal(stub.calls.pullRequest.filter(n => n === 60030).length, 1);
    assert.equal(stub.calls.pullRequest.filter(n => n === 60031).length, 1);
    assert.equal(stub.calls.pullRequest.length, 6); // four first PRs and the two shared ones
    assert.equal(result.prLookupFailures, 1); // 60031, once, though two candidates carry it bare
    const stored = await store.list({ source: 'codex-release' });
    assert.deepEqual(hasUrl(byPr(stored, 60001)), [true, true]);
    assert.deepEqual(hasUrl(byPr(stored, 60002)), [true, true]);
    assert.deepEqual(hasUrl(byPr(stored, 60003)), [true, false]);
    assert.deepEqual(hasUrl(byPr(stored, 60004)), [true, false]);
    assert.deepEqual(byPr(stored, 60001).evidence[1], byPr(stored, 60002).evidence[1]);
  });
});

test('collectReleases: a failed lookup that is not a rate limit costs only its own pull request', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.0', 'rust-v0.161.0'], [release('rust-v0.162.0', notes('Add beta view. (#60010, #60011, #60012, #60013, #60014, #60015)'))]);
    // Each kind of failure is followed by another lookup, so a version that stopped on it would show in the calls.
    const errors = new Map<number, Error>([
      [60010, new GitHubError('not found', pullPath(60010), { status: 404 })],
      [60011, new GitHubError('no answer', pullPath(60011))], // a request that never got an answer has no status
      [60012, new GitHubError('server error', pullPath(60012), { status: 500 })],
      [60013, new GitHubError('forbidden', pullPath(60013), { status: 403 })], // a 403 that does not say rate limit is not one
      [60014, Object.assign(new Error('rate limit?'), { rateLimited: true })], // not a GitHubError, so not believed
    ]);
    stub.state.pullError = n => errors.get(n);
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(stub.calls.pullRequest, [60010, 60011, 60012, 60013, 60014, 60015]); // every lookup was made
    assert.equal(result.prLookupFailures, 5);
    assert.equal(result.firstLookupError, 'not found');
    assert.equal(result.rateLimited, false);
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.162.0');
    const [beta] = await store.list({ source: 'codex-release' });
    assert.deepEqual(hasUrl(beta!), [false, false, false, false, false, true]);
  });
});

test('collectReleases: a rate limit during the pull request lookups ends the run: the checkpoint stops before the release it cut into, and the next run goes on from there', async () => {
  const variants: Array<[string, { status?: number; rateLimitResetAt?: Date }]> = [
    ['REST, 403 with a reset time', { status: 403, rateLimitResetAt: RESET }],
    ['GraphQL, no status and no reset time', {}],
  ];
  for (const [name, details] of variants) {
    await withStore(async (store, snapshotDir) => {
      await store.setCheckpoint('lastStableTag', 'rust-v0.160.0');
      const stub = stubGitHub(['rust-v0.163.0', 'rust-v0.162.0', 'rust-v0.161.0', 'rust-v0.160.0'], [
        release('rust-v0.161.0', notes('Add alpha tool. (#60001)')),
        release('rust-v0.162.0', notes('Add beta view. (#60010)', 'Add gamma flag. (#60020, #60021)')),
        release('rust-v0.163.0', notes('Add delta pane. (#60030)')),
      ]);
      // The third lookup of the run is refused: 60001 and 60020 are answered, 60021 is not.
      stub.state.pullError = (n, call) => call === 3 ? limited(pullPath(n), details) : undefined;
      const first = await collectReleases(store, stub.github, snapshotDir);
      assert.deepEqual(first, {
        window: { from: 'rust-v0.160.0', to: 'rust-v0.163.0', releases: ['rust-v0.163.0', 'rust-v0.162.0', 'rust-v0.161.0'] },
        added: 3, gap: false, prLookupFailures: 2, unreleased: [], unrecognized: [], rateLimited: true,
        firstLookupError: limited(pullPath(60021), details).message,
        ...(details.rateLimitResetAt && { rateLimitResetAt: details.rateLimitResetAt }),
      }, name);
      assert.deepEqual(stub.calls.release, ['rust-v0.161.0', 'rust-v0.162.0'], name); // 0.163.0 is not even fetched
      assert.deepEqual(stub.calls.pullRequest, [60001, 60020, 60021], name); // 60010 is not asked for after the refusal
      assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.161.0', name); // the newest release that was finished
      await stat(snapshotPath(snapshotDir, 'rust-v0.162.0'));
      const stored = await store.list({ source: 'codex-release' });
      assert.deepEqual(hasUrl(byPr(stored, 60001)), [true], name);
      assert.deepEqual(hasUrl(byPr(stored, 60020)), [true, false], name);
      assert.deepEqual(hasUrl(byPr(stored, 60010)), [false], name);
      assert.equal(byPr(stored, 60030), undefined, name);

      // The limit is lifted. The next run starts at the release that was cut into, reuses what is stored and asks only for the rest.
      stub.state.pullError = undefined;
      const asked = stub.calls.pullRequest.length;
      const second = await collectReleases(store, stub.github, snapshotDir);
      assert.deepEqual(stub.calls.pullRequest.slice(asked), [60021, 60010, 60030], name);
      assert.deepEqual(second, {
        window: { from: 'rust-v0.161.0', to: 'rust-v0.163.0', releases: ['rust-v0.163.0', 'rust-v0.162.0'] },
        added: 1, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false,
      }, name);
      assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.163.0', name);
      const after = await store.list({ source: 'codex-release' });
      assert.ok(after.every(c => hasUrl(c).every(Boolean)), name);
      assert.equal(byPr(after, 60020).window?.fromTag, 'rust-v0.160.0', name); // the first run's window stays, though this one starts at 0.161.0
    });
  }
});

test('collectReleases: after a refusal the other pull requests of the same bullet are not asked for either', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.0', 'rust-v0.161.0'], [release('rust-v0.162.0', notes('Add beta view. (#60010, #60011, #60012)'))]);
    stub.state.pullError = (n, call) => call === 1 ? limited(pullPath(n)) : undefined; // a later lookup would work, so asking would show
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(stub.calls.pullRequest, [60010]);
    assert.equal(result.prLookupFailures, 3);
    assert.equal(result.rateLimited, true);
    assert.equal(result.added, 1);
    const [beta] = await store.list({ source: 'codex-release' });
    assert.deepEqual(hasUrl(beta!), [false, false, false]);
    assert.equal(await store.checkpoint('lastStableTag'), undefined); // no release was finished, so there is no checkpoint at all
  });
});

test('collectReleases: a rate-limited release fetch ends the run the same way: the checkpoint stops at the last release that was finished', async () => {
  await withStore(async (store, snapshotDir) => {
    await store.setCheckpoint('lastStableTag', 'rust-v0.161.0');
    const stub = stubGitHub(['rust-v0.163.0', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.0', notes('Add alpha tool. (#60001)')),
      release('rust-v0.163.0', notes('Add beta view. (#60010)')),
    ]);
    stub.state.releaseError = tag => tag === 'rust-v0.163.0' ? limited(releasePath(tag), { status: 403, rateLimitResetAt: RESET }) : undefined;
    const first = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(first, {
      window: { from: 'rust-v0.161.0', to: 'rust-v0.163.0', releases: ['rust-v0.163.0', 'rust-v0.162.0'] },
      added: 1, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: true, rateLimitResetAt: RESET,
    });
    assert.deepEqual(stub.calls.release, ['rust-v0.162.0', 'rust-v0.163.0']);
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.162.0');

    stub.state.releaseError = undefined;
    const second = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(second, {
      window: { from: 'rust-v0.162.0', to: 'rust-v0.163.0', releases: ['rust-v0.163.0'] },
      added: 1, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false,
    });
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.163.0');
  });
  // When the very first release is refused nothing was finished: the checkpoint stays where it was.
  await withStore(async (store, snapshotDir) => {
    await store.setCheckpoint('lastStableTag', 'rust-v0.161.0');
    const stub = stubGitHub(['rust-v0.162.0', 'rust-v0.161.0'], [release('rust-v0.162.0', notes('Add alpha tool. (#60001)'))]);
    stub.state.releaseError = tag => limited(releasePath(tag));
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.equal(result.rateLimited, true);
    assert.equal(result.added, 0);
    assert.ok(!('rateLimitResetAt' in result));
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.161.0');
  });
});

test('collectReleases: a rate-limited tag list ends the run quietly, with nothing read and the checkpoint where it was', async () => {
  await withStore(async (store, snapshotDir) => {
    await store.setCheckpoint('lastStableTag', 'rust-v0.161.0');
    const stub = stubGitHub(['rust-v0.162.0', 'rust-v0.161.0'], [release('rust-v0.162.0', notes('Add alpha tool. (#60001)'))]);
    stub.state.tagsError = () => limited('repos/openai/codex/tags?per_page=100&page=1', { status: 429, rateLimitResetAt: RESET });
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(result, { added: 0, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: true, rateLimitResetAt: RESET });
    assert.deepEqual(stub.calls.release, []);
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.161.0');
  });
});

test('collectReleases: reading a release again asks for nothing that is stored and writes nothing', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.1', notes('Add alpha tool. (#60001)')),
      release('rust-v0.162.0', notes('Add beta view. (#60010, #60011)', 'Add gamma flag. (#60020)')),
    ]);
    await collectReleases(store, stub.github, snapshotDir);
    assert.equal(stub.calls.pullRequest.length, 4);
    const stored = await store.list({ source: 'codex-release' });

    // The checkpoint is put back, so the same two releases are read again.
    await store.setCheckpoint('lastStableTag', 'rust-v0.161.0');
    const second = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(second, {
      window: { from: 'rust-v0.161.0', to: 'rust-v0.162.1', releases: ['rust-v0.162.1', 'rust-v0.162.0'] },
      added: 0, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false,
    });
    assert.equal(stub.calls.pullRequest.length, 4, 'no lookup');
    assert.deepEqual(await store.list({ source: 'codex-release' }), stored, 'no write');
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.162.1');

    // A pull request that another candidate stored is not asked for again either.
    stub.state.tags.unshift('rust-v0.163.0');
    stub.state.releases.set('rust-v0.163.0', release('rust-v0.163.0', notes('Add delta pane. (#60030, #60001)')));
    const third = await collectReleases(store, stub.github, snapshotDir);
    assert.equal(third.added, 1);
    assert.deepEqual(stub.calls.pullRequest.slice(4), [60030]);
    const delta = byPr(await store.list({ source: 'codex-release' }), 60030);
    assert.deepEqual(delta.evidence[1], byPr(stored, 60001).evidence[0]);
  });
});

test('collectReleases: a candidate that exists keeps its window when a later run reads its release again', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0', 'rust-v0.160.0'], [
      release('rust-v0.162.1', notes('Add alpha tool. (#60001)')),
      release('rust-v0.162.0', notes('Add beta view. (#60010)')),
      release('rust-v0.161.0', notes('Add an old thing. (#59000)')),
    ]);
    await collectReleases(store, stub.github, snapshotDir); // window from 0.161.0: the first two releases
    const before = await store.list({ source: 'codex-release' });
    assert.deepEqual(before.map(c => c.window?.fromTag), ['rust-v0.161.0', 'rust-v0.161.0']);

    // The checkpoint goes back one more release, so this window starts at 0.160.0 and reads all three.
    await store.setCheckpoint('lastStableTag', 'rust-v0.160.0');
    const second = await collectReleases(store, stub.github, snapshotDir);
    assert.equal(second.added, 1);
    assert.deepEqual(stub.calls.pullRequest.slice(2), [59000]);
    const after = await store.list({ source: 'codex-release' });
    // The two candidates of the first run are what they were, down to the window and updatedAt; only the new one has this run's window.
    for (const candidate of before) assert.deepEqual(after.find(c => c.id === candidate.id), candidate);
    assert.deepEqual(byPr(after, 59000).window, { fromTag: 'rust-v0.160.0', toTag: 'rust-v0.161.0' });
  });
});

test('collectReleases: a bullet is keyed by the first PR of its closing list, not by a PR it mentions', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.0', 'rust-v0.161.0'], [release('rust-v0.162.0', notes('Building on #50148, add worktree tools. (#52000)'))]);
    await collectReleases(store, stub.github, snapshotDir);
    const [candidate] = await store.list({ source: 'codex-release' });
    assert.equal(candidate!.fingerprint, 'codex-release:pr:52000');
    assert.equal(candidate!.summary, 'Building on #50148, add worktree tools.');
    assert.deepEqual(candidate!.evidence.map(e => e.ref), ['#52000', '#50148']);
  });
});

test('collectReleases: bullets whose closing lists start with the same PR are one candidate: the later write wins, the window of the first release stays', async () => {
  // Within a release the bullets are written last first, so the first bullet of the notes is the later write and the one that stays.
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.0', 'rust-v0.161.0'], [release('rust-v0.162.0', notes('Alpha one. (#50001, #50002)', 'Alpha two. (#50001)'))]);
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.equal(result.added, 1);
    const stored = await store.list({ source: 'codex-release' });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.fingerprint, 'codex-release:pr:50001');
    assert.equal(stored[0]!.summary, 'Alpha one.');
    assert.deepEqual(stored[0]!.evidence.map(e => e.ref), ['#50001', '#50002']);
  });
  // The same PR opens a bullet of the next release as well (two cases among the last 65 stable releases): the same candidate again.
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.1', notes('Alpha three. (#50001)')),
      release('rust-v0.162.0', notes('Alpha one. (#50001, #50002)')),
    ]);
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.equal(result.added, 1);
    const stored = await store.list({ source: 'codex-release' });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.summary, 'Alpha three.');
    assert.deepEqual(stored[0]!.evidence.map(e => e.ref), ['#50001']);
    assert.deepEqual(stored[0]!.window, { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.0' });
  });
});

test('collectReleases: notes that are empty or have none of the usual sections are unrecognized, a fix-only release is not, and neither holds the checkpoint', async () => {
  await withStore(async (store, snapshotDir) => {
    await store.setCheckpoint('lastStableTag', 'rust-v0.161.0');
    const stub = stubGitHub(['rust-v0.165.0', 'rust-v0.164.0', 'rust-v0.163.0', 'rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.165.0', '### New Features\n\n- Add a thing. (#60040)\n'), // headings of another level, on the newest tag
      release('rust-v0.164.0', 'Some notes nobody reads', true), // flagged as prerelease: seen, not read, so not listed
      release('rust-v0.163.0', ''),
      release('rust-v0.162.1', '## Bug Fixes\n\n- Fix a crash. (#51203)\n\n## Changelog\n\n- #51203 Fix a crash @someone\n'), // a fix-only patch release is normal
      release('rust-v0.162.0', notes('Add beta view. (#60010)')),
    ]);
    const result = await collectReleases(store, stub.github, snapshotDir);
    assert.deepEqual(result.unrecognized, ['rust-v0.165.0', 'rust-v0.163.0']); // newest first
    assert.equal(result.added, 1);
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.165.0');
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

test('collectReleases: the signal is checked before every bullet, so an abort is noticed even when no request is made', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.1', notes('Add alpha tool. (#60001)')),
      release('rust-v0.162.0', notes('Add beta view. (#60010)')),
    ]);
    await collectReleases(store, stub.github, snapshotDir); // everything is stored now, so reading the releases again needs no lookup
    await store.setCheckpoint('lastStableTag', 'rust-v0.161.0');
    const lookups = stub.calls.pullRequest.length;
    const controller = new AbortController();
    controller.abort();
    // The stubs ignore the signal, as a client between two requests would: only the check before the bullet can notice.
    await assert.rejects(collectReleases(store, stub.github, snapshotDir, controller.signal), (error: unknown) => (error as Error).name === 'AbortError');
    assert.equal(stub.calls.pullRequest.length, lookups);
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.161.0');
  });
});

test('collectReleases: a failed release fetch fails the run and keeps the checkpoint, so the next run retries the window', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], [
      release('rust-v0.162.1', notes('Add alpha tool. (#60001)')),
      release('rust-v0.162.0', notes('Add beta view. (#60010)')),
    ]);
    stub.state.releaseError = tag => tag === 'rust-v0.162.1' ? new GitHubError(`GitHub HTTP 500 for ${releasePath(tag)}`, releasePath(tag), { status: 500 }) : undefined;
    await assert.rejects(collectReleases(store, stub.github, snapshotDir), (error: unknown) => error instanceof GitHubError && error.status === 500);
    assert.equal(await store.checkpoint('lastStableTag'), undefined);
    assert.equal((await store.list({ source: 'codex-release' })).length, 1); // 0.162.0 went first and is already stored

    stub.state.releaseError = undefined;
    const retry = await collectReleases(store, stub.github, snapshotDir);
    assert.equal(retry.added, 1); // only 0.162.1 is new; the stored 0.162.0 candidate is read again and left as it is
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

    assert.equal(byPr(stored, 60001).title, exact);
    assert.equal(byPr(stored, 60002).title, `${digits(159)}…`);
    assert.equal(byPr(stored, 60003).title, `${'x'.repeat(158)}😀…`);
    for (const n of [60001, 60002, 60003]) assert.equal([...byPr(stored, n).title].length, 160);
    assert.doesNotMatch(byPr(stored, 60003).title, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/); // no half of a surrogate pair
    // The summary keeps the whole bullet.
    assert.equal(byPr(stored, 60001).summary, exact);
    assert.equal(byPr(stored, 60002).summary, over);
    assert.equal(byPr(stored, 60003).summary, emoji);
  });
});

test('collectReleases: the evidence excerpt names at most 20 files and says how many it left out', async () => {
  const cases: Array<[number, string]> = [[20, ''], [21, '\n…另有 1 个文件'], [25, '\n…另有 5 个文件']];
  for (const [count, tail] of cases) {
    await withStore(async (store, snapshotDir) => {
      const stub = stubGitHub(['rust-v0.162.0', 'rust-v0.161.0'], [release('rust-v0.162.0', notes('Add beta view. (#60010)'))]);
      stub.state.fileCount = count;
      await collectReleases(store, stub.github, snapshotDir);
      const [beta] = await store.list({ source: 'codex-release' });
      // The stub files change as many lines each, so the ranking keeps the order the pull request lists them in.
      assert.equal(beta!.evidence[0]!.excerpt, `PR 60010 title\n\n${pathsOf(60010, Math.min(count, 20)).join('\n')}${tail}`, `${count} files`);
    });
  }
});

test('collectReleases: the excerpt is the title, the description cut at a whole line, and the files ranked by lines changed with tests and snapshots last', async () => {
  await withStore(async (store, snapshotDir) => {
    const line = (i: number): string => `${String(i).padStart(2, '0')}${'x'.repeat(97)}`; // 99 code points
    const body = Array.from({ length: 30 }, (_, i) => line(i)).join('\r\n'); // CRLF, as GitHub often sends it
    const files = [
      ['docs/readme.md', 1, 0],
      ['codex-rs/core/src/big.rs', 100, 50],
      ['codex-rs/core/tests/suite/x.rs', 500, 0],
      ['codex-rs/tui/src/small.rs', 5, 0],
      ['codex-rs/tui/src/render_tests.rs', 300, 0],
      ['codex-rs/tui/src/snapshots/z.snap', 900, 0],
      ['web/app.spec.ts', 40, 0],
      ['web/app.test.ts', 41, 0],
      ['tests/top.rs', 10, 0],
    ] as const;
    const stub = stubGitHub(['rust-v0.162.0', 'rust-v0.161.0'], [release('rust-v0.162.0', notes('Add beta view. (#60010)'))]);
    stub.state.pullOverride = () => ({ body, files: files.map(([path, additions, deletions]) => ({ path, additions, deletions })) });
    await collectReleases(store, stub.github, snapshotDir);
    const [beta] = await store.list({ source: 'codex-release' });
    const kept = Array.from({ length: 15 }, (_, i) => line(i)).join('\n'); // 15 lines are 1,499 code points, a 16th would pass 1,500
    assert.equal(beta!.evidence[0]!.excerpt, [
      'PR 60010 title',
      `${kept}\n…`,
      [
        'codex-rs/core/src/big.rs', 'codex-rs/tui/src/small.rs', 'docs/readme.md', // everything else, by lines changed
        'codex-rs/tui/src/snapshots/z.snap', 'codex-rs/core/tests/suite/x.rs', 'codex-rs/tui/src/render_tests.rs', 'web/app.test.ts', 'web/app.spec.ts', 'tests/top.rs', // then the tests and snapshots
      ].join('\n'),
    ].join('\n\n'));
  });
});

test('collectReleases: a short description is kept whole, an empty one leaves no section, and a single line that is too long is cut inside', async () => {
  await withStore(async (store, snapshotDir) => {
    const stub = stubGitHub(['rust-v0.162.0', 'rust-v0.161.0'], [release('rust-v0.162.0', notes('Add beta view. (#60010, #60011, #60012)'))]);
    const bodies = new Map([[60010, 'Why\n\nBecause it is needed.\n'], [60011, ''], [60012, 'y'.repeat(2000)]]);
    stub.state.pullOverride = n => ({ body: bodies.get(n) ?? '' });
    await collectReleases(store, stub.github, snapshotDir);
    const [beta] = await store.list({ source: 'codex-release' });
    const [short, empty, long] = beta!.evidence.map(e => e.excerpt);
    assert.equal(short, `PR 60010 title\n\nWhy\n\nBecause it is needed.\n\n${pathsOf(60010, 2).join('\n')}`);
    assert.equal(empty, excerptOf(60011));
    assert.equal(long, `PR 60012 title\n\n${'y'.repeat(1499)}…\n\n${pathsOf(60012, 2).join('\n')}`);
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
