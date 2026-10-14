/** Model-free inspection of one explicitly selected metadata file; never searches for or executes an application. */
import { constants, watch, type FSWatcher } from 'node:fs';
import { mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { CandidateInput } from '../core/types.js';
import type { ScanResult } from './discovery.js';

export const LOCAL_VERSION_MAX_BYTES = 1_048_576;
export const LOCAL_VERSION_STATE_FILE = 'local-version.json';
const REFERENCE_URL = 'https://learn.chatgpt.com/docs/changelog';
interface Version { version?: string; build?: string }
interface Observation extends Version { schemaVersion: 1; targetKey: string; checkedAt: string }
export interface LocalVersionScanResult extends ScanResult, Version { candidateId?: string; fingerprint?: string }
export interface LocalVersionStore { saveCandidate(input: CandidateInput): Promise<{ id: string }> }
export interface LocalVersionWatchOptions { debounceMs?: number; onError?: (error: Error) => void }
const scanQueues = new Map<string, Promise<unknown>>();

function pathFor(input: string): string {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0')) throw new Error('Select an absolute local version file path');
  const path = resolve(input);
  if (!['.json', '.plist'].includes(extname(path).toLowerCase())) throw new Error('Select a package.json or XML plist version file');
  return path;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function value(input: unknown, field: string): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'string' && !(typeof input === 'number' && Number.isSafeInteger(input) && input >= 0)) throw new Error(`${field} must be nonempty text or a nonnegative integer`);
  const output = String(input).trim();
  if (!output || output.length > 128 || /[\u0000-\u001f\u007f]/.test(output)) throw new Error(`${field} must be short, single-line text`);
  return output;
}
function decodeXml(text: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(text)) throw new Error('Unsupported XML entity in version metadata');
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_whole, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (named[entity] !== undefined) return named[entity];
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error('Invalid XML character reference');
    return String.fromCodePoint(code);
  });
}
/** Small non-executing XML plist reader. Only direct root-dictionary version keys are collected. */
function parsePlist(text: string): Version {
  if (/<!ENTITY|<!\[CDATA\[/i.test(text)) throw new Error('Entity declarations and CDATA are not supported in version metadata');
  const tokens = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE\s+plist\b[^>]*>|<\/?[A-Za-z][^>]*>|[^<]+/g;
  const stack: string[] = [];
  const fields: Record<string, string> = {};
  const watched = new Set(['CFBundleShortVersionString', 'CFBundleVersion']);
  let end = 0, rootClosed = false, seenRoot = false, seenDictionary = false;
  let pendingKey: string | undefined;
  let capture: { tag: string; text: string } | undefined;
  for (const token of text.matchAll(tokens)) {
    if (token.index !== end) throw new Error('Malformed XML version metadata');
    const item = token[0]; end += item.length;
    if (item.startsWith('<?') || item.startsWith('<!--')) continue;
    if (item.startsWith('<!DOCTYPE')) {
      if (seenRoot || item.includes('[')) throw new Error('Unsupported plist document declaration');
      continue;
    }
    if (!item.startsWith('<')) {
      if (capture) capture.text += item;
      else if (item.trim() && !(stack.length >= 3 && ['key', 'string', 'integer', 'real', 'date', 'data'].includes(stack.at(-1)!))) throw new Error('Unexpected text in XML version metadata');
      continue;
    }
    const tag = /^<(\/?)([A-Za-z][\w.-]*)(?:\s+[^<>]*?)?\s*(\/?)>$/.exec(item);
    if (!tag) throw new Error('Malformed XML element');
    const closing = tag[1] === '/', name = tag[2]!, selfClosing = tag[3] === '/' || /\/>$/.test(item);
    if (closing) {
      if (stack.at(-1) !== name) throw new Error('Unbalanced XML version metadata');
      if (capture && stack.length === 3 && capture.tag === name) {
        const content = decodeXml(capture.text);
        if (name === 'key') pendingKey = content.trim();
        else if (pendingKey && watched.has(pendingKey)) {
          if (Object.hasOwn(fields, pendingKey)) throw new Error('Duplicate plist version field');
          fields[pendingKey] = content; pendingKey = undefined;
        } else pendingKey = undefined;
        capture = undefined;
      }
      stack.pop();
      if (name === 'plist') rootClosed = true;
      continue;
    }
    if (!stack.length) {
      if (seenRoot || rootClosed || name !== 'plist' || selfClosing) throw new Error('Expected one XML plist root');
      seenRoot = true;
    } else if (stack.length === 1) {
      if (seenDictionary || name !== 'dict' || selfClosing) throw new Error('Expected one plist root dictionary');
      seenDictionary = true;
    }
    if (capture) throw new Error('Nested content in a plist version value');
    if (stack.length === 2) {
      if (name === 'key') {
        if (pendingKey && watched.has(pendingKey)) throw new Error('Missing plist version value');
        capture = { tag: name, text: '' };
      } else {
        if (pendingKey && watched.has(pendingKey) && !['string', 'integer'].includes(name)) throw new Error('Plist version value must be a string or integer');
        if (['string', 'integer'].includes(name)) capture = { tag: name, text: '' };
        else pendingKey = undefined;
      }
    }
    // Text in non-version nested scalar values is ignored, without collecting nested keys.
    if (!selfClosing) stack.push(name);
    else if (capture) {
      if (name === 'key') pendingKey = '';
      else if (pendingKey && watched.has(pendingKey)) throw new Error('Empty plist version value');
      else pendingKey = undefined;
      capture = undefined;
    }
  }
  if (end !== text.length || !seenRoot || !rootClosed || stack.length || capture || (pendingKey && watched.has(pendingKey))) throw new Error('Incomplete XML version metadata');
  return { version: value(fields.CFBundleShortVersionString, 'version'), build: value(fields.CFBundleVersion, 'build') };
}

export function parseLocalVersion(text: string, format: 'json' | 'plist'): Version {
  let result: Version;
  if (format === 'json') {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON metadata object');
    const data = parsed as Record<string, unknown>;
    result = { version: value(data.version, 'version'), build: value(data.build, 'build') };
  } else result = parsePlist(text.replace(/^\uFEFF/, ''));
  if (!result.version && !result.build) throw new Error('No version or build field found in selected metadata');
  return result;
}

async function boundedRead(path: string, maximum: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Selected version metadata must be a regular file');
    if (before.size > maximum) throw new Error('Version metadata exceeds the 1 MiB read limit');
    const buffer = Buffer.alloc(maximum + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      signal.throwIfAborted();
      const chunk = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (!chunk.bytesRead) break;
      bytes += chunk.bytesRead;
    }
    signal.throwIfAborted();
    if (bytes > maximum) throw new Error('Version metadata exceeds the read limit');
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Version metadata changed during the read; retry after the update finishes');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
  } finally { await handle.close(); }
}
function label(version: Version): string { return version.version ? `${version.version}${version.build ? ` (${version.build})` : ''}` : `build ${version.build}`; }
function safeError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  if (code === 'ENOENT') return 'Selected version metadata is temporarily missing; the previous baseline is retained';
  if (code) return `Local version metadata operation failed (${code}); the previous baseline is retained`;
  // JSON parser messages can include arbitrary file contents; never echo them.
  if (error instanceof SyntaxError) return 'Selected version metadata is not valid JSON; the previous baseline is retained';
  if (error instanceof Error && (error.name === 'TypeError' || error.name === 'RangeError')) return 'Invalid local version metadata; the previous baseline is retained';
  return error instanceof Error ? error.message : 'Local version check failed';
}
async function readObservation(path: string, signal: AbortSignal): Promise<Observation | undefined> {
  let text: string;
  try { text = await boundedRead(path, 8192, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const data = JSON.parse(text) as Partial<Observation>;
  if (!data || typeof data !== 'object' || data.schemaVersion !== 1 || typeof data.targetKey !== 'string' || !/^[a-f0-9]{64}$/.test(data.targetKey) || typeof data.checkedAt !== 'string' || !Number.isFinite(Date.parse(data.checkedAt))) throw new Error('Invalid local version baseline; repair the saved checkpoint before scanning');
  const version = value(data.version, 'saved version'), build = value(data.build, 'saved build');
  if (!version && !build) throw new Error('Saved local version baseline contains no version');
  return { schemaVersion: 1, targetKey: data.targetKey, checkedAt: data.checkedAt, ...(version ? { version } : {}), ...(build ? { build } : {}) };
}
async function scan(directory: string, store: LocalVersionStore, options: { path: string }, signal: AbortSignal): Promise<LocalVersionScanResult> {
  const result: LocalVersionScanResult = { baseline: 0, unchanged: 0, changed: 0, errors: [] };
  try {
    signal.throwIfAborted();
    const selected = pathFor(options.path);
    const checkpoint = join(resolve(directory), LOCAL_VERSION_STATE_FILE);
    if (selected === checkpoint) throw new Error('The selected metadata file cannot be the OpenCodex version checkpoint');
    const selectedCanonical = await realpath(selected);
    const checkpointCanonical = await realpath(checkpoint).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return checkpoint;
      throw error;
    });
    if (selectedCanonical === checkpointCanonical) throw new Error('The selected metadata file cannot be the OpenCodex version checkpoint');
    const previous = await readObservation(checkpoint, signal);
    const current = parseLocalVersion(await boundedRead(selected, LOCAL_VERSION_MAX_BYTES, signal), extname(selected).toLowerCase() === '.json' ? 'json' : 'plist');
    const targetKey = hash(selected);
    const observation: Observation = { schemaVersion: 1, targetKey, checkedAt: new Date().toISOString(), ...current };
    const identity = JSON.stringify([current.version ?? null, current.build ?? null]);
    result.version = current.version; result.build = current.build;
    if (!previous || previous.targetKey !== targetKey) result.baseline = 1;
    else if (previous.version === current.version && previous.build === current.build) { result.unchanged = 1; return result; }
    else {
      signal.throwIfAborted();
      const fingerprint = `codex-local-version:${targetKey}:${hash(identity)}`;
      const candidate = await store.saveCandidate({
        title: `Codex local version ${label(previous)} → ${label(current)}`,
        description: `Source: user-selected local version metadata. Version/build changed from ${label(previous)} to ${label(current)}. This is a local update signal, not proof of a new product feature or successful runtime test. The attached public link is a documentation reference only; the selected local path is not included.`,
        sourceUrl: REFERENCE_URL, sourceType: 'local-version', version: label(current), fingerprint,
      });
      result.changed = 1; result.candidateId = candidate.id; result.fingerprint = fingerprint;
    }
    signal.throwIfAborted();
    await mkdir(resolve(directory), { recursive: true, mode: 0o700 });
    const temporary = `${checkpoint}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(observation, null, 2) + '\n', { mode: 0o600, flag: 'wx', signal });
      signal.throwIfAborted();
      await rename(temporary, checkpoint);
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  } catch (error) { signal.throwIfAborted(); result.errors.push(safeError(error)); }
  return result;
}
/** Serializes watcher/poll scans. The first successful observation establishes a baseline without creating a candidate. */
export async function scanLocalVersion(directory: string, store: LocalVersionStore, options: { path: string }, signal: AbortSignal): Promise<LocalVersionScanResult> {
  signal.throwIfAborted();
  const key = resolve(directory);
  const task = (scanQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => scan(directory, store, options, signal));
  scanQueues.set(key, task);
  try { return await task; }
  finally { if (scanQueues.get(key) === task) scanQueues.delete(key); }
}

/** Observe the selected file's parent so atomic file replacement still emits an event. Polling/restart catch-up uses scanLocalVersion. */
export function watchLocalVersion(file: string, onChange: () => void | Promise<void>, options: LocalVersionWatchOptions = {}): () => void {
  const path = pathFor(file);
  const debounceMs = options.debounceMs ?? 250;
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 0 || debounceMs > 60_000) throw new Error('debounceMs must be an integer from 0 to 60000');
  let watcher: FSWatcher | undefined, timer: ReturnType<typeof setTimeout> | undefined, closed = false;
  const report = (error: unknown) => { if (!closed) options.onError?.(new Error(safeError(error))); };
  try {
    watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
      if (closed || (filename !== null && filename.toString() !== basename(path))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (!closed) void Promise.resolve().then(() => { if (!closed) return onChange(); }).catch(report);
      }, debounceMs);
      timer.unref();
    });
    watcher.on('error', report);
  } catch (error) { throw new Error(safeError(error)); }
  return () => { closed = true; if (timer) clearTimeout(timer); watcher?.close(); };
}
