import { check } from './check.js';

export const SOURCES = ['codex-release', 'codex-files', 'desktop', 'rss'] as const;
export type Source = typeof SOURCES[number];
export const STATUSES = ['new', 'reported', 'started', 'ignored'] as const;
export type Status = typeof STATUSES[number];
export const CATEGORIES = ['cli-core', 'desktop', 'cloud', 'model', 'fix', 'other'] as const;
export const RELEVANCES = ['high', 'medium', 'low'] as const;
export const EVIDENCE_KINDS = ['pr', 'file', 'chunk', 'i18n', 'rss', 'feature-flag', 'schema', 'doc'] as const;
export type EvidenceKind = typeof EVIDENCE_KINDS[number];

export interface Evidence { kind: EvidenceKind; ref: string; url?: string; excerpt?: string }
export interface Classification {
  category: typeof CATEGORIES[number]; relevance: typeof RELEVANCES[number];
  /** The `id` of another candidate this one was merged into. */
  mergedInto?: string;
  /**
   * The Codex feature as a name (at most 20 code points) and what Codex does, in one sentence (at most 60). Both are absent on a
   * classification made before they existed, which marks it to be classified again; they are empty when the model gave none, which the
   * page treats as absent.
   */
  headline?: string; gist?: string;
  rationale: string;
}
export interface ReportChecks { requiredSections: boolean; dshRefsTotal: number; dshRefsResolved: number }
export interface ReportRecord {
  /** Relative to the OpenCodex data directory, e.g. `reports/<id>/report.md`. */
  path: string;
  sessionId?: string; generatedAt: string; checks: ReportChecks;
}
/**
 * One discovered Codex feature, tracked from discovery through its gap report to a creator-mode hand-off.
 * Every timestamp on it is an ISO-8601 UTC string such as `2026-10-15T00:00:00.000Z`; lexicographic order is then chronological order, which the store relies on when it sorts by `updatedAt`.
 */
export interface Candidate {
  id: string; fingerprint: string; source: Source; title: string; summary: string;
  status: Status; createdAt: string; updatedAt: string;
  window?: { fromTag?: string; toTag?: string; version?: string };
  evidence: Evidence[];
  classification?: Classification;
  report?: ReportRecord;
  started?: { sessionId: string; at: string };
  /**
   * What automatic research did with the candidate: when it last tried (at most once a UTC day), and why that try failed. A new try
   * replaces both, so `lastError` belongs to `autoAttemptedAt`. Absent until a first try.
   */
  research?: { autoAttemptedAt?: string; lastError?: string };
}

/** Allowed status moves. `reported -> reported` regenerates a report, `started -> started` opens another session, `started -> reported` regenerates the report after a start, `ignored -> new` is a manual restore. */
const TRANSITIONS: Record<Status, readonly Status[]> = {
  new: ['reported', 'ignored'],
  reported: ['started', 'ignored', 'reported'],
  started: ['started', 'reported', 'ignored'],
  ignored: ['new'],
};
/** True when `from -> to` is an allowed move; false for anything outside `STATUSES`, so statuses read back from disk are safe to ask about. */
export function canTransition(from: Status, to: Status): boolean {
  return Object.hasOwn(TRANSITIONS, from) && TRANSITIONS[from].includes(to);
}
export function fingerprintOf(source: Source, key: string): string {
  check(key.trim().length > 0, 'fingerprint key must not be blank');
  check(key === key.trim(), 'fingerprint key must not have surrounding whitespace');
  check(!/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(key), 'fingerprint key must be one line');
  return `${source}:${key}`;
}
/** Moves a candidate to `status` at time `at`. Only `status` and `updatedAt` change; every other field is history, so a restore (`ignored -> new`) keeps `report`, `started`, `classification` and `research`. */
export function transition(candidate: Candidate, status: Status, at: string): Candidate {
  check(Object.hasOwn(TRANSITIONS, candidate.status), `Unknown candidate status ${JSON.stringify(candidate.status)}`);
  check(canTransition(candidate.status, status), `Invalid transition ${candidate.status} -> ${status}`);
  return { ...candidate, status, updatedAt: at };
}
