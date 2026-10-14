/** Allowlisted, bounded reads of shipped investigation guidance. */
import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
export interface CatalogEntry { id: string; title: string; path: string; kind: string; description: string; topics: string[] }
export interface ResourceReadOptions { action?: 'index' | 'read'; offset?: number; maxCharacters?: number }
interface ResourcePosition { title: string; offset: number }
export interface ResourceIndex {
  id: string; action: 'index'; title: string; description: string; kind: string; sha256: string; totalCharacters: number;
  headings?: Array<ResourcePosition & { level: number }>;
  entries?: Array<ResourcePosition & { id: string }>;
  omittedEntries?: number;
  excerpt?: string; complete?: true;
}
export interface ResourceExcerpt {
  id: string; action: 'read'; sha256: string; totalCharacters: number;
  offset: number; excerpt: string; nextOffset?: number;
}
const MAX_RESOURCE_BYTES = 200_000;
const MAX_INDEX_ENTRIES = 128;
const label = (value: string) => value.length <= 160 ? value : `${value.slice(0, 157)}...`;
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
function headings(content: string): NonNullable<ResourceIndex['headings']> {
  const result: NonNullable<ResourceIndex['headings']> = [];
  let fence: { character: string; length: number } | undefined;
  let frontmatter = content.startsWith('---\n') || content.startsWith('---\r\n');
  let offset = 0;
  let previous: { title: string; offset: number } | undefined;
  for (const lineWithNewline of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const line = lineWithNewline.replace(/\r?\n$/, '');
    if (frontmatter) {
      if (offset !== 0 && /^(?:---|\.\.\.)\s*$/.test(line)) frontmatter = false;
    } else {
      const fenced = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fenced) {
        const token = fenced[1]!;
        if (!fence) fence = { character: token[0]!, length: token.length };
        else if (token[0] === fence.character && token.length >= fence.length) fence = undefined;
        previous = undefined;
      } else if (!fence) {
        const atx = /^ {0,3}(#{1,6})[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/.exec(line);
        const setext = /^ {0,3}(=+|-+)[\t ]*$/.exec(line);
        if (atx) { result.push({ title: label(atx[2]!), level: atx[1]!.length, offset }); previous = undefined; }
        else if (setext && previous) { result.push({ ...previous, level: setext[1]![0] === '=' ? 1 : 2 }); previous = undefined; }
        else previous = line.trim() && !/^ {4}|^\t/.test(line) ? { title: label(line.trim()), offset } : undefined;
      }
    }
    offset += lineWithNewline.length;
  }
  return result;
}
function sourceEntries(content: string): NonNullable<ResourceIndex['entries']> {
  const parsed: unknown = JSON.parse(content);
  const sources = parsed && typeof parsed === 'object' ? (parsed as { sources?: unknown }).sources : undefined;
  if (!Array.isArray(sources)) throw new Error('Source index must contain a sources array');
  const positions = new Map<string, number>();
  // Offsets point at each id property in the original JSON, not a reserialized copy.
  for (const match of content.matchAll(/"id"\s*:\s*("(?:\\.|[^"\\])*")/g)) {
    const id: unknown = JSON.parse(match[1]!);
    if (typeof id === 'string' && !positions.has(id)) positions.set(id, match.index!);
  }
  return sources.map(source => {
    if (!source || typeof source !== 'object' || typeof source.id !== 'string' || typeof source.title !== 'string' || !positions.has(source.id)) throw new Error('Source index entries require an id and title');
    return { id: source.id, title: label(source.title), offset: positions.get(source.id)! };
  });
}
export class ResourceReader {
  constructor(readonly packageRoot: string) {}
  async catalog(): Promise<CatalogEntry[]> {
    const catalog = JSON.parse((await this.readFile('resources/catalog.json', MAX_RESOURCE_BYTES)).content) as { schemaVersion: number; entries: CatalogEntry[] };
    if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries) || catalog.entries.length > 256) throw new Error('Unsupported OpenCodex resource catalog');
    const ids = new Set<string>();
    for (const item of catalog.entries) {
      if (!item || typeof item !== 'object' || !['id', 'title', 'path', 'kind', 'description'].every(key => typeof item[key as keyof CatalogEntry] === 'string') || !Array.isArray(item.topics) || !item.topics.every(topic => typeof topic === 'string') || !item.id || ids.has(item.id)) throw new Error('Invalid OpenCodex resource catalog entry');
      ids.add(item.id);
    }
    return catalog.entries;
  }
  async read(id: string, maxBytes = 200_000): Promise<{ id: string; content: string }> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 200_000) throw new Error('Resource read limit must be from 1 to 200000 bytes');
    const item = await this.entry(id);
    return { id, content: (await this.readFile(item.path, maxBytes)).content };
  }
  /** Short guides fit in one call; longer bodies require explicit bounded pages. */
  async readForAgent(id: string, options: ResourceReadOptions = {}): Promise<ResourceIndex | ResourceExcerpt> {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['action', 'offset', 'maxCharacters'].includes(key))) throw new Error('Invalid resource read options');
    const action = options.action === undefined ? 'index' : options.action;
    if (action !== 'index' && action !== 'read') throw new Error('Resource action must be index or read');
    if (action === 'index' && (options.offset !== undefined || options.maxCharacters !== undefined)) throw new Error('Resource index does not accept offset or maxCharacters; use action read');
    const offset = options.offset === undefined ? 0 : options.offset;
    const maxCharacters = options.maxCharacters === undefined ? 3000 : options.maxCharacters;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Resource offset must be a nonnegative integer');
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 6000) throw new Error('Resource maxCharacters must be an integer from 1 to 6000');
    const item = await this.entry(id);
    const file = await this.readFile(item.path, MAX_RESOURCE_BYTES);
    const common = { id, sha256: file.sha256, totalCharacters: file.content.length };
    if (action === 'read') {
      if (offset > file.content.length) throw new Error('Resource offset exceeds totalCharacters');
      const end = Math.min(offset + maxCharacters, file.content.length);
      return { ...common, action, offset, excerpt: file.content.slice(offset, end), ...(end < file.content.length ? { nextOffset: end } : {}) };
    }
    const positions = item.kind === 'sources' ? sourceEntries(file.content) : headings(file.content);
    return {
      ...common, action, title: label(item.title), description: item.description.slice(0, 400), kind: item.kind,
      ...(item.kind === 'sources' ? { entries: positions.slice(0, MAX_INDEX_ENTRIES) as ResourceIndex['entries'] } : { headings: positions.slice(0, MAX_INDEX_ENTRIES) as ResourceIndex['headings'] }),
      ...(positions.length > MAX_INDEX_ENTRIES ? { omittedEntries: positions.length - MAX_INDEX_ENTRIES } : {}),
      ...(file.content.length <= 3000 ? { excerpt: file.content, complete: true } : {}),
    };
  }
  private async entry(id: string): Promise<CatalogEntry> {
    const item = (await this.catalog()).find(entry => entry.id === id);
    if (!item) throw new Error(`Unknown OpenCodex resource: ${id}`);
    return item;
  }
  private async readFile(resourcePath: string, maxBytes: number): Promise<{ content: string; sha256: string }> {
    if (isAbsolute(resourcePath) || resourcePath.includes('\\') || resourcePath.includes('\0') || resourcePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Resource path must be relative to the installed package');
    const root = await realpath(this.packageRoot);
    const path = await realpath(resolve(root, resourcePath));
    if (!within(root, path)) throw new Error('Resource path escapes the installed package');
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Resource exceeds ${maxBytes} byte read limit or is not a file`);
      const bytes = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const chunk = await file.read(bytes, length, bytes.length - length, null);
        if (chunk.bytesRead === 0) break;
        length += chunk.bytesRead;
      }
      if (length > maxBytes) throw new Error(`Resource exceeds ${maxBytes} byte read limit`);
      const after = await file.stat();
      if (stat.ino !== after.ino || stat.dev !== after.dev || stat.size !== length || after.size !== length || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error('Resource changed while reading; retry its index');
      const contentBytes = bytes.subarray(0, length);
      return { content: contentBytes.toString('utf8'), sha256: createHash('sha256').update(contentBytes).digest('hex') };
    } finally { await file.close(); }
  }
}
