import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CandidateStore } from '../src/core/store.ts';
import { collectDesktop, diffManifests, extractStrings, snapshotDesktop, stripHash } from '../src/host/sources/desktop-app.ts';
import { readBundleVersion, type PlutilRunner } from '../src/host/sources/plist.ts';
import { makeAsar } from './helpers/make-asar.ts';

test('stripHash removes the trailing 12-hex content hash', () => {
  assert.equal(stripHash('/webview/assets/page-codex-quick-chat-window-39f8940ad19e.js'), '/webview/assets/page-codex-quick-chat-window.js');
  assert.equal(stripHash('/webview/index.html'), '/webview/index.html');
});

test('extractStrings keeps template literals and codex i18n keys', () => {
  const source = 'e=`选择技能`,t=`技能`,"codex.command.composer.captureAppshot":`截图`,n=`x`';
  const { strings, keys } = extractStrings(source);
  assert.deepEqual(keys, ['codex.command.composer.captureAppshot']);
  assert.ok(strings.includes('选择技能'));
});

test('diffManifests reports added codex chunks and new keys only', () => {
  const previous = { version: '1', entries: ['/webview/assets/codex-light-aaaaaaaaaaaa.js'], keys: ['codex.a'], strings: ['x'] };
  const current = { version: '2', entries: ['/webview/assets/codex-light-bbbbbbbbbbbb.js', '/webview/assets/page-codex-quick-chat-window-cccccccccccc.js'], keys: ['codex.a', 'codex.quickChat.open'], strings: ['x', 'y'] };
  const diff = diffManifests(previous, current);
  assert.deepEqual(diff.addedChunks, ['/webview/assets/page-codex-quick-chat-window.js']);
  assert.deepEqual(diff.addedKeys, ['codex.quickChat.open']);
  assert.deepEqual(diff.addedStrings, ['y']);
});

test('extractStrings pairs every backtick, so a too-short or too-long template cannot shift later pairings', () => {
  // The first version of the extractor skipped templates outside 2..200 characters, which paired the *closing*
  // backtick of the next template with the opening one after it: every later "string" became the code between two templates.
  const source = 'a=`月`,b=`优惠`,"codex.x.one":`第一`,c=`' + 'long'.repeat(60) + '`,"codex.x.two":`二`,f=`第三条`';
  const { strings } = extractStrings(source);
  assert.deepEqual(strings, ['优惠', '第一', '第三条']);
  assert.ok(strings.every(text => !text.includes('codex.') && !text.includes('=')));
});

test('extractStrings treats an escaped backtick as part of the template', () => {
  const { strings } = extractStrings('a=`he said \\`hi\\``,b=`好吧`');
  assert.deepEqual(strings, ['he said \\`hi\\`', '好吧']);
});

test('extractStrings pairs a key with its template or double-quoted message and leaves other keys unpaired', () => {
  const source = '"codex.a.b":`技能 {name}`,"codex.a.c":"含 `gh` 的句子","codex.a.d":someCall(),"codex.a.e":`二`,"codex.a.f":"她说\\"好\\"",x=`噪声`';
  const { keys, messages } = extractStrings(source);
  assert.deepEqual(keys, ['codex.a.b', 'codex.a.c', 'codex.a.d', 'codex.a.e', 'codex.a.f']);
  assert.deepEqual([...messages], [['codex.a.b', '技能 {name}'], ['codex.a.c', '含 `gh` 的句子'], ['codex.a.e', '二'], ['codex.a.f', '她说"好"']]);
});

const infoPlist = (version: string, build: string) => [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0"><dict>',
  '<key>CFBundleName</key><string>ChatGPT</string>',
  `<key>CFBundleShortVersionString</key><string>${version}</string>`,
  `<key>CFBundleVersion</key><string>${build}</string>`,
  '</dict></plist>',
].join('\n');

