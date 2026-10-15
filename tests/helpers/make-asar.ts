import { Buffer } from 'node:buffer';

type Tree = { files: Record<string, unknown> };
export interface AsarOptions {
  /** Paths that get a header node but no data, like files that live in app.asar.unpacked. */
  unpacked?: readonly string[];
  /** Symlinks, path to target: a header node with neither size nor offset. */
  links?: Readonly<Record<string, string>>;
  /** Last chance to change the header tree before it is written, for malformed-archive tests. */
  edit?: (tree: Tree) => void;
}
/** Minimal asar writer matching Electron's pickle header layout. */
export function makeAsar(files: Record<string, string>, { unpacked = [], links = {}, edit }: AsarOptions = {}): Buffer {
  const tree: Tree = { files: {} };
  const chunks: Buffer[] = []; let offset = 0;
  const place = (path: string, node: unknown) => {
    let dir = tree; const parts = path.split('/').filter(Boolean);
    for (const part of parts.slice(0, -1)) dir = (dir.files[part] ??= { files: {} }) as Tree;
    dir.files[parts.at(-1)!] = node;
  };
  for (const [path, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    if (unpacked.includes(path)) { place(path, { size: data.length, unpacked: true }); continue; }
    place(path, { size: data.length, offset: String(offset) });
    chunks.push(data); offset += data.length;
  }
  for (const [path, target] of Object.entries(links)) place(path, { link: target });
  edit?.(tree);
  const json = Buffer.from(JSON.stringify(tree), 'utf8');
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4); json.copy(padded);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(4, 0); header.writeUInt32LE(padded.length + 8, 4); header.writeUInt32LE(padded.length + 4, 8); header.writeUInt32LE(json.length, 12);
  return Buffer.concat([header, padded, ...chunks]);
}
