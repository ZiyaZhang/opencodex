import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertFixtureHome, controlPort, initializeFixtureHome, MARKER } from './home.mjs';

test('dedicated home must be explicitly initialized and match DSH_HOME', () => {
  const temp = mkdtempSync(join(tmpdir(), 'opencodex-fixture-'));
  try {
    assert.throws(() => assertFixtureHome({ OPENCODEX_QA_HOME: temp, DSH_HOME: temp }), /marker/);
    const root = initializeFixtureHome(temp);
    assert.equal(assertFixtureHome({ OPENCODEX_QA_HOME: temp, DSH_HOME: temp }), root);
    assert.throws(() => assertFixtureHome({ OPENCODEX_QA_HOME: temp }), /DSH_HOME/);
    assert.throws(() => assertFixtureHome({ OPENCODEX_QA_HOME: temp, DSH_HOME: homedir() }), /DSH_HOME/);
    const before = readFileSync(join(root, MARKER), 'utf8');
    assert.equal(initializeFixtureHome(temp), root);
    assert.equal(readFileSync(join(root, MARKER), 'utf8'), before);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('refuses daily state, populated unmarked directories, symlinks and forged markers', () => {
  assert.throws(() => initializeFixtureHome(join(homedir(), '.dsh')), /Refusing/);
  assert.throws(() => initializeFixtureHome(join(homedir(), '.dsh', 'qa')), /Refusing/);
  assert.throws(() => initializeFixtureHome(homedir()), /Refusing/);
  assert.throws(() => initializeFixtureHome('relative'), /absolute/);
  const temp = mkdtempSync(join(tmpdir(), 'opencodex-fixture-'));
  try {
    writeFileSync(join(temp, 'existing.txt'), 'do not overwrite');
    assert.throws(() => initializeFixtureHome(temp), /nonempty/);
    assert.equal(readFileSync(join(temp, 'existing.txt'), 'utf8'), 'do not overwrite');
    const marked = initializeFixtureHome(join(temp, 'marked'));
    symlinkSync(marked, join(temp, 'alias'));
    assert.throws(() => initializeFixtureHome(join(temp, 'alias')), /symlink/);
    writeFileSync(join(marked, MARKER), JSON.stringify({ kind: 'opencodex-output-qa', version: 1, home: '/incorrect' }));
    assert.throws(() => assertFixtureHome({ OPENCODEX_QA_HOME: marked, DSH_HOME: marked }), /contents/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('control port accepts only an unprivileged integer', () => {
  assert.equal(controlPort('53752'), 53752);
  for (const invalid of ['0', '80', '65536', '53752/path', '1e4', 'NaN', '']) assert.throws(() => controlPort(invalid), /Invalid/);
});
