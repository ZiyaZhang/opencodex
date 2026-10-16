/**
 * The OpenCodex Remote: request and response types, the request check, and the descriptors for the authenticated DSH Remote carrier.
 * The client bundle imports this file, so everything it takes from Host modules is `import type`; the only runtime import is the
 * dependency-free `core/check.ts`.
 */
import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import type { Candidate } from '../core/candidate.js';
import { ValidationError, check } from '../core/check.js';
import type { ModelRoute, Settings } from '../core/settings.js';
import type { CheckResult } from './collector.js';

export type OpenCodexRequest =
  | { action: 'snapshot' }
  | { action: 'check' }
  | { action: 'classify' }
  | { action: 'report'; id: string }
  | { action: 'start'; id: string }
  | { action: 'ignore'; id: string }
  | { action: 'restore'; id: string }
  | { action: 'readReport'; id: string }
  | { action: 'candidate'; id: string }
  | { action: 'rebuildIndex' }
  | { action: 'settings'; patch: Partial<Settings> };

/** What every action answers once it has finished: the snapshot, plus the field of its own for the actions that return something. */
export interface OpenCodexResponse {
  settings: Settings;
  /**
   * Every `reported` and `started` candidate, then the newest others up to 800 in all, `new` before `ignored`; within each group latest
   * change first. Each evidence entry carries only `kind`, `ref` and `url`, `summary` is cut to 300 code points and
   * `classification.rationale` to 120; `candidate` returns one record whole.
   */
  candidates: Candidate[];
  /** How many candidates there are, and how many of them (the oldest new ones, then ignored ones) `candidates` leaves out. */
  totalCandidates: number;
  omittedCandidates: number;
  checkpoints: Record<string, string | undefined>;
  /** The last check this Host process ran, by the timer or on request (one that failed as a whole has a `check:` line), and when it ended. */
  lastCheck?: CheckResult;
  lastCheckAt?: string;
  /** Work in progress: a check, and the candidates with a report or a start running. */
  busy: { check: boolean; candidates: Record<string, 'report' | 'start'> };
  /** `readReport`: the report, or empty text and a `notice` saying why there is none to show. */
  report?: { id: string; markdown: string; notice?: string };
  /** `candidate`: the whole record, evidence excerpts included. */
  candidate?: Candidate;
  /** The DSH index in use, once one is loaded or built. */
  indexSummary?: { entries: number; commit: string; builtAt: string };
  /** `start`: the creator-mode session just opened, for the page to switch to. */
  startedSessionId?: string;
  /** What this answer lacks though the action finished: the list or the checkpoints could not be read, records were damaged, the list was too large. */
  notice?: string;
}

/** Results above this many characters of JSON are refused, so the snapshot keeps far below it (see `OpenCodexResponse.candidates`). */
export const MAX_PAYLOAD = 4_000_000;
const BARE_ACTIONS: ReadonlySet<string> = new Set(['snapshot', 'check', 'classify', 'rebuildIndex']);
const ID_ACTIONS: ReadonlySet<string> = new Set(['report', 'start', 'ignore', 'restore', 'readReport', 'candidate']);
/** Candidate ids are `randomUUID()`s: lowercase, one path segment. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The JSON type of every setting. The values themselves (absolute paths, ranges) are `mergeSettings`'s to check on the Host. */
const SETTING_SHAPES = {
  channel: 'string', desktopPlistPath: 'string', desktopLocale: 'string', dshMirrorPath: 'string',
  classifyModel: 'route', reportModel: 'route', reportPreset: 'string', startPreset: 'string', startModel: 'route',
  dailyReportLimit: 'number', checkIntervalHours: 'number',
} as const satisfies Record<keyof Settings, 'string' | 'number' | 'route'>;
const SHAPE_TEXT = { string: '字符串', number: '数字' } as const;

