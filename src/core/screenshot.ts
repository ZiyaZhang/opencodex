import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { check, relativePath } from './validation.js';

export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
export type ScreenshotMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

/** Confined, link-free screenshot read shared by registration and acceptance gates. */
export async function readScreenshotFile(root: string, jobId: string, path: string): Promise<Buffer> {
  relativePath(path); relativePath(jobId, 'Screenshot job ID');
  check(!jobId.includes('/'), 'Screenshot job ID must identify one directory');
  const requested = resolve(root, path);
  const jobRelative = relative(join(root, jobId), requested);
  check(jobRelative && !isAbsolute(jobRelative) && jobRelative !== '..' && !jobRelative.startsWith(`..${sep}`), 'Screenshot path must stay inside its own job');
  const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
  const directories: Array<{ path: string; stat: Stats }> = [];
  let directory = root;
  for (const part of [undefined, ...relative(root, requested).split(sep).slice(0, -1)]) {
    if (part !== undefined) directory = join(directory, part);
    const stat = await lstat(directory);
    check(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(directory) === directory, 'Screenshot paths must not contain symlinks or non-directories');
    directories.push({ path: directory, stat });
  }
  const before = await lstat(requested);
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, 'Screenshot must be a regular file without symlinks or hard links');
  check(before.size > 0 && before.size <= MAX_SCREENSHOT_BYTES, 'Screenshot must be nonempty and at most 2 MiB');
  const handle = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    check(opened.isFile() && opened.nlink === 1 && sameFile(before, opened), 'Screenshot changed while opening');
    const checkPaths = async () => {
      for (const item of directories) {
        const current = await lstat(item.path);
        check(current.isDirectory() && !current.isSymbolicLink() && sameFile(item.stat, current) && await realpath(item.path) === item.path, 'Screenshot directory changed while reading');
      }
      const current = await lstat(requested);
      check(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && sameFile(opened, current) && await realpath(requested) === requested, 'Screenshot path changed while reading');
    };
    await checkPaths();
    const bytes = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    check(length > 0 && length <= MAX_SCREENSHOT_BYTES, 'Screenshot must be nonempty and at most 2 MiB');
    const after = await handle.stat();
    check(sameFile(opened, after) && after.nlink === 1 && opened.size === length && after.size === length && opened.mtimeMs === after.mtimeMs && opened.ctimeMs === after.ctimeMs, 'Screenshot changed while reading');
    await checkPaths();
    const result = bytes.subarray(0, length);
    validateScreenshotBytes(result);
    return result;
  } finally { await handle.close(); }
}

function jpegContainer(bytes: Buffer): boolean {
  if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2; let hasFrame = false; let hasScan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) return hasFrame && hasScan && offset === bytes.length;
    if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (marker === 0x01) continue;
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || length > bytes.length - offset) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || bytes.readUInt16BE(offset + 3) === 0 || bytes.readUInt16BE(offset + 5) === 0) return false;
      hasFrame = true;
    }
    offset += length;
    if (marker === 0xda) {
      if (!hasFrame || length < 6) return false;
      hasScan = true;
      // Escaped FF and restart markers belong to scan data. Any other marker
      // returns control to segment parsing, including progressive JPEG scans.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const next = bytes[offset + 1];
        if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
        break;
      }
    }
  }
  return false;
}

/** Bounded image signature/container check, not a pixel decoder or visual review. */
export function validateScreenshotBytes(bytes: Buffer): ScreenshotMimeType {
  check(bytes.length > 0 && bytes.length <= MAX_SCREENSHOT_BYTES, 'Screenshot must be nonempty and at most 2 MiB');
  const png = bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  if (png) {
    let offset = 8; let hasData = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      check(length <= bytes.length - offset - 12, 'Screenshot PNG container is truncated');
      const kind = bytes.toString('ascii', offset + 4, offset + 8);
      if (kind === 'IDAT') hasData = true;
      offset += 12 + length;
      if (kind === 'IEND') {
        check(length === 0 && hasData && offset === bytes.length
          && bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])), 'Screenshot PNG container is invalid');
        return 'image/png';
      }
    }
  }
  if (jpegContainer(bytes)) return 'image/jpeg';
  const webp = bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length
    && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))
    && bytes.readUInt32LE(16) > 0 && bytes.readUInt32LE(16) <= bytes.length - 20;
  if (webp) return 'image/webp';
  throw new Error('Screenshot must have a valid PNG, JPEG or WebP signature and container');
}
