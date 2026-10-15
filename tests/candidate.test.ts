import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintOf, transition, type Candidate } from '../src/core/candidate.ts';

const base = (): Candidate => ({
  id: 'c1', fingerprint: 'codex-release:pr:50148', source: 'codex-release', title: 'Managed worktree tools', summary: '',
  status: 'new', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', evidence: [],
});

test('fingerprint is stable per source and key', () => {
  assert.equal(fingerprintOf('codex-release', 'pr:50148'), 'codex-release:pr:50148');
  assert.equal(fingerprintOf('desktop', 'i18n:codex.command.composer'), 'desktop:i18n:codex.command.composer');
  assert.throws(() => fingerprintOf('rss', 'a\rb'), /one line/);
});

test('only forward transitions and ignore are allowed', () => {
  assert.equal(transition(base(), 'reported', '2026-10-15T01:00:00.000Z').status, 'reported');
  assert.equal(transition({ ...base(), status: 'reported' }, 'started', '2026-10-15T01:00:00.000Z').status, 'started');
  assert.equal(transition(base(), 'ignored', '2026-10-15T01:00:00.000Z').status, 'ignored');
  assert.throws(() => transition({ ...base(), status: 'started' }, 'new', '2026-10-15T01:00:00.000Z'), /Invalid transition/);
  assert.throws(() => transition(base(), 'started', '2026-10-15T01:00:00.000Z'), /Invalid transition/);
});
