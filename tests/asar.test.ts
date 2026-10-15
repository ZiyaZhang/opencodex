import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAsar } from './helpers/make-asar.ts';
import { listAsar, readAsarEntry } from '../src/host/sources/asar.ts';

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'oc-asar-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('lists entries and reads one file through the pickle header', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-asar-'));
  try {
    const path = join(dir, 'app.asar');
    await writeFile(path, makeAsar({ 'webview/index.html': '<html>', 'webview/assets/codex-light-53d4e35e1869.js': 'x'.repeat(10), 'webview/assets/zh-CN-b05cfd55c534.js': 'e=`技能`,"codex.command.composer.captureAppshot":`捕获`' }));
    const entries = await listAsar(path);
    assert.deepEqual(entries.map(e => e.path).sort(), ['/webview/assets/codex-light-53d4e35e1869.js', '/webview/assets/zh-CN-b05cfd55c534.js', '/webview/index.html']);
    assert.equal((await readAsarEntry(path, '/webview/index.html')).toString(), '<html>');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('data starts at 8 + the pickle size, so every file reads back intact whatever the header padding', async () => {
  // JSON lengths 1..4 modulo 4 give every padding the pickle can have; the data offset must not depend on it.
  await withDir(async dir => {
    for (let pad = 0; pad < 4; pad++) {
      const files = { [`a/${'n'.repeat(pad + 1)}.txt`]: '第一份', 'b.txt': 'second' };
      const path = join(dir, `pad${pad}.asar`);
      await writeFile(path, makeAsar(files));
      for (const entry of await listAsar(path)) {
        const wanted = Object.entries(files).find(([name]) => `/${name}` === entry.path)![1];
        assert.equal((await readAsarEntry(path, entry)).toString('utf8'), wanted);
      }
    }
  });
});

test('a listed entry is read without parsing the multi-megabyte header, a path string parses it once', async () => {
  await withDir(async dir => {
    const path = join(dir, 'app.asar');
    const archive = makeAsar({ 'webview/index.html': '<html>', 'webview/app.js': 'console.log(1)' });
    await writeFile(path, archive);
    const entry = (await listAsar(path)).find(e => e.path === '/webview/app.js')!;
    // Same length, so the prefix and every offset stay valid, but the JSON can no longer be parsed.
    archive.fill('!', 16, 16 + archive.readUInt32LE(12));
    await writeFile(path, archive);
    assert.equal((await readAsarEntry(path, entry)).toString(), 'console.log(1)');
    await assert.rejects(readAsarEntry(path, '/webview/app.js'), SyntaxError);
  });
});

test('files kept outside the archive are not listed and do not shift the offsets of the packed ones', async () => {
  await withDir(async dir => {
    const path = join(dir, 'app.asar');
    await writeFile(path, makeAsar({ 'native/addon.node': 'native', 'webview/a.js': 'first', 'native/other.node': 'native', 'webview/b.js': 'second' }, { unpacked: ['native/addon.node', 'native/other.node'] }));
    const entries = await listAsar(path);
    assert.deepEqual(entries.map(e => e.path), ['/webview/a.js', '/webview/b.js']);
    assert.deepEqual(await Promise.all(entries.map(async e => (await readAsarEntry(path, e)).toString())), ['first', 'second']);
    await assert.rejects(readAsarEntry(path, '/native/addon.node'), /not found/);
  });
});

test('a truncated archive throws instead of returning a half-filled buffer', async () => {
  await withDir(async dir => {
    const archive = makeAsar({ 'a.txt': 'hello', 'b.txt': 'world!' });
    const cutData = join(dir, 'cut-data.asar'), cutHeader = join(dir, 'cut-header.asar');
    await writeFile(cutData, archive.subarray(0, archive.length - 2));
    await writeFile(cutHeader, archive.subarray(0, 30));
    assert.equal((await readAsarEntry(cutData, '/a.txt')).toString(), 'hello');
    await assert.rejects(readAsarEntry(cutData, '/b.txt'), /truncated/);
    await assert.rejects(listAsar(cutHeader), /truncated/);
  });
});

const prefixOf = (...words: number[]) => { const prefix = Buffer.alloc(16); words.forEach((word, i) => prefix.writeUInt32LE(word, i * 4)); return prefix; };

test('a header that is not an asar prefix is rejected before anything is read from it', async () => {
  await withDir(async dir => {
    const wrongMagic = makeAsar({ 'a.txt': 'x' });
    wrongMagic.writeUInt32LE(5, 0);
    const overTheCap = 64 * 1024 * 1024 + 1;
    const cases: Array<[string, Buffer, RegExp]> = [
      ['text', Buffer.from('x'.repeat(64)), /Not an asar archive/],
      ['first pickle is not 4 bytes', wrongMagic, /Not an asar archive/],
      ['JSON longer than its pickle', prefixOf(4, 10, 8, 20), /Not an asar archive/],
      ['JSON over the 64 MiB cap', prefixOf(4, overTheCap + 8, overTheCap + 4, overTheCap), /exceeds 64 MiB/],
    ];
    for (const [name, bytes, message] of cases) {
      const path = join(dir, `${name.replace(/\W+/g, '-')}.asar`);
      await writeFile(path, bytes);
      await assert.rejects(listAsar(path), message, name);
    }
  });
});

test('a missing entry and an oversized entry are rejected', async () => {
  await withDir(async dir => {
    const path = join(dir, 'real.asar');
    await writeFile(path, makeAsar({ 'big.bin': 'x'.repeat(100) }));
    await assert.rejects(readAsarEntry(path, '/missing.bin'), /not found/);
    await assert.rejects(readAsarEntry(path, '/big.bin', 99), /exceeds 99 bytes/);
    assert.equal((await readAsarEntry(path, '/big.bin', 100)).length, 100);
  });
});

test('symlink nodes have no data of their own and are not listed', async () => {
  await withDir(async dir => {
    const path = join(dir, 'app.asar');
    await writeFile(path, makeAsar({ 'lib/tool.js': 'tool' }, { links: { 'bin/tool': '../lib/tool.js' } }));
    const entries = await listAsar(path);
    assert.deepEqual(entries.map(e => e.path), ['/lib/tool.js']);
    await assert.rejects(readAsarEntry(path, '/bin/tool'), /not found/);
  });
});

test('an offset that is not a plain decimal string, or a size that is not a count, fails the listing instead of reading the wrong bytes', async () => {
  await withDir(async dir => {
    const damage: Array<[string, (node: Record<string, unknown>) => void, RegExp]> = [
      ['letters', node => { node.offset = 'x'; }, /Invalid asar offset for \/a\.txt/],
      ['negative', node => { node.offset = '-1'; }, /Invalid asar offset/],
      ['fraction', node => { node.offset = '1.5'; }, /Invalid asar offset/],
      ['hex', node => { node.offset = '0x10'; }, /Invalid asar offset/],
      ['padded', node => { node.offset = ' 5'; }, /Invalid asar offset/],
      ['empty', node => { node.offset = ''; }, /Invalid asar offset/],
      ['beyond 2**53', node => { node.offset = '9007199254740993'; }, /Invalid asar offset/],
      ['a number, not a string', node => { node.offset = 5; }, /Invalid asar offset/],
      ['missing', node => { delete node.offset; }, /Invalid asar offset/],
      ['size missing', node => { delete node.size; }, /Invalid asar size/],
      ['size negative', node => { node.size = -1; }, /Invalid asar size/],
      ['size fractional', node => { node.size = 1.5; }, /Invalid asar size/],
      ['size a string', node => { node.size = '5'; }, /Invalid asar size/],
    ];
    for (const [name, edit, message] of damage) {
      const path = join(dir, `${name.replace(/\W+/g, '-')}.asar`);
      await writeFile(path, makeAsar({ 'a.txt': 'hello' }, { edit: tree => edit(tree.files['a.txt'] as Record<string, unknown>) }));
      await assert.rejects(listAsar(path), message, name);
      await assert.rejects(readAsarEntry(path, '/a.txt'), message, name);
    }
  });
});

test('an entry object with an impossible range is refused before any read', async () => {
  await withDir(async dir => {
    const path = join(dir, 'app.asar');
    await writeFile(path, makeAsar({ 'a.txt': 'hello' }));
    for (const entry of [{ path: '/a.txt', size: 5, offset: Number.NaN }, { path: '/a.txt', size: 5, offset: -1 }, { path: '/a.txt', size: 1.5, offset: 0 }, { path: '/a.txt', size: -2, offset: 0 }]) {
      await assert.rejects(readAsarEntry(path, entry), /Invalid asar range/);
    }
  });
});
