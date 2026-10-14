/** Local reference uploads: bounded decoding, fixed paths and atomic no-clobber writes. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MAX_SCREENSHOT_BYTES, validateScreenshotBytes, validateScreenshotMetadata, type OpenCodexStore } from '../core/index.js';
import type { Artifact, CreateJobInput, Job, ScreenshotMetadata } from '../core/types.js';
import type { ReferenceImageInput } from './remote.js';

export const MAX_REFERENCE_IMAGE_BYTES = MAX_SCREENSHOT_BYTES;
const MAX_BASE64_LENGTH = Math.ceil(MAX_REFERENCE_IMAGE_BYTES / 3) * 4;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFERENCE_FILES = { 'reference.png': 'image/png', 'reference.jpeg': 'image/jpeg', 'reference.webp': 'image/webp' } as const;

export function decodeReferenceImage(input: ReferenceImageInput): { bytes: Buffer; filename: 'reference.png' | 'reference.jpeg' | 'reference.webp' } {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['mimeType', 'dataBase64'].includes(key))) throw new Error('referenceImage accepts only mimeType and dataBase64');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(input.mimeType)) throw new Error('Reference image must be PNG, JPEG or WebP');
  const encoded = input.dataBase64;
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > MAX_BASE64_LENGTH) throw new Error('Reference image must be at most 2 MiB');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Reference image requires canonical base64 without a data URL or whitespace');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_REFERENCE_IMAGE_BYTES) throw new Error('Reference image must be at most 2 MiB');
  if (bytes.toString('base64') !== encoded) throw new Error('Reference image requires canonical base64');
  let detected: ReferenceImageInput['mimeType'];
  try { detected = validateScreenshotBytes(bytes); }
  catch { throw new Error('Reference image signature is unsupported or truncated'); }
  if (detected !== input.mimeType) throw new Error('Reference image signature does not match its declared MIME type or is truncated');
  return { bytes, filename: input.mimeType === 'image/png' ? 'reference.png' : input.mimeType === 'image/jpeg' ? 'reference.jpeg' : 'reference.webp' };
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }

async function checkedJobRoot(store: OpenCodexStore, jobId: string): Promise<string> {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new Error('Invalid image job ID');
  store.getJob(jobId); // A filesystem directory alone never grants access to an image.
  const root = store.artifactRoot;
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) throw new Error('Image artifact root must not contain symlinks');
  return root;
}

/** Read through a bounded handle; reject links and recheck identities before and after I/O. */
async function readJobImage(root: string, jobId: string, path: string, signal: AbortSignal): Promise<Buffer> {
  const jobRoot = join(root, jobId);
  const rel = relative(jobRoot, path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Image path must stay inside its own job');
  const directories: Array<{ path: string; stat: Stats }> = [];
  let cursor = root;
  for (const part of [undefined, ...relative(root, path).split(sep).slice(0, -1)]) {
    if (part !== undefined) cursor = join(cursor, part);
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(cursor) !== cursor) throw new Error('Image paths must not contain symlinks or non-directories');
    directories.push({ path: cursor, stat });
  }
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('Image must be a regular file without symlinks or hard links');
  if (!before.size || before.size > MAX_REFERENCE_IMAGE_BYTES) throw new Error('Image must be nonempty and at most 2 MiB');
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened)) throw new Error('Image changed while opening');
    const checkPaths = async () => {
      for (const directory of directories) {
        const current = await lstat(directory.path);
        if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(directory.stat, current) || await realpath(directory.path) !== directory.path) throw new Error('Image directory changed while reading');
      }
      const current = await lstat(path);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !sameFile(opened, current) || await realpath(path) !== path) throw new Error('Image path changed while reading');
    };
    await checkPaths();
    // Never use readFile(): a file that grows after stat must still have a hard allocation/read limit.
    const bytes = Buffer.alloc(MAX_REFERENCE_IMAGE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (!length || length > MAX_REFERENCE_IMAGE_BYTES) throw new Error('Image must be nonempty and at most 2 MiB');
    const after = await file.stat();
    if (!sameFile(opened, after) || opened.size !== length || after.size !== length || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw new Error('Image changed while reading');
    await checkPaths();
    signal.throwIfAborted();
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

function encodedImage(bytes: Buffer, expectedMime?: ReferenceImageInput['mimeType']): ReferenceImageInput {
  const mimeType = expectedMime ?? (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : 'image/webp');
  const image = { mimeType, dataBase64: bytes.toString('base64') };
  decodeReferenceImage(image); // Reuse upload validation; an extension is never trusted as proof of format.
  return image;
}

export async function readReferenceImage(store: OpenCodexStore, jobId: string, signal: AbortSignal): Promise<ReferenceImageInput | undefined> {
  signal.throwIfAborted();
  const root = await checkedJobRoot(store, jobId);
  const directory = join(root, jobId);
  let directoryStat: Stats;
  try { directoryStat = await lstat(directory); } catch (error) { if (missing(error)) return undefined; throw error; }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Reference image job directory must not contain symlinks');
  const found: Array<{ path: string; mimeType: ReferenceImageInput['mimeType'] }> = [];
  for (const [filename, mimeType] of Object.entries(REFERENCE_FILES)) {
    const path = join(directory, filename);
    try { await lstat(path); found.push({ path, mimeType }); } catch (error) { if (!missing(error)) throw error; }
  }
  if (!found.length) return undefined;
  if (found.length > 1) throw new Error('Multiple reference images found for one job');
  const image = found[0]!;
  return encodedImage(await readJobImage(root, jobId, image.path, signal), image.mimeType);
}

export async function readScreenshot(store: OpenCodexStore, jobId: string, artifactId: string, signal: AbortSignal): Promise<ReferenceImageInput> {
  signal.throwIfAborted();
  const root = await checkedJobRoot(store, jobId);
  const artifact = store.snapshot().artifacts.find(item => item.id === artifactId);
  if (!artifact || artifact.jobId !== jobId || artifact.kind !== 'screenshot') throw new Error('Screenshot must be a registered screenshot artifact of this job');
  if (!artifact.bytes || artifact.bytes > MAX_REFERENCE_IMAGE_BYTES) throw new Error('Screenshot must be nonempty and at most 2 MiB');
  if (isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new Error('Invalid screenshot artifact path');
  const bytes = await readJobImage(root, jobId, resolve(root, artifact.path), signal);
  if (bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Screenshot no longer matches its registered SHA-256');
  return encodedImage(bytes);
}

/** A user can supplement any existing dossier without resuming research or claiming acceptance. */
export async function addScreenshot(store: OpenCodexStore, jobId: string, image: ReferenceImageInput, metadata: ScreenshotMetadata, signal: AbortSignal): Promise<Artifact> {
  signal.throwIfAborted();
  validateScreenshotMetadata(metadata);
  if (metadata.provenance !== 'user') throw new Error('Uploaded screenshots must use user provenance');
  const screenshot = structuredClone(metadata);
  const decoded = decodeReferenceImage(image);
  const root = await checkedJobRoot(store, jobId);
  const rootStat = await lstat(root);
  const directory = join(root, jobId);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Screenshot job directory must not contain symlinks');
  const checkDirectories = async () => {
    for (const [path, before] of [[root, rootStat], [directory, directoryStat]] as const) {
      const current = await lstat(path);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(before, current) || await realpath(path) !== path) throw new Error('Screenshot directory changed while writing');
    }
  };
  const filename = `screenshot-${randomUUID()}.${decoded.filename.split('.').at(-1)}`;
  const destination = join(directory, filename);
  const temporary = join(directory, `.screenshot-${randomUUID()}.tmp`);
  let ownedFile: Stats | undefined;
  let ownsTemporary = false, ownsDestination = false;
  const removeOwned = async (path: string) => {
    try {
      const current = await lstat(path);
      if (ownedFile && current.isFile() && !current.isSymbolicLink() && sameFile(ownedFile, current)) await unlink(path);
    } catch (error) { if (!missing(error)) throw error; }
  };
  try {
    signal.throwIfAborted();
    await checkDirectories();
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    ownsTemporary = true;
    try {
      ownedFile = await file.stat();
      if (!ownedFile.isFile() || ownedFile.nlink !== 1) throw new Error('Screenshot temporary file must be a regular unlinked file');
      await checkDirectories();
      await file.writeFile(decoded.bytes); await file.sync();
    } finally { await file.close(); }
    signal.throwIfAborted();
    await checkDirectories();
    const temporaryStat = await lstat(temporary);
    if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink() || temporaryStat.nlink !== 1 || !ownedFile || !sameFile(ownedFile, temporaryStat)) throw new Error('Screenshot temporary path changed while writing');
    await link(temporary, destination); // No existing file, reference image or previous upload can be overwritten.
    ownsDestination = true;
    await unlink(temporary); ownsTemporary = false;
    await checkDirectories();
    signal.throwIfAborted();
    return await store.registerArtifact(jobId, { path: `${jobId}/${filename}`, kind: 'screenshot', label: screenshot.caption, screenshot });
  } catch (error) {
    if (ownsDestination) await removeOwned(destination).catch(() => undefined);
    if (ownsTemporary) await removeOwned(temporary).catch(() => undefined);
    throw error;
  }
}

export async function createJobWithReference(store: OpenCodexStore, input: CreateJobInput, image: ReferenceImageInput, signal: AbortSignal): Promise<Job> {
  const decoded = decodeReferenceImage(image); // Every upload check precedes any job or file mutation.
  if (!input || typeof input !== 'object' || (input.description !== undefined && typeof input.description !== 'string')) throw new Error('Job description must be text');
  signal.throwIfAborted();
  // Candidate creation is idempotent. A retried create must not replace a reference
  // or run failure transitions against the already existing research job.
  const existing = input.candidateId ? store.snapshot().jobs.find(job => job.candidateId === input.candidateId) : undefined;
  if (existing) return store.getJob(existing.id);
  const description = `${input.description ?? ''}\n\nUser-supplied visual reference: ${decoded.filename} (relative to this job's workspace). Inspect it with the installed read_image tool or equivalent before recording visual observations. This file is stored locally; exclude it from published plugin artifacts.`.trim();
  const root = await realpath(store.artifactRoot);
  const job = await store.createJob({ ...input, description });
  const directory = join(root, job.id);
  const destination = join(directory, decoded.filename);
  const temporary = join(directory, `.reference-${randomUUID()}.tmp`);
  let ownsTemporary = false;
  let ownsDestination = false;
  try {
    await mkdir(directory, { mode: 0o700 }); // A pre-existing directory or symlink is never adopted here.
    signal.throwIfAborted();
    const file = await open(temporary, 'wx', 0o600);
    ownsTemporary = true;
    try { await file.writeFile(decoded.bytes); await file.sync(); } finally { await file.close(); }
    signal.throwIfAborted();
    await link(temporary, destination); // Publish a complete file atomically, refusing any existing name.
    ownsDestination = true;
    await unlink(temporary); ownsTemporary = false;
    await store.registerArtifact(job.id, {
      path: `${job.id}/${decoded.filename}`, kind: 'screenshot', label: '用户提供的 Codex 参考截图',
      screenshot: { subject: 'codex', caption: input.title, provenance: 'user' },
    });
    return job;
  } catch (error) {
    if (ownsDestination) await unlink(destination).catch(() => undefined);
    if (ownsTemporary) await unlink(temporary).catch(() => undefined);
    // Keep the durable record explicit if an I/O error occurs after job creation.
    await store.transitionJob(job.id, 'queued', { reason: 'Preparing the local reference image' });
    await store.transitionJob(job.id, 'failed', { reason: 'Local reference image could not be saved; no research was started' });
    throw error;
  }
}
