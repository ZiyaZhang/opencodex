import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodexStore } from '../src/core/index.js';
import { scanSources, fetchDiscoverySource, DISCOVERY_SOURCES } from '../src/host/discovery.js';

const date = new Date().toISOString().slice(0, 10);
const source = DISCOVERY_SOURCES[0];
const body = (extra = '') => `- ${date}\n### Codex desktop app 26.1014 {#release}\n### New features\n- **Draft preview:** Preview the draft in a separate pane.\n- **Question chips:** Keep questions beside the composer.\n${extra}`;
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-scan-'));
  const store = await OpenCodexStore.open({ directory });
  const original = globalThis.fetch;
  t.after(async () => { globalThis.fetch = original; await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, scan: () => scanSources(directory, store, new AbortController().signal) };
}

test('first scan discovers individual recent features without starting research; repeated and edited sources deduplicate', async t => {
  const f = await fixture(t);
  let content = body();
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), source.url);
    assert.equal(options?.redirect, 'error');
    return new Response(content, { headers: { etag: 'synthetic', 'content-type': 'text/markdown' } });
  };
  assert.equal((await f.scan()).discovered, 2);
  assert.equal(f.store.snapshot().candidates.length, 2);
  assert.equal(f.store.snapshot().jobs.length, 0);
  assert.ok(f.store.snapshot().candidates.every(item => item.publishedAt && item.releaseTitle && item.sourceUrl.endsWith('#release')));
  assert.equal((await f.scan()).discovered, 0);
  content = body('- **Attachment labels:** Show the file name below an image.');
  const update = await f.scan();
  assert.equal(update.changed, 1);
  assert.equal(update.discovered, 1);
  assert.equal(f.store.snapshot().candidates.length, 3);
  assert.equal(f.store.snapshot().jobs.length, 0);
});

test('old hash-only baselines force a full feature parse and retire only unselected legacy notices', async t => {
  const f = await fixture(t);
  const old = { title: 'Codex changelog changed — unverified', description: 'Whole page changed', sourceUrl: source.pageUrl, fingerprint: `codex-changelog:${'a'.repeat(64)}` };
  await f.store.saveCandidate(old);
  await f.store.saveCandidate({ ...old, fingerprint: `codex-cli-releases:${'b'.repeat(64)}`, status: 'selected' });
  await writeFile(join(f.directory, 'discovery.json'), JSON.stringify({ schemaVersion: 1, sources: { 'codex-changelog': { hash: 'a'.repeat(64), etag: 'old', checkedAt: new Date().toISOString() } } }));
  globalThis.fetch = async (_url, options) => {
    assert.equal(new Headers(options?.headers).get('if-none-match'), null);
    return new Response(body());
  };
  assert.equal((await f.scan()).discovered, 2);
  const candidates = f.store.snapshot().candidates;
  assert.equal(candidates[0]?.status, 'dismissed');
  assert.equal(candidates[1]?.status, 'selected');
  assert.equal(JSON.parse(await readFile(join(f.directory, 'discovery.json'), 'utf8')).schemaVersion, 2);
});

test('compatible ETags avoid reparsing; failed fetch or unsupported format never advances the saved checkpoint', async t => {
  const f = await fixture(t);
  globalThis.fetch = async () => new Response(body(), { headers: { etag: 'saved' } });
  await f.scan();
  const checkpoint = await readFile(join(f.directory, 'discovery.json'), 'utf8');
  globalThis.fetch = async (_url, options) => {
    assert.equal(new Headers(options?.headers).get('if-none-match'), 'saved');
    return new Response(null, { status: 304 });
  };
  assert.equal((await f.scan()).unchanged, 1);
  globalThis.fetch = async () => new Response('<html>temporary sign-in page</html>');
  assert.match((await f.scan()).errors[0]!, /format was not recognized/);
  assert.equal(await readFile(join(f.directory, 'discovery.json'), 'utf8'), checkpoint);
  assert.equal(f.store.snapshot().candidates.length, 2);
});

test('official HTML fallback is bounded and used after RSS fetch failure', async t => {
  const f = await fixture(t);
  const requests: string[] = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    return String(url) === source.url ? new Response('gone', { status: 404 }) : new Response(body());
  };
  assert.equal((await f.scan()).discovered, 2);
  assert.deepEqual(requests, [source.url, source.fallbackUrl]);
});

test('an unparseable successful RSS response falls back to HTML and checkpoints only the valid source', async t => {
  const f = await fixture(t);
  const requests: string[] = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    return String(url) === source.url
      ? new Response('<html>temporary sign-in page</html>', { headers: { etag: 'invalid-rss' } })
      : new Response(body(), { headers: { etag: 'valid-html' } });
  };
  const result = await f.scan();
  assert.deepEqual(result.errors, []);
  assert.equal(result.discovered, 2);
  assert.deepEqual(requests, [source.url, source.fallbackUrl]);
  const saved = JSON.parse(await readFile(join(f.directory, 'discovery.json'), 'utf8'));
  assert.equal(saved.sources[source.id].url, source.fallbackUrl);
  assert.equal(saved.sources[source.id].etag, 'valid-html');
});

test('discovery rejects oversized responses and unsolicited 304, and does not follow redirects', async t => {
  await fixture(t);
  globalThis.fetch = async () => new Response('x', { headers: { 'content-length': '1500001' } });
  await assert.rejects(fetchDiscoverySource(source.url, undefined, new AbortController().signal), /byte limit/);
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  await assert.rejects(fetchDiscoverySource(source.url, undefined, new AbortController().signal), /HTTP 503/);
  globalThis.fetch = async () => new Response(null, { status: 304 });
  await assert.rejects(fetchDiscoverySource(source.url, undefined, new AbortController().signal), /Unexpected 304/);
});