/** A plain object, as JSON makes them: one with another prototype (`{ __proto__: … }` in a literal) is no request. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
const isRoute = (value: unknown): value is ModelRoute =>
  isRecord(value) && Object.keys(value).every(key => key === 'provider' || key === 'model') && typeof value.provider === 'string' && typeof value.model === 'string';

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], action: string): void {
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  check(extra.length === 0, `${action} 不接受这些字段：${extra.map(key => JSON.stringify(key)).join('、')}`);
}

/** A copy of a settings patch that holds only `Settings` keys, each with a value of its JSON type: a string, a finite number, or a `{ provider, model }` route of strings. */
function settingsPatch(value: unknown): Partial<Settings> {
  check(isRecord(value), 'settings 的 patch 必须是一个对象');
  const patch: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    check(Object.hasOwn(SETTING_SHAPES, key), `没有这个设置项：${JSON.stringify(key)}`);
    const shape = SETTING_SHAPES[key as keyof Settings];
    if (shape === 'route') {
      check(isRoute(field), `设置项 ${key} 必须是 { provider, model }，两项都是字符串`);
      patch[key] = { provider: field.provider, model: field.model };
    } else {
      check(shape === 'number' ? typeof field === 'number' && Number.isFinite(field) : typeof field === 'string', `设置项 ${key} 必须是${SHAPE_TEXT[shape]}`);
      patch[key] = field;
    }
  }
  return patch as Partial<Settings>;
}

/**
 * The request check `call` runs: the listed actions only, an `id` only where the action takes one and only as a candidate UUID, a settings
 * `patch` only with `Settings` keys of the right JSON type, and no other key anywhere. Returns a fresh copy; throws a ValidationError whose
 * message the page shows.
 */
export function parseRequest(value: unknown): OpenCodexRequest {
  check(isRecord(value), 'OpenCodex 请求必须是一个 JSON 对象');
  const { action } = value;
  check(typeof action === 'string', 'OpenCodex 请求缺少 action');
  if (BARE_ACTIONS.has(action)) {
    onlyKeys(value, ['action'], action);
    return { action } as OpenCodexRequest;
  }
  if (ID_ACTIONS.has(action)) {
    onlyKeys(value, ['action', 'id'], action);
    check(typeof value.id === 'string' && UUID.test(value.id), `${action} 需要候选 id（小写 UUID）`);
    return { action, id: value.id } as OpenCodexRequest;
  }
  if (action === 'settings') {
    onlyKeys(value, ['action', 'patch'], action);
    return { action, patch: settingsPatch(value.patch) };
  }
  throw new ValidationError(`未知的 OpenCodex 操作：${JSON.stringify(action)}`);
}

/**
 * The request codec on the wire: a plain JSON object and nothing more. The gateway turns any codec failure into a bare "failed boundary
 * validation", so the content is checked by `parseRequest` inside `call`, whose errors reach the page as they are.
 */
function requestObject(value: unknown): unknown {
  check(isRecord(value), 'OpenCodex 请求必须是一个 JSON 对象');
  return value;
}

/** The JSON form of a result (Dates become ISO strings, `undefined` fields drop out), refused above 4 MB. */
function json(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('OpenCodex 的返回值不是 JSON');
  if (text.length > MAX_PAYLOAD) throw new Error(`OpenCodex 一次返回的数据超过 4 MB（${text.length} 个字符）`);
  return JSON.parse(text);
}

/**
 * The gateway runs a strict parameter codec's `parse` on the Host before the call, and a strict result codec's `encode` on the Host after it;
 * the result's `parse` is never called by the pinned 0.2.1-alpha.2 gateway or client, so the 4 MB bound sits in `encode`.
 */
export const OPEN_CODEX_DESCRIPTOR: InvocationDescriptor = {
  id: 'dsh-opencodex#opencodex/call', service: 'opencodex', namespace: 'opencodex', method: 'call',
  invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: 'OpenCodexRequest', create: () => ({ parse: requestObject }) } }],
  result: { mode: 'strict', typeSymbol: 'OpenCodexResponse', create: () => ({ parse: json }), encode: value => json(value) },
};
export const OPEN_CODEX_REMOTE: TypertRemoteContribution = { package: 'dsh-opencodex', descriptors: [OPEN_CODEX_DESCRIPTOR] };
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap { opencodex: { call: (request: OpenCodexRequest, signal?: AbortSignal) => Promise<RemoteResult<OpenCodexResponse>> } }
  interface TypertRemoteMap { 'opencodex/call': (request: OpenCodexRequest, signal?: AbortSignal) => Promise<RemoteResult<OpenCodexResponse>> }
}
