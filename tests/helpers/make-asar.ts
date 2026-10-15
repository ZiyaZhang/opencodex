import { Buffer } from 'node:buffer';
/** Minimal asar writer matching Electron's pickle header layout. Paths in `unpacked` get a header node but no data, like files that live in app.asar.unpacked. */
export function makeAsar(files: Record<string, string>, unpacked: readonly string[] = []): Buffer {
  const tree: { files: Record<string, unknown> } = { files: {} };
  const chunks: Buffer[] = []; let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    let node = tree; const parts = path.split('/').filter(Boolean);
    for (const dir of parts.slice(0, -1)) node = (node.files[dir] ??= { files: {} }) as typeof tree;
    if (unpacked.includes(path)) { node.files[parts.at(-1)!] = { size: data.length, unpacked: true }; continue; }
    node.files[parts.at(-1)!] = { size: data.length, offset: String(offset) };
    chunks.push(data); offset += data.length;
  }
  const json = Buffer.from(JSON.stringify(tree), 'utf8');
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4); json.copy(padded);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(4, 0); header.writeUInt32LE(padded.length + 8, 4); header.writeUInt32LE(padded.length + 4, 8); header.writeUInt32LE(json.length, 12);
  return Buffer.concat([header, padded, ...chunks]);
}
