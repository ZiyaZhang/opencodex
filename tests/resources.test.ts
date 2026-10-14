import assert from 'node:assert/strict';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = async (path: string) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const isWithin = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

interface ResourceEntry {
  id: string;
  title: string;
  kind: 'skill' | 'reference' | 'sources';
  path: string;
  description: string;
  topics: string[];
}

interface SourceEntry {
  id: string;
  title: string;
  url: string;
  topics: string[];
  platforms: string[];
  sourceType: string;
  checkedAt: string;
  notes: string;
}

const checkStrings = (values: unknown) => {
  assert.ok(Array.isArray(values) && values.length > 0);
  assert.ok(values.every((value) => typeof value === 'string' && value.trim().length > 0));
};

test('catalog IDs resolve to packaged, bounded files and all Markdown links resolve', async () => {
  const catalog = await readJson('resources/catalog.json') as { schemaVersion: number; entries: ResourceEntry[] };
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(catalog.entries.length > 0);
  assert.equal(new Set(catalog.entries.map((entry) => entry.id)).size, catalog.entries.length);
  const canonicalRoot = await realpath(root);
  for (const entry of catalog.entries) {
    assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    checkStrings([entry.title, entry.description]);
    checkStrings(entry.topics);
    assert.ok(['skill', 'reference', 'sources'].includes(entry.kind));
    assert.ok(!isAbsolute(entry.path), `${entry.id}: absolute resource path`);
    assert.ok(entry.path.startsWith(entry.kind === 'sources' ? 'resources/' : 'skills/'));
    const path = await realpath(resolve(root, entry.path));
    assert.ok(isWithin(canonicalRoot, path), `${entry.id}: path escapes package`);
    const metadata = await stat(path);
    assert.ok(metadata.isFile() && metadata.size > 0 && metadata.size < 1_000_000);
    if (!entry.path.endsWith('.md')) continue;
    const content = await readFile(path, 'utf8');
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const link = match[1]!;
      if (link.startsWith('#') || /^https?:/.test(link)) continue;
      const target = await realpath(resolve(dirname(path), decodeURIComponent(link.split('#')[0]!)));
      assert.ok(isWithin(canonicalRoot, target), `${entry.id}: reference escapes package`);
      assert.ok((await stat(target)).isFile(), `${entry.id}: broken reference ${link}`);
    }
  }
  assert.equal(catalog.entries.find((entry) => entry.id === 'opencodex')?.kind, 'skill');
  assert.equal(catalog.entries.find((entry) => entry.id === 'source-index')?.path, 'resources/sources.json');
});

test('source index has unique public HTTPS entries with explicit scope and check dates', async () => {
  const index = await readJson('resources/sources.json') as { schemaVersion: number; checkedAt: string; sources: SourceEntry[] };
  assert.equal(index.schemaVersion, 1);
  assert.match(index.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(index.sources.length > 0);
  assert.equal(new Set(index.sources.map((entry) => entry.id)).size, index.sources.length);
  assert.equal(new Set(index.sources.map((entry) => entry.url)).size, index.sources.length);
  for (const source of index.sources) {
    checkStrings([source.id, source.title, source.sourceType, source.notes]);
    checkStrings(source.topics);
    checkStrings(source.platforms);
    assert.match(source.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isFinite(Date.parse(source.checkedAt)));
    const url = new URL(source.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.ok(url.hostname.includes('.') && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  }
});
