/**
 * What the page gets from the plugin entry besides the DSH controls: one call to the Host and the switch to a session. Requests and
 * answers are the Host's own types (`../host/remote.ts`), taken as types only so the bundle carries no Host code; the names below are the
 * parts of an answer the page passes around on their own.
 */
import type { OpenCodexRequest, OpenCodexResponse } from '../host/remote.js';

/** One request to the Host: the answer, or an error whose message the page shows. */
export type Call = (request: OpenCodexRequest, signal?: AbortSignal) => Promise<OpenCodexResponse>;
/** Shows a session in the DSH workspace. */
export type OpenSession = (sessionId: string) => void;

/** `models`: DSH's providers, each with its models; a provider whose list could not be read has none, and the answer's `notice` says why. */
export type ModelCatalog = NonNullable<OpenCodexResponse['models']>;
/** `brief`: the task instructions a start sends unless the page edits them, and what goes with them. */
export type Brief = NonNullable<OpenCodexResponse['brief']>;
/** `readReport`: the report, or empty text and a `notice` saying why there is none to show. */
export type ReportText = NonNullable<OpenCodexResponse['report']>;
