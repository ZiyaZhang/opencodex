/** Conservative request reservation and authoritative DSH usage accounting. */
import type { GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm';

/** UTF-8 bytes deliberately overestimate common text tokenizers; images need a separate allowance. */
export function estimateRequestTokens(options: GenerateOptions): number {
  const bytes = Buffer.byteLength(JSON.stringify({ messages: options.messages, system: options.system, tools: options.tools, toolHistory: options.toolHistory }), 'utf8');
  const imageAllowance = (JSON.stringify(options.messages).match(/"type":"(?:image|file)"/g)?.length ?? 0) * 16_384;
  return bytes + imageAllowance + 1_024;
}

export interface RequestShape { route: string; parts: string[]; messages: string[]; upper: number }
export interface BudgetCalibration { shape: RequestShape; inputTokens: number }
export function requestShape(options: GenerateOptions): RequestShape {
  return { route: JSON.stringify([options.provider, options.model]), parts: [options.system, options.tools, options.toolHistory].map(value => JSON.stringify(value) ?? ''), messages: options.messages.map(message => JSON.stringify(message)), upper: estimateRequestTokens(options) };
}
/** Reuse observed input only for the same route. Changed text is still priced at one token per byte. */
export function calibratedRequestTokens(shape: RequestShape, previous?: BudgetCalibration): number {
  if (!previous || previous.shape.route !== shape.route || !Number.isSafeInteger(previous.inputTokens) || previous.inputTokens < 0) return shape.upper;
  const changedBytes = (parts: string[], prior: string[]) => parts.reduce((sum, text, index) => sum + (text === prior[index] ? 0 : Buffer.byteLength(text, 'utf8') + (text.match(/"type":"(?:image|file)"/g)?.length ?? 0) * 16_384), 0);
  // Removed content receives no credit. A 25% margin and fixed framing reserve cover wire variance.
  return Math.min(shape.upper, Math.ceil(previous.inputTokens * 1.25) + changedBytes(shape.parts, previous.shape.parts) + changedBytes(shape.messages, previous.shape.messages) + 1_024);
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
