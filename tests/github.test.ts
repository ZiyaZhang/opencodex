import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, defaultGhRunner, type GhRunner } from '../src/host/github.ts';

test('stable releases filter prereleases and keep order', async () => {
  const calls: string[][] = [];
  const runner: GhRunner = async args => { calls.push(args); return JSON.stringify([
    { tag_name: 'rust-v0.163.0-alpha.1', prerelease: true, published_at: '2026-10-10T00:00:00Z', body: '' },
    { tag_name: 'rust-v0.162.1', prerelease: false, published_at: '2026-10-09T19:44:51Z', body: '## Bug Fixes\n- x (#1)' },
    { tag_name: 'rust-v0.162.0', prerelease: false, published_at: '2026-10-08T18:55:59Z', body: '## New Features\n- y (#2)' },
  ]); };
  const client = new GitHubClient({ gh: runner });
  const releases = await client.stableReleases(10);
  assert.deepEqual(releases.map(r => r.tag), ['rust-v0.162.1', 'rust-v0.162.0']);
  assert.match(calls[0]!.join(' '), /repos\/openai\/codex\/releases/);
  assert.ok(!calls[0]!.includes('--paginate'), 'one page of releases is enough');
});

test('treePaths keeps only watched blobs and rejects truncated trees', async () => {
  const runner: GhRunner = async () => JSON.stringify({ truncated: false, tree: [
    { path: 'docs/config.md', type: 'blob', sha: 'a1' }, { path: 'codex-rs/core/src/x.rs', type: 'blob', sha: 'b2' }, { path: 'codex-rs/features/src/lib.rs', type: 'blob', sha: 'c3' }, { path: 'docs', type: 'tree', sha: 'd4' },
  ] });
  const paths = await new GitHubClient({ gh: runner }).treePaths('rust-v0.162.1', p => /^codex-rs\/features\/|^docs\//.test(p));
  assert.deepEqual([...paths.entries()], [['docs/config.md', 'a1'], ['codex-rs/features/src/lib.rs', 'c3']]);
  const truncated: GhRunner = async () => JSON.stringify({ truncated: true, tree: [] });
  await assert.rejects(new GitHubClient({ gh: truncated }).treePaths('rust-v0.162.1', () => true), /truncated/);
});

test('fileAt decodes base64 contents', async () => {
  const runner: GhRunner = async () => JSON.stringify({ encoding: 'base64', content: Buffer.from('hello\nworld\n').toString('base64') });
  assert.equal(await new GitHubClient({ gh: runner }).fileAt('rust-v0.162.1', 'docs/config.md'), 'hello\nworld\n');
});

test('pull request view maps the gh json shape', async () => {
  const runner: GhRunner = async () => JSON.stringify({ number: 50148, title: 'Add managed worktree tools to the TUI', body: 'desc', url: 'https://github.com/openai/codex/pull/50148', additions: 1220, deletions: 44, files: [{ path: 'codex-rs/tui/src/lib.rs', additions: 3, deletions: 1 }] });
  const pr = await new GitHubClient({ gh: runner }).pullRequest(50148);
  assert.equal(pr.number, 50148);
  assert.deepEqual(pr.files.map(f => f.path), ['codex-rs/tui/src/lib.rs']);
});

// Everything below is additional coverage. No test here touches the network: each client gets a gh runner or a fetch stub.

interface Call { url: string; accept: string | null; userAgent: string | null; signal: AbortSignal | null | undefined }
/** Records every REST request and answers it from `answer`. */
function stubFetch(answer: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const call: Call = { url: String(input), accept: headers.get('accept'), userAgent: headers.get('user-agent'), signal: init?.signal };
    calls.push(call);
    return answer(call);
  };
  return { fetch: stub as typeof fetch, calls };
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** What execFile rejects with when `gh` is not installed. */
const missingGh: GhRunner = async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT', errno: -2, syscall: 'spawn gh', path: 'gh' }); };

test('without gh the client reads api.github.com and reports HTTP errors', async () => {
  const ok = stubFetch(() => json([
    { tag_name: 'rust-v0.163.0-alpha.1', prerelease: true, published_at: '2026-10-10T00:00:00Z', body: '' },
    { tag_name: 'rust-v0.162.1', prerelease: false, published_at: '2026-10-09T19:44:51Z', body: null },
    { tag_name: 'rust-v0.162.0', prerelease: false, published_at: '2026-10-08T18:55:59Z', body: 'notes' },
  ]));
  const releases = await new GitHubClient({ gh: null, fetch: ok.fetch }).stableReleases(1);
  assert.deepEqual(releases, [{ tag: 'rust-v0.162.1', publishedAt: '2026-10-09T19:44:51Z', body: '' }], 'limit applies after the prerelease filter, and a null body becomes an empty string');
  assert.deepEqual(ok.calls.map(c => c.url), ['https://api.github.com/repos/openai/codex/releases?per_page=100']);
  assert.equal(ok.calls[0]!.accept, 'application/vnd.github+json');
  assert.match(ok.calls[0]!.userAgent ?? '', /^dsh-opencodex\//, 'GitHub rejects requests without a User-Agent');

  const limited = stubFetch(() => json({ message: 'API rate limit exceeded' }, 403));
  await assert.rejects(new GitHubClient({ gh: null, fetch: limited.fetch }).stableReleases(5), /GitHub HTTP 403.*rate limit exceeded/);
  const html = stubFetch(() => new Response('<html>Forbidden</html>', { status: 403 }));
  await assert.rejects(new GitHubClient({ gh: null, fetch: html.fetch }).stableReleases(5), /GitHub HTTP 403/);
});

test('stable releases need both a clear prerelease flag and a plain rust-vX.Y.Z tag', async () => {
  const release = (tag_name: string, prerelease: boolean) => ({ tag_name, prerelease, published_at: '2026-10-09T00:00:00Z', body: '' });
  const runner: GhRunner = async () => JSON.stringify([release('rust-v0.164.0', true), release('v0.1.0', false), release('rust-v0.163.0-rc.1', false), release('rust-v0.162.1', false)]);
  assert.deepEqual((await new GitHubClient({ gh: runner }).stableReleases(10)).map(r => r.tag), ['rust-v0.162.1']);
});

test('invalid JSON names the request it came from', async () => {
  await assert.rejects(new GitHubClient({ gh: async () => '<html>bad gateway</html>' }).stableReleases(1), /invalid JSON for repos\/openai\/codex\/releases/);
  const stub = stubFetch(() => new Response('oops', { status: 200 }));
  await assert.rejects(new GitHubClient({ gh: null, fetch: stub.fetch }).treePaths('rust-v0.162.1', () => true), /invalid JSON for repos\/openai\/codex\/git\/trees\/rust-v0\.162\.1/);
});

test('abort signals reach both gh and fetch', async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const runner: GhRunner = async (_args, signal) => { seen = signal; return '[]'; };
  await new GitHubClient({ gh: runner }).stableReleases(1, controller.signal);
  assert.equal(seen, controller.signal);
  const stub = stubFetch(() => json([]));
  await new GitHubClient({ gh: null, fetch: stub.fetch }).stableReleases(1, controller.signal);
  assert.equal(stub.calls[0]!.signal, controller.signal);
});

test('treePaths asks for the recursive tree of the tag', async () => {
  const calls: string[][] = [];
  const runner: GhRunner = async args => { calls.push(args); return JSON.stringify({ truncated: false, tree: [] }); };
  await new GitHubClient({ gh: runner }).treePaths('rust-v0.162.1', () => true);
  assert.ok(calls[0]!.includes('repos/openai/codex/git/trees/rust-v0.162.1?recursive=1'));
});

test('fileAt encodes the path and ref, and ignores base64 line wrapping', async () => {
  const text = `${'line of text '.repeat(40)}\n`;
  const wrapped = Buffer.from(text).toString('base64').replace(/(.{60})/g, '$1\n'); // the contents API wraps at 60 columns
  const calls: string[][] = [];
  const runner: GhRunner = async args => { calls.push(args); return JSON.stringify({ type: 'file', encoding: 'base64', content: wrapped }); };
  assert.equal(await new GitHubClient({ gh: runner }).fileAt('rust-v0.162.1', 'docs/my file.md'), text);
  assert.ok(calls[0]!.includes('repos/openai/codex/contents/docs/my%20file.md?ref=rust-v0.162.1'));
});

test('fileAt names the 1 MB limit instead of returning an empty file', async () => {
  const big: GhRunner = async () => JSON.stringify({ type: 'file', encoding: 'none', content: '', size: 2_500_000 });
  await assert.rejects(new GitHubClient({ gh: big }).fileAt('rust-v0.162.1', 'codex-rs/big.json'), /codex-rs\/big\.json.*1 MB.*2500000/);
  const directory: GhRunner = async () => JSON.stringify([{ name: 'config.md', type: 'file' }]);
  await assert.rejects(new GitHubClient({ gh: directory }).fileAt('rust-v0.162.1', 'docs'), /docs.*directory/);
  const odd: GhRunner = async () => JSON.stringify({ type: 'file', encoding: 'utf-8', content: 'x' });
  await assert.rejects(new GitHubClient({ gh: odd }).fileAt('rust-v0.162.1', 'docs/a.md'), /Unexpected encoding utf-8/);
});

test('gh pull request files keep only the path and the line counts', async () => {
  const runner: GhRunner = async () => JSON.stringify({ number: 5, title: 't', body: null, url: 'https://github.com/openai/codex/pull/5', additions: 3, deletions: 1, files: [{ path: 'a.rs', additions: 3, deletions: 1, changeType: 'MODIFIED' }] });
  const pr = await new GitHubClient({ gh: runner }).pullRequest(5);
  assert.deepEqual(pr.files, [{ path: 'a.rs', additions: 3, deletions: 1 }]);
  assert.equal(pr.body, '');
});

test('a gh pull request view without files is completed with --paginate --slurp', async () => {
  const calls: string[][] = [];
  const runner: GhRunner = async args => {
    calls.push(args);
    if (args[0] === 'pr') return JSON.stringify({ number: 9, title: 't', body: 'b', url: 'https://github.com/openai/codex/pull/9', additions: 2, deletions: 0 }); // no `files` key
    return JSON.stringify(Array.from({ length: 31 }, (_, i) => [{ filename: `f${i}.rs`, additions: 1, deletions: 0 }])); // --slurp: one array per page
  };
  const pr = await new GitHubClient({ gh: runner }).pullRequest(9);
  assert.equal(pr.files.length, 30, 'gh fetches every page; the client keeps the same 30-page cap as the REST loop');
  assert.deepEqual([pr.files[0]!.path, pr.files[29]!.path], ['f0.rs', 'f29.rs']);
  assert.match(calls[1]!.join(' '), /api --paginate --slurp .*repos\/openai\/codex\/pulls\/9\/files\?per_page=100/);
});

test('gh pr view lists at most 100 files, so a short list is completed from the paged endpoint', async () => {
  const entries = (count: number) => Array.from({ length: count }, (_, i) => ({ filename: `src/f${i}.rs`, additions: 1, deletions: 0 }));
  const view = (changedFiles: number, files: number) => JSON.stringify({ number: 8, title: 't', body: 'b', url: 'https://github.com/openai/codex/pull/8', additions: 1, deletions: 0, changedFiles, files: entries(files).map(({ filename, ...rest }) => ({ path: filename, ...rest })) });
  const calls: string[][] = [];
  const truncated: GhRunner = async args => { calls.push(args); return args[0] === 'pr' ? view(199, 100) : JSON.stringify([entries(100), entries(99)]); };
  const pr = await new GitHubClient({ gh: truncated }).pullRequest(8);
  assert.equal(pr.files.length, 199);
  assert.match(calls[0]!.join(' '), /--json [^ ]*changedFiles/, 'the view asks for the total so a short list is noticed');
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.includes('--slurp'));
  // a complete list needs no second request
  calls.length = 0;
  const complete: GhRunner = async args => { calls.push(args); return view(14, 14); };
  assert.equal((await new GitHubClient({ gh: complete }).pullRequest(8)).files.length, 14);
  assert.equal(calls.length, 1);
});

