import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient, GitHubError, defaultGhRunner, ghEnvironment, type GhRunner } from '../src/host/github.ts';
import { publicNetwork } from '../src/host/public-network.ts';

test('stableTags reads the tags listing through gh api, newest semver first, honoring the limit', async () => {
  const calls: string[][] = [];
  // Scrambled on purpose, and with the odd names GitHub really has next to the stable tags.
  const names = ['rust-v0.9.0', 'rust-v0.10.0', 'rust-v0.162.0', 'rust-v0.162.1', 'rust-v0.163.0-alpha.1', 'rust-v0.161.0-rc.1', 'rust-vv0.99.0', 'winget-test-rust-v0.106.0', 'rusty-v8-v152.2.0', 'v0.1.0', 'rust-v0.162.1-hotfix', 'rust-v0.161.0'];
  const runner: GhRunner = async args => { calls.push(args); return JSON.stringify(names.map(name => ({ name }))); };
  const client = new GitHubClient({ gh: runner });
  assert.deepEqual(await client.stableTags(10), ['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0', 'rust-v0.10.0', 'rust-v0.9.0'], 'numeric semver order (0.10.0 above 0.9.0); alphas and look-alikes dropped');
  assert.deepEqual(await client.stableTags(2), ['rust-v0.162.1', 'rust-v0.162.0']);
  const page1 = ['api', '-H', 'Accept: application/vnd.github+json', '--', 'repos/openai/codex/tags?per_page=100&page=1'];
  assert.deepEqual(calls, [page1, page1], 'one plain `gh api` read of page 1 per call (no --paginate, no `gh release list`); the page is short, so nothing more is asked');
});

