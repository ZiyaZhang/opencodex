export const JOB_STATUSES = ['detected', 'draft', 'queued', 'researching', 'specifying', 'researched', 'building', 'verifying', 'ready', 'paused', 'blocked', 'failed', 'installed', 'covered', 'cancelled'] as const;
export type JobStatus = typeof JOB_STATUSES[number];
export type EvidenceKind = 'observed' | 'inferred' | 'unknown';
export type VerificationScope = 'behavior' | 'visual' | 'lifecycle';
export interface Settings {
  defaultJobTokenLimit: number;
  dailyTokenLimit: number;
  maxDurationMs: number;
  maxRepairRounds: number;
  monitorEnabled: boolean;
  monitorIntervalMinutes: number;
  localVersionFile: string;
  updateResearchMode: 'notify' | 'investigate';
}
export interface JobBudget { tokenLimit: number; maxDurationMs: number; maxRepairRounds: number }
export interface StateEvent { at: string; from: JobStatus | null; to: JobStatus; reason: string }
export interface ForegroundRequest {
  id: string; target: string; scope: string; steps: string[]; requestedAt: string;
  approvedAt?: string; completedAt?: string; releasedAt?: string; releaseReason?: string;
}
export interface ForegroundLease { jobId: string; requestId: string; approvedAt: string }
export interface SessionBinding { sessionId: string; parentSessionId?: string; boundAt: string }
export interface PluginInstallation {
  requestId: string; artifactId: string; artifactSha256: string;
  status: 'installing' | 'installed' | 'failed' | 'interrupted';
  startedAt: string; completedAt?: string;
  packageName?: string; version?: string;
  application?: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled';
  error?: string; logPath?: string; warnings?: string[];
}
export interface AcceptanceRun {
  id: string; specId: string; artifactId: string; artifactSha256: string;
  status: 'running' | 'passed' | 'blocked' | 'failed' | 'interrupted';
  startedAt: string; completedAt?: string; reportPath?: string; details?: string;
}
export interface Job {
  id: string; title: string; description: string; source: 'user' | 'discovery'; candidateId?: string;
  mode: 'reconstruct' | 'investigate';
  status: JobStatus; createdAt: string; updatedAt: string; budget: JobBudget;
  elapsedMs: number; activeSince: string | null; repairRounds: number;
  history: StateEvent[]; budgetHistory: Array<{ at: string; previous: JobBudget; next: JobBudget }>;
  sessionId?: string; executionSessionId?: string; sessionIds: string[]; sessionBindings: SessionBinding[]; workdir?: string;
  foreground?: ForegroundRequest; artifactId?: string; installedReceipt?: string;
  installation?: PluginInstallation;
  acceptance?: AcceptanceRun;
  coverage?: { specId: string; confirmedAt: string; reason: string };
}
export interface Candidate {
  id: string; title: string; description: string; sourceUrl: string; version?: string;
  publishedAt?: string; releaseTitle?: string;
  detectedAt: string; updatedAt: string; fingerprint: string; status: 'new' | 'selected' | 'dismissed';
  sourceType?: 'public-source' | 'local-version';
  /** Captured at first detection; changing settings later does not opt in old candidates. */
  autoInvestigate?: boolean;
  sourceSnapshot?: { path: string; sha256: string; bytes: number; fetchedAt: string };
}
export interface Evidence {
  id: string; jobId: string; kind: EvidenceKind; claim: string; createdAt: string;
  sourceUrl?: string; localPath?: string; sha256?: string; relatedEvidenceIds: string[];
}
export interface FeatureSpec {
  id: string; jobId: string; title: string; behavior: string[]; visual: string[]; lifecycle: string[];
  existingCapabilities: string[]; gaps: string[]; evidenceIds: string[]; createdAt: string;
}
export interface ScreenshotMetadata {
  subject: 'codex' | 'dsh' | 'other'; caption: string;
  provenance: 'user' | 'capture' | 'public-source'; sourceUrl?: string; version?: string;
}
export interface Artifact {
  id: string; jobId: string; path: string; label: string; kind: 'plugin' | 'report' | 'screenshot' | 'log';
  sha256: string; bytes: number; createdAt: string;
  /** Optional only for compatibility with screenshots recorded before this contract. */
  screenshot?: ScreenshotMetadata;
  /** Present for a package explicitly supplied outside the research agent. */
  provenance?: { kind: 'operator-assisted'; details: string };
}
export interface Verification {
  id: string; jobId: string; specId: string; artifactId: string; artifactSha256: string; scope: VerificationScope;
  outcome: 'passed' | 'failed' | 'partial'; method: 'browser' | 'command' | 'manual';
  environment: 'isolated'; details: string; evidenceIds: string[]; screenshotIds?: string[]; createdAt: string;
}
export interface CapabilityCheck {
  id: string; available: boolean; detail: string; version?: string;
}
export interface CapabilitySnapshot { checkedAt: string; checks: CapabilityCheck[] }
export interface TokenUsage { inputTokens: number; outputTokens: number }
export interface TokenReservation {
  requestId: string; jobId: string; reservedTokens: number; reservedAt: string;
  status: 'inflight' | 'settled' | 'unknown'; usage?: TokenUsage; settledAt?: string;
  unknownReason?: string;
}
export interface TokenSummary {
  confirmedTokens: number; reservedTokens: number; unknownRequests: number; remainingTokens: number;
}
export interface BudgetSummary {
  job: TokenSummary; daily: TokenSummary; day: string; elapsedMs: number; repairRounds: number;
}
export interface StoreState {
  schemaVersion: 1; createdAt: string; updatedAt: string; settings: Settings;
  jobs: Job[]; candidates: Candidate[]; evidence: Evidence[]; specs: FeatureSpec[];
  artifacts: Artifact[]; verifications: Verification[]; reservations: TokenReservation[];
  capabilities: CapabilitySnapshot | null;
  foregroundLease?: ForegroundLease;
}
export interface CreateJobInput {
  title: string; description?: string; source?: 'user' | 'discovery'; candidateId?: string;
  mode?: Job['mode'];
  budget?: Partial<JobBudget>;
}
export type CandidateInput = Pick<Candidate, 'title' | 'description' | 'sourceUrl' | 'fingerprint'> & Partial<Pick<Candidate, 'version' | 'status' | 'sourceType' | 'publishedAt' | 'releaseTitle' | 'sourceSnapshot'>>;
export type EvidenceInput = Pick<Evidence, 'kind' | 'claim'> & Partial<Pick<Evidence, 'sourceUrl' | 'localPath' | 'relatedEvidenceIds'>>;
export type SpecInput = Omit<FeatureSpec, 'id' | 'jobId' | 'createdAt'>;
export type VerificationInput = Omit<Verification, 'id' | 'jobId' | 'specId' | 'createdAt' | 'artifactSha256'>;
export interface StoreOptions { directory: string; artifactRoot?: string; now?: () => Date }
