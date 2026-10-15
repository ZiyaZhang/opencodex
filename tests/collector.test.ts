import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Source } from '../src/core/candidate.ts';
import { ValidationError } from '../src/core/check.ts';
import { DEFAULT_SETTINGS, mergeSettings, validateSettings, type ModelRoute, type Settings, type SettingsPatch } from '../src/core/settings.ts';
import { CandidateStore } from '../src/core/store.ts';
import { loadIndex, pruneDesktopSnapshots, refreshIndex, runCheck, type CheckOptions, type CheckResult } from '../src/host/collector.ts';
import { GitHubClient, type GhRunner } from '../src/host/github.ts';
import type { PlutilRunner } from '../src/host/sources/plist.ts';
import { makeAsar } from './helpers/make-asar.ts';

const MIRROR = fileURLToPath(new URL('./fixtures/mirror/', import.meta.url));
// The RSS fixture's items are dated Aug-Oct 2026; every check pins the clock so the parser's 120-day window never drifts.
const NOW = new Date('2026-10-15T00:00:00Z');
const readRelease = () => readFile(new URL('./fixtures/release-0.162.0.md', import.meta.url), 'utf8');
const readFeed = () => readFile(new URL('./fixtures/changelog-rss-sample.xml', import.meta.url), 'utf8');
/** The desktop source and the index switched off; a test switches on what it needs. */
const QUIET: Settings = { ...DEFAULT_SETTINGS, desktopPlistPath: '', dshMirrorPath: '' };
const never = () => new AbortController().signal;

async function withHome(run: (home: string, store: CandidateStore) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'oc-collector-'));
  try { await run(home, new CandidateStore(home)); } finally { await rm(home, { recursive: true, force: true }); }
}
/** A fetch that answers every request with `body` and records the URLs asked for. */
function serve(body: string, status = 200, urls: string[] = []): typeof fetch {
  return async (input: string | URL | Request) => { urls.push(String(input)); return new Response(body, { status }); };
}
const offline = () => new GitHubClient({ gh: async () => { throw new Error('offline'); } });

const TAGS = ['rust-v0.162.0', 'rust-v0.161.0'];
const FLAGS = 'codex-rs/features/src/lib.rs';
/** The feature registry at each tag: 0.162.0 adds one flag. */
const FLAGS_AT: Record<string, string> = {
  'rust-v0.161.0': 'pub enum Feature {\n    Worktrees,\n}\n',
  'rust-v0.162.0': 'pub enum Feature {\n    Worktrees,\n    RemoteCompaction,\n}\n',
};
/** What gh prints when a call fails; GitHubClient reads the status from it. */
const ghExit = (stderr: string) => Object.assign(new Error('Command failed: gh'), { code: 1, stderr });

/**
 * A gh runner that answers like openai/codex with two stable tags: the 0.162.0 notes, a two-file pull request for every number,
 * and trees in which only the feature registry differs. Every call is recorded; `failTrees`, `failPr` and `failRelease` each break one kind of request.
 */
