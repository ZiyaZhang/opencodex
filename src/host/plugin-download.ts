/** Explicit user downloads of registered packages; never installs or executes them. */
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MAX_ARTIFACT_BYTES, type OpenCodexStore } from '../core/index.js';
import { inspectTarball } from './artifact.js';
import type { PluginArtifactChunk } from './remote.js';

export const PLUGIN_DOWNLOAD_CHUNK_BYTES = 512 * 1024;
// Match the package inspector's compressed-byte limit, which is stricter than the core artifact limit.
export const MAX_PLUGIN_DOWNLOAD_BYTES = Math.min(MAX_ARTIFACT_BYTES, 16_000_000);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }

async function readPackage(root: string, jobId: string, path: string, signal: AbortSignal): Promise<Buffer> {
  const jobRoot = join(root, jobId), rel = relative(jobRoot, path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Plugin path must stay inside its own job');
  const directories: Array<{ path: string; stat: Stats }> = [];
  let cursor = root;
  for (const part of [undefined, ...relative(root, path).split(sep).slice(0, -1)]) {
    if (part !== undefined) cursor = join(cursor, part);
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(cursor) !== cursor) throw new Error('Plugin paths must not contain symlinks or non-directories');
    directories.push({ path: cursor, stat });
  }
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('Plugin must be a regular file without symlinks or hard links');
  if (!before.size || before.size > MAX_PLUGIN_DOWNLOAD_BYTES) throw new Error('Plugin must be nonempty and at most 16 MB');
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened) || before.size !== opened.size || before.mtimeMs !== opened.mtimeMs || before.ctimeMs !== opened.ctimeMs) throw new Error('Plugin changed while opening');
    const checkPaths = async () => {
      for (const directory of directories) {
        const current = await lstat(directory.path);
        if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(directory.stat, current) || await realpath(directory.path) !== directory.path) throw new Error('Plugin directory changed while reading');
      }
      const current = await lstat(path);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !sameFile(opened, current) || await realpath(path) !== path) throw new Error('Plugin path changed while reading');
    };
    await checkPaths();
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      signal.throwIfAborted();
      // Bound every read even if a registered package grows after the initial stat.
      const chunk = Buffer.alloc(Math.min(65_536, MAX_PLUGIN_DOWNLOAD_BYTES + 1 - length));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, length);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > MAX_PLUGIN_DOWNLOAD_BYTES) throw new Error('Plugin must be nonempty and at most 16 MB');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (!length || !sameFile(opened, after) || opened.size !== length || after.size !== length || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs || after.nlink !== 1) throw new Error('Plugin changed while reading');
    await checkPaths();
    signal.throwIfAborted();
    return Buffer.concat(chunks, length);
  } finally { await file.close(); }
}

/** Return the exact registered buffer for either download or Host-controlled installation. */
export async function readRegisteredPlugin(store: OpenCodexStore, jobId: string, artifactId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (typeof jobId !== 'string' || !ID.test(jobId) || typeof artifactId !== 'string' || !ID.test(artifactId)) throw new Error('Invalid plugin job or artifact ID');
  store.getJob(jobId);
  const artifact = store.snapshot().artifacts.find(item => item.id === artifactId);
  if (!artifact || artifact.jobId !== jobId || artifact.kind !== 'plugin') throw new Error('Download requires a registered plugin artifact of this job');
  if (!artifact.bytes || artifact.bytes > MAX_PLUGIN_DOWNLOAD_BYTES) throw new Error('Plugin must be nonempty and at most 16 MB');
  if (isAbsolute(artifact.path) || artifact.path.includes('\\') || artifact.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid plugin artifact path');
  const filename = basename(artifact.path);
  if (!/\.(?:tgz|tar\.gz)$/.test(filename) || /[\x00-\x1f\x7f]/.test(filename)) throw new Error('Plugin download requires an npm tarball filename');
  const bytes = await readPackage(store.artifactRoot, jobId, resolve(store.artifactRoot, artifact.path), signal);
  if (bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Plugin no longer matches its registered SHA-256');
  const inspection = inspectTarball(bytes); // Inspect the exact buffer, never reopen the path or execute it.
  signal.throwIfAborted();
  return { artifact, filename, bytes, inspection };
}

export async function readPluginArtifact(store: OpenCodexStore, jobId: string, artifactId: string, offset: number | undefined, signal: AbortSignal): Promise<PluginArtifactChunk> {
  const { artifact, filename, bytes } = await readRegisteredPlugin(store, jobId, artifactId, signal);
  const start = offset === undefined ? 0 : offset;
  if (!Number.isSafeInteger(start) || start < 0 || start >= artifact.bytes) throw new Error('Plugin download offset must be an integer inside the registered file');
  const end = Math.min(start + PLUGIN_DOWNLOAD_CHUNK_BYTES, bytes.length);
  return { filename, sha256: artifact.sha256, totalBytes: bytes.length, offset: start, dataBase64: bytes.subarray(start, end).toString('base64'), ...(end < bytes.length ? { nextOffset: end } : {}) };
}
