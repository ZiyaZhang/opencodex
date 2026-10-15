export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ValidationError(message);
}
export function textValue(value: unknown, label: string, allowEmpty = false): asserts value is string {
  check(typeof value === 'string' && value.length <= 100_000 && (allowEmpty || value.trim().length > 0), `${label} must be a nonempty string`);
}
export function count(value: unknown, label: string, minimum = 0): asserts value is number {
  check(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum, `${label} must be an integer >= ${minimum}`);
}
export function isoDate(value: unknown, label: string): asserts value is string {
  textValue(value, label);
  check(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, `${label} must be an ISO timestamp`);
}
export function webUrl(value: unknown, label: string): asserts value is string {
  textValue(value, label);
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationError(`${label} must be an absolute HTTP(S) URL`); }
  check(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, `${label} must be a credential-free HTTP(S) URL`);
}
export function relativePath(value: unknown, label = 'path'): asserts value is string {
  textValue(value, label);
  check(!value.includes('\0') && !value.includes('\\') && !value.startsWith('/') && !/^[a-zA-Z]:/.test(value), `${label} must be relative to the artifact root`);
  check(value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'), `${label} contains an unsafe path segment`);
}
