import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ResourceReader, type CatalogEntry, type ResourceReadOptions } from '../src/host/resources.js';

async function fixture(t: TestContext, content: string, kind = 'reference') {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-resources-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'package');
  await mkdir(join(root, 'resources'), { recursive: true });
  const path = kind === 'sources' ? 'resources/sources.json' : 'resources/guide.md';
  const entry: CatalogEntry = { id: 'guide', title: 'Fixture guide', path, kind, description: 'A compact description', topics: ['fixture'] };
  const catalogPath = join(root, 'resources/catalog.json');
  await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, entries: [entry] }));
  await writeFile(join(root, path), content);
  return { root, directory, path, entry, catalogPath, reader: new ResourceReader(root) };
}

test('long-resource default returns only an outline with real offsets and a content hash', async t => {
  const content = `---\nname: fixture\n---\n# First title\n${'PRIVATE_BODY_NOT_IN_DEFAULT '.repeat(180)}\n\n## Second title\nMore detail\n\n\`\`\`md\n# A code example, not a heading\n\`\`\`\n\nThird title\n-----------\nDetails\n`;
  const f = await fixture(t, content);
  const result = await f.reader.readForAgent('guide');
  assert.equal(result.action, 'index');
  if (result.action !== 'index') assert.fail('Expected index');
  assert.equal(result.description, 'A compact description');
  assert.equal(result.totalCharacters, content.length);
  assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal('content' in result, false); assert.equal('excerpt' in result, false); assert.equal('complete' in result, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_BODY_NOT_IN_DEFAULT'), false);
  assert.deepEqual(result.headings, [
    { title: 'First title', level: 1, offset: content.indexOf('# First title') },
    { title: 'Second title', level: 2, offset: content.indexOf('## Second title') },
    { title: 'Third title', level: 2, offset: content.indexOf('Third title') },
  ]);
  assert.deepEqual(await f.reader.read('guide'), { id: 'guide', content }, 'UI full-text reads remain unchanged');
});

test('short guides fit in the default index call; 3001 characters no longer fit implicitly', async t => {
  const content = '# Short guide\nA useful instruction.';
  const f = await fixture(t, content);
  const result = await f.reader.readForAgent('guide');
  assert.equal(result.action, 'index');
  if (result.action !== 'index') assert.fail('Expected index');
  assert.equal(result.complete, true); assert.equal(result.excerpt, content);
  await writeFile(join(f.root, f.path), 'a'.repeat(3000));
  assert.equal((await f.reader.readForAgent('guide') as { complete?: true }).complete, true);
  await writeFile(join(f.root, f.path), 'a'.repeat(3001));
  assert.equal('excerpt' in await f.reader.readForAgent('guide'), false);
});

test('bounded excerpt pages reconstruct every character and refresh their hash after a change', async t => {
  const content = '# 多语言 guide\r\n中文🙂e\u0301 '.repeat(400);
  const f = await fixture(t, content);
  const initial = await f.reader.readForAgent('guide', { action: 'read' });
  assert.equal(initial.action, 'read');
  if (initial.action !== 'read') assert.fail('Expected excerpt');
  assert.equal(initial.offset, 0); assert.equal(initial.excerpt.length, 3000); assert.equal(initial.nextOffset, 3000);
  let offset = 0; const parts: string[] = [];
  do {
    const page = await f.reader.readForAgent('guide', { action: 'read', offset, maxCharacters: 7 });
    if (page.action !== 'read') assert.fail('Expected excerpt');
    assert.equal(page.sha256, initial.sha256); assert.equal(page.totalCharacters, content.length);
    assert.ok(page.excerpt.length <= 7); parts.push(page.excerpt);
    if (page.nextOffset === undefined) break;
    assert.equal(page.nextOffset, offset + page.excerpt.length); offset = page.nextOffset;
  } while (true);
  assert.equal(parts.join(''), content, 'surrogate pairs split at page boundaries lose no code units');
  const end = await f.reader.readForAgent('guide', { action: 'read', offset: content.length, maxCharacters: 6000 });
  assert.equal(end.action, 'read');
  if (end.action !== 'read') assert.fail('Expected excerpt');
  assert.equal(end.excerpt, ''); assert.equal(end.nextOffset, undefined);
  await writeFile(join(f.root, f.path), `${content}\nChanged`);
  const updated = await f.reader.readForAgent('guide');
  assert.notEqual(updated.sha256, initial.sha256);
  assert.equal(updated.totalCharacters, content.length + 8);
});

test('source outlines provide only compact source titles, ids and original offsets', async t => {
  const sources = [
    { id: 'one', title: 'First source', url: 'https://example.org/hidden-one', notes: 'NOTES_STAY_OUT_OF_INDEX '.repeat(160) },
    { id: '二', title: 'Second source', url: 'https://example.org/hidden-two', notes: 'More notes' },
  ];
  const content = JSON.stringify({ schemaVersion: 1, sources }, null, 2);
  const f = await fixture(t, content, 'sources');
  const result = await f.reader.readForAgent('guide');
  if (result.action !== 'index') assert.fail('Expected index');
  assert.deepEqual(result.entries, sources.map(source => ({ id: source.id, title: source.title, offset: content.indexOf(`"id": "${source.id}"`) })));
  assert.equal(result.headings, undefined); assert.equal(result.excerpt, undefined);
  assert.doesNotMatch(JSON.stringify(result), /https:|NOTES_STAY_OUT_OF_INDEX/);
  const excerpt = await f.reader.readForAgent('guide', { action: 'read', offset: result.entries![1]!.offset, maxCharacters: 60 });
  if (excerpt.action !== 'read') assert.fail('Expected excerpt');
  assert.ok(excerpt.excerpt.startsWith('"id": "二"'));
});

test('agent read validates action, pagination integers, maximums, and catalog ids', async t => {
  const f = await fixture(t, '# Test\nBody');
  for (const offset of [-1, 0.5, NaN, Infinity, '0', null, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.reader.readForAgent('guide', { action: 'read', offset } as ResourceReadOptions), /offset/);
  }
  for (const maxCharacters of [0, -1, 1.5, 6001, NaN, Infinity, '3000', null]) {
    await assert.rejects(f.reader.readForAgent('guide', { action: 'read', maxCharacters } as ResourceReadOptions), /maxCharacters/);
  }
  await assert.rejects(f.reader.readForAgent('guide', { action: 'read', offset: 500 }), /totalCharacters/);
  await assert.rejects(f.reader.readForAgent('guide', { action: 'all' } as never), /action/);
  await assert.rejects(f.reader.readForAgent('guide', { offset: 0 }), /use action read/);
  await assert.rejects(f.reader.readForAgent('guide', { action: 'index', maxCharacters: 100 }), /use action read/);
  await assert.rejects(f.reader.readForAgent('guide', { arbitraryPath: '/etc/passwd' } as never), /options/);
  await assert.rejects(f.reader.readForAgent('../../package.json'), /Unknown/);
});

test('resource and catalog reads remain bounded and cannot follow an allowlist path outside the package', async t => {
  const f = await fixture(t, '# Test\nBody');
  await writeFile(join(f.directory, 'outside.md'), 'outside');
  const catalog = (path: string) => writeFile(f.catalogPath, JSON.stringify({ schemaVersion: 1, entries: [{ ...f.entry, path }] }));
  await catalog('../outside.md');
  await assert.rejects(f.reader.readForAgent('guide'), /relative/);
  await symlink(join(f.directory, 'outside.md'), join(f.root, 'resources/linked.md'));
  await catalog('resources/linked.md');
  await assert.rejects(f.reader.readForAgent('guide'), /escapes/);
  await catalog(join(f.directory, 'outside.md'));
  await assert.rejects(f.reader.read('guide'), /relative/);
  await catalog(f.path); await writeFile(join(f.root, f.path), 'x'.repeat(200_001));
  await assert.rejects(f.reader.readForAgent('guide'), /200000 byte/);
  await assert.rejects(f.reader.read('guide', 200_001), /limit/);
  await writeFile(f.catalogPath, ' '.repeat(200_001));
  await assert.rejects(f.reader.catalog(), /200000 byte/);
});

test('large outlines cap labels and entries with an explicit omitted count', async t => {
  const content = Array.from({ length: 150 }, (_, index) => `# ${index} ${'Title '.repeat(50)}\nBody\n`).join('');
  const f = await fixture(t, content);
  const result = await f.reader.readForAgent('guide');
  if (result.action !== 'index') assert.fail('Expected index');
  assert.equal(result.headings!.length, 128); assert.equal(result.omittedEntries, 22);
  assert.ok(result.headings!.every(heading => heading.title.length <= 160));
  assert.equal(result.excerpt, undefined);
});
