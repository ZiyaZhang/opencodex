import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtemp, open, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectArtifact, inspectTarball } from '../src/host/artifact.js';

function tarball(files: Record<string, string>, link = false): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content), header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    header[156] = link ? 50 : 48;
    header.fill(32, 148, 156);
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}
function valid(scripts?: object) {
  return {
    'package/package.json': JSON.stringify({ name: 'synthetic-feature-fixture', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, ...(scripts ? { scripts } : {}) }),
    'package/cordis.patch.yml': 'plugins: []', 'package/dist/host.js': 'export const syntheticFixture = true;',
  };
}

test('package inspection reads a real archive without executing generated code and does not claim functional acceptance', () => {
  const result = inspectTarball(tarball(valid()));
  assert.equal(result.passed, true);
  assert.match(result.details.join(' '), /No code was executed/);
  assert.match(result.details.join(' '), /still require independent/);
});
test('package inspection rejects install scripts, path escapes and links', () => {
  assert.throws(() => inspectTarball(tarball(valid({ postinstall: 'touch user-profile' }))), /install scripts/);
  assert.throws(() => inspectTarball(tarball({ '../escape': 'bad' })), /Unsafe archive path/);
  assert.throws(() => inspectTarball(tarball(valid(), true)), /links/);
  assert.throws(() => inspectTarball(tarball({ 'package/package.json': '{}' })), /name and version/);
});

test('artifact file inspection refuses oversized and symlinked files before allocating their contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-artifact-'));
  try {
    const path = join(directory, 'huge.tgz');
    const handle = await open(path, 'w');
    await handle.truncate(100_000_000); await handle.close();
    await assert.rejects(inspectArtifact(path, 'irrelevant'), /16 MB/);
    const link = join(directory, 'link.tgz'); await symlink(path, link);
    await assert.rejects(inspectArtifact(link, 'irrelevant'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