function codex(body: string, options: { failTrees?: boolean; failPr?: number; failRelease?: string } = {}): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = async args => {
    calls.push(args);
    const target = args.at(-1)!;
    if (args[0] === 'release' && args[1] === 'view') {
      if (options.failRelease) throw ghExit(options.failRelease);
      return JSON.stringify({ tagName: target, body, publishedAt: '2026-10-08T18:55:59Z', isPrerelease: false });
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      if (Number(target) === options.failPr) throw ghExit(`GraphQL: Could not resolve to a PullRequest with the number of ${target}. (repository.pullRequest)`);
      return JSON.stringify({
        number: Number(target), title: `PR ${target}`, body: '', url: `https://github.com/openai/codex/pull/${target}`, additions: 3, deletions: 1, changedFiles: 2,
        files: [{ path: 'codex-rs/core/src/lib.rs', additions: 2, deletions: 1 }, { path: 'docs/config.md', additions: 1, deletions: 0 }],
      });
    }
    if (args[0] === 'api') {
      if (target.startsWith('repos/openai/codex/tags?')) return JSON.stringify(target.endsWith('&page=1') ? TAGS.map(name => ({ name })) : []);
      const tree = /^repos\/openai\/codex\/git\/trees\/([^?]+)\?recursive=1$/.exec(target);
      if (tree) {
        if (options.failTrees) throw ghExit('gh: Server Error (HTTP 502)');
        const tag = decodeURIComponent(tree[1]!);
        if (!TAGS.includes(tag)) throw ghExit('gh: Not Found (HTTP 404)');
        return JSON.stringify({ truncated: false, tree: [
          { path: FLAGS, type: 'blob', sha: `flags-${tag}` }, { path: 'docs/config.md', type: 'blob', sha: 'same-at-both-tags' },
          { path: 'codex-rs/core/src/lib.rs', type: 'blob', sha: `core-${tag}` }, { path: 'docs', type: 'tree', sha: 'docs-tree' },
        ] });
      }
      const file = /^repos\/openai\/codex\/contents\/(.+)\?ref=(.+)$/.exec(target);
      const text = file && decodeURIComponent(file[1]!) === FLAGS ? FLAGS_AT[decodeURIComponent(file[2]!)] : undefined;
      if (text !== undefined) return JSON.stringify({ encoding: 'base64', content: Buffer.from(text).toString('base64') });
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { gh, calls };
}
const count = async (store: CandidateStore, source: Source) => (await store.list({ source })).length;
/** A check with the desktop source and the index off, the given gh runner and the RSS fixture. */
const quietCheck = async (home: string, store: CandidateStore, gh: GhRunner) =>
  runCheck({ directory: home, store, settings: QUIET, github: new GitHubClient({ gh }), fetcher: serve(await readFeed()), signal: never(), now: NOW });

test('a failing source is recorded and the others still run; the desktop source and the index are skipped when unset', async () => {
  await withHome(async (home, store) => {
    const result = await runCheck({ directory: home, store, settings: QUIET, github: offline(), fetcher: serve('not found', 404), signal: never() });
    // Both GitHub sources read the tags themselves, so an offline GitHub fails each of them; the RSS source still runs after them.
    assert.equal(result.errors.length, 3);
    assert.match(result.errors[0]!, /^releases: .*offline/);
    assert.match(result.errors[1]!, /^files: .*offline/);
    assert.equal(result.errors[2], 'rss: RSS HTTP 404');
    assert.equal(result.index, undefined);
    assert.deepEqual(result.desktop, { version: '', changed: false, added: 0, keys: 0 });
    assert.deepEqual(result.releases, { added: 0, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false });
    assert.deepEqual(result.files, { added: 0, merged: 0, gap: false });
    assert.equal(result.rss, 0);
    assert.deepEqual(await store.checkpoints(), {});
    assert.deepEqual(await store.list(), []);
  });
});

test('a check collects every source into the data directory, and a second check adds nothing', async () => {
  const github = codex(await readRelease());
  const xml = await readFeed();
  await withHome(async (home, store) => {
    const options: CheckOptions = {
      directory: home, store, settings: { ...QUIET, dshMirrorPath: MIRROR }, github: new GitHubClient({ gh: github.gh }), fetcher: serve(xml), signal: never(), now: NOW,
    };
    const first: CheckResult = await runCheck(options);
    assert.deepEqual(first.errors, []);
    assert.deepEqual(first.releases.window, { from: 'rust-v0.161.0', to: 'rust-v0.162.0', releases: ['rust-v0.162.0'] });
    assert.deepEqual([first.releases.added, first.releases.prLookupFailures, first.releases.gap], [6, 0, false]);
    assert.deepEqual(first.files, { window: { from: 'rust-v0.161.0', to: 'rust-v0.162.0', releases: ['rust-v0.162.0'] }, added: 1, merged: 0, gap: false });
    assert.deepEqual(first.desktop, { version: '', changed: false, added: 0, keys: 0 });
    assert.ok(first.rss > 0);
    assert.deepEqual([await count(store, 'codex-release'), await count(store, 'codex-files'), await count(store, 'rss'), await count(store, 'desktop')], [6, 1, first.rss, 0]);
    const [flags] = await store.list({ source: 'codex-files' });
    assert.deepEqual(flags!.window, { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.0' });
    assert.deepEqual(flags!.evidence.map(e => [e.kind, e.ref]), [['feature-flag', FLAGS]]);
    assert.match(flags!.evidence[0]!.excerpt ?? '', /RemoteCompaction/, 'the flag 0.162.0 added');
    await stat(join(home, 'snapshots', 'codex-releases', 'rust-v0.162.0.json'));
    await stat(join(home, 'snapshots', 'codex-files', 'rust-v0.161.0__rust-v0.162.0.json'));

    assert.ok(first.index && first.index.entries > 0);
    const index = await loadIndex(home);
    assert.ok(index, 'index/dsh-index.json reads back as an index');
    assert.equal(index.entries.length, first.index.entries);
    assert.equal(index.commit, first.index.commit);
    const state = await store.checkpoints();
    assert.deepEqual([state.lastStableTag, state.lastFilesTag, state.indexCommit], ['rust-v0.162.0', 'rust-v0.162.0', first.index.commit]);
    assert.match(state.rssHash ?? '', /^[0-9a-f]{64}$/);

    github.calls.length = 0;
    const second = await runCheck(options);
    assert.deepEqual(second.errors, []);
    assert.ok(!second.releases.window);
    assert.ok(!second.desktop.changed);
    assert.deepEqual([second.releases.added, second.desktop.added, second.rss], [0, 0, 0]);
    assert.deepEqual(second.files, { added: 0, merged: 0, gap: false });
    assert.equal(second.index?.entries, first.index.entries);
    assert.equal((await store.list()).length, 6 + 1 + first.rss);
    const tagsPage = 'repos/openai/codex/tags?per_page=100&page=1';
    assert.deepEqual(github.calls.map(args => args.at(-1)), [tagsPage, tagsPage], 'the second check only lists the tags, once per GitHub source');
  });
});

test('a watched-file diff that failed is taken up by the next check, although the release source has moved on', async () => {
  const body = await readRelease();
  const xml = await readFeed();
  await withHome(async (home, store) => {
    const check = (gh: GhRunner) => runCheck({ directory: home, store, settings: QUIET, github: new GitHubClient({ gh }), fetcher: serve(xml), signal: never(), now: NOW });
    const first = await check(codex(body, { failTrees: true }).gh);
    assert.equal(first.releases.added, 6);
    assert.ok(first.rss > 0);
    assert.deepEqual(first.files, { added: 0, merged: 0, gap: false });
    assert.equal(first.errors.length, 1);
    assert.match(first.errors[0]!, /^files: .*HTTP 502/);
    assert.equal(await store.checkpoint('lastStableTag'), 'rust-v0.162.0');

    const working = codex(body);
    const second = await check(working.gh);
    assert.deepEqual(second.errors, []);
    assert.ok(!second.releases.window);
    assert.equal(second.files.added, 1);
    assert.ok(working.calls.some(args => args.at(-1) === 'repos/openai/codex/git/trees/rust-v0.161.0?recursive=1'));
    await stat(join(home, 'snapshots', 'codex-files', 'rust-v0.161.0__rust-v0.162.0.json'));

    working.calls.length = 0;
    const third = await check(working.gh);
    assert.deepEqual([third.files.added, third.errors.length], [0, 0]);
    assert.ok(!working.calls.some(args => /git\/trees/.test(args.at(-1)!)), 'nothing is owed any more');
  });
});

test('gaps since the stored tags and failed PR lookups are reported, and the windows are still collected', async () => {
  const xml = await readFeed();
  await withHome(async (home, store) => {
    // rust-v0.150.0 is older than every tag listed and its tree is gone: both sources restart at the previous minor.
    await store.setCheckpoint('lastStableTag', 'rust-v0.150.0');
    await store.setCheckpoint('lastFilesTag', 'rust-v0.150.0');
    const github = codex(await readRelease(), { failPr: 50148 });
    const result = await runCheck({ directory: home, store, settings: QUIET, github: new GitHubClient({ gh: github.gh }), fetcher: serve(xml), signal: never(), now: NOW });
    assert.equal(result.releases.gap, true);
    assert.equal(result.releases.prLookupFailures, 1);
    assert.deepEqual([result.releases.added, result.files.added, result.files.gap], [6, 1, true]);
    assert.deepEqual(result.files.window, { from: 'rust-v0.161.0', to: 'rust-v0.162.0', releases: ['rust-v0.162.0'] });
    assert.equal(result.errors.length, 3);
    assert.match(result.errors[0]!, /^releases: .*rust-v0\.150\.0.*rust-v0\.161\.0/);
    assert.match(result.errors[1]!, /^releases: 1 PR lookups failed \(GitHub HTTP 404 for repos\/openai\/codex\/pulls\/50148: .*\); those candidates carry bare evidence until the next run$/);
    assert.equal(result.errors[2], 'files: the stored tag no longer exists; the window restarted at the previous minor');
  });
});

test('the watched-file source still runs when the release source fails', async () => {
  await withHome(async (home, store) => {
    const result = await quietCheck(home, store, codex(await readRelease(), { failRelease: 'HTTP 502: Bad Gateway (https://api.github.com/repos/openai/codex/releases/tags/rust-v0.162.0)' }).gh);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, /^releases: GitHub HTTP 502 for repos\/openai\/codex\/releases\/tags\/rust-v0\.162\.0/);
    assert.equal(result.files.added, 1);
    assert.deepEqual([await count(store, 'codex-release'), await count(store, 'codex-files')], [0, 1]);
    assert.equal(await store.checkpoint('lastStableTag'), undefined);
  });
});

test('a rate limit and release notes of an unknown shape are reported without failing the check', async () => {
  await withHome(async (home, store) => {
    // gh names no reset time; the release source stops at the release it could not read and keeps its checkpoint.
    const limited = await quietCheck(home, store, codex(await readRelease(), { failRelease: 'HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/repos/openai/codex/releases/tags/rust-v0.162.0)' }).gh);
    assert.equal(limited.releases.rateLimited, true);
    assert.deepEqual(limited.errors, ['releases: GitHub rate limit hit; the checkpoint stopped before the affected release']);
    assert.equal(await store.checkpoint('lastStableTag'), undefined);

    const odd = await quietCheck(home, store, codex('Highlights\n\n- Faster startup (#51600)\n').gh);
    assert.deepEqual(odd.releases.unrecognized, ['rust-v0.162.0']);
    assert.deepEqual(odd.errors, ['releases: release notes format not recognized for rust-v0.162.0']);
  });
  await withHome(async (home, store) => {
    // REST names the reset time; it is reported in ISO form. The watched-file source asks for the same tags and fails on the same limit.
    const resetAt = new Date('2026-10-15T13:00:00.000Z');
    const limit: typeof fetch = async () => new Response(JSON.stringify({ message: 'API rate limit exceeded for 192.0.2.1.' }), {
      status: 403, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt.getTime() / 1000) },
    });
    const result = await runCheck({ directory: home, store, settings: QUIET, github: new GitHubClient({ gh: null, fetch: limit }), fetcher: serve(await readFeed()), signal: never(), now: NOW });
    assert.equal(result.errors.length, 2);
    assert.equal(result.errors[0], 'releases: GitHub rate limit hit, resets at 2026-10-15T13:00:00.000Z; the checkpoint stopped before the affected release');
    assert.match(result.errors[1]!, /^files: GitHub HTTP 403 for repos\/openai\/codex\/tags\?per_page=100&page=1: API rate limit exceeded/);
    assert.ok(result.rss > 0, 'the RSS source is not held up by GitHub');
  });
  await withHome(async (home, store) => {
    // A retry-after too large for a Date leaves an Invalid Date behind; the notice goes out without a reset time rather than failing.
    const garbled: typeof fetch = async () => new Response('{}', { status: 403, headers: { 'retry-after': '1e300' } });
    const result = await runCheck({ directory: home, store, settings: QUIET, github: new GitHubClient({ gh: null, fetch: garbled }), fetcher: serve('', 404), signal: never() });
    assert.equal(result.errors[0], 'releases: GitHub rate limit hit; the checkpoint stopped before the affected release');
  });
});