test('gh stableTags pages like REST: on while a full page leaves tags missing, stop once enough, never past five pages', async () => {
  /** A gh runner that answers `gh api repos/openai/codex/tags?per_page=100&page=N` from `pageOf(N)` and records every N asked for. */
  const tagsViaGh = (pageOf: (page: number) => Array<{ name: string }>) => {
    const asked: number[] = [];
    const runner: GhRunner = async args => {
      const page = /^repos\/openai\/codex\/tags\?per_page=100&page=(\d+)$/.exec(args.at(-1)!)?.[1];
      if (page === undefined || args[0] !== 'api' || args.includes('--paginate')) throw new Error(`unexpected gh call: ${args.join(' ')}`);
      asked.push(Number(page));
      return JSON.stringify(pageOf(Number(page)));
    };
    return { client: new GitHubClient({ gh: runner }), asked };
  };
  const full = (stable: string[]) => [...stable.map(name => ({ name })), ...Array.from({ length: 100 - stable.length }, (_, i) => ({ name: `rust-v0.163.0-alpha.${i}` }))];

  const short = tagsViaGh(page => page === 1 ? full(['rust-v0.9.0', 'rust-v0.162.1']) : [{ name: 'rust-v0.10.0' }, { name: 'rust-v0.162.0' }]);
  assert.deepEqual(await short.client.stableTags(10), ['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.10.0', 'rust-v0.9.0']);
  assert.deepEqual(short.asked, [1, 2], 'a full page 1 asks for page 2; the short page 2 ends the listing');

  const enough = tagsViaGh(page => page === 1 ? full(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0']) : []);
  assert.deepEqual(await enough.client.stableTags(3), ['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0']);
  assert.deepEqual(enough.asked, [1], 'three stable tags are in hand after page 1');

  const endless = tagsViaGh(page => full([`rust-v0.${page}.0`, 'rust-v0.1.0']));
  assert.deepEqual(await endless.client.stableTags(50), ['rust-v0.5.0', 'rust-v0.4.0', 'rust-v0.3.0', 'rust-v0.2.0', 'rust-v0.1.0'], 'rust-v0.1.0 is on every page but listed once');
  assert.deepEqual(endless.asked, [1, 2, 3, 4, 5], 'five pages is the cap');
});

test('a tags page that is not a JSON array is an error, not an empty listing', async () => {
  const viaGh = await failure(new GitHubClient({ gh: async () => JSON.stringify({ message: 'oops' }) }).stableTags(3));
  assert.ok(viaGh instanceof Error && !(viaGh instanceof GitHubError));
  assert.match(viaGh.message, /repos\/openai\/codex\/tags: page 1 is not a JSON array/);
  const stub = stubFetch(() => json({ message: 'oops' }));
  await assert.rejects(new GitHubClient({ gh: null, fetch: stub.fetch }).stableTags(3), /repos\/openai\/codex\/tags: page 1 is not a JSON array/);
});

test('REST stableTags pages through the tags listing and stops at the first short page', async () => {
  const filler = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => ({ name: `${prefix}${i}` }));
  const pages = [
    [{ name: 'rust-v0.9.0' }, { name: 'rust-v0.162.1' }, ...filler(98, 'rust-v0.163.0-alpha.')], // a full page holding two stable tags
    [{ name: 'rust-v0.10.0' }, { name: 'rust-v0.162.0' }, ...filler(40, 'rust-v0.161.0-alpha.')], // a short page: the listing ends here
  ];
  const stub = stubFetch(({ url }) => json(pages[Number(/&page=(\d+)$/.exec(url)![1]) - 1] ?? []));
  const client = new GitHubClient({ gh: null, fetch: stub.fetch });
  assert.deepEqual(await client.stableTags(10), ['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.10.0', 'rust-v0.9.0']);
  assert.deepEqual(stub.calls.map(c => c.url), [
    'https://api.github.com/repos/openai/codex/tags?per_page=100&page=1',
    'https://api.github.com/repos/openai/codex/tags?per_page=100&page=2',
  ], 'the short second page ends the listing: no third request');
});

test('REST stableTags stops once it holds enough stable tags, reads at most five pages, and lists a tag once', async () => {
  const full = (stable: string[], prefix: string) => [...stable.map(name => ({ name })), ...Array.from({ length: 100 - stable.length }, (_, i) => ({ name: `${prefix}${i}` }))];
  const enough = stubFetch(({ url }) => json(url.endsWith('page=1') ? full(['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0'], 'rust-v0.163.0-alpha.') : []));
  assert.deepEqual(await new GitHubClient({ gh: null, fetch: enough.fetch }).stableTags(3), ['rust-v0.162.1', 'rust-v0.162.0', 'rust-v0.161.0']);
  assert.equal(enough.calls.length, 1, 'three stable tags are in hand after page 1');
  // every page is full and each holds one new stable tag plus rust-v0.1.0 again: never enough for 50
  const endless = stubFetch(({ url }) => json(full([`rust-v0.${/&page=(\d+)$/.exec(url)![1]}.0`, 'rust-v0.1.0'], 'rust-v0.200.0-alpha.')));
  assert.deepEqual(await new GitHubClient({ gh: null, fetch: endless.fetch }).stableTags(50), ['rust-v0.5.0', 'rust-v0.4.0', 'rust-v0.3.0', 'rust-v0.2.0', 'rust-v0.1.0']);
  assert.equal(endless.calls.length, 5, 'five pages is the cap');
});

test('release maps the gh json shape and the REST shape, with an empty body for null', async () => {
  const calls: string[][] = [];
  const view: GhRunner = async args => { calls.push(args); return JSON.stringify({ tagName: 'rust-v0.162.0', body: '## New Features\n- y (#2)', publishedAt: '2026-10-08T18:55:59Z', isPrerelease: false }); };
  assert.deepEqual(await new GitHubClient({ gh: view }).release('rust-v0.162.0'), { tag: 'rust-v0.162.0', publishedAt: '2026-10-08T18:55:59Z', body: '## New Features\n- y (#2)', prerelease: false });
  assert.deepEqual(calls[0], ['release', 'view', '--repo', 'openai/codex', '--json', 'tagName,body,publishedAt,isPrerelease', '--', 'rust-v0.162.0'], 'flags first, then -- and the tag');
  await new GitHubClient({ gh: view }).release('--web');
  assert.deepEqual(calls[1]!.slice(-2), ['--', '--web'], 'a tag that looks like a flag stays a value');
  const emptyBody: GhRunner = async () => JSON.stringify({ tagName: 'rust-v0.163.0-alpha.1', body: null, publishedAt: '2026-10-10T00:00:00Z', isPrerelease: true });
  assert.deepEqual(await new GitHubClient({ gh: emptyBody }).release('rust-v0.163.0-alpha.1'), { tag: 'rust-v0.163.0-alpha.1', publishedAt: '2026-10-10T00:00:00Z', body: '', prerelease: true });

  const rest = stubFetch(() => json({ tag_name: 'rust-v0.162.0', body: null, published_at: '2026-10-08T18:55:59Z', prerelease: false, draft: false, assets: [{ name: 'codex-x86_64-apple-darwin.tar.gz' }] }));
  assert.deepEqual(await new GitHubClient({ gh: null, fetch: rest.fetch }).release('rust-v0.162.0'), { tag: 'rust-v0.162.0', publishedAt: '2026-10-08T18:55:59Z', body: '', prerelease: false });
  assert.deepEqual(rest.calls.map(c => c.url), ['https://api.github.com/repos/openai/codex/releases/tags/rust-v0.162.0']);
  const alpha = stubFetch(() => json({ tag_name: 'rust-v0.163.0-alpha.1', body: 'notes', published_at: '2026-10-10T00:00:00Z', prerelease: true }));
  assert.deepEqual(await new GitHubClient({ gh: null, fetch: alpha.fetch }).release('rust-v0.163.0-alpha.1'), { tag: 'rust-v0.163.0-alpha.1', publishedAt: '2026-10-10T00:00:00Z', body: 'notes', prerelease: true });
  const odd = stubFetch(() => json({ tag_name: 'a/b c', body: '', published_at: '2026-10-10T00:00:00Z', prerelease: false }));
  await new GitHubClient({ gh: null, fetch: odd.fetch }).release('a/b c');
  assert.equal(odd.calls[0]!.url, 'https://api.github.com/repos/openai/codex/releases/tags/a%2Fb%20c', 'the tag is encoded as one path segment');
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
/** Sets (or, for `undefined`, removes) environment variables while `run` executes, then puts each one back exactly as it was, "not set" included. */
async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const before = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  apply(vars);
  try { await run(); } finally { apply(before); }
}
/** The error a promise rejects with; the test fails when it resolves. */
const failure = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => assert.fail('expected a rejection'), (error: unknown) => error);

test('without gh the client reads api.github.com and reports HTTP errors', async () => {
  const ok = stubFetch(() => json([{ name: 'rust-v0.162.1' }, { name: 'rust-v0.163.0-alpha.1' }, { name: 'rust-v0.162.0' }]));
  assert.deepEqual(await new GitHubClient({ gh: null, fetch: ok.fetch }).stableTags(1), ['rust-v0.162.1']);
  assert.deepEqual(ok.calls.map(c => c.url), ['https://api.github.com/repos/openai/codex/tags?per_page=100&page=1'], 'one request: the page is short and the limit is met');
  assert.equal(ok.calls[0]!.accept, 'application/vnd.github+json');
  assert.match(ok.calls[0]!.userAgent ?? '', /^dsh-opencodex\//, 'GitHub rejects requests without a User-Agent');

  const limited = stubFetch(() => json({ message: 'API rate limit exceeded' }, 403));
  await assert.rejects(new GitHubClient({ gh: null, fetch: limited.fetch }).stableTags(5), /GitHub HTTP 403.*rate limit exceeded/);
  const html = stubFetch(() => new Response('<html>Forbidden</html>', { status: 403 }));
  await assert.rejects(new GitHubClient({ gh: null, fetch: html.fetch }).stableTags(5), /GitHub HTTP 403/);
});

test('invalid JSON names the request it came from', async () => {
  await assert.rejects(new GitHubClient({ gh: async () => '<html>bad gateway</html>' }).stableTags(1), /invalid JSON for repos\/openai\/codex\/tags\?per_page=100&page=1/);
  const stub = stubFetch(() => new Response('oops', { status: 200 }));
  await assert.rejects(new GitHubClient({ gh: null, fetch: stub.fetch }).treePaths('rust-v0.162.1', () => true), /invalid JSON for repos\/openai\/codex\/git\/trees\/rust-v0\.162\.1/);
});

test('abort signals reach both gh and fetch', async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const runner: GhRunner = async (_args, signal) => { seen = signal; return '[]'; };
  await new GitHubClient({ gh: runner }).stableTags(1, controller.signal);
  assert.equal(seen, controller.signal);
  const stub = stubFetch(() => json([]));
  await new GitHubClient({ gh: null, fetch: stub.fetch }).stableTags(1, controller.signal);
  assert.equal(stub.calls[0]!.signal, controller.signal);
});

test('treePaths asks for the recursive tree of the tag', async () => {
  const calls: string[][] = [];
  const runner: GhRunner = async args => { calls.push(args); return JSON.stringify({ truncated: false, tree: [] }); };
  await new GitHubClient({ gh: runner }).treePaths('rust-v0.162.1', () => true);
  assert.ok(calls[0]!.includes('repos/openai/codex/git/trees/rust-v0.162.1?recursive=1'));
  await new GitHubClient({ gh: runner }).treePaths('a/b c', () => true);
  assert.ok(calls[1]!.includes('repos/openai/codex/git/trees/a%2Fb%20c?recursive=1'), 'the tag is encoded as one path segment');
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
  const calls: string[][] = [];
  const runner: GhRunner = async args => { calls.push(args); return JSON.stringify({ number: 5, title: 't', body: null, url: 'https://github.com/openai/codex/pull/5', additions: 3, deletions: 1, files: [{ path: 'a.rs', additions: 3, deletions: 1, changeType: 'MODIFIED' }] }); };
  const pr = await new GitHubClient({ gh: runner }).pullRequest(5);
  assert.deepEqual(pr.files, [{ path: 'a.rs', additions: 3, deletions: 1 }]);
  assert.equal(pr.body, '');
  assert.deepEqual(calls, [['pr', 'view', '--repo', 'openai/codex', '--json', 'number,title,body,url,additions,deletions,changedFiles,files', '--', '5']], 'flags first, then -- and the number');
});

test('a pull request view without files is completed one gh api call per page, the same 30-page loop as REST', async () => {
  const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ filename: `src/f${from + i}.rs`, additions: 1, deletions: 0 }));
  const view = JSON.stringify({ number: 9, title: 't', body: 'b', url: 'https://github.com/openai/codex/pull/9', additions: 103, deletions: 0 }); // no `files` key
  const calls: string[][] = [];
  const runner: GhRunner = async args => {
    calls.push(args);
    if (args[0] === 'pr') return view;
    return JSON.stringify(/&page=1$/.test(args.at(-1)!) ? rows(0, 100) : rows(100, 3));
  };
  const pr = await new GitHubClient({ gh: runner }).pullRequest(9);
  assert.equal(pr.files.length, 103);
  assert.deepEqual(pr.files[102], { path: 'src/f102.rs', additions: 1, deletions: 0 });
  assert.deepEqual(calls.slice(1), [
    ['api', '-H', 'Accept: application/vnd.github+json', '--', 'repos/openai/codex/pulls/9/files?per_page=100&page=1'],
    ['api', '-H', 'Accept: application/vnd.github+json', '--', 'repos/openai/codex/pulls/9/files?per_page=100&page=2'],
  ], 'plain `gh api` reads, one per page: no --paginate, no --slurp');
});

