/** Browser-safe descriptors for the authenticated DSH Remote carrier. */
import type { InvocationDescriptor, TypertRemoteContribution, RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { BudgetSummary, CreateJobInput, JobBudget, ScreenshotMetadata, Settings, StoreState, VerificationInput } from '../core/types.js';

export interface ReferenceImageInput {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  dataBase64: string;
}

export interface PluginArtifactChunk {
  filename: string;
  sha256: string;
  totalBytes: number;
  offset: number;
  dataBase64: string;
  nextOffset?: number;
}

export type OpenCodexRequest =
  | { action: 'snapshot' | 'scan' | 'scanLocalVersion' | 'capabilities' }
  | { action: 'create'; input: CreateJobInput; referenceImage?: ReferenceImageInput }
  | { action: 'readReferenceImage'; jobId: string }
  | { action: 'readScreenshot'; jobId: string; artifactId: string }
  | { action: 'addScreenshot'; jobId: string; image: ReferenceImageInput; metadata: ScreenshotMetadata }
  | { action: 'readPluginArtifact'; jobId: string; artifactId: string; offset?: number }
  | { action: 'settings'; patch: Partial<Settings> }
  | { action: 'start'; jobId: string; note?: string; freshContext?: boolean }
  | { action: 'pause' | 'cancel' | 'validateArtifact' | 'installPlugin'; jobId: string }
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
  scan?: { baseline: number; unchanged: number; changed: number; discovered?: number; errors: string[] };
  validation?: { passed: boolean; details: string[] };
  referenceImage?: ReferenceImageInput;
  screenshot?: ReferenceImageInput;
  pluginArtifact?: PluginArtifactChunk;
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
      || typeof parsed.action !== 'string' || !['snapshot', 'scan', 'scanLocalVersion', 'capabilities', 'create', 'readReferenceImage', 'readScreenshot', 'addScreenshot', 'readPluginArtifact', 'installPlugin', 'settings', 'start', 'pause', 'cancel', 'validateArtifact', 'extendBudget', 'approveForeground', 'recordVerification', 'markReady', 'markCovered', 'readResource'].includes(parsed.action)) {
    throw new Error('Unknown OpenCodex action');
  }
  if (parsed.action === 'installPlugin' && (Object.keys(parsed).some(key => !['action', 'jobId'].includes(key)) || !('jobId' in parsed) || typeof parsed.jobId !== 'string')) throw new Error('Installation accepts a job identifier only, never a package spec or path');
  if (parsed.action === 'readReferenceImage' || parsed.action === 'readScreenshot') {
    const allowed = parsed.action === 'readScreenshot' ? ['action', 'jobId', 'artifactId'] : ['action', 'jobId'];
    if (Object.keys(parsed).some(key => !allowed.includes(key))) throw new Error('Image reads accept job/artifact identifiers only, never a path');
  }
  if (parsed.action === 'readPluginArtifact') {
    if (Object.keys(parsed).some(key => !['action', 'jobId', 'artifactId', 'offset'].includes(key))) throw new Error('Plugin reads accept job/artifact identifiers and offset only, never a path');
    if (!('jobId' in parsed) || typeof parsed.jobId !== 'string' || !('artifactId' in parsed) || typeof parsed.artifactId !== 'string') throw new Error('Plugin reads require job and artifact identifiers');
    if ('offset' in parsed && (!Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0)) throw new Error('Plugin download offset must be a nonnegative integer');
  }
  if (parsed.action === 'addScreenshot') {
    if (Object.keys(parsed).some(key => !['action', 'jobId', 'image', 'metadata'].includes(key))) throw new Error('Screenshot uploads accept job ID, image and metadata only, never a path');
    if (!('jobId' in parsed) || typeof parsed.jobId !== 'string' || !('image' in parsed) || !('metadata' in parsed)) throw new Error('Screenshot upload requires job ID, image and metadata');
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