const infoPlist = (version: string, build: string) => [
  '<?xml version="1.0" encoding="UTF-8"?>', '<plist version="1.0"><dict>',
  `<key>CFBundleShortVersionString</key><string>${version}</string>`, `<key>CFBundleVersion</key><string>${build}</string>`, '</dict></plist>',
].join('\n');
/** Stands in for `plutil -convert xml1 -o - <file>` on the XML plists written here, so the test also runs where /usr/bin/plutil does not exist. */
const xmlPlutil: PlutilRunner = async (_file, args) => ({ stdout: await readFile(args.at(-1)!, 'utf8') });
const localeTable = (...keys: string[]) => keys.map(key => `"${key}":\`${key.split('.').at(-1)}\``).join(',');

test('the desktop source reports a missing locale bundle and a key turnover as errors, and keeps the three newest snapshots', async () => {
  await withHome(async (home, store) => {
    const contents = join(home, 'app', 'ChatGPT.app', 'Contents');
    await mkdir(join(contents, 'Resources'), { recursive: true });
    const plist = join(contents, 'Info.plist');
    const install = async (version: string, build: string, files: Record<string, string>) => {
      await writeFile(join(contents, 'Resources', 'app.asar'), makeAsar(files));
      await writeFile(plist, infoPlist(version, build));
    };
    const check = async () => {
      const result = await runCheck({ directory: home, store, settings: { ...QUIET, desktopPlistPath: plist }, plutil: xmlPlutil, github: offline(), fetcher: serve('', 404), signal: never() });
      return { desktop: result.desktop, errors: result.errors.filter(error => error.startsWith('desktop:')) };
    };
    const NEW_KEYS = localeTable('codex.x.y.one', 'codex.x.y.two', 'codex.x.y.three', 'codex.x.y.four');

    await install('26.1.0', '100', { 'webview/assets/zh-CN-bbbbbbbbbbbb.js': localeTable('codex.a.b.one', 'codex.a.b.two', 'codex.a.b.three') });
    assert.deepEqual(await check(), { desktop: { version: '26.1.0 (100)', changed: true, added: 0, keys: 3, localeBundle: '/webview/assets/zh-CN-bbbbbbbbbbbb.js' }, errors: [] });

    await install('26.1.1', '101', { 'webview/assets/en-US-cccccccccccc.js': localeTable('codex.a.b.one') });
    const missing = await check();
    assert.equal(missing.desktop.keys, 0);
    assert.deepEqual(missing.errors, ['desktop: no zh-CN locale bundle with codex keys in 26.1.1 (101)']);
    assert.deepEqual((await check()).errors, missing.errors, 'an unchanged version without the bundle is reported again');

    await install('26.1.2', '102', { 'webview/assets/zh-CN-dddddddddddd.js': NEW_KEYS });
    const turnover = await check();
    assert.equal(turnover.desktop.keysReset, true);
    assert.deepEqual(turnover.errors, ['desktop: key layout changed in 26.1.2 (102); i18n baseline reset, no i18n candidates this run']);

    await install('26.1.3', '103', { 'webview/assets/zh-CN-dddddddddddd.js': NEW_KEYS });
    assert.deepEqual(await check(), { desktop: { version: '26.1.3 (103)', changed: true, added: 0, keys: 4, localeBundle: '/webview/assets/zh-CN-dddddddddddd.js' }, errors: [] });
    assert.deepEqual((await readdir(join(home, 'snapshots', 'desktop'))).sort(), ['26.1.1_(101)', '26.1.2_(102)', '26.1.3_(103)']);
    assert.equal(await store.checkpoint('lastDesktopVersion'), '26.1.3 (103)');
  });
});

