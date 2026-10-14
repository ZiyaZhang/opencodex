import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { LOCAL_VERSION_MAX_BYTES, LOCAL_VERSION_STATE_FILE, parseLocalVersion, scanLocalVersion, watchLocalVersion, type LocalVersionStore } from '../src/host/local-version.js';
import type { CandidateInput } from '../src/core/types.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-local-version-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const selected = join(directory, 'synthetic-app', 'package.json');
  await mkdir(join(directory, 'synthetic-app'));
  const saved = new Map<string, CandidateInput & { id: string }>();
  let calls = 0;
  const store: LocalVersionStore = {
    async saveCandidate(input) {
      calls++;
      const previous = saved.get(input.fingerprint);
      if (previous) return previous;
      const candidate = { ...input, id: `candidate-${saved.size + 1}` };
      saved.set(input.fingerprint, candidate);
      return candidate;
    },
  };
  const state = join(directory, 'state');
  const signal = new AbortController().signal;
  return { directory, selected, state, saved, store, signal, get calls() { return calls; }, scan: () => scanLocalVersion(state, store, { path: selected }, signal) };
}

test('first local observation is a baseline; version/build changes persist and duplicate scans stay quiet', async t => {
  const f = await fixture(t);
  await writeFile(f.selected, JSON.stringify({ version: '1.2.3', build: 70, description: 'synthetic baseline' }));
  assert.equal((await f.scan()).baseline, 1);
  assert.equal(f.calls, 0);
  await writeFile(f.selected, JSON.stringify({ description: 'unrelated packaging change', build: 70, version: ' 1.2.3 ' }));
  assert.equal((await f.scan()).unchanged, 1);
  assert.equal(f.calls, 0);
  await writeFile(f.selected, JSON.stringify({ version: '1.2.4', build: 71 }));
  const changed = await f.scan();
  assert.equal(changed.changed, 1);
  assert.equal(changed.version, '1.2.4');
  assert.equal(changed.build, '71');
  assert.equal(changed.candidateId, 'candidate-1');
  const candidate = [...f.saved.values()][0]!;
  assert.equal(candidate.sourceType, 'local-version');
  assert.match(candidate.title, /1\.2\.3 \(70\).*1\.2\.4 \(71\)/);
  assert.ok(!JSON.stringify(candidate).includes(f.directory));
  assert.ok(!await readFile(join(f.state, LOCAL_VERSION_STATE_FILE), 'utf8').then(value => value.includes(f.selected)));
  // A fresh call with only the persisted checkpoint represents restart catch-up.
  assert.equal((await scanLocalVersion(f.state, f.store, { path: f.selected }, f.signal)).unchanged, 1);
  await writeFile(f.selected, JSON.stringify({ version: '1.2.4', build: 72 }));
  assert.equal((await f.scan()).changed, 1);
  assert.equal(f.saved.size, 2);
});

