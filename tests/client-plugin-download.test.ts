import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fetchPluginArtifact } from '../src/client/plugin-download.js';
import type { Artifact } from '../src/core/types.js';
import type { OpenCodexRequest, OpenCodexResponse, PluginArtifactChunk } from '../src/host/remote.js';

const bytes = Buffer.alloc(600_000, 29);
const artifact: Artifact = { id: 'package', jobId: 'job', path: 'job/plugin.tgz', kind: 'plugin', label: 'package', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: '2026-10-14T00:00:00Z' };
function chunk(offset: number): PluginArtifactChunk {
  const end = Math.min(offset + 512 * 1024, bytes.length);
  return { filename: 'plugin.tgz', offset, totalBytes: bytes.length, sha256: artifact.sha256, dataBase64: bytes.subarray(offset, end).toString('base64'), ...(end < bytes.length ? { nextOffset: end } : {}) };
}
function response(part: PluginArtifactChunk) { return { pluginArtifact: part } as OpenCodexResponse; }

test('package download assembles authenticated chunks and verifies the complete registered hash', async () => {
  const calls: OpenCodexRequest[] = [], progress: number[] = [];
  const result = await fetchPluginArtifact(async request => {
    calls.push(request);
    assert.equal(request.action, 'readPluginArtifact');
    return response(chunk(request.offset ?? 0));
  }, 'job', artifact, new AbortController().signal, received => progress.push(received));
  assert.deepEqual(calls, [{ action: 'readPluginArtifact', jobId: 'job', artifactId: 'package', offset: 0 }, { action: 'readPluginArtifact', jobId: 'job', artifactId: 'package', offset: 524288 }]);
  assert.deepEqual(progress, [524288, 600000]);
  assert.equal(result.filename, 'plugin.tgz');
  assert.deepEqual(Buffer.from(result.bytes), bytes);
});

test('download rejects changed metadata, skipped chunks, incomplete endings and unsafe filenames', async t => {
  const cases: Array<[string, (part: PluginArtifactChunk) => PluginArtifactChunk]> = [
    ['hash changed', part => ({ ...part, sha256: '0'.repeat(64) })],
    ['size changed', part => ({ ...part, totalBytes: bytes.length + 1 })],
    ['offset changed', part => ({ ...part, offset: part.offset + 1 })],
    ['missing remainder', part => ({ ...part, nextOffset: undefined })],
    ['out-of-order remainder', part => ({ ...part, nextOffset: 4 })],
    ['unsafe filename', part => ({ ...part, filename: '../plugin.tgz' })],
    ['invalid base64', part => ({ ...part, dataBase64: '****' })],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    await assert.rejects(fetchPluginArtifact(async () => response(mutate(chunk(0))), 'job', artifact, new AbortController().signal));
  });
});

test('download rejects corrupted file contents even when response metadata preserves the expected hash', async () => {
  await assert.rejects(fetchPluginArtifact(async request => {
    assert.equal(request.action, 'readPluginArtifact');
    const part = chunk(request.offset ?? 0), content = Buffer.from(part.dataBase64, 'base64');
    content[0] ^= 255;
    return response({ ...part, dataBase64: content.toString('base64') });
  }, 'job', artifact, new AbortController().signal), /SHA-256/);
});

test('download cancellation stops after an in-flight response without fetching another chunk', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(fetchPluginArtifact(async () => { calls++; controller.abort(); return response(chunk(0)); }, 'job', artifact, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});