/** Stands in for `plutil -convert xml1 -o - <file>` on the XML plists these tests write, so most of the suite also runs where /usr/bin/plutil does not exist (CI is Linux). */
const xmlPlutil: PlutilRunner = async (_file, args) => ({ stdout: await readFile(args.at(-1)!, 'utf8') });
type Plutil = PlutilRunner | 'real';
const needsPlutil = process.platform === 'darwin' ? false : 'needs /usr/bin/plutil (macOS)';

interface FakeMachine {
  contents: string; plist: string; asar: string; snapshots: string; store: CandidateStore;
  install(version: string, build: string, files: Record<string, string>): Promise<void>;
  collect(plutil?: Plutil): ReturnType<typeof collectDesktop>;
}
/** A temp directory laid out like `<root>/ChatGPT.app/Contents/{Info.plist,Resources/app.asar}` plus a store and a snapshot directory. */
async function withMachine(run: (machine: FakeMachine) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'oc-desktop-'));
  try {
    const contents = join(root, 'ChatGPT.app', 'Contents');
    await mkdir(join(contents, 'Resources'), { recursive: true });
    const machine: FakeMachine = {
      contents, plist: join(contents, 'Info.plist'), asar: join(contents, 'Resources', 'app.asar'), snapshots: join(root, 'snapshots'),
      store: new CandidateStore(join(root, 'store'), () => new Date('2026-10-15T00:00:00Z')),
      async install(version, build, files) {
        await writeFile(machine.asar, makeAsar(files));
        await writeFile(machine.plist, infoPlist(version, build));
      },
      collect: (plutil = xmlPlutil) => collectDesktop(machine.store, machine.snapshots, machine.plist, 'zh-CN', plutil === 'real' ? undefined : plutil),
    };
    await run(machine);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const table = (...pairs: Array<[string, string]>) => `a=\`技能\`,${pairs.map(([key, text]) => `"${key}":\`${text}\``).join(',')}`;
const V1 = {
  'webview/index.html': '<html>',
  'webview/assets/codex-light-aaaaaaaaaaaa.js': 'x',
  'webview/assets/zh-CN-bbbbbbbbbbbb.js': table(['codex.command.composer.captureAppshot', '捕获']),
};
const V2 = {
  'webview/index.html': '<html>',
  'webview/assets/codex-light-eeeeeeeeeeee.js': 'x',
  'webview/assets/page-codex-quick-chat-window-cccccccccccc.js': 'y',
  'webview/assets/zh-CN-dddddddddddd.js': table(['codex.command.composer.captureAppshot', '捕获'], ['codex.quickChat.open', '打开快速聊天']),
};

for (const [name, plutil, skip] of [['stand-in plutil', xmlPlutil, false], ['real /usr/bin/plutil', 'real', needsPlutil]] as const) {
  test(`collectDesktop writes a baseline first, skips the archive while the version is unchanged, then turns the diff into candidates (${name})`, { skip }, async () => {
    await withMachine(async machine => {
      await machine.install('26.1.0', '100', V1);
      assert.deepEqual(await machine.collect(plutil), { version: '26.1.0 (100)', changed: true, added: 0 });
      const baseline = join(machine.snapshots, 'desktop', '26.1.0_(100)');
      assert.deepEqual(JSON.parse(await readFile(join(baseline, 'manifest.json'), 'utf8')), {
        version: '26.1.0 (100)', entries: ['/webview/assets/codex-light-aaaaaaaaaaaa.js', '/webview/assets/zh-CN-bbbbbbbbbbbb.js', '/webview/index.html'],
      });
      assert.deepEqual(JSON.parse(await readFile(join(baseline, 'strings.json'), 'utf8')), { version: '26.1.0 (100)', keys: ['codex.command.composer.captureAppshot'], strings: ['技能', '捕获'] });
      assert.equal(await machine.store.checkpoint('lastDesktopVersion'), '26.1.0 (100)');
      assert.equal((await machine.store.list({ source: 'desktop' })).length, 0);

      // Same version: the archive must not even be opened, so a broken one cannot matter.
      await writeFile(machine.asar, 'not an archive');
      assert.deepEqual(await machine.collect(plutil), { version: '26.1.0 (100)', changed: false, added: 0 });

      await machine.install('26.1.1', '101', V2);
      assert.deepEqual(await machine.collect(plutil), { version: '26.1.1 (101)', changed: true, added: 2 });
      const found = await machine.store.list({ source: 'desktop' });
      assert.deepEqual(found.map(c => c.fingerprint).sort(), [
        'desktop:chunk:/webview/assets/page-codex-quick-chat-window.js:26.1.1 (101)',
        'desktop:i18n:codex.quickChat.open:26.1.1 (101)',
      ]);
      const chunk = found.find(c => c.evidence[0]?.kind === 'chunk')!, i18n = found.find(c => c.evidence[0]?.kind === 'i18n')!;
      assert.deepEqual(chunk.evidence, [{ kind: 'chunk', ref: '/webview/assets/page-codex-quick-chat-window.js' }]);
      assert.match(chunk.summary, /26\.1\.0 \(100\).*26\.1\.1 \(101\)/);
      assert.deepEqual(i18n.evidence, [{ kind: 'i18n', ref: 'codex.quickChat.open', excerpt: '打开快速聊天' }]);
      assert.equal(i18n.summary, 'codex.quickChat.open: 打开快速聊天');
      for (const candidate of found) { assert.equal(candidate.status, 'new'); assert.deepEqual(candidate.window, { version: '26.1.1 (101)' }); }
      assert.equal(await machine.store.checkpoint('lastDesktopVersion'), '26.1.1 (101)');

      // Re-running the same transition after a crash before the checkpoint must not duplicate anything.
      await machine.store.setCheckpoint('lastDesktopVersion', '26.1.0 (100)');
      assert.deepEqual(await machine.collect(plutil), { version: '26.1.1 (101)', changed: true, added: 0 });
      assert.equal((await machine.store.list({ source: 'desktop' })).length, 2);
    });
  });
}

test('new keys are grouped by their first three segments, each group listing the Chinese strings that go with its keys', async () => {
  await withMachine(async machine => {
    await machine.install('1', '1', { 'webview/assets/zh-CN-bbbbbbbbbbbb.js': table(['codex.old.key', '旧']) });
    await machine.collect();
    await machine.install('2', '2', {
      'webview/assets/zh-CN-cccccccccccc.js': 'z="no message here",' + table(
        ['codex.old.key', '旧'], ['codex.settings.theme.title', '主题'], ['codex.settings.theme.hint', '选择\n外观'], ['codex.settings.theme', '主题组'],
        ['codex.plain.thing.x', 'y'], ['codex.long.text.key', '长'.repeat(250)],
      ) + ',"codex.plain.thing.z":someCall()',
    });
    assert.equal((await machine.collect()).added, 3);
    const byTitle = new Map((await machine.store.list({ source: 'desktop' })).map(c => [c.title, c]));
    const theme = byTitle.get('桌面端新文案组 codex.settings.theme')!;
    assert.deepEqual(theme.evidence.map(e => [e.ref, e.excerpt]), [['codex.settings.theme', '主题组'], ['codex.settings.theme.hint', '选择 外观'], ['codex.settings.theme.title', '主题']]);
    assert.equal(theme.summary, 'codex.settings.theme: 主题组\ncodex.settings.theme.hint: 选择 外观\ncodex.settings.theme.title: 主题');
    // A key whose value is not a literal still becomes evidence, just without an excerpt.
    assert.deepEqual(byTitle.get('桌面端新文案组 codex.plain.thing')!.evidence, [{ kind: 'i18n', ref: 'codex.plain.thing.x', excerpt: 'y' }, { kind: 'i18n', ref: 'codex.plain.thing.z' }]);
    // A message longer than the 200-character excerpt limit is cut with an ellipsis.
    const long = byTitle.get('桌面端新文案组 codex.long.text')!;
    assert.equal(long.evidence[0]!.excerpt, `${'长'.repeat(199)}…`);
    assert.equal(long.summary, `codex.long.text.key: ${'长'.repeat(199)}…`);
  });
});

test('a long group is cut at whole lines with a count of what was left out', async () => {
  await withMachine(async machine => {
    await machine.install('1', '1', { 'webview/assets/zh-CN-bbbbbbbbbbbb.js': table(['codex.old.key', '旧']) });
    await machine.collect();
    const many = Array.from({ length: 60 }, (_, i): [string, string] => [`codex.big.group.item${String(i).padStart(2, '0')}`, '文'.repeat(40)]);
    await machine.install('2', '2', { 'webview/assets/zh-CN-cccccccccccc.js': table(['codex.old.key', '旧'], ...many) });
    await machine.collect();
    const [group] = await machine.store.list({ source: 'desktop' });
    assert.equal(group!.evidence.length, 60);
    const lines = group!.summary.split('\n');
    assert.match(lines.at(-1)!, /^…另有 \d+ 项$/);
    assert.ok(lines.slice(0, -1).every(line => /^codex\.big\.group\.item\d\d: 文{40}$/.test(line)));
    assert.equal(lines.length - 1 + Number(/\d+/.exec(lines.at(-1)!)![0]), 60);
    assert.ok(lines.slice(0, -1).join('\n').length <= 1_000);
  });
});

test('a machine without ChatGPT.app is skipped silently, other failures to look are not', async () => {
  await withMachine(async machine => {
    const missing = join(machine.contents, 'nope', 'Info.plist');
    assert.deepEqual(await collectDesktop(machine.store, machine.snapshots, missing, 'zh-CN', xmlPlutil), { version: '', changed: false, added: 0 });
    assert.equal(await machine.store.checkpoint('lastDesktopVersion'), undefined);
    // Info.plist present but no archive next to it: that is a broken install, not an absent app.
    await writeFile(machine.plist, infoPlist('1', '1'));
    await assert.rejects(machine.collect(), { code: 'ENOENT' });
    assert.equal(await machine.store.checkpoint('lastDesktopVersion'), undefined);
  });
});

test('an unreadable app directory is reported, not mistaken for an absent app', { skip: process.getuid?.() === 0 && 'root ignores file modes' }, async () => {
  await withMachine(async machine => {
    await machine.install('1', '1', V1);
    await chmod(machine.contents, 0o000);
    try { await assert.rejects(machine.collect(), { code: 'EACCES' }); } finally { await chmod(machine.contents, 0o755); }
  });
});

test('a previous snapshot that is missing, unreadable or malformed counts as a first run instead of throwing', async () => {
  await withMachine(async machine => {
    await machine.install('1', '1', V1);
    await machine.collect();
    await rm(join(machine.snapshots, 'desktop', '1_(1)'), { recursive: true });
    await machine.install('2', '2', V2);
    assert.deepEqual(await machine.collect(), { version: '2 (2)', changed: true, added: 0 });
    assert.equal(await machine.store.checkpoint('lastDesktopVersion'), '2 (2)');

    for (const damage of ['{ not json', 'null', '{"version":"2 (2)","entries":"nope"}']) {
      await writeFile(join(machine.snapshots, 'desktop', '2_(2)', 'manifest.json'), damage);
      await machine.store.setCheckpoint('lastDesktopVersion', '2 (2)');
      await machine.install('3', '3', V1);
      assert.deepEqual(await machine.collect(), { version: '3 (3)', changed: true, added: 0 });
    }
    assert.equal((await machine.store.list({ source: 'desktop' })).length, 0);

    // The snapshot written for 3 (3) is healthy, so the next transition compares again.
    await machine.install('4', '4', V2);
    assert.equal((await machine.collect()).added, 2);
  });
});

test('a missing locale bundle gives an empty snapshot, and the keys it later appears with are not all reported as new', async () => {
  await withMachine(async machine => {
    const withoutLocale = { 'webview/index.html': '<html>', 'webview/assets/codex-light-aaaaaaaaaaaa.js': 'x' };
    await machine.install('1', '1', withoutLocale);
    assert.deepEqual(await machine.collect(), { version: '1 (1)', changed: true, added: 0 });
    assert.deepEqual(JSON.parse(await readFile(join(machine.snapshots, 'desktop', '1_(1)', 'strings.json'), 'utf8')), { version: '1 (1)', keys: [], strings: [] });

    // Without a key baseline all keys would look new; only the genuinely new chunk is reported.
    await machine.install('2', '2', V2);
    assert.deepEqual(await machine.collect(), { version: '2 (2)', changed: true, added: 1 });
    assert.deepEqual((await machine.store.list({ source: 'desktop' })).map(c => c.evidence[0]?.kind), ['chunk']);

    // The bundle going away again is fine too.
    await machine.install('3', '3', withoutLocale);
    assert.deepEqual(await machine.collect(), { version: '3 (3)', changed: true, added: 0 });
  });
});

test('snapshotDesktop reads exactly the bundle of the requested locale and lists every archive entry', async () => {
  await withMachine(async machine => {
    await machine.install('26.1.0', '100', {
      ...V1,
      'webview/assets/zh-CN-extra-cccccccccccc.js': table(['codex.decoy.extra.key', '诱饵']),
      'webview/assets/en-GB-dddddddddddd.js': table(['codex.english.only.key', 'English']),
    });
    const zh = await snapshotDesktop(machine.plist, 'zh-CN', xmlPlutil);
    assert.equal(zh.version, '26.1.0 (100)');
    assert.equal(zh.entries.length, 5);
    assert.deepEqual(zh.keys, ['codex.command.composer.captureAppshot']);
    assert.deepEqual([...zh.messages!], [['codex.command.composer.captureAppshot', '捕获']]);
    assert.deepEqual((await snapshotDesktop(machine.plist, 'en-GB', xmlPlutil)).keys, ['codex.english.only.key']);
    assert.deepEqual((await snapshotDesktop(machine.plist, 'en', xmlPlutil)).keys, []);
    // Regex metacharacters in a locale are plain text, never a pattern.
    assert.deepEqual((await snapshotDesktop(machine.plist, 'zh.CN', xmlPlutil)).keys, []);
  });
});

test('a bundle that is updated while it is being read fails the snapshot instead of mixing two versions', async () => {
  await withMachine(async machine => {
    await machine.install('1', '1', V1);
    // Reads: collectDesktop's own version check, then snapshotDesktop before and after it opens the archive.
    let reads = 0;
    const moving: PlutilRunner = async () => ({ stdout: infoPlist(reads++ < 2 ? '1' : '2', '1') });
    await assert.rejects(machine.collect(moving), /changed while it was being read/);
    assert.equal(await machine.store.checkpoint('lastDesktopVersion'), undefined);
    await assert.rejects(readFile(join(machine.snapshots, 'desktop', '1_(1)', 'manifest.json')), { code: 'ENOENT' });
  });
});

test('readBundleVersion converts to stdout and never rewrites the plist, and rejects one without the version fields', async () => {
  const calls: string[][] = [];
  const run: PlutilRunner = async (file, args) => { calls.push([file, ...args]); return { stdout: infoPlist('26.1007.21159', '20052') }; };
  assert.deepEqual(await readBundleVersion('/x/Info.plist', run), { version: '26.1007.21159', build: '20052' });
  assert.deepEqual(calls, [['/usr/bin/plutil', '-convert', 'xml1', '-o', '-', '/x/Info.plist']]);
  await assert.rejects(readBundleVersion('/x/Info.plist', async () => ({ stdout: infoPlist('1', '2').replace('CFBundleVersion', 'SomethingElse') })), /No version fields/);
});

test('readBundleVersion reads XML and binary plists through the real plutil', { skip: needsPlutil }, async () => {
  await withMachine(async machine => {
    await writeFile(machine.plist, infoPlist('26.1007.21159', '20052'));
    assert.deepEqual(await readBundleVersion(machine.plist), { version: '26.1007.21159', build: '20052' });
    await promisify(execFile)('/usr/bin/plutil', ['-convert', 'binary1', machine.plist]);
    assert.equal((await readFile(machine.plist)).subarray(0, 6).toString(), 'bplist');
    assert.deepEqual(await readBundleVersion(machine.plist), { version: '26.1007.21159', build: '20052' });
  });
});
