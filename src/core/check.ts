export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ValidationError(message);
}
/** A JSON object: neither null nor an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