test('gh file pages stop at 30 pages, and a page that is not an array is an error', async () => {
  const view = JSON.stringify({ number: 9, title: 't', body: 'b', url: 'https://github.com/openai/codex/pull/9', additions: 1, deletions: 0 });
  const full = Array.from({ length: 100 }, (_, i) => ({ filename: `src/f${i}.rs`, additions: 1, deletions: 0 }));
  let calls = 0;
  const endless: GhRunner = async args => { calls++; return args[0] === 'pr' ? view : JSON.stringify(full); };
  assert.equal((await new GitHubClient({ gh: endless }).pullRequest(9)).files.length, 3000);
  assert.equal(calls, 31, 'the view plus thirty pages');
  const notAnArray: GhRunner = async args => args[0] === 'pr' ? view : JSON.stringify({ message: 'oops' });
  const error = await failure(new GitHubClient({ gh: notAnArray }).pullRequest(9));
  assert.ok(error instanceof Error && !(error instanceof GitHubError));
  assert.match(error.message, /repos\/openai\/codex\/pulls\/9\/files: page 1 is not a JSON array/);
});

test('gh pr view lists at most 100 files, so a short list is completed from the paged endpoint', async () => {
  const entries = (count: number) => Array.from({ length: count }, (_, i) => ({ filename: `src/f${i}.rs`, additions: 1, deletions: 0 }));
  const view = (changedFiles: number, files: number) => JSON.stringify({ number: 8, title: 't', body: 'b', url: 'https://github.com/openai/codex/pull/8', additions: 1, deletions: 0, changedFiles, files: entries(files).map(({ filename, ...rest }) => ({ path: filename, ...rest })) });
  const calls: string[][] = [];
  const truncated: GhRunner = async args => { calls.push(args); return args[0] === 'pr' ? view(199, 100) : JSON.stringify(/&page=1$/.test(args.at(-1)!) ? entries(100) : entries(99)); };
  const pr = await new GitHubClient({ gh: truncated }).pullRequest(8);
  assert.equal(pr.files.length, 199);
  assert.match(calls[0]!.join(' '), /--json [^ ]*changedFiles/, 'the view asks for the total so a short list is noticed');
  assert.equal(calls.length, 3, 'the view and two pages');
  assert.ok(calls.slice(1).every(args => args[0] === 'api' && !args.includes('--paginate') && !args.includes('--slurp')));
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
  const stub = stubFetch(() => json([{ name: 'rust-v0.162.1' }]));
  const client = new GitHubClient({ gh: runner, fetch: stub.fetch });
  assert.deepEqual(await client.stableTags(1), ['rust-v0.162.1']);
  assert.deepEqual(await client.stableTags(1), ['rust-v0.162.1']);
  assert.equal(attempts, 1, 'ENOENT is remembered after the first call');
  assert.equal(stub.calls.length, 2);
});

