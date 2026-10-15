import { check } from './check.js';

export const SOURCES = ['codex-release', 'codex-files', 'desktop', 'rss'] as const;
export type Source = typeof SOURCES[number];
export const STATUSES = ['new', 'reported', 'started', 'ignored'] as const;
export type Status = typeof STATUSES[number];
export type EvidenceKind = 'pr' | 'file' | 'chunk' | 'i18n' | 'rss' | 'feature-flag' | 'schema' | 'doc';

export interface Evidence { kind: EvidenceKind; ref: string; url?: string; excerpt?: string }
export interface Classification { category: 'cli-core' | 'desktop' | 'cloud' | 'model' | 'fix' | 'other'; relevance: 'high' | 'medium' | 'low'; mergedInto?: string; rationale: string }
export interface ReportRecord { path: string; sessionId?: string; generatedAt: string; checks: { requiredSections: boolean; dshRefsTotal: number; dshRefsResolved: number } }
/** One discovered Codex feature, tracked from discovery through its gap report to a creator-mode hand-off. */
export interface Candidate {
  id: string; fingerprint: string; source: Source; title: string; summary: string;
  status: Status; createdAt: string; updatedAt: string;
  window?: { fromTag?: string; toTag?: string; version?: string };
  evidence: Evidence[];
  classification?: Classification;
  report?: ReportRecord;
  started?: { sessionId: string; at: string };
}

/** Allowed status moves; `reported -> reported` regenerates a report, `ignored -> new` is a manual restore. */
const TRANSITIONS: Record<Status, readonly Status[]> = {
  new: ['reported', 'ignored'], reported: ['started', 'ignored', 'reported'], started: ['ignored'], ignored: ['new'],
};
export function fingerprintOf(source: Source, key: string): string {
  check(key.trim().length > 0 && !/[\r\n]/.test(key), 'fingerprint key must be one line');
  return `${source}:${key}`;
}
export function transition(candidate: Candidate, status: Status, at: string): Candidate {
  check(TRANSITIONS[candidate.status].includes(status), `Invalid transition ${candidate.status} -> ${status}`);
  return { ...candidate, status, updatedAt: at };
}
