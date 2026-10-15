import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CandidateStore } from '../src/core/store.ts';
import { listAsar } from '../src/host/sources/asar.ts';
import { collectDesktop, diffManifests, extractStrings, snapshotDesktop, stripHash, versionLabel, type DesktopCollection } from '../src/host/sources/desktop-app.ts';
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

test('stripHash takes 12-hex, 16-hex and base36 hashes, and leaves unhashed names and other suffix lengths alone', () => {
  const stripped: Array<[string, string]> = [
    ['/webview/assets/icon-set-0123456789abcdef.js', '/webview/assets/icon-set.js'], // 16 hex
    ['/webview/assets/page-codex-quick-chat-window-39F8940AD19E.js', '/webview/assets/page-codex-quick-chat-window.js'], // upper-case hex
    ['/main/chunk-Ab3dEf9x.js', '/main/chunk.js'], // mixed-case base36
    ['/main/store-k3x9a1b2c4.js', '/main/store.js'], // lower-case base36 with digits
    ['/webview/assets/a-abc12345.js', '/webview/assets/a.js'], // 8 characters
    ['/webview/assets/a-abc1234567890123.js', '/webview/assets/a.js'], // 16 characters
  ];
  for (const [path, expected] of stripped) assert.equal(stripHash(path), expected, path);
  const untouched = [
    '/webview/apps/file-explorer.png', '/webview/assets/codex-announcement.js', '/webview/licenses/emoji-datasource.LICENSE', // plain lowercase words
    '/webview/assets/a-abc1234.js', '/webview/assets/a-abc12345678901234.js', // 7 and 17 characters
    '/webview/index.html', '/webview/assets/foo.abcdef123456.js', // no hyphen before the suffix
  ];
  for (const path of untouched) assert.equal(stripHash(path), path, path);
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

interface CollectOptions { plutil?: Plutil; locale?: string; signal?: AbortSignal }
interface FakeMachine {
  contents: string; plist: string; asar: string; snapshots: string; store: CandidateStore;
  install(version: string, build: string, files: Record<string, string>): Promise<void>;
  collect(options?: CollectOptions): ReturnType<typeof collectDesktop>;
  /** Where the snapshot of a version label lives. */
  dirOf(label: string): string;
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
      collect: ({ plutil = xmlPlutil, locale = 'zh-CN', signal } = {}) =>
        collectDesktop(machine.store, machine.snapshots, machine.plist, locale, plutil === 'real' ? undefined : plutil, signal),
      dirOf: label => join(machine.snapshots, 'desktop', label.replace(/[^\w.()-]/g, '_')),
    };
    await run(machine);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const table = (...pairs: Array<[string, string]>) => `a=\`技能\`,${pairs.map(([key, text]) => `"${key}":\`${text}\``).join(',')}`;
const strings = async (machine: FakeMachine, label: string): Promise<unknown> => JSON.parse(await readFile(join(machine.dirOf(label), 'strings.json'), 'utf8'));
const ZH_B = '/webview/assets/zh-CN-bbbbbbbbbbbb.js', ZH_D = '/webview/assets/zh-CN-dddddddddddd.js';
/** Filler keys, so that a test's base key list is big enough for a few new keys not to be a turnover of more than half of it. */
const filler = (count: number): Array<[string, string]> => Array.from({ length: count }, (_, i) => [`codex.filler.group.k${String(i).padStart(3, '0')}`, '填']);
const CMD: Array<[string, string]> = [['codex.command.composer.captureAppshot', '捕获'], ['codex.command.composer.attach', '附件'], ['codex.command.sidebar.toggle', '侧边栏']];
const CMD_KEYS = ['codex.command.composer.attach', 'codex.command.composer.captureAppshot', 'codex.command.sidebar.toggle'];
const V1 = {
  'webview/index.html': '<html>',
  'webview/assets/codex-light-aaaaaaaaaaaa.js': 'x',
  'webview/assets/zh-CN-bbbbbbbbbbbb.js': table(...CMD),
};
const V2 = {
  'webview/index.html': '<html>',
  'webview/assets/codex-light-eeeeeeeeeeee.js': 'x',
  'webview/assets/page-codex-quick-chat-window-cccccccccccc.js': 'y',
  'webview/assets/zh-CN-dddddddddddd.js': table(...CMD, ['codex.quickChat.open', '打开快速聊天']),
};

for (const [name, plutil, skip] of [['stand-in plutil', xmlPlutil, false], ['real /usr/bin/plutil', 'real', needsPlutil]] as const) {
  test(`collectDesktop writes a baseline first, skips the archive while the version is unchanged, then turns the diff into candidates (${name})`, { skip }, async () => {
    await withMachine(async machine => {
      await machine.install('26.1.0', '100', V1);
      // The result type is what the check runner (Task 10) imports by this name.
      const first: DesktopCollection = await machine.collect({ plutil });
      assert.deepEqual(first, { version: '26.1.0 (100)', changed: true, added: 0, keys: 3, localeBundle: ZH_B });
      const baseline = machine.dirOf('26.1.0 (100)');
      assert.ok(baseline.endsWith('26.1.0_(100)'));
      assert.deepEqual(JSON.parse(await readFile(join(baseline, 'manifest.json'), 'utf8')), {
        version: '26.1.0 (100)', entries: ['/webview/assets/codex-light-aaaaaaaaaaaa.js', '/webview/assets/zh-CN-bbbbbbbbbbbb.js', '/webview/index.html'],
      });
      assert.deepEqual(await strings(machine, '26.1.0 (100)'), { version: '26.1.0 (100)', locale: 'zh-CN', keys: CMD_KEYS, strings: ['技能', '捕获', '附件', '侧边栏'], localeBundle: ZH_B });
      assert.equal(await machine.store.checkpoint('lastDesktopVersion'), '26.1.0 (100)');
      assert.equal((await machine.store.list({ source: 'desktop' })).length, 0);

      // Same version: the archive must not even be opened, so a broken one cannot matter. The report comes from the stored snapshot.
      await writeFile(machine.asar, 'not an archive');
      assert.deepEqual(await machine.collect({ plutil }), { version: '26.1.0 (100)', changed: false, added: 0, keys: 3, localeBundle: ZH_B });

      await machine.install('26.1.1', '101', V2);
      assert.deepEqual(await machine.collect({ plutil }), { version: '26.1.1 (101)', changed: true, added: 2, keys: 4, localeBundle: ZH_D });
      const found = await machine.store.list({ source: 'desktop' });
      assert.deepEqual(found.map(c => c.fingerprint).sort(), [
        'desktop:chunk:/webview/assets/page-codex-quick-chat-window.js:26.1.1 (101)',
        'desktop:i18n:codex.quickChat.open:26.1.1 (101)',
      ]);
      const chunk = found.find(c => c.evidence[0]?.kind === 'chunk')!, i18n = found.find(c => c.evidence[0]?.kind === 'i18n')!;
      // `ref` is the stable hash-free name; the excerpt names the real archive path of this version.
      assert.deepEqual(chunk.evidence, [{ kind: 'chunk', ref: '/webview/assets/page-codex-quick-chat-window.js', excerpt: '/webview/assets/page-codex-quick-chat-window-cccccccccccc.js' }]);
      assert.match(chunk.summary, /26\.1\.0 \(100\).*26\.1\.1 \(101\)/);
      assert.deepEqual(i18n.evidence, [{ kind: 'i18n', ref: 'codex.quickChat.open', excerpt: '打开快速聊天' }]);
      assert.equal(i18n.summary, 'codex.quickChat.open: 打开快速聊天');
      for (const candidate of found) { assert.equal(candidate.status, 'new'); assert.deepEqual(candidate.window, { version: '26.1.1 (101)' }); }
      assert.equal(await machine.store.checkpoint('lastDesktopVersion'), '26.1.1 (101)');

      // Re-running the same transition after a crash before the checkpoint must not duplicate anything.
      await machine.store.setCheckpoint('lastDesktopVersion', '26.1.0 (100)');
      assert.deepEqual(await machine.collect({ plutil }), { version: '26.1.1 (101)', changed: true, added: 0, keys: 4, localeBundle: ZH_D });
      assert.equal((await machine.store.list({ source: 'desktop' })).length, 2);
    });
  });
}

test('chunk evidence lists every real archive path behind the stable name, one per line', async () => {
  await withMachine(async machine => {
    await machine.install('1', '1', V1);
    await machine.collect();
    await machine.install('2', '2', { ...V1, 'webview/assets/page-codex-twin-dddddddddddd.js': 'a', 'webview/assets/page-codex-twin-cccccccccccc.js': 'b', 'webview/assets/other-cccccccccccc.js': 'c' });
    assert.equal((await machine.collect()).added, 1);
    const [candidate] = await machine.store.list({ source: 'desktop' });
    assert.deepEqual(candidate!.evidence, [{ kind: 'chunk', ref: '/webview/assets/page-codex-twin.js', excerpt: '/webview/assets/page-codex-twin-cccccccccccc.js\n/webview/assets/page-codex-twin-dddddddddddd.js' }]);
  });
});

test('new keys are grouped by their first three segments, each group listing the Chinese strings that go with its keys', async () => {
  await withMachine(async machine => {
    await machine.install('1', '1', { 'webview/assets/zh-CN-bbbbbbbbbbbb.js': table(['codex.old.key', '旧'], ...filler(20)) });
    await machine.collect();
    await machine.install('2', '2', {
      'webview/assets/zh-CN-cccccccccccc.js': 'z="no message here",' + table(
        ['codex.old.key', '旧'], ...filler(20), ['codex.settings.theme.title', '主题'], ['codex.settings.theme.hint', '选择\n外观'], ['codex.settings.theme', '主题组'],
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

test('the group summary, with its "…另有 N 项" tail, never exceeds 1,000 characters', async () => {
  // Lines of exactly 99 characters: ten fit in 999, and the old cut kept ten lines and then added the tail, ending at 1,007.
  async function summaryOf(count: number): Promise<{ summary: string; evidence: number }> {
    return withMachineValue(async machine => {
      await machine.install('1', '1', { 'webview/assets/zh-CN-bbbbbbbbbbbb.js': table(['codex.old.key', '旧'], ...filler(100)) });
      await machine.collect();
      const many = Array.from({ length: count }, (_, i): [string, string] => [`codex.big.group.item${String(i).padStart(2, '0')}`, '文'.repeat(75)]);
      await machine.install('2', '2', { 'webview/assets/zh-CN-cccccccccccc.js': table(['codex.old.key', '旧'], ...filler(100), ...many) });
      await machine.collect();
      const [group] = await machine.store.list({ source: 'desktop' });
      return { summary: group!.summary, evidence: group!.evidence.length };
    });
  }
  const whole = await summaryOf(10);
  assert.equal(whole.summary.length, 999);
  assert.ok(!whole.summary.includes('另有'));
  for (const count of [11, 12, 40]) {
    const { summary, evidence } = await summaryOf(count);
    assert.equal(evidence, count);
    assert.ok(summary.length <= 1_000, `${count} lines gave ${summary.length} characters`);
    const lines = summary.split('\n');
    assert.match(lines.at(-1)!, /^…另有 \d+ 项$/);
    assert.ok(lines.slice(0, -1).every(line => /^codex\.big\.group\.item\d\d: 文{75}$/.test(line)));
    assert.equal(lines.length - 1 + Number(/\d+/.exec(lines.at(-1)!)![0]), count);
  }
  // Eleven lines: nine fit together with the tail (899 + 8 characters), a tenth would not.
  assert.equal((await summaryOf(11)).summary.split('\n').length, 10);
});
async function withMachineValue<T>(run: (machine: FakeMachine) => Promise<T>): Promise<T> {
  let value: T | undefined;
  await withMachine(async machine => { value = await run(machine); });
  return value as T;
}

test('a machine without ChatGPT.app is skipped silently, other failures to look are not', async () => {
  await withMachine(async machine => {
    const missing = join(machine.contents, 'nope', 'Info.plist');
    assert.deepEqual(await collectDesktop(machine.store, machine.snapshots, missing, 'zh-CN', xmlPlutil), { version: '', changed: false, added: 0, keys: 0 });
    assert.equal(await machine.store.checkpoint('lastDesktopVersion'), undefined);
    // Info.plist present but no archive next to it: that is a broken install, not an absent app.
    await writeFile(machine.plist, infoPlist('1', '1'));
    // A path that runs through a file is as absent as a missing one.
    assert.deepEqual(await collectDesktop(machine.store, machine.snapshots, join(machine.plist, 'Info.plist'), 'zh-CN', xmlPlutil), { version: '', changed: false, added: 0, keys: 0 });
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
  const V3 = {
    'webview/index.html': '<html>',
    'webview/assets/codex-light-eeeeeeeeeeee.js': 'x',
    'webview/assets/page-codex-third-ffffffffffff.js': 'z',
    'webview/assets/zh-CN-aaaaaaaaaaaa.js': table(...CMD, ['codex.quickChat.open', '打开快速聊天'], ['codex.third.key', '第三']),
  };
  const healthyStrings = { version: '2 (2)', locale: 'zh-CN', keys: ['codex.a.b'], strings: ['技能'], localeBundle: ZH_D };
  const damages: Array<[string, string, string]> = [
    ['manifest.json', 'not json', '{ not json'],
    ['manifest.json', 'null', 'null'],
    ['manifest.json', 'an array', '[]'],
    ['manifest.json', 'entries is not an array', '{"version":"2 (2)","entries":"nope"}'],
    ['manifest.json', 'entries hold a number', '{"version":"2 (2)","entries":["/a.js",7]}'],
    ['manifest.json', 'version is missing', '{"entries":["/a.js"]}'],
    ['strings.json', 'keys hold null', JSON.stringify({ ...healthyStrings, keys: ['codex.a.b', null] })],
    ['strings.json', 'strings hold an object', JSON.stringify({ ...healthyStrings, strings: ['技能', {}] })],
    ['strings.json', 'localeBundle is a number', JSON.stringify({ ...healthyStrings, localeBundle: 5 })],
    ['strings.json', 'localeBundle is missing', JSON.stringify({ version: '2 (2)', locale: 'zh-CN', keys: [], strings: [] })],
    ['strings.json', 'locale is missing', JSON.stringify({ version: '2 (2)', keys: [], strings: [], localeBundle: null })],
  ];
  async function run(damage?: [string, string, string]) {
    return withMachineValue(async machine => {
      await machine.install('2', '2', V2);
      await machine.collect();
      if (damage) await writeFile(join(machine.dirOf('2 (2)'), damage[0]), damage[2]);
      await machine.install('3', '3', V3);
      const result = await machine.collect();
      return { result, candidates: (await machine.store.list({ source: 'desktop' })).length };
    });
  }
  // Control: a healthy base yields a new chunk and a new key group.
  assert.deepEqual(await run(), { result: { version: '3 (3)', changed: true, added: 2, keys: 5, localeBundle: '/webview/assets/zh-CN-aaaaaaaaaaaa.js' }, candidates: 2 });
  for (const damage of damages) {
    assert.deepEqual(await run(damage), { result: { version: '3 (3)', changed: true, added: 0, keys: 5, localeBundle: '/webview/assets/zh-CN-aaaaaaaaaaaa.js' }, candidates: 0 }, `${damage[0]}: ${damage[1]}`);
  }
});

test('a missing previous snapshot directory is a first run too, and the next version compares against the rebuilt one', async () => {
  await withMachine(async machine => {
    await machine.install('1', '1', V1);
    await machine.collect();
    await rm(machine.dirOf('1 (1)'), { recursive: true });
    await machine.install('2', '2', V2);
    assert.deepEqual(await machine.collect(), { version: '2 (2)', changed: true, added: 0, keys: 4, localeBundle: ZH_D });
    assert.equal(await machine.store.checkpoint('lastDesktopVersion'), '2 (2)');
    await machine.install('3', '3', { ...V2, 'webview/assets/page-codex-later-cccccccccccc.js': 'q' });
    assert.equal((await machine.collect()).added, 1);
  });
});

test('a snapshot that has gone missing for the current version is rebuilt on the next poll, so the next transition has a base', async () => {
  await withMachine(async machine => {
    await machine.install('1', '1', V1);
    await machine.collect();
    await rm(machine.dirOf('1 (1)'), { recursive: true });
    assert.deepEqual(await machine.collect(), { version: '1 (1)', changed: true, added: 0, keys: 3, localeBundle: ZH_B });
    assert.deepEqual(await machine.collect(), { version: '1 (1)', changed: false, added: 0, keys: 3, localeBundle: ZH_B });
    await machine.install('2', '2', V2);
    assert.equal((await machine.collect()).added, 2);
  });
});

test('a missing locale bundle gives an empty snapshot, and the keys it later appears with are not all reported as new', async () => {
  await withMachine(async machine => {
    const withoutLocale = { 'webview/index.html': '<html>', 'webview/assets/codex-light-aaaaaaaaaaaa.js': 'x' };
    await machine.install('1', '1', withoutLocale);
    assert.deepEqual(await machine.collect(), { version: '1 (1)', changed: true, added: 0, keys: 0 });
    assert.deepEqual(await strings(machine, '1 (1)'), { version: '1 (1)', locale: 'zh-CN', keys: [], strings: [], localeBundle: null });

    // With no key list at all there is no base: only the genuinely new chunk is reported, not every key.
    await machine.install('2', '2', V2);
    assert.deepEqual(await machine.collect(), { version: '2 (2)', changed: true, added: 1, keys: 4, localeBundle: ZH_D });
    assert.deepEqual((await machine.store.list({ source: 'desktop' })).map(c => c.evidence[0]?.kind), ['chunk']);

    // The bundle going away again is fine too, and says so.
    await machine.install('3', '3', withoutLocale);
    assert.deepEqual(await machine.collect(), { version: '3 (3)', changed: true, added: 0, keys: 0 });
  });
});

test('a version without keys hands the last key list on, so the diff over a gap still yields the new keys', async () => {
  const base: Array<[string, string]> = [...filler(6), ['codex.a.one', '一'], ['codex.a.two', '二']];
  const baseKeys = base.map(([key]) => key).sort();
  const withBundle = (hash: string, ...pairs: Array<[string, string]>) => ({ 'webview/index.html': '<html>', [`webview/assets/zh-CN-${hash}.js`]: table(...pairs) });
  const gap = (...extra: string[]) => ({ 'webview/index.html': '<html>', ...Object.fromEntries(extra.map(name => [`webview/assets/${name}`, 'y'])) });
  await withMachine(async machine => {
    await machine.install('1', '1', withBundle('bbbbbbbbbbbb', ...base));
    assert.deepEqual(await machine.collect(), { version: '1 (1)', changed: true, added: 0, keys: 8, localeBundle: '/webview/assets/zh-CN-bbbbbbbbbbbb.js' });

    // v2: the bundle is gone (renamed, or named in a form the match does not know). A chunk that is new in this version is still found.
    await machine.install('2', '2', gap('page-codex-gap-cccccccccccc.js'));
    assert.deepEqual(await machine.collect(), { version: '2 (2)', changed: true, added: 1, keys: 0 });
    assert.deepEqual(await strings(machine, '2 (2)'), { version: '2 (2)', locale: 'zh-CN', keys: baseKeys, strings: [], localeBundle: null });

    // The missing bundle stays visible on later polls, without opening the archive.
    await writeFile(machine.asar, 'not an archive');
    assert.deepEqual(await machine.collect(), { version: '2 (2)', changed: false, added: 0, keys: 0 });

    // v3: still no bundle. The base survives a second gap.
    await machine.install('3', '3', gap());
    assert.deepEqual(await machine.collect(), { version: '3 (3)', changed: true, added: 0, keys: 0 });
    assert.deepEqual((await strings(machine, '3 (3)') as { keys: string[] }).keys, baseKeys);

    // v4: the bundle is back with two keys that are new relative to v1, the last version that had any.
    await machine.install('4', '4', withBundle('dddddddddddd', ...base, ['codex.a.three', '三'], ['codex.b.four', '四']));
    assert.deepEqual(await machine.collect(), { version: '4 (4)', changed: true, added: 2, keys: 10, localeBundle: '/webview/assets/zh-CN-dddddddddddd.js' });
    const found = await machine.store.list({ source: 'desktop' });
    assert.deepEqual(found.map(c => c.title).sort(), ['桌面端新文案组 codex.a.three', '桌面端新文案组 codex.b.four', '桌面端新模块 page-codex-gap.js']);
    assert.deepEqual(found.filter(c => c.evidence[0]?.kind === 'i18n').map(c => [c.summary, c.window]).sort(), [
      ['codex.a.three: 三', { version: '4 (4)' }], ['codex.b.four: 四', { version: '4 (4)' }],
    ]);
    const stored = await strings(machine, '4 (4)') as { keys: string[]; localeBundle: string | null };
    assert.deepEqual(stored.keys, [...baseKeys, 'codex.a.three', 'codex.b.four'].sort());
    assert.equal(stored.localeBundle, '/webview/assets/zh-CN-dddddddddddd.js');
  });
});

test('the locale bundle is the sibling with the most codex keys, whatever order the header lists them in', async () => {
  const keyless: [string, string] = ['webview/assets/es-ES-aaaaaaaaaaaa.js', 'x=`纯文本`,y=`别的`'];
  const small: [string, string] = ['webview/assets/es-ES-bbbbbbbbbbbb.js', table(['codex.a.one', 'uno'])];
  const big: [string, string] = ['webview/assets/es-ES-cccccccccccc.js', table(['codex.a.one', 'uno'], ['codex.a.two', 'dos'], ['codex.a.three', 'tres'])];
  const tie: [string, string] = ['webview/assets/es-ES-dddddddddddd.js', table(['codex.z.one', 'x'], ['codex.z.two', 'y'], ['codex.z.three', 'z'])];
  const orders = [[keyless, small, big], [big, small, keyless], [small, keyless, big], [tie, big, keyless], [keyless, tie, big], [big, tie]];
  for (const order of orders) {
    await withMachine(async machine => {
      await machine.install('1', '1', Object.fromEntries(order));
      // The permutation really is the header order, so the test cannot pass by accident.
      assert.deepEqual((await listAsar(machine.asar)).map(e => e.path), order.map(([path]) => `/${path}`));
      const snapshot = await snapshotDesktop(machine.plist, 'es-ES', xmlPlutil);
      // On a tie between two keyed chunks the lower path wins, so the pick does not depend on the header either.
      assert.equal(snapshot.localeBundle, '/webview/assets/es-ES-cccccccccccc.js');
      assert.deepEqual(snapshot.keys, ['codex.a.one', 'codex.a.three', 'codex.a.two']);
      assert.deepEqual([...snapshot.messages], [['codex.a.one', 'uno'], ['codex.a.two', 'dos'], ['codex.a.three', 'tres']]);
      assert.deepEqual(snapshot.strings, ['技能', 'uno', 'dos', 'tres']);
    });
  }
});

test('when no sibling of the locale has any codex key there is no locale bundle, whatever else it holds', async () => {
  await withMachine(async machine => {
    await machine.install('1', '1', { 'webview/assets/es-ES-aaaaaaaaaaaa.js': 'x=`纯文本`,y=`别的`', 'webview/assets/es-ES-bbbbbbbbbbbb.js': 'z=`还有`' });
    const snapshot = await snapshotDesktop(machine.plist, 'es-ES', xmlPlutil);
    assert.equal(snapshot.localeBundle, null);
    assert.deepEqual([snapshot.keys, snapshot.strings, [...snapshot.messages]], [[], [], []]);
  });
});

test('snapshotDesktop reads only bundles of the requested locale and lists every archive entry', async () => {
  await withMachine(async machine => {
    await machine.install('26.1.0', '100', {
      ...V1,
      'webview/assets/zh-CN-extra-cccccccccccc.js': table(['codex.decoy.extra.key', '诱饵']),
      'webview/assets/en-GB-dddddddddddd.js': table(['codex.english.only.key', 'English']),
    });
    const zh = await snapshotDesktop(machine.plist, 'zh-CN', xmlPlutil);
    assert.equal(zh.version, '26.1.0 (100)');
    assert.equal(zh.entries.length, 5);
    assert.equal(zh.localeBundle, ZH_B);
    assert.deepEqual(zh.keys, CMD_KEYS);
    assert.deepEqual([...zh.messages], CMD);
    assert.deepEqual((await snapshotDesktop(machine.plist, 'en-GB', xmlPlutil)).keys, ['codex.english.only.key']);
    assert.deepEqual((await snapshotDesktop(machine.plist, 'en', xmlPlutil)).keys, []);
    // Regex metacharacters in a locale are plain text, never a pattern.
    assert.deepEqual((await snapshotDesktop(machine.plist, 'zh.CN', xmlPlutil)).keys, []);
  });
});

test('locale bundles named with a 16-hex or base36 hash are found, hashes of other lengths are not', async () => {
  await withMachine(async machine => {
    await machine.install('1', '1', {
      'webview/assets/pt-BR-0123456789abcdef.js': table(['codex.a.pt', 'um']),
      'webview/assets/ja-K3x9A1b2c4.js': table(['codex.a.ja', '一']),
      'webview/assets/de-DE-abc1234.js': table(['codex.a.short', '7']),
      'webview/assets/fr-FR-abc12345678901234.js': table(['codex.a.long', '17']),
    });
    assert.equal((await snapshotDesktop(machine.plist, 'pt-BR', xmlPlutil)).localeBundle, '/webview/assets/pt-BR-0123456789abcdef.js');
    assert.equal((await snapshotDesktop(machine.plist, 'ja', xmlPlutil)).localeBundle, '/webview/assets/ja-K3x9A1b2c4.js');
    assert.equal((await snapshotDesktop(machine.plist, 'de-DE', xmlPlutil)).localeBundle, null);
    assert.equal((await snapshotDesktop(machine.plist, 'fr-FR', xmlPlutil)).localeBundle, null);
  });
});

test('a changed locale is snapshotted again at the same version, and its keys are not compared with another locale\'s', async () => {
  const bundles = (hash: string, ...keys: string[]) => ({
    'webview/index.html': '<html>',
    [`webview/assets/zh-CN-${hash}.js`]: table(...keys.map((key): [string, string] => [key, '中'])),
    [`webview/assets/es-ES-${hash}.js`]: table(...keys.map((key): [string, string] => [key, 'es'])),
  });
  await withMachine(async machine => {
    await machine.install('1', '1', bundles('bbbbbbbbbbbb', 'codex.a.one', 'codex.a.two'));
    assert.deepEqual(await machine.collect(), { version: '1 (1)', changed: true, added: 0, keys: 2, localeBundle: '/webview/assets/zh-CN-bbbbbbbbbbbb.js' });
    // Same version, other locale: the stored snapshot answers for zh-CN only, so this takes a new one.
    assert.deepEqual(await machine.collect({ locale: 'es-ES' }), { version: '1 (1)', changed: true, added: 0, keys: 2, localeBundle: '/webview/assets/es-ES-bbbbbbbbbbbb.js' });
    assert.deepEqual(await machine.collect({ locale: 'es-ES' }), { version: '1 (1)', changed: false, added: 0, keys: 2, localeBundle: '/webview/assets/es-ES-bbbbbbbbbbbb.js' });
    assert.equal(((await strings(machine, '1 (1)')) as { locale: string }).locale, 'es-ES');

    // A locale with no bundle at all reports that, and the report goes away again when the locale does.
    assert.deepEqual(await machine.collect({ locale: 'xx-XX' }), { version: '1 (1)', changed: true, added: 0, keys: 0 });
    assert.deepEqual(await machine.collect({ locale: 'xx-XX' }), { version: '1 (1)', changed: false, added: 0, keys: 0 });
    assert.deepEqual(await machine.collect({ locale: 'zh-CN' }), { version: '1 (1)', changed: true, added: 0, keys: 2, localeBundle: '/webview/assets/zh-CN-bbbbbbbbbbbb.js' });

    // A new version together with a locale change: the old keys belong to another locale, so a new key is not reported against them...
    await machine.install('2', '2', bundles('cccccccccccc', 'codex.a.one', 'codex.a.two', 'codex.a.three'));
    assert.equal((await machine.collect({ locale: 'es-ES' })).added, 0);
    // ...but the next version compares es-ES with es-ES again.
    await machine.install('3', '3', bundles('dddddddddddd', 'codex.a.one', 'codex.a.two', 'codex.a.three', 'codex.a.four'));
    assert.equal((await machine.collect({ locale: 'es-ES' })).added, 1);
  });
});

test('an older build than the checkpoint re-baselines instead of reporting what the newer one dropped as new', async () => {
  const withBundle = (extra: Record<string, string>, ...pairs: Array<[string, string]>) => ({ 'webview/index.html': '<html>', ...extra, 'webview/assets/zh-CN-bbbbbbbbbbbb.js': table(['codex.cur.key', '当前'], ...pairs) });
  const newer = withBundle({});
  const older = withBundle({ 'webview/assets/page-codex-legacy-cccccccccccc.js': 'y' }, ['codex.legacy.key', '旧']);
  await withMachine(async machine => {
    await machine.install('26.2.0', '200', newer);
    await machine.collect();
    // The older build still has a chunk and a key that the newer one removed: neither is a new feature.
    await machine.install('26.1.0', '100', older);
    assert.deepEqual(await machine.collect(), { version: '26.1.0 (100)', changed: true, added: 0, keys: 2, localeBundle: ZH_B });
    assert.equal((await machine.store.list()).length, 0);
    assert.equal(await machine.store.checkpoint('lastDesktopVersion'), '26.1.0 (100)');
    // Going up again compares with the downgraded snapshot as usual.
    await machine.install('26.3.0', '300', { ...older, 'webview/assets/page-codex-fresh-cccccccccccc.js': 'q' });
    assert.equal((await machine.collect()).added, 1);
  });
});

test('builds compare as numbers, so 9 to 10 is an upgrade, and as natural-order text when they are not numbers', async () => {
  const base = { 'webview/index.html': '<html>', 'webview/assets/codex-light-aaaaaaaaaaaa.js': 'x' };
  const plus = { ...base, 'webview/assets/page-codex-added-cccccccccccc.js': 'y' };
  for (const [from, to, upgrade] of [['9', '10', true], ['10', '9', false], ['b9', 'b10', true], ['b10', 'b9', false], ['beta1', 'alpha1', false], ['alpha1', 'beta1', true]] as const) {
    await withMachine(async machine => {
      await machine.install('1.0', from, base);
      await machine.collect();
      await machine.install('1.0', to, plus);
      assert.equal((await machine.collect()).added, upgrade ? 1 : 0, `${from} -> ${to}`);
    });
  }
});

test('a key list that turns over by more than half is a new bundle layout: it becomes the base, makes no candidates and is reported', async () => {
  const keys = (prefix: string, count: number) => Array.from({ length: count }, (_, i): [string, string] => [`codex.${prefix}.group.k${i}`, `文${i}`]);
  const bundle = (hash: string, ...pairs: Array<[string, string]>) => ({ [`webview/assets/zh-CN-${hash}.js`]: table(...pairs) });
  await withMachine(async machine => {
    await machine.install('1', '1', bundle('bbbbbbbbbbbb', ...keys('old', 10)));
    await machine.collect();
    // All ten keys renamed: ten "new" keys against a base of ten.
    await machine.install('2', '2', bundle('cccccccccccc', ...keys('new', 10)));
    assert.deepEqual(await machine.collect(), { version: '2 (2)', changed: true, added: 0, keys: 10, localeBundle: '/webview/assets/zh-CN-cccccccccccc.js', keysReset: true });
    assert.equal((await machine.store.list()).length, 0);
    assert.deepEqual((await strings(machine, '2 (2)') as { keys: string[] }).keys, keys('new', 10).map(([key]) => key));
    // The new layout is the base from here on.
    await machine.install('3', '3', bundle('dddddddddddd', ...keys('new', 10), ['codex.new.extra.key', '新']));
    assert.deepEqual(await machine.collect(), { version: '3 (3)', changed: true, added: 1, keys: 11, localeBundle: '/webview/assets/zh-CN-dddddddddddd.js' });
  });
});

test('the flood guard trips above half of the previous key count, not at half', async () => {
  for (const [extra, reset] of [[5, false], [6, true]] as const) {
    await withMachine(async machine => {
      const base = Array.from({ length: 10 }, (_, i): [string, string] => [`codex.old.group.k${i}`, '旧']);
      const added = Array.from({ length: extra }, (_, i): [string, string] => [`codex.old.group.x${i}`, '新']);
      await machine.install('1', '1', { 'webview/assets/zh-CN-bbbbbbbbbbbb.js': table(...base) });
      await machine.collect();
      await machine.install('2', '2', { 'webview/assets/zh-CN-cccccccccccc.js': table(...base, ...added) });
      const result = await machine.collect();
      assert.equal(result.keysReset, reset ? true : undefined, `${extra} new keys`);
      assert.equal(result.added, reset ? 0 : 1, `${extra} new keys`);
    });
  }
});

test('an aborted signal stops the collection between steps and leaves no checkpoint or snapshot behind', async () => {
  await withMachine(async machine => {
    await machine.install('1', '1', V1);
    let calls = 0;
    const counting: PlutilRunner = (file, args, options) => { calls++; return xmlPlutil(file, args, options); };
    await assert.rejects(machine.collect({ plutil: counting, signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.equal(calls, 0);
    // Aborted while the n-th plutil call runs: the run stops at the next check, before anything is written.
    for (const abortAt of [1, 2, 3]) {
      const controller = new AbortController();
      let seen = 0;
      const aborting: PlutilRunner = async (file, args, options) => { const out = await xmlPlutil(file, args, options); if (++seen === abortAt) controller.abort(); return out; };
      await assert.rejects(machine.collect({ plutil: aborting, signal: controller.signal }), { name: 'AbortError' }, `abort during call ${abortAt}`);
      assert.equal(await machine.store.checkpoint('lastDesktopVersion'), undefined);
      await assert.rejects(readFile(join(machine.dirOf('1 (1)'), 'manifest.json')), { code: 'ENOENT' });
    }
    assert.equal((await machine.collect()).changed, true);
  });
});

test('the signal reaches the plutil runner, and no signal option is passed when there is none', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const spy: PlutilRunner = (file, args, options) => { seen.push({ ...options }); return xmlPlutil(file, args, options); };
  await withMachine(async machine => {
    await machine.install('1', '1', V1);
    const controller = new AbortController();
    await machine.collect({ plutil: spy, signal: controller.signal });
    assert.ok(seen.length >= 3);
    assert.ok(seen.every(options => options.signal === controller.signal));
    seen.length = 0;
    await machine.collect({ plutil: spy });
    assert.equal(seen.length, 1);
    assert.equal(Object.hasOwn(seen[0]!, 'signal'), false);
  });
});

test('an abort after a candidate leaves the checkpoint alone, and the next run finishes the rest without duplicates', async () => {
  // After the first candidate the loop stops; after the last one only the check before the checkpoint write is left.
  for (const abortAfter of [1, 2]) {
    await withMachine(async machine => {
      await machine.install('1', '1', { 'webview/assets/zh-CN-bbbbbbbbbbbb.js': table(['codex.old.key', '旧'], ...filler(10)) });
      await machine.collect();
      await machine.install('2', '2', { 'webview/assets/zh-CN-cccccccccccc.js': table(['codex.old.key', '旧'], ...filler(10), ['codex.aa.one.x', '甲'], ['codex.bb.two.y', '乙']) });
      const controller = new AbortController();
      const upsert = machine.store.upsert.bind(machine.store);
      let upserts = 0;
      machine.store.upsert = async input => { const result = await upsert(input); if (++upserts === abortAfter) controller.abort(); return result; };
      await assert.rejects(machine.collect({ signal: controller.signal }), { name: 'AbortError' }, `abort after candidate ${abortAfter}`);
      assert.equal(await machine.store.checkpoint('lastDesktopVersion'), '1 (1)');
      assert.equal((await machine.store.list()).length, abortAfter);
      machine.store.upsert = upsert;
      assert.deepEqual(await machine.collect(), { version: '2 (2)', changed: true, added: 2 - abortAfter, keys: 13, localeBundle: '/webview/assets/zh-CN-cccccccccccc.js' });
      assert.equal((await machine.store.list()).length, 2);
      assert.equal(await machine.store.checkpoint('lastDesktopVersion'), '2 (2)');
    });
  }
});

test('a bundle that is updated while it is being read fails the snapshot instead of mixing two versions', async () => {
  await withMachine(async machine => {
    await machine.install('1', '1', V1);
    // Reads: collectDesktop's own version check, then snapshotDesktop before and after it opens the archive.
    let reads = 0;
    const moving: PlutilRunner = async () => ({ stdout: infoPlist(reads++ < 2 ? '1' : '2', '1') });
    await assert.rejects(machine.collect({ plutil: moving }), /changed while it was being read/);
    assert.equal(await machine.store.checkpoint('lastDesktopVersion'), undefined);
    await assert.rejects(readFile(join(machine.dirOf('1 (1)'), 'manifest.json')), { code: 'ENOENT' });
  });
});

test('readBundleVersion converts to stdout and never rewrites the plist, and rejects one without the version fields', async () => {
  const calls: Array<[string, ...string[]]> = [];
  const run: PlutilRunner = async (file, args) => { calls.push([file, ...args]); return { stdout: infoPlist('26.1007.21159', '20052') }; };
  assert.deepEqual(await readBundleVersion('/x/Info.plist', run), { version: '26.1007.21159', build: '20052' });
  assert.deepEqual(calls, [['/usr/bin/plutil', '-convert', 'xml1', '-o', '-', '/x/Info.plist']]);
  await assert.rejects(readBundleVersion('/x/Info.plist', async () => ({ stdout: infoPlist('1', '2').replace('CFBundleVersion', 'SomethingElse') })), /No version fields/);
});

test('readBundleVersion refuses newlines and control characters, which the checkpoint store would reject after the snapshot was written', async () => {
  const returning = (version: string, build = '1'): PlutilRunner => async () => ({ stdout: infoPlist(version, build) });
  for (const bad of ['1.0\n2', '1.0\r', '1\t2', '1\u00002', '1\u001b[0m', '1\u009f2', '1\u{2028}2', '1\u{2029}2', '   ']) {
    await assert.rejects(readBundleVersion('/x/Info.plist', returning(bad)), /No version fields|Invalid CFBundleShortVersionString/, JSON.stringify(bad));
    await assert.rejects(readBundleVersion('/x/Info.plist', returning('1.0', bad)), /No version fields|Invalid CFBundleVersion/, JSON.stringify(bad));
  }
  // Padding is trimmed, and whatever it accepts the store accepts as a checkpoint value.
  const padded = await readBundleVersion('/x/Info.plist', returning('  26.1  ', ' 7 '));
  assert.deepEqual(padded, { version: '26.1', build: '7' });
  await withMachine(async machine => { await machine.store.setCheckpoint('lastDesktopVersion', versionLabel(padded)); });
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
