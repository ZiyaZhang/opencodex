import test from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError } from '../src/core/check.ts';
import {
  CATEGORIES, EVIDENCE_KINDS, RELEVANCES, SOURCES, STATUSES, canTransition, fingerprintOf, transition,
  type Candidate, type Status,
} from '../src/core/candidate.ts';

const T0 = '2026-10-15T00:00:00.000Z';
const T1 = '2026-10-15T01:00:00.000Z';
const T2 = '2026-10-15T02:00:00.000Z';
const T3 = '2026-10-15T03:00:00.000Z';

// Characters that are easy to lose in an editor are built from code points instead of typed.
const NBSP = String.fromCharCode(0xa0);
const NEL = String.fromCharCode(0x85);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const EM_DASH = String.fromCharCode(0x2014);

const base = (): Candidate => ({
  id: 'c1', fingerprint: 'codex-release:pr:50148', source: 'codex-release', title: 'Managed worktree tools', summary: '',
  status: 'new', createdAt: T0, updatedAt: T0, evidence: [],
});

// The nine legal moves, spelled out so a change to the table has to change this list too.
const LEGAL = new Set([
  'new>reported', 'new>ignored',
  'reported>started', 'reported>ignored', 'reported>reported',
  'started>started', 'started>reported', 'started>ignored',
  'ignored>new',
]);
const invalid = (from: string, to: string) => ({ name: 'ValidationError', message: `Invalid transition ${from} -> ${to}` });

test('fingerprint is stable per source and key', () => {
  assert.equal(fingerprintOf('codex-release', 'pr:50148'), 'codex-release:pr:50148');
  assert.equal(fingerprintOf('desktop', 'i18n:codex.command.composer'), 'desktop:i18n:codex.command.composer');
  for (const source of SOURCES) assert.equal(fingerprintOf(source, 'k:1'), `${source}:k:1`);
  // inner spaces, non-ASCII text and URL punctuation are ordinary key content
  for (const key of ['file:docs/my notes.md', 'https://example.com/a?b=1&c=2#d', `title:Plan mode ${EM_DASH} preview`]) {
    assert.equal(fingerprintOf('rss', key), `rss:${key}`);
  }
});

test('fingerprint keys must be non-blank, trimmed and single-line, each with its own message', () => {
  const rejects = (message: string, keys: string[]) => {
    for (const key of keys) assert.throws(() => fingerprintOf('rss', key), { name: 'ValidationError', message }, JSON.stringify(key));
  };
  rejects('fingerprint key must not be blank', ['', ' ', '   ', '\t', '\n', '\r\n', LS, NBSP]);
  rejects('fingerprint key must not have surrounding whitespace', [' a', 'a ', ' a ', '\ta', 'a\n', '\na', 'a\r\n', `a${LS}`, `${NBSP}a`]);
  rejects('fingerprint key must be one line', [
    'a\nb', 'a\rb', 'a\r\nb', `a${LS}b`, `a${PS}b`, `a${NEL}b`, 'a\tb', 'a\u0000b', 'a\u001fb', 'a\u007fb',
  ]);
});

test('exactly nine status moves are legal', () => {
  assert.equal(LEGAL.size, 9);
  for (const from of STATUSES) for (const to of STATUSES) {
    const legal = LEGAL.has(`${from}>${to}`);
    assert.equal(canTransition(from, to), legal, `canTransition ${from} -> ${to}`);
    const input: Candidate = { ...base(), status: from };
    if (legal) {
      const next = transition(input, to, T1);
      assert.equal(next.status, to, `${from} -> ${to}`);
      assert.equal(next.updatedAt, T1, `${from} -> ${to}`);
    } else {
      assert.throws(() => transition(input, to, T1), invalid(from, to), `${from} -> ${to}`);
    }
  }
});

test('transition changes only status and updatedAt, so a restore keeps the report history', () => {
  const started: Candidate = {
    ...base(), status: 'started', updatedAt: T1,
    window: { fromTag: 'rust-v0.130.0', toTag: 'rust-v0.131.0', version: '0.131.0' },
    evidence: [{ kind: 'pr', ref: '50148', url: 'https://github.com/openai/codex/pull/50148', excerpt: 'Add managed worktree tools' }],
    classification: { category: 'cli-core', relevance: 'high', rationale: 'new tool surface' },
    report: { path: 'reports/c1/report.md', sessionId: 's1', generatedAt: T1, checks: { requiredSections: true, dshRefsTotal: 4, dshRefsResolved: 3 } },
    started: { sessionId: 's2', at: T1 },
  };
  const snapshot = structuredClone(started);

  const ignored = transition(started, 'ignored', T2);
  assert.deepEqual(started, snapshot, 'the input candidate is not mutated');
  assert.notEqual(ignored, started, 'a new object is returned');
  assert.deepEqual(ignored, { ...snapshot, status: 'ignored', updatedAt: T2 });

  const restored = transition(ignored, 'new', T3);
  assert.deepEqual(restored, { ...snapshot, status: 'new', updatedAt: T3 }, 'report, started and classification survive a restore');
  assert.equal(restored.createdAt, T0);
});

test('unknown stored statuses fail as ValidationError, never as TypeError', () => {
  // hand-edited JSON, plus names that exist on Object.prototype and would slip past an `in` check
  for (const bad of ['bogus', '', 'NEW', 'constructor', '__proto__', 'toString', 'hasOwnProperty', undefined, null, 42]) {
    const stored = { ...base(), status: bad } as unknown as Candidate;
    assert.throws(
      () => transition(stored, 'new', T1),
      (error: unknown) => error instanceof ValidationError && error.message.startsWith('Unknown candidate status '),
      `status ${String(bad)}`,
    );
    assert.equal(canTransition(bad as Status, 'new'), false, `canTransition from ${String(bad)}`);
  }
  assert.throws(() => transition({ ...base(), status: 'bogus' as Status }, 'new', T1), { name: 'ValidationError', message: 'Unknown candidate status "bogus"' });
  // an unknown target is an ordinary invalid move
  assert.throws(() => transition(base(), 'bogus' as Status, T1), invalid('new', 'bogus'));
  assert.equal(canTransition('new', 'bogus' as Status), false);
});

test('exported value lists pin the schema vocabulary', () => {
  assert.deepEqual([...SOURCES], ['codex-release', 'codex-files', 'desktop', 'rss']);
  assert.deepEqual([...STATUSES], ['new', 'reported', 'started', 'ignored']);
  assert.deepEqual([...CATEGORIES], ['cli-core', 'desktop', 'cloud', 'model', 'fix', 'other']);
  assert.deepEqual([...RELEVANCES], ['high', 'medium', 'low']);
  assert.deepEqual([...EVIDENCE_KINDS], ['pr', 'file', 'chunk', 'i18n', 'rss', 'feature-flag', 'schema', 'doc']);
});