test('XML plist reads only direct dictionary version fields and does not execute or resolve XML entities', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Nested</key><dict><key>CFBundleShortVersionString</key><string>ignored</string></dict>
<key>Array</key><array><string>unrelated</string><true/></array>
<key>CFBundleShortVersionString</key><string>2.&#48; &amp; beta</string>
<key>CFBundleVersion</key><integer>210</integer>
</dict></plist>`;
  assert.deepEqual(parseLocalVersion(xml, 'plist'), { version: '2.0 & beta', build: '210' });
  assert.throws(() => parseLocalVersion(xml.replace('2.&#48; &amp; beta', '&private;'), 'plist'), /entity/);
  assert.throws(() => parseLocalVersion(xml.replace('<dict>', '<dict><key>CFBundleVersion</key><string>999</string>'), 'plist'), /Duplicate/);
  assert.throws(() => parseLocalVersion(xml.replace('</dict></plist>', '</dict>'), 'plist'), /Incomplete/);
  assert.throws(() => parseLocalVersion('<!DOCTYPE plist [<!ENTITY x SYSTEM "file:///private">]><plist><dict/></plist>', 'plist'), /Entity/);
  assert.throws(() => parseLocalVersion('<plist><dict><key>CFBundleVersion</key><string>1</string></dict><dict/></plist>', 'plist'), /one plist/);
  assert.throws(() => parseLocalVersion('bplist00binary', 'plist'));
});

test('missing and partially written update files retain the previous baseline and recover on the next scan', async t => {
  const f = await fixture(t);
  await writeFile(f.selected, '{"version":"1"}');
  await f.scan();
  await rm(f.selected);
  const missing = await f.scan();
  assert.equal(missing.errors.length, 1);
  assert.match(missing.errors[0]!, /temporarily missing/);
  await writeFile(f.selected, '{"version":"2","privateField":"SECRET_NEVER_ECHO"');
  const partial = await f.scan();
  assert.equal(partial.errors.length, 1);
  assert.ok(!JSON.stringify(partial).includes('SECRET_NEVER_ECHO'));
  assert.equal(f.saved.size, 0);
  await writeFile(f.selected, '{"version":"2"}');
  assert.equal((await f.scan()).changed, 1);
  assert.match([...f.saved.values()][0]!.title, /1 → 2/);
});

test('metadata size, selected path, and format are bounded without advancing a valid baseline', async t => {
  const f = await fixture(t);
  await writeFile(f.selected, '{"version":"1"}');
  await f.scan();
  await writeFile(f.selected, ' '.repeat(LOCAL_VERSION_MAX_BYTES + 1));
  assert.match((await f.scan()).errors[0]!, /1 MiB/);
  assert.equal(f.saved.size, 0);
  assert.equal((await scanLocalVersion(f.state, f.store, { path: 'relative/package.json' }, f.signal)).errors.length, 1);
  assert.equal((await scanLocalVersion(f.state, f.store, { path: join(f.directory, 'metadata.js') }, f.signal)).errors.length, 1);
  assert.throws(() => parseLocalVersion('{"build":{}}', 'json'));
  assert.throws(() => parseLocalVersion('{"version":"1\\n2"}', 'json'));
  assert.throws(() => parseLocalVersion('{"name":"no version"}', 'json'));
});

test('concurrent watcher/poll scans create one candidate and switching the selected path establishes a new baseline', async t => {
  const f = await fixture(t);
  await writeFile(f.selected, '{"version":"1"}');
  await Promise.all([f.scan(), f.scan()]);
  await writeFile(f.selected, '{"version":"2"}');
  const results = await Promise.all([f.scan(), f.scan(), f.scan()]);
  assert.equal(results.reduce((count, item) => count + item.changed, 0), 1);
  assert.equal(f.calls, 1);
  const other = join(f.directory, 'other.json');
  await writeFile(other, '{"version":"90"}');
  assert.equal((await scanLocalVersion(f.state, f.store, { path: other }, f.signal)).baseline, 1);
  assert.equal(f.calls, 1);
});

test('a failed candidate save does not consume the update checkpoint', async t => {
  const f = await fixture(t);
  await writeFile(f.selected, '{"version":"1"}');
  await f.scan();
  await writeFile(f.selected, '{"version":"2"}');
  const failed = await scanLocalVersion(f.state, { saveCandidate: async () => { throw new Error('Synthetic store unavailable'); } }, { path: f.selected }, f.signal);
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.changed, 0);
  assert.equal((await f.scan()).changed, 1);
});

test('parent watcher observes atomic replacement, does not invent sibling updates, and disposes callbacks', async t => {
  const f = await fixture(t);
  await writeFile(f.selected, '{"version":"1"}');
  await f.scan();
  let events = 0;
  const errors: Error[] = [];
  const dispose = watchLocalVersion(f.selected, async () => { events++; await f.scan(); }, { debounceMs: 15, onError: error => errors.push(error) });
  t.after(async () => dispose());
  await writeFile(join(f.directory, 'synthetic-app', 'unrelated.txt'), 'unchanged target');
  await delay(80);
  // Some systems emit a null filename or a delayed original event; a scan must remain a no-op.
  assert.equal(f.saved.size, 0);
  const replacement = join(f.directory, 'synthetic-app', 'replacement.tmp');
  await writeFile(replacement, '{"version":"2"}');
  await rename(replacement, f.selected);
  const deadline = Date.now() + 1500;
  while (!f.saved.size && Date.now() < deadline) await delay(20);
  assert.equal(f.saved.size, 1, 'atomic replacement should produce one local update candidate');
  assert.equal(errors.length, 0);
  dispose();
  const stoppedAt = events;
  await writeFile(f.selected, '{"version":"3"}');
  await delay(80);
  assert.equal(events, stoppedAt);
});

test('pre-aborted scans create neither baseline nor candidate', async t => {
  const f = await fixture(t);
  await writeFile(f.selected, '{"version":"1"}');
  const controller = new AbortController(); controller.abort(new Error('Synthetic stop'));
  await assert.rejects(scanLocalVersion(f.state, f.store, { path: f.selected }, controller.signal), /Synthetic stop/);
  assert.equal(f.calls, 0);
  await assert.rejects(readFile(join(f.state, LOCAL_VERSION_STATE_FILE)), { code: 'ENOENT' });
});


test('plist scan observes a build-only update and a nonexistent parent cannot claim an active watcher', async t => {
  const f = await fixture(t);
  const plist = join(f.directory, 'synthetic-app', 'Info.plist');
  const xml = (build: number) => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>3.0</string><key>CFBundleVersion</key><string>${build}</string></dict></plist>`;
  await writeFile(plist, xml(100));
  assert.equal((await scanLocalVersion(f.state, f.store, { path: plist }, f.signal)).baseline, 1);
  await writeFile(plist, xml(101));
  const changed = await scanLocalVersion(f.state, f.store, { path: plist }, f.signal);
  assert.equal(changed.changed, 1);
  assert.equal(changed.build, '101');
  assert.throws(() => watchLocalVersion(join(f.directory, 'missing-parent', 'Info.plist'), () => undefined), /temporarily missing/);
});


test('a selected input cannot be overwritten by the version checkpoint', async t => {
  const f = await fixture(t);
  await mkdir(f.state);
  const input = join(f.state, LOCAL_VERSION_STATE_FILE);
  const content = '{"version":"user-file"}';
  await writeFile(input, content);
  const result = await scanLocalVersion(f.state, f.store, { path: input }, f.signal);
  assert.match(result.errors[0]!, /cannot be the OpenCodex version checkpoint/);
  assert.equal(await readFile(input, 'utf8'), content);
  assert.equal(f.saved.size, 0);
});