test('REST pull request: html url, and file pages end at the first short page', async () => {
  const files = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ filename: `src/f${from + i}.rs`, additions: 1, deletions: 0 }));
  const pull = { number: 7, title: 'Add x', body: null, url: 'https://api.github.com/repos/openai/codex/pulls/7', html_url: 'https://github.com/openai/codex/pull/7', additions: 103, deletions: 0 };
  const stub = stubFetch(({ url }) => url.endsWith('/pulls/7') ? json(pull) : url.endsWith('&page=1') ? json(files(0, 100)) : json(files(100, 3)));
  const pr = await new GitHubClient({ gh: null, fetch: stub.fetch }).pullRequest(7);
  assert.equal(pr.url, 'https://github.com/openai/codex/pull/7', 'the REST `url` field is the API address; the page address is html_url');
  assert.equal(pr.body, '');
  assert.equal(pr.files.length, 103);
  assert.deepEqual(pr.files[102], { path: 'src/f102.rs', additions: 1, deletions: 0 });
  assert.deepEqual(stub.calls.map(c => c.url), [
    'https://api.github.com/repos/openai/codex/pulls/7',
    'https://api.github.com/repos/openai/codex/pulls/7/files?per_page=100&page=1',
    'https://api.github.com/repos/openai/codex/pulls/7/files?per_page=100&page=2',
  ]);
});