test('pruneDesktopSnapshots keeps the newest version directories by mtime and leaves plain files alone', async () => {
  await withHome(async snapshots => {
    const dir = join(snapshots, 'desktop');
    const oldestFirst = ['1.2_(3)', '1.0_(1)', '1.4_(5)', '1.1_(2)', '1.3_(4)']; // mtimes deliberately out of name order
    for (const name of oldestFirst) { await mkdir(join(dir, name), { recursive: true }); await writeFile(join(dir, name, 'manifest.json'), '{}'); }
    await writeFile(join(dir, '.DS_Store'), '');
    for (const [minute, name] of oldestFirst.entries()) { const at = new Date(Date.UTC(2026, 9, 1, 0, minute)); await utimes(join(dir, name), at, at); }
    await pruneDesktopSnapshots(snapshots, 3);
    assert.deepEqual((await readdir(dir)).sort(), ['.DS_Store', '1.1_(2)', '1.3_(4)', '1.4_(5)']);
    await pruneDesktopSnapshots(join(snapshots, 'nowhere'), 3); // no desktop snapshots yet: nothing to do
    await assert.rejects(pruneDesktopSnapshots(snapshots, 0), ValidationError);
    assert.equal((await readdir(dir)).length, 4);
  });
});

test('refreshIndex writes the index and its commit, and a wrong or empty mirror keeps the previous index', async () => {
  await withHome(async (home, store) => {
    const index = await refreshIndex(home, store, MIRROR);
    assert.ok(index.entries.length > 0);
    const file = join(home, 'index', 'dsh-index.json');
    const written = await readFile(file, 'utf8');
    assert.deepEqual(await loadIndex(home), index);
    assert.equal(await store.checkpoint('indexCommit'), index.commit);
    const empty = await mkdtemp(join(tmpdir(), 'oc-empty-mirror-'));
    try {
      await assert.rejects(refreshIndex(home, store, empty), /DSH index is empty/);
      await assert.rejects(refreshIndex(home, store, join(empty, 'missing')), /must be an existing directory/);
    } finally { await rm(empty, { recursive: true, force: true }); }
    assert.equal(await readFile(file, 'utf8'), written);
    assert.deepEqual(await loadIndex(home), index);
  });
});

