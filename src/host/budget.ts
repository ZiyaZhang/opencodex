/** Conservative request reservation and authoritative DSH usage accounting. */
import type { GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm';

/** UTF-8 bytes deliberately overestimate common text tokenizers; images need a separate allowance. */
export function estimateRequestTokens(options: GenerateOptions): number {
  const bytes = Buffer.byteLength(JSON.stringify({ messages: options.messages, system: options.system, tools: options.tools, toolHistory: options.toolHistory }), 'utf8');
  const imageAllowance = (JSON.stringify(options.messages).match(/"type":"(?:image|file)"/g)?.length ?? 0) * 16_384;
  return bytes + imageAllowance + 1_024;
}
/** DSH counters are disjoint, so cached input is part of the budget too. */
export function billableUsage(usage: TokenUsage): { inputTokens: number; outputTokens: number } {
  for (const [name, value] of Object.entries(usage)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`Invalid provider token counter: ${name}`);
  }
  const input = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const total = usage.totalTokens ?? input + usage.outputTokens;
  return { inputTokens: Math.max(input, total - usage.outputTokens), outputTokens: usage.outputTokens };
}
