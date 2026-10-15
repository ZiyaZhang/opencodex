import { open, type FileHandle } from 'node:fs/promises';

export interface AsarEntry { path: string; size: number; offset: number }
interface Node { files?: Record<string, Node>; size?: number; offset?: string; unpacked?: boolean }

const MAX_HEADER_BYTES = 64 * 1024 * 1024;

/** Read exactly `length` bytes at `position`; a short read means a truncated archive, never a half-filled buffer. */
async function readExact(handle: FileHandle, length: number, position: number, what: string): Promise<Buffer> {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(position) || position < 0) throw new Error(`Invalid asar range for ${what}`);
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) throw new Error(`asar is truncated: ${what} needs ${length} bytes at offset ${position}, the file ends after ${filled}`);
    filled += bytesRead;
  }
  return buffer;
}

/** The 16-byte prefix is two pickles, [4][pickleSize] then [pickleSize - 4][jsonLength]; file data starts at 8 + pickleSize, not at 16 + jsonLength. */
async function readPrefix(handle: FileHandle): Promise<{ jsonLength: number; base: number }> {
  const prefix = await readExact(handle, 16, 0, 'the header prefix');
  const pickleSize = prefix.readUInt32LE(4), jsonLength = prefix.readUInt32LE(12);
  if (prefix.readUInt32LE(0) !== 4 || jsonLength + 8 > pickleSize) throw new Error('Not an asar archive');
  if (jsonLength > MAX_HEADER_BYTES) throw new Error('asar header exceeds 64 MiB');
  return { jsonLength, base: 8 + pickleSize };
}

async function readTree(handle: FileHandle, jsonLength: number): Promise<Node> {
  return JSON.parse((await readExact(handle, jsonLength, 16, 'the header')).toString('utf8')) as Node;
}

function flatten(tree: Node): AsarEntry[] {
  const out: AsarEntry[] = [];
  const walk = (node: Node, prefix: string) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const full = `${prefix}/${name}`;
      if (child.files) walk(child, full);
      else if (!child.unpacked) out.push({ path: full, size: child.size ?? 0, offset: Number(child.offset ?? 0) });
    }
  };
  walk(tree, '');
  return out;
}

export async function listAsar(path: string): Promise<AsarEntry[]> {
  const handle = await open(path, 'r');
  try { return flatten(await readTree(handle, (await readPrefix(handle)).jsonLength)); }
  finally { await handle.close(); }
}

/**
 * Pass an entry from `listAsar` when you already have the listing: the header is 5.8 MB in ChatGPT.app, and a
 * listed entry already carries its offset, so only the 16-byte prefix is read. A path string parses the header once.
 */
export async function readAsarEntry(path: string, entry: string | AsarEntry, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const { jsonLength, base } = await readPrefix(handle);
    const found = typeof entry === 'string' ? flatten(await readTree(handle, jsonLength)).find(e => e.path === entry) : entry;
    if (!found) throw new Error(`asar entry not found: ${String(entry)}`);
    if (found.size > limit) throw new Error(`asar entry exceeds ${limit} bytes: ${found.path}`);
    return await readExact(handle, found.size, base + found.offset, found.path);
  } finally { await handle.close(); }
}
