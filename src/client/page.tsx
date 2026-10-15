import type { OpenCodexRequest, OpenCodexResponse } from '../host/remote.js';

type Call = (request: OpenCodexRequest, signal?: AbortSignal) => Promise<OpenCodexResponse>;
type OpenPlugin = (packageName: string) => void;

/** Placeholder shell. The v1 page (tabs, lists, settings form) is recovered from git history when the real page lands. */
export function OpenCodexPage(_props: { call: Call; openPlugin?: OpenPlugin }) {
  return <div className="oc-page">OpenCodex v2</div>;
}
