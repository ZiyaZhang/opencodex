import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodexStore } from '../src/core/index.js';
import { scanSources, fetchDiscoverySource, DISCOVERY_SOURCES } from '../src/host/discovery.js';

test('discovery saves a baseline before reporting changed official sources and never starts research', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-scan-'));
  const store = await OpenCodexStore.open({ directory });
  const original = globalThis.fetch;
  let body = '<main>Codex release A</main>';
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    assert.ok(DISCOVERY_SOURCES.some(source => source.url === String(url)));
    assert.equal(options?.redirect, 'error');
    requests++;
    return new Response(body, { status: 200, headers: { etag: 'test', 'content-type': 'text/html' } });
  };
  try {
    const baseline = await scanSources(directory, store, new AbortController().signal);
    assert.equal(baseline.baseline, 2);
    assert.equal(store.snapshot().candidates.length, 0);
    assert.equal((await scanSources(directory, store, new AbortController().signal)).unchanged, 2);
    body = '<main>Codex release B</main>';
    assert.equal((await scanSources(directory, store, new AbortController().signal)).changed, 2);
    assert.equal(store.snapshot().candidates.length, 2);
    assert.match(store.snapshot().candidates[0]!.description, /not been tested/);
    assert.equal(store.snapshot().jobs.length, 0);
    assert.equal(requests, 6);
  } finally { globalThis.fetch = original; await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('discovery rejects oversized streams and non-success responses', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('x', { headers: { 'content-length': '1500001' } });
    await assert.rejects(fetchDiscoverySource(DISCOVERY_SOURCES[0].url, undefined, new AbortController().signal), /byte limit/);
    globalThis.fetch = async () => new Response('unavailable', { status: 503 });
    await assert.rejects(fetchDiscoverySource(DISCOVERY_SOURCES[0].url, undefined, new AbortController().signal), /HTTP 503/);
  } finally { globalThis.fetch = original; }
});