test('loadIndex returns nothing for a missing, unparsable or foreign index file', async () => {
  await withHome(async home => {
    assert.equal(await loadIndex(home), undefined);
    await mkdir(join(home, 'index'));
    const file = join(home, 'index', 'dsh-index.json');
    await writeFile(file, '{"version": 1, "entries": [');
    assert.equal(await loadIndex(home), undefined);
    await writeFile(file, JSON.stringify({ version: 2, builtAt: '', commit: '', mirror: '', entries: [] }));
    assert.equal(await loadIndex(home), undefined);
  });
});

test('an abort ends the whole check, before it starts or inside a source', async () => {
  await withHome(async (home, store) => {
    const fetched: string[] = [];
    const calls: string[][] = [];
    const before = new AbortController();
    before.abort();
    const listing: GhRunner = async args => { calls.push(args); return '[]'; };
    await assert.rejects(runCheck({ directory: home, store, settings: QUIET, github: new GitHubClient({ gh: listing }), fetcher: serve('', 404, fetched), signal: before.signal }), { name: 'AbortError' });
    assert.deepEqual([calls, fetched], [[], []]);

    const midway = new AbortController();
    const aborting: GhRunner = async () => { midway.abort(); throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); };
    await assert.rejects(runCheck({ directory: home, store, settings: { ...QUIET, dshMirrorPath: MIRROR }, github: new GitHubClient({ gh: aborting }), fetcher: serve('', 404, fetched), signal: midway.signal }), { name: 'AbortError' });
    assert.deepEqual(fetched, [], 'no source runs after the abort');
    assert.equal(await loadIndex(home), undefined);
  });
});