test('REST pull request files: an empty page ends the loop, and 30 pages (GitHub\'s 3000-file limit) is the cap', async () => {
  const files = (count: number) => Array.from({ length: count }, (_, i) => ({ filename: `src/f${i}.rs`, additions: 1, deletions: 0 }));
  const pull = { number: 7, title: 't', body: 'b', html_url: 'https://github.com/openai/codex/pull/7', additions: 1, deletions: 0 };
  const exact = stubFetch(({ url }) => url.endsWith('/pulls/7') ? json(pull) : url.endsWith('&page=1') ? json(files(100)) : json([]));
  assert.equal((await new GitHubClient({ gh: null, fetch: exact.fetch }).pullRequest(7)).files.length, 100);
  assert.equal(exact.calls.length, 3, 'the PR, one full page, then the empty page that proves nothing is left');
  const endless = stubFetch(({ url }) => url.endsWith('/pulls/7') ? json(pull) : json(files(100)));
  assert.equal((await new GitHubClient({ gh: null, fetch: endless.fetch }).pullRequest(7)).files.length, 3000);
  assert.equal(endless.calls.length, 31, 'the PR plus at most thirty file pages');
});

test('a missing gh binary sends the client to REST, and gh is not tried again', async () => {
  let attempts = 0;
  const runner: GhRunner = async (args, signal) => { attempts++; return missingGh(args, signal); };
  const stub = stubFetch(() => json([{ tag_name: 'rust-v0.162.1', prerelease: false, published_at: '2026-10-09T19:44:51Z', body: 'x' }]));
  const client = new GitHubClient({ gh: runner, fetch: stub.fetch });
  assert.deepEqual((await client.stableReleases(1)).map(r => r.tag), ['rust-v0.162.1']);
  assert.deepEqual((await client.stableReleases(1)).map(r => r.tag), ['rust-v0.162.1']);
  assert.equal(attempts, 1, 'ENOENT is remembered after the first call');
  assert.equal(stub.calls.length, 2);
});

