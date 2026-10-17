/**
 * The Host contract as the page reads it. The Host's own types, plus the optional fields this release adds on the Host side (the model
 * catalog, the research queue and its notice, the automatic research setting, a candidate's research record), written here so the page
 * can be built against them before the Host carries them. Each addition is optional: a Host without it is read as one that has none of
 * it. Once the Host's types have these fields, the names below become aliases of them.
 */
import type { Candidate } from '../core/candidate.js';
import type { Settings } from '../core/settings.js';
import type { OpenCodexRequest, OpenCodexResponse } from '../host/remote.js';

/** Which new candidates the Host researches by itself after a check: none, the high-relevance ones, or the medium-relevance ones too. */
export type AutoResearch = 'off' | 'high' | 'medium';
/** The Host's default for `autoResearch`, which a Host without the setting is shown with. */
export const DEFAULT_AUTO_RESEARCH: AutoResearch = 'high';
export type ClientSettings = Settings & { autoResearch?: AutoResearch };
/** A candidate, with what automatic research recorded on it: when it last tried this candidate, and why that failed. */
export type ClientCandidate = Candidate & { research?: { autoAttemptedAt?: string; lastError?: string } };
/** The models DSH offers, by provider; a provider whose listing failed has no models, and the answer's `notice` says why. */
export type ModelCatalog = Array<{ provider: string; providerName: string; models: Array<{ id: string; name: string }> }>;

export type ClientResponse = Omit<OpenCodexResponse, 'settings' | 'candidates' | 'candidate'> & {
  settings: ClientSettings;
  candidates: ClientCandidate[];
  candidate?: ClientCandidate;
  /** `models`: the catalog. */
  models?: ModelCatalog;
  /** The candidates waiting for automatic research, in the order they will run; the running one is in `busy`. */
  researchQueue?: string[];
  /** Why automatic research stopped: the day's reports used up, another process researching. */
  researchNotice?: string;
};
export type ClientRequest =
  | Exclude<OpenCodexRequest, { action: 'settings' }>
  | { action: 'settings'; patch: Partial<ClientSettings> }
  | { action: 'models' };

/** One request to the Host: the answer, or an error whose message the page shows. */
export type Call = (request: ClientRequest, signal?: AbortSignal) => Promise<ClientResponse>;
/** Shows a session in the DSH workspace. */
export type OpenSession = (sessionId: string) => void;