test('validateSettings accepts the defaults and rejects each bad field with a ValidationError', () => {
  validateSettings(DEFAULT_SETTINGS);
  const bad: Array<[Partial<Record<keyof Settings, unknown>>, RegExp]> = [
    [{ channel: 'alpha' }, /channel/],
    [{ desktopPlistPath: 'Applications/ChatGPT.app/Contents/Info.plist' }, /desktopPlistPath/],
    [{ desktopPlistPath: 42 }, /desktopPlistPath/],
    [{ dshMirrorPath: '~/harness/deepseek-harness' }, /dshMirrorPath/],
    [{ dshMirrorPath: null }, /dshMirrorPath/],
    [{ desktopLocale: 'zh CN' }, /desktopLocale/],
    [{ desktopLocale: '' }, /desktopLocale/],
    [{ desktopLocale: null }, /desktopLocale/], // a regular expression would read null as the text "null"
    [{ dailyReportLimit: 0 }, /dailyReportLimit/],
    [{ dailyReportLimit: 2.5 }, /dailyReportLimit/],
    [{ dailyReportLimit: '10' }, /dailyReportLimit/],
    [{ checkIntervalHours: 0 }, /checkIntervalHours/],
    [{ checkIntervalHours: 169 }, /checkIntervalHours/],
    [{ checkIntervalHours: Number.NaN }, /checkIntervalHours/],
    [{ classifyModel: { provider: '', model: 'deepseek-flash' } }, /classifyModel/],
    [{ classifyModel: 'deepseek-flash' }, /classifyModel/],
    [{ reportModel: { provider: 'deepseek-official' } }, /reportModel/],
    [{ reportModel: null }, /reportModel/],
    [{ reportPreset: 1 }, /reportPreset/],
    [{ startPreset: undefined }, /startPreset/],
  ];
  for (const [fields, message] of bad) {
    const value = { ...DEFAULT_SETTINGS, ...fields } as Settings;
    assert.throws(() => validateSettings(value), (error: unknown) => error instanceof ValidationError && message.test(error.message), `${Object.keys(fields)[0]}: ${String(Object.values(fields)[0])}`);
  }
  assert.throws(() => validateSettings(null as unknown as Settings), ValidationError);
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, desktopPlistPath: '', dshMirrorPath: '/Users/me/deepseek-harness', checkIntervalHours: 168 }), undefined);
});

