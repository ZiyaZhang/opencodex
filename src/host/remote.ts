/** Browser-safe descriptors for the authenticated DSH Remote carrier. */
import type { InvocationDescriptor, TypertRemoteContribution, RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { BudgetSummary, CreateJobInput, JobBudget, Settings, StoreState, VerificationInput } from '../core/types.js';

export interface ReferenceImageInput {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  dataBase64: string;
}

export type OpenCodexRequest =
  | { action: 'snapshot' | 'scan' | 'scanLocalVersion' | 'capabilities' }
  | { action: 'create'; input: CreateJobInput; referenceImage?: ReferenceImageInput }
  | { action: 'readReferenceImage'; jobId: string }
  | { action: 'readScreenshot'; jobId: string; artifactId: string }
  | { action: 'settings'; patch: Partial<Settings> }
  | { action: 'start'; jobId: string; note?: string }
  | { action: 'pause' | 'cancel' | 'validateArtifact'; jobId: string }
  | { action: 'extendBudget'; jobId: string; patch: Partial<JobBudget> }
  | { action: 'approveForeground'; jobId: string; requestId: string }
  | { action: 'recordVerification'; jobId: string; input: VerificationInput }
  | { action: 'markReady'; jobId: string }
  | { action: 'markCovered'; jobId: string; specId: string; reason: string }
  | { action: 'readResource'; id: string };
export interface OpenCodexResponse {
  state: StoreState;
  budgets: Record<string, BudgetSummary>;
  resource?: { id: string; content: string };
  scan?: { baseline: number; unchanged: number; changed: number; errors: string[] };
  validation?: { passed: boolean; details: string[] };
  referenceImage?: ReferenceImageInput;
  screenshot?: ReferenceImageInput;
}

function json(value: unknown): unknown {
  // Carrier inputs are JSON already; explicit serialization limits excessive nested payloads.
  const text = JSON.stringify(value);
  if (text === undefined || text.length > 4_000_000) throw new Error('OpenCodex RPC payload must be JSON and at most 4 MB');
  return JSON.parse(text);
}
function request(value: unknown): OpenCodexRequest {
  const parsed = json(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('action' in parsed)
      || typeof parsed.action !== 'string' || !['snapshot', 'scan', 'scanLocalVersion', 'capabilities', 'create', 'readReferenceImage', 'readScreenshot', 'settings', 'start', 'pause', 'cancel', 'validateArtifact', 'extendBudget', 'approveForeground', 'recordVerification', 'markReady', 'markCovered', 'readResource'].includes(parsed.action)) {
    throw new Error('Unknown OpenCodex action');
  }
  if (parsed.action === 'readReferenceImage' || parsed.action === 'readScreenshot') {
    const allowed = parsed.action === 'readScreenshot' ? ['action', 'jobId', 'artifactId'] : ['action', 'jobId'];
    if (Object.keys(parsed).some(key => !allowed.includes(key))) throw new Error('Image reads accept job/artifact identifiers only, never a path');
  }
  return parsed as OpenCodexRequest;
}

export const OPEN_CODEX_DESCRIPTOR: InvocationDescriptor = {
  id: 'dsh-opencodex#opencodex/call', service: 'opencodex', namespace: 'opencodex', method: 'call',
  invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: 'OpenCodexRequest', create: () => ({ parse: request }) } }],
  result: { mode: 'strict', typeSymbol: 'OpenCodexResponse', create: () => ({ parse: json }) },
};
export const OPEN_CODEX_REMOTE: TypertRemoteContribution = { package: 'dsh-opencodex', descriptors: [OPEN_CODEX_DESCRIPTOR] };

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    opencodex: { call: (request: OpenCodexRequest, signal?: AbortSignal) => Promise<RemoteResult<OpenCodexResponse>> };
  }
  interface TypertRemoteMap {
    'opencodex/call': (request: OpenCodexRequest, signal?: AbortSignal) => Promise<RemoteResult<OpenCodexResponse>>;
  }
}