test('a gh that is not signed in is treated like a missing gh: exit code 4, or "not logged into" on stderr', async () => {
  const exit4 = Object.assign(new Error('Command failed: gh release list --repo openai/codex\nTo get started with GitHub CLI, please run:  gh auth login'), { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' });
  const notLoggedInto = Object.assign(new Error('Command failed: gh api repos/openai/codex/tags'), { code: 1, stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n' });
  const messageOnly = Object.assign(new Error('You are not logged into any GitHub hosts'), { code: 1 });
  for (const error of [exit4, notLoggedInto, messageOnly]) {
    let attempts = 0;
    const runner: GhRunner = async () => { attempts++; throw error; };
    const stub = stubFetch(() => json([{ name: 'rust-v0.162.1' }]));
    const client = new GitHubClient({ gh: runner, fetch: stub.fetch });
    assert.deepEqual(await client.stableTags(1), ['rust-v0.162.1']);
    assert.deepEqual(await client.stableTags(1), ['rust-v0.162.1']);
    assert.equal(attempts, 1, 'remembered after the first failure');
    assert.equal(stub.calls.length, 2);
  }
  // the commands that do not go through `gh api` take the same way out
  const signedOut: GhRunner = async () => { throw exit4; };
  const stub = stubFetch(({ accept, url }) => accept === 'application/vnd.github.diff' ? new Response('diff --git a/x b/x\n') : url.includes('/releases/tags/') ? json({ tag_name: 'rust-v0.162.0', body: 'b', published_at: '2026-10-08T18:55:59Z', prerelease: false }) : json({}));
  const client = new GitHubClient({ gh: signedOut, fetch: stub.fetch });
  assert.equal((await client.release('rust-v0.162.0'))?.body, 'b');
  assert.equal(await client.pullRequestDiff(7), 'diff --git a/x b/x\n');
});

test('gh failures other than a missing binary or a missing login are not hidden behind an anonymous retry', async () => {
  const notFound = Object.assign(new Error('Command failed: gh release list\ngh: Not Found (HTTP 404)'), { code: 1, stderr: 'gh: Not Found (HTTP 404)\n' });
  const badToken = Object.assign(new Error('Command failed: gh release list\ngh: Bad credentials (HTTP 401)'), { code: 1, stderr: 'gh: Bad credentials (HTTP 401)\n' });
  const cancelled = Object.assign(new Error('Command failed: gh release list'), { code: 2, stderr: '' });
  for (const [error, expected] of [[notFound, /Not Found/], [badToken, /Bad credentials/], [cancelled, /Command failed/]] as const) {
    const stub = stubFetch(() => json([]));
    await assert.rejects(new GitHubClient({ gh: async () => { throw error; }, fetch: stub.fetch }).stableTags(1), expected);
    assert.equal(stub.calls.length, 0);
  }
});

test('pull request diff runs gh pr diff, and uses the REST diff media type without gh', async () => {
  const diff = 'diff --git a/x.rs b/x.rs\n+added\n';
  const calls: string[][] = [];
  const runner: GhRunner = async args => { calls.push(args); return diff; };
  assert.equal(await new GitHubClient({ gh: runner }).pullRequestDiff(7), diff);
  assert.deepEqual(calls[0], ['pr', 'diff', '--repo', 'openai/codex', '--', '7'], 'flags first, then -- and the number');

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
  await withEnv({ PATH: '/nonexistent-dir-for-the-gh-test' }, async () => {
    await assert.rejects(defaultGhRunner(['--version']), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  });
});

test('ghEnvironment overrides what a login shell may have exported and keeps everything else', () => {
  // DEBUG=1 and GH_DEBUG=api make gh print `* Request at ...` trace lines ahead of its error line; on gh 2.88 GH_DEBUG=0 beats both
  const login = { PATH: '/usr/bin:/bin', HTTPS_PROXY: 'http://127.0.0.1:7897', HOME: '/Users/x', CLICOLOR_FORCE: '1', GH_FORCE_TTY: '120', NO_COLOR: '', GH_HOST: 'ghe.example.com', GH_PAGER: 'less -R', GH_PROMPT_DISABLED: '', DEBUG: '1', GH_DEBUG: 'api' };
  assert.deepEqual(ghEnvironment(login), { PATH: '/usr/bin:/bin', HTTPS_PROXY: 'http://127.0.0.1:7897', HOME: '/Users/x', DEBUG: '1', GH_PAGER: 'cat', CLICOLOR_FORCE: '0', NO_COLOR: '1', GH_FORCE_TTY: '', GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com', GH_DEBUG: '0' });
  assert.equal(login.CLICOLOR_FORCE, '1', 'the input is left alone');
  assert.equal(login.GH_DEBUG, 'api', 'the input is left alone');
  assert.deepEqual(ghEnvironment({}), { GH_PAGER: 'cat', CLICOLOR_FORCE: '0', NO_COLOR: '1', GH_FORCE_TTY: '', GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com', GH_DEBUG: '0' });
  assert.equal(ghEnvironment().PATH, process.env.PATH, 'defaults to the process environment');
});

test('the default runner starts gh with that environment and the arguments exactly as given', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencodex-fake-gh-'));
  try {
    // A stand-in `gh` that reports what it was started with: no GitHub, no network.
    const report = ['GH_PAGER', 'CLICOLOR_FORCE', 'NO_COLOR', 'GH_FORCE_TTY', 'GH_PROMPT_DISABLED', 'GH_HOST', 'GH_DEBUG'].map(name => `echo "${name}=$${name}"`);
    await writeFile(join(dir, 'gh'), ['#!/bin/sh', ...report, 'for arg in "$@"; do echo "arg:$arg"; done', ''].join('\n'), { mode: 0o755 });
    await withEnv({ PATH: dir, CLICOLOR_FORCE: '1', GH_FORCE_TTY: '120', NO_COLOR: undefined, GH_HOST: 'ghe.example.com', GH_PAGER: 'less -R', GH_DEBUG: 'api' }, async () => {
      const out = await defaultGhRunner(['release', 'view', '--repo', 'openai/codex', '--', '--web']);
      assert.equal(out, ['GH_PAGER=cat', 'CLICOLOR_FORCE=0', 'NO_COLOR=1', 'GH_FORCE_TTY=', 'GH_PROMPT_DISABLED=1', 'GH_HOST=github.com', 'GH_DEBUG=0', 'arg:release', 'arg:view', 'arg:--repo', 'arg:openai/codex', 'arg:--', 'arg:--web', ''].join('\n'));
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('with gh off the PATH the real default runner finds out once and the client carries on over REST', async () => {
  await withEnv({ PATH: '/nonexistent-dir-for-the-gh-test' }, async () => {
    const stub = stubFetch(() => json([{ name: 'rust-v0.162.1' }]));
    const client = new GitHubClient({ fetch: stub.fetch }); // no gh option: the real default runner really tries to start gh
    assert.deepEqual(await client.stableTags(1), ['rust-v0.162.1']);
    assert.equal(client.route, 'rest');
    assert.deepEqual(await client.stableTags(1), ['rust-v0.162.1']);
    assert.equal(stub.calls.length, 2);
  });
});

test('withEnv puts variables back exactly, deleting the ones that were not set', async () => {
  delete process.env.OPENCODEX_TEST_UNSET;
  process.env.OPENCODEX_TEST_SET = 'before';
  await withEnv({ OPENCODEX_TEST_UNSET: 'during', OPENCODEX_TEST_SET: undefined }, async () => {
    assert.equal(process.env.OPENCODEX_TEST_UNSET, 'during');
    assert.ok(!('OPENCODEX_TEST_SET' in process.env));
  });
  assert.ok(!('OPENCODEX_TEST_UNSET' in process.env), 'removed again, not left as the string "undefined"');
  assert.equal(process.env.OPENCODEX_TEST_SET, 'before');
  delete process.env.OPENCODEX_TEST_SET;
});

test('REST failures are GitHubErrors with status and path, and a rate limit carries its reset time', async () => {
  const reset = 1_790_000_000; // epoch seconds, as in the x-ratelimit-reset header
  const fail = async (status: number, headers: Record<string, string> = {}) => {
    const stub = stubFetch(() => new Response(JSON.stringify({ message: 'API rate limit exceeded for 203.0.113.9.' }), { status, headers }));
    const error = await failure(new GitHubClient({ gh: null, fetch: stub.fetch }).stableTags(3));
    assert.ok(error instanceof GitHubError, String(error));
    assert.equal(error.name, 'GitHubError');
    assert.equal(error.status, status);
    assert.equal(error.path, 'repos/openai/codex/tags?per_page=100&page=1');
    assert.match(error.message, new RegExp(`^GitHub HTTP ${status} for repos/openai/codex/tags\\?per_page=100&page=1: API rate limit exceeded`));
    return error;
  };
  assert.equal((await fail(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })).rateLimitResetAt?.getTime(), reset * 1000);
  assert.equal((await fail(403, { 'x-ratelimit-reset': String(reset) })).rateLimitResetAt?.getTime(), reset * 1000, 'the reset header alone is taken at its word');
  assert.equal((await fail(429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })).rateLimitResetAt?.getTime(), reset * 1000);
  assert.equal((await fail(403, { 'x-ratelimit-remaining': '57', 'x-ratelimit-reset': String(reset) })).rateLimitResetAt, undefined, 'a 403 with calls to spare is a permission problem, not a rate limit');
  assert.equal((await fail(404, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })).rateLimitResetAt, undefined);
  assert.equal((await fail(403, { 'x-ratelimit-reset': 'soon' })).rateLimitResetAt, undefined);
  assert.equal((await fail(403)).rateLimitResetAt, undefined);
  assert.equal((await fail(500)).status, 500);
});

test('gh failures are GitHubErrors too: the HTTP status comes out of stderr, and "not found" texts count as 404', async () => {
  const path = 'repos/openai/codex/git/trees/rust-v0.162.1?recursive=1';
  const cases: Array<[string, number | undefined]> = [
    ['gh: Not Found (HTTP 404)', 404],
    ["gh: We couldn't respond to your request in time. Sorry about that. Please try resubmitting your request and contact us if the problem persists. (HTTP 504)", 504],
    ['gh: API rate limit exceeded for user ID 1234. If you reach out to GitHub Support for help, please include the request ID ABCD:1234. (HTTP 403)', 403],
    ['could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000) (https://api.github.com/repos/openai/codex/pulls/1)', 406],
    ['release not found', 404],
    ['GraphQL: Could not resolve to a PullRequest with the number of 999999999. (repository.pullRequest)', 404],
    ['gh: Bad credentials (HTTP 401)', 401],
    ['stream error: stream ID 1; CANCEL; received from peer', undefined],
  ];
  for (const [stderr, status] of cases) {
    const original = Object.assign(new Error(`Command failed: gh api -H Accept: application/vnd.github+json -- ${path}\n${stderr}\n`), { code: 1, stderr: `${stderr}\n` });
    const error = await failure(new GitHubClient({ gh: async () => { throw original; } }).treePaths('rust-v0.162.1', () => true));
    assert.ok(error instanceof GitHubError, stderr);
    assert.equal(error.status, status, stderr);
    assert.equal(error.path, path);
    assert.equal(error.cause, original);
    assert.equal(error.rateLimitResetAt, undefined, 'gh does not print the reset time');
    assert.ok(!error.message.includes('Command failed'), `the message carries gh's own line, not the command line: ${error.message}`);
    if (status === undefined) assert.match(error.message, /^GitHub request for repos\/openai\/codex\/git\/trees\/rust-v0\.162\.1\?recursive=1 failed \(gh\): stream error/);
    else assert.ok(error.message.startsWith(`GitHub HTTP ${status} for ${path}`), error.message);
  }
  const notFound = Object.assign(new Error('Command failed: gh api\ngh: Not Found (HTTP 404)'), { code: 1, stderr: 'gh: Not Found (HTTP 404)\n' });
  const rest = stubFetch(() => json({ message: 'Not Found' }, 404));
  const viaGh = await failure(new GitHubClient({ gh: async () => { throw notFound; } }).treePaths('rust-v0.162.1', () => true));
  const viaRest = await failure(new GitHubClient({ gh: null, fetch: rest.fetch }).treePaths('rust-v0.162.1', () => true));
  assert.equal((viaGh as Error).message, (viaRest as Error).message, 'the same failure reads the same on both paths');
});

test('the command line in an exec error message does not decide the status; gh\'s own stderr does', async () => {
  // the tag is caller-supplied and ends up in the command line that execFile repeats in its message
  const tag = 'weird HTTP 500 tag';
  const original = Object.assign(new Error(`Command failed: gh release view --repo openai/codex --json tagName -- ${tag}\nrelease not found\n`), { code: 1, stderr: 'release not found\n' });
  assert.equal(await new GitHubClient({ gh: async () => { throw original; } }).release(tag), undefined, 'release not found is a 404, whatever the tag says');
  const stderrless = Object.assign(new Error('GitHub says: Not Found (HTTP 404)'), { code: 1 }); // a runner that only fills the message
  const error = await failure(new GitHubClient({ gh: async () => { throw stderrless; } }).pullRequestDiff(3));
  assert.ok(error instanceof GitHubError && error.status === 404);
});

test('release gives undefined for a tag without a release on both paths, and every other failure throws', async () => {
  const fails = (stderr: string): GhRunner => async () => { throw Object.assign(new Error(`Command failed: gh\n${stderr}`), { code: 1, stderr }); };
  // a stable tag can exist before its release is published
  assert.equal(await new GitHubClient({ gh: fails('release not found\n') }).release('rust-v0.163.0'), undefined);
  assert.equal(await new GitHubClient({ gh: fails('gh: Not Found (HTTP 404)\n') }).release('rust-v0.163.0'), undefined);
  const notFound = stubFetch(() => json({ message: 'Not Found' }, 404));
  assert.equal(await new GitHubClient({ gh: null, fetch: notFound.fetch }).release('rust-v0.163.0'), undefined);
  assert.deepEqual(notFound.calls.map(c => c.url), ['https://api.github.com/repos/openai/codex/releases/tags/rust-v0.163.0']);
  // anything else is an error
  const gateway = await failure(new GitHubClient({ gh: fails("gh: We couldn't respond to your request in time. (HTTP 504)\n") }).release('rust-v0.163.0'));
  assert.ok(gateway instanceof GitHubError && gateway.status === 504);
  const server = await failure(new GitHubClient({ gh: null, fetch: stubFetch(() => json({ message: 'Server Error' }, 500)).fetch }).release('rust-v0.163.0'));
  assert.ok(server instanceof GitHubError && server.status === 500);
  const limited = await failure(new GitHubClient({ gh: null, fetch: stubFetch(() => json({ message: 'rate limited' }, 403)).fetch }).release('rust-v0.163.0'));
  assert.ok(limited instanceof GitHubError && limited.status === 403);
  // a missing pull request, tree, file or diff is still an error
  const noPull = await failure(new GitHubClient({ gh: fails('GraphQL: Could not resolve to a PullRequest with the number of 99999999. (repository.pullRequest)\n') }).pullRequest(99999999));
  assert.ok(noPull instanceof GitHubError && noPull.status === 404 && noPull.path === 'repos/openai/codex/pulls/99999999');
  const noTree = await failure(new GitHubClient({ gh: null, fetch: notFound.fetch }).treePaths('rust-v9.9.9', () => true));
  assert.ok(noTree instanceof GitHubError && noTree.status === 404);
  const noFile = await failure(new GitHubClient({ gh: null, fetch: notFound.fetch }).fileAt('rust-v0.162.1', 'no/such.md'));
  assert.ok(noFile instanceof GitHubError && noFile.status === 404);
  const noDiff = await failure(new GitHubClient({ gh: fails('could not find pull request diff: HTTP 404: Not Found (https://api.github.com/repos/openai/codex/pulls/1)\n') }).pullRequestDiff(1));
  assert.ok(noDiff instanceof GitHubError && noDiff.status === 404);
});

test('a REST request that never reaches GitHub names the path and the route, and keeps the cause', async () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7897'), { code: 'ECONNREFUSED' });
  const fetchFailed = Object.assign(new TypeError('fetch failed'), { cause: refused });
  const error = await failure(new GitHubClient({ gh: null, fetch: stubFetch(() => { throw fetchFailed; }).fetch }).stableTags(1));
  assert.ok(error instanceof GitHubError);
  assert.equal(error.message, 'GitHub request for repos/openai/codex/tags?per_page=100&page=1 failed (custom fetch): connect ECONNREFUSED 127.0.0.1:7897');
  assert.equal(error.cause, fetchFailed);
  assert.equal(error.status, undefined);
  assert.equal(error.path, 'repos/openai/codex/tags?per_page=100&page=1');

  // Node's dual-stack connect errors are AggregateErrors with an empty message: the code says what happened
  const aggregate = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }) });
  const noMessage = await failure(new GitHubClient({ gh: null, fetch: stubFetch(() => { throw aggregate; }).fetch }).stableTags(1));
  assert.match((noMessage as Error).message, /failed \(custom fetch\): ECONNREFUSED$/);
  // an error without a cause speaks for itself
  const plain = await failure(new GitHubClient({ gh: null, fetch: stubFetch(() => { throw new TypeError('terminated'); }).fetch }).stableTags(1));
  assert.match((plain as Error).message, /failed \(custom fetch\): terminated$/);
  // the body can break off after the headers
  const cut = stubFetch(() => new Response(new ReadableStream({ start(controller) { controller.error(new Error('socket hang up')); } }), { status: 200 }));
  const broken = await failure(new GitHubClient({ gh: null, fetch: cut.fetch }).stableTags(1));
  assert.ok(broken instanceof GitHubError);
  assert.match(broken.message, /failed \(custom fetch\): socket hang up$/);
});

test('an abort is never reworded: gh and REST rethrow the signal\'s own reason, and an abort does not count against gh', async () => {
  const viaRest = new AbortController();
  viaRest.abort();
  const stub = stubFetch(({ signal }) => { signal?.throwIfAborted(); return json([]); });
  const killed: GhRunner = async (_args, signal) => { signal?.throwIfAborted(); return '[]'; };
  assert.equal(await failure(new GitHubClient({ gh: null, fetch: stub.fetch }).stableTags(1, viaRest.signal)), viaRest.signal.reason);
  const custom = new AbortController();
  custom.abort(new Error('shutting down')); // a reason that does not look like an AbortError at all
  assert.equal(await failure(new GitHubClient({ gh: null, fetch: stub.fetch }).stableTags(1, custom.signal)), custom.signal.reason);
  assert.equal(await failure(new GitHubClient({ gh: killed }).stableTags(1, custom.signal)), custom.signal.reason);
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); // a timeout signal wrapped around the call elsewhere
  assert.equal(await failure(new GitHubClient({ gh: null, fetch: stubFetch(() => { throw timeout; }).fetch }).stableTags(1)), timeout);

  const viaGh = new AbortController();
  viaGh.abort();
  assert.equal(await failure(new GitHubClient({ gh: killed }).stableTags(1, viaGh.signal)), viaGh.signal.reason, 'the same error as the REST abort');
  const timedOut = Object.assign(new Error('timed out'), { name: 'TimeoutError' }); // raised by the runner itself, no signal involved
  assert.equal(await failure(new GitHubClient({ gh: async () => { throw timedOut; } }).stableTags(1)), timedOut);

  // the abort lands together with an error that looks like a missing gh: still an abort, no REST, and gh is not written off
  const gate = new AbortController();
  let attempts = 0;
  const runner: GhRunner = async () => { attempts++; if (attempts > 1) return '[]'; gate.abort(); return missingGh([]); };
  const fallback = stubFetch(() => json([{ name: 'rust-v0.162.1' }]));
  const client = new GitHubClient({ gh: runner, fetch: fallback.fetch });
  assert.equal(await failure(client.stableTags(1, gate.signal)), gate.signal.reason);
  assert.equal(fallback.calls.length, 0, 'no switch to REST');
  assert.equal(client.route, 'gh');
  assert.deepEqual(await client.stableTags(1), [], 'gh is still tried on the next call');
  assert.equal(attempts, 2);
  assert.equal(fallback.calls.length, 0);
});

test('route tells which path served the last request, and gh stays written off once it proved unusable', async () => {
  const viaGh = new GitHubClient({ gh: async () => '[]' });
  assert.equal(viaGh.route, undefined, 'nothing asked yet');
  await viaGh.stableTags(1);
  assert.equal(viaGh.route, 'gh');
  const viaRest = new GitHubClient({ gh: null, fetch: stubFetch(() => json([])).fetch });
  await viaRest.stableTags(1);
  assert.equal(viaRest.route, 'rest');
  // a failing gh request is still a gh request
  const notFound: GhRunner = async () => { throw Object.assign(new Error('Command failed: gh'), { code: 1, stderr: 'gh: Not Found (HTTP 404)\n' }); };
  const failing = new GitHubClient({ gh: notFound, fetch: stubFetch(() => json([])).fetch });
  await failure(failing.stableTags(1));
  assert.equal(failing.route, 'gh');
  // gh proves unusable: the call that finds out already reports REST, and gh is never started again
  let attempts = 0;
  const signedOut: GhRunner = async () => { attempts++; throw Object.assign(new Error('Command failed: gh api'), { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' }); };
  const client = new GitHubClient({ gh: signedOut, fetch: stubFetch(() => json([])).fetch });
  await client.stableTags(1);
  assert.equal(client.route, 'rest');
  await client.stableTags(1);
  assert.equal(client.route, 'rest');
  assert.equal(attempts, 1, 'unusable is sticky for the life of the client');
});

test('stableTags insists on a positive integer limit', async () => {
  const stub = stubFetch(() => json([]));
  const client = new GitHubClient({ gh: null, fetch: stub.fetch });
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) await assert.rejects(client.stableTags(bad), RangeError);
  assert.equal(stub.calls.length, 0, 'refused before any request');
});

test('stableTags stops trusting the listing order the moment a page breaks it', async () => {
  const full = (names: string[]) => [...names.map(name => ({ name })), ...Array.from({ length: 100 - names.length }, (_, i) => ({ name: `rust-v0.200.0-alpha.${i}` }))];
  const serve = (pages: Array<Array<{ name: string }>>) => {
    const stub = stubFetch(({ url }) => json(pages[Number(/&page=(\d+)$/.exec(url)![1]) - 1] ?? []));
    return { client: new GitHubClient({ gh: null, fetch: stub.fetch }), requests: () => stub.calls.length };
  };
  // in order: two stable tags are enough for limit 2, so page 1 is the only request
  const ordered = serve([full(['rust-v0.162.0', 'rust-v0.161.0']), full(['rust-v0.999.0'])]);
  assert.deepEqual(await ordered.client.stableTags(2), ['rust-v0.162.0', 'rust-v0.161.0']);
  assert.equal(ordered.requests(), 1);
  // 0.161.0 listed after 0.160.0 is a newer tag after an older one: the listing is not newest-first any more, so having enough tags does not end the reading
  const shuffled = serve([full(['rust-v0.160.0', 'rust-v0.161.0']), [{ name: 'rust-v0.163.0' }, { name: 'rust-v0.162.0' }]]);
  assert.deepEqual(await shuffled.client.stableTags(2), ['rust-v0.163.0', 'rust-v0.162.0']);
  assert.equal(shuffled.requests(), 2);
  // the break may sit across a page boundary
  const across = serve([full(['rust-v0.161.0', 'rust-v0.160.0']), full(['rust-v0.163.0', 'rust-v0.159.0']), [{ name: 'rust-v0.164.0' }]]);
  assert.deepEqual(await across.client.stableTags(3), ['rust-v0.164.0', 'rust-v0.163.0', 'rust-v0.161.0']);
  assert.equal(across.requests(), 3);
  // a tag listed twice is not a break
  const repeated = serve([full(['rust-v0.162.0', 'rust-v0.161.0', 'rust-v0.162.0']), full(['rust-v0.999.0'])]);
  assert.deepEqual(await repeated.client.stableTags(2), ['rust-v0.162.0', 'rust-v0.161.0']);
  assert.equal(repeated.requests(), 1);
  // a listing that stays out of order is read only up to the five-page cap
  const chaos = serve(Array.from({ length: 8 }, (_, i) => full([`rust-v0.${2 * i + 1}.0`, `rust-v0.${2 * i + 2}.0`])));
  assert.deepEqual(await chaos.client.stableTags(1), ['rust-v0.10.0']);
  assert.equal(chaos.requests(), 5);
});

test('responses of an unexpected shape fail with a plain Error that names the path', async () => {
  const shape = async (promise: Promise<unknown>, pattern: RegExp) => {
    const error = await failure(promise);
    assert.ok(error instanceof Error && !(error instanceof GitHubError), `a plain Error, got ${String(error)}`);
    assert.match(error.message, pattern);
  };
  const gh = (value: unknown) => new GitHubClient({ gh: async () => JSON.stringify(value) });
  const rest = (value: unknown) => new GitHubClient({ gh: null, fetch: stubFetch(() => json(value)).fetch });
  const keepAll = () => true;
  // tree
  await shape(gh({ truncated: false }).treePaths('rust-v0.162.1', keepAll), /repos\/openai\/codex\/git\/trees\/rust-v0\.162\.1\?recursive=1.*"tree" is not an array/);
  await shape(gh(null).treePaths('rust-v0.162.1', keepAll), /not a JSON object/);
  await shape(gh({ tree: [{ path: 'a.rs', type: 'blob' }] }).treePaths('rust-v0.162.1', keepAll), /"sha" is not a string/);
  await shape(gh({ tree: [null] }).treePaths('rust-v0.162.1', keepAll), /not a JSON object/);
  // release: gh shape and REST shape
  const releaseAt = /repos\/openai\/codex\/releases\/tags\/rust-v0\.162\.0/;
  await shape(gh({ tagName: 'rust-v0.162.0', body: 'x', isPrerelease: false }).release('rust-v0.162.0'), new RegExp(`${releaseAt.source}.*"publishedAt" is not a string`));
  await shape(gh({ tagName: 'rust-v0.162.0', body: 'x', publishedAt: '2026-10-08T00:00:00Z', isPrerelease: 'no' }).release('rust-v0.162.0'), /"isPrerelease" is not a boolean/);
  await shape(gh({ tagName: 'rust-v0.162.0', body: 5, publishedAt: '2026-10-08T00:00:00Z', isPrerelease: false }).release('rust-v0.162.0'), /"body" is not a string/);
  await shape(rest({ tag_name: 162, published_at: '2026-10-08T00:00:00Z', prerelease: false, body: '' }).release('rust-v0.162.0'), /"tag_name" is not a string/);
  await shape(gh([]).release('rust-v0.162.0'), /not a JSON object/);
  // pull request
  const pull = { number: 7, title: 't', body: 'b', url: 'https://github.com/openai/codex/pull/7', additions: 1, deletions: 0 };
  await shape(gh({ ...pull, number: '7' }).pullRequest(7), /repos\/openai\/codex\/pulls\/7.*"number" is not a number/);
  await shape(gh({ ...pull, title: undefined }).pullRequest(7), /"title" is not a string/);
  await shape(gh({ ...pull, additions: '1' }).pullRequest(7), /"additions" is not a number/);
  await shape(gh({ ...pull, files: [{ additions: 1, deletions: 0 }] }).pullRequest(7), /"path" is not a string/);
  await shape(gh({ ...pull, files: 'none' }).pullRequest(7), /"files" is not an array/);
  const badRows = new GitHubClient({ gh: null, fetch: stubFetch(({ url }) => json(url.endsWith('/pulls/7') ? pull : [{ additions: 1, deletions: 0 }])).fetch });
  await shape(badRows.pullRequest(7), /pulls\/7\/files.*"filename" is not a string/);
  // tags and file contents
  await shape(rest([{ nom: 'rust-v0.162.0' }]).stableTags(1), /repos\/openai\/codex\/tags.*"name" is not a string/);
  await shape(rest([null]).stableTags(1), /not a JSON object/);
  await shape(gh(null).fileAt('rust-v0.162.1', 'docs/a.md'), /not a JSON object/);
});

/** No proxy variable but one that is no URL: the real publicNetwork rejects on it, before anything is sent. */
const brokenProxy = { HTTPS_PROXY: 'not a url', https_proxy: undefined, HTTP_PROXY: undefined, http_proxy: undefined };

test('a failure while setting up the proxied network is wrapped like a request failure', async () => {
  await withEnv(brokenProxy, async () => {
    // The premise, checked first: if the real publicNetwork ever stops rejecting here, the test fails before the client below can send anything.
    await assert.rejects(publicNetwork(new AbortController().signal), TypeError);
    const client = new GitHubClient({ gh: null }); // no fetch option, so the real publicNetwork is set up first
    const error = await failure(client.stableTags(1));
    assert.ok(error instanceof GitHubError, String(error));
    assert.ok(error.cause instanceof TypeError, 'the original error is the cause');
    assert.equal(error.message, `GitHub request for repos/openai/codex/tags?per_page=100&page=1 failed (proxy setup): ${error.cause.message}`);
    assert.equal(error.path, 'repos/openai/codex/tags?per_page=100&page=1');
    assert.equal(error.status, undefined);
    assert.equal(client.route, 'rest');
    // the diff request sets the network up the same way and names its own path
    const diff = await failure(client.pullRequestDiff(7));
    assert.ok(diff instanceof GitHubError);
    assert.match(diff.message, /^GitHub request for repos\/openai\/codex\/pulls\/7 failed \(proxy setup\): .+/);
    assert.equal(diff.path, 'repos/openai/codex/pulls/7');
  });
});

test('an abort that lands while the network is being set up is rethrown as it came', async () => {
  const controller = new AbortController();
  controller.abort(new Error('shutting down'));
  const error = await failure(new GitHubClient({ gh: null }).stableTags(1, controller.signal)); // publicNetwork throws the signal's reason before it does anything
  assert.equal(error, controller.signal.reason);
  assert.ok(!(error instanceof GitHubError));
});