test('gh failures other than a missing binary are not hidden behind an anonymous retry', async () => {
  const failing: GhRunner = async () => { throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { code: 1 }); };
  const stub = stubFetch(() => json([]));
  await assert.rejects(new GitHubClient({ gh: failing, fetch: stub.fetch }).stableReleases(1), /Not Found/);
  assert.equal(stub.calls.length, 0);
});

test('pull request diff runs gh pr diff, and uses the REST diff media type without gh', async () => {
  const diff = 'diff --git a/x.rs b/x.rs\n+added\n';
  const calls: string[][] = [];
  const runner: GhRunner = async args => { calls.push(args); return diff; };
  assert.equal(await new GitHubClient({ gh: runner }).pullRequestDiff(7), diff);
  assert.deepEqual(calls[0], ['pr', 'diff', '7', '--repo', 'openai/codex']);

  const pull = { number: 7, title: 't', body: 'b', html_url: 'https://github.com/openai/codex/pull/7', additions: 1, deletions: 0 };
  const stub = stubFetch(({ accept, url }) => accept === 'application/vnd.github.diff' ? new Response(diff) : url.includes('/files?') ? json([]) : json(pull));
  const client = new GitHubClient({ gh: missingGh, fetch: stub.fetch }); // pull request view and diff both fall back after ENOENT
  assert.equal(await client.pullRequestDiff(7), diff);
  assert.equal(stub.calls[0]!.url, 'https://api.github.com/repos/openai/codex/pulls/7');
  assert.equal(stub.calls[0]!.accept, 'application/vnd.github.diff');
  assert.equal((await client.pullRequest(7)).title, 't');
  const empty = stubFetch(() => new Response('must not be asked'));
  assert.equal(await new GitHubClient({ gh: async () => '', fetch: empty.fetch }).pullRequestDiff(7), '');
  assert.equal(empty.calls.length, 0, 'an empty diff from gh is an answer, not a reason to go to REST');
  const denied = stubFetch(() => json({ message: 'Sorry, the diff exceeded the maximum number of lines (20000)' }, 406));
  await assert.rejects(new GitHubClient({ gh: null, fetch: denied.fetch }).pullRequestDiff(7), /GitHub HTTP 406.*maximum number of lines/);
});

test('the real gh runner rejects with ENOENT when gh is not on PATH', async () => {
  const saved = process.env.PATH;
  process.env.PATH = '/nonexistent-dir-for-the-gh-test';
  try {
    await assert.rejects(defaultGhRunner(['--version']), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally { process.env.PATH = saved; }
});