test('mergeSettings lays a patch over the current settings, validates the result and returns a frozen copy', () => {
  const route: ModelRoute = { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
  const merged = mergeSettings(DEFAULT_SETTINGS, { dshMirrorPath: '/Users/me/deepseek-harness', classifyModel: route, dailyReportLimit: 3 });
  assert.deepEqual(merged, { ...DEFAULT_SETTINGS, dshMirrorPath: '/Users/me/deepseek-harness', classifyModel: route, dailyReportLimit: 3 });
  assert.ok(Object.isFrozen(merged) && Object.isFrozen(merged.classifyModel) && Object.isFrozen(merged.reportModel));
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS) && Object.isFrozen(DEFAULT_SETTINGS.classifyModel) && Object.isFrozen(DEFAULT_SETTINGS.reportModel));
  assert.equal(DEFAULT_SETTINGS.dshMirrorPath, '', 'the current settings are not changed');
  route.model = 'changed later';
  assert.equal(merged.classifyModel.model, 'deepseek-v4-flash', 'a route is copied, not shared with the patch');
  assert.ok(!Object.isFrozen(route), "the caller's objects are not frozen");

  // `undefined` keeps the current value, and keys outside Settings are not carried into the result.
  assert.deepEqual(mergeSettings(merged, { dshMirrorPath: undefined, extra: true } as SettingsPatch), merged);
  // A route in a patch replaces the whole route; fields it does not know are dropped.
  assert.deepEqual(mergeSettings(merged, { reportModel: { provider: 'p', model: 'm', note: 'x' } as ModelRoute }).reportModel, { provider: 'p', model: 'm' });
  assert.throws(() => mergeSettings(merged, { reportModel: { provider: 'p' } as ModelRoute }), /reportModel/);
  assert.throws(() => mergeSettings(merged, { checkIntervalHours: 0 }), ValidationError);
  assert.throws(() => mergeSettings(merged, null as unknown as SettingsPatch), ValidationError);
  assert.equal(merged.checkIntervalHours, 24);
  // Settings read back from an older file: defaults fill the fields it lacks.
  assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, { startPreset: 'cordis-dev' }), { ...DEFAULT_SETTINGS, startPreset: 'cordis-dev' });
});
