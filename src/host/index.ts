import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { OPEN_CODEX_DESCRIPTOR, type OpenCodexRequest, type OpenCodexResponse } from './remote.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

export interface Config { dataDirectory?: string }
declare module '@deepseek-ai/cordis' { interface Context { opencodex: OpenCodex } }

export default class OpenCodex extends TypertRemoteService {
  static inject = ['typert'];
  constructor(ctx: Context, public config: Config = {}) {
    super(ctx, 'opencodex', { namespace: 'opencodex' });
    ctx.typert.register({ package: 'dsh-opencodex', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: [OPEN_CODEX_DESCRIPTOR] });
  }
  async call(request: OpenCodexRequest, signal: AbortSignal): Promise<OpenCodexResponse> {
    signal.throwIfAborted();
    if (request.action !== 'snapshot') throw new Error('Unknown OpenCodex request');
    return { version };
  }
}
