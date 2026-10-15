import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Evidence } from '../../core/candidate.js';
import { writeJsonAtomic, type CandidateStore } from '../../core/store.js';
import { listAsar, readAsarEntry } from './asar.js';
import { readBundleVersion, type PlutilRunner } from './plist.js';

export interface DesktopManifest {
  version: string; entries: string[]; keys: string[]; strings: string[];
  /** Key to message from the locale bundle that supplied `keys`. `snapshotDesktop` fills it; it is not written to the snapshot files. */
  messages?: ReadonlyMap<string, string>;
}
/** What `snapshotDesktop` found. `localeBundle` is the archive path the keys came from; null when no bundle of the locale had a single `codex.` key. */
export interface DesktopSnapshot extends DesktopManifest { messages: ReadonlyMap<string, string>; localeBundle: string | null }
export interface DesktopDiff { addedChunks: string[]; removedChunks: string[]; addedKeys: string[]; addedStrings: string[] }
export interface DesktopCollection {
  version: string; changed: boolean; added: number;
  /** `codex.` keys in this version's own locale bundle. 0 means no bundle of the locale was found (or none had keys): report it as an error. */
  keys: number;
  /** Archive path of the bundle the keys came from; absent when `keys` is 0. */
  localeBundle?: string;
  /** More than half of the keys changed at once, which is a new bundle layout rather than that many features: the key baseline was reset and no key candidates were made. */
  keysReset?: boolean;
}

const MAX_MESSAGE = 200, MAX_SUMMARY = 1_000;
// Unrolled loops: linear time, and a backslash-escaped quote stays inside its literal.
const TEMPLATE = /`([^`\\]*(?:\\[\s\S][^`\\]*)*)`/g;
const KEY = /"(codex\.[A-Za-z0-9_.-]{3,120})"\s*:/g;
const MESSAGE = /"(codex\.[A-Za-z0-9_.-]{3,120})"\s*:\s*(?:`([^`\\]*(?:\\[\s\S][^`\\]*)*)`|"([^"\\]*(?:\\[\s\S][^"\\]*)*)")/g;

/**
 * `name-<hash>.ext` becomes `name.ext`. A hash is 8..16 alphanumerics: 12-hex and 16-hex content hashes, or base36 ones with a digit or an
 * upper-case letter in them. That keeps a plain lowercase word, such as the `-explorer` of an unhashed `file-explorer.png`, from being taken for one.
 */
export const stripHash = (path: string) => path.replace(/-(?=[0-9A-Za-z]*[0-9A-Z]|[a-f]{8,16}\.)[0-9A-Za-z]{8,16}(\.[0-9A-Za-z]+)$/, '$1');
const decodeQuoted = (raw: string): string => { try { return JSON.parse(`"${raw}"`) as string; } catch { return raw; } };

/**
 * `strings` are the template literals of 2..200 characters, `keys` the `"codex.*":` keys, `messages` the literal each key is
 * followed by. The locale bundle is one flat object literal, so a key's message is the template or double-quoted string right
 * after it (in the current bundle the one message that contains backticks is double-quoted). Keys with any other value get no message.
 */
export function extractStrings(source: string): { strings: string[]; keys: string[]; messages: Map<string, string> } {
  // Pair every backtick and filter by length afterwards. Skipping a too-short or too-long template while matching would pair
  // the closing backtick of the next template with the opening one after it, and every later "string" would be code.
  const strings = [...new Set([...source.matchAll(TEMPLATE)].map(m => m[1]!).filter(text => text.length >= 2 && text.length <= 200))];
  const keys = [...new Set([...source.matchAll(KEY)].map(m => m[1]!))].sort();
  const messages = new Map<string, string>();
  for (const m of source.matchAll(MESSAGE)) {
    const text = m[2] ?? decodeQuoted(m[3]!);
    if (text) messages.set(m[1]!, text);
  }
  return { strings, keys, messages };
}

export function diffManifests(previous: DesktopManifest, current: DesktopManifest): DesktopDiff {
  const prevChunks = new Set(previous.entries.map(stripHash)), currChunks = new Set(current.entries.map(stripHash));
  const codexChunk = (p: string) => /\/webview\/assets\/.*codex.*\.js$/i.test(p);
  const prevKeys = new Set(previous.keys), prevStrings = new Set(previous.strings);
  return {
    addedChunks: [...currChunks].filter(p => !prevChunks.has(p) && codexChunk(p)).sort(),
    removedChunks: [...prevChunks].filter(p => !currChunks.has(p) && codexChunk(p)).sort(),
    addedKeys: current.keys.filter(k => !prevKeys.has(k)),
    addedStrings: current.strings.filter(s => !prevStrings.has(s)),
  };
}

export const versionLabel = ({ version, build }: { version: string; build: string }) => `${version} (${build})`;

/**
 * `/webview/assets/<locale>-<hash>.js` with an 8..16 character alphanumeric hash; the locale is compared as text, never built into a pattern.
 * A false match costs one extra read, a missed one loses the locale, so this stays wide and the key count decides which sibling is used.
 */
function isLocaleBundle(path: string, locale: string): boolean {
  const prefix = `/webview/assets/${locale}-`;
  return path.startsWith(prefix) && /^[0-9a-z]{8,16}\.js$/i.test(path.slice(prefix.length));
}
const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Reads the archive once; call only after the plist version changed. `run` replaces the plutil process, for tests off macOS. */
export async function snapshotDesktop(plistPath: string, locale: string, run?: PlutilRunner, signal?: AbortSignal): Promise<DesktopSnapshot> {
  signal?.throwIfAborted();
  const label = versionLabel(await readBundleVersion(plistPath, run, signal));
  signal?.throwIfAborted();
  // plistPath is <App>.app/Contents/Info.plist; the archive sits next to it in Contents/Resources.
  const asar = join(dirname(plistPath), 'Resources', 'app.asar');
  const listed = await listAsar(asar);
  // Some locales ship a second chunk under the same name pattern that has no Codex keys, and the header lists chunks by name, so either
  // one can come first. Read them all and keep the one with the most keys; on a tie the lower path wins, so the header order never matters.
  let best: ({ path: string } & ReturnType<typeof extractStrings>) | undefined;
  for (const entry of listed.filter(e => isLocaleBundle(e.path, locale)).sort(byPath)) {
    signal?.throwIfAborted();
    const found = extractStrings((await readAsarEntry(asar, entry)).toString('utf8'));
    if (found.keys.length > (best?.keys.length ?? 0)) best = { path: entry.path, ...found };
  }
  signal?.throwIfAborted();
  // An update swaps Info.plist and app.asar one after the other. A label that moved while we read means the two may not belong
  // together, and recording them as one version would hide that release's whole diff, so fail and let the next run retry.
  if (versionLabel(await readBundleVersion(plistPath, run, signal)) !== label) throw new Error('ChatGPT.app changed while it was being read');
  return {
    version: label, entries: listed.map(e => e.path).sort(), keys: best?.keys ?? [], strings: best?.strings ?? [],
    messages: best?.messages ?? new Map<string, string>(), localeBundle: best?.path ?? null,
  };
}

const snapshotPath = (snapshotDir: string, label: string) => join(snapshotDir, 'desktop', label.replace(/[^\w.()-]/g, '_'));
const keyGroup = (key: string) => key.split('.').slice(0, 3).join('.');
const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
const isTexts = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/** `strings.json`. `locale` is what the snapshot was taken for, and it answers for that locale only. `localeBundle` null marks keys carried over from an earlier version because this one had none. */
interface StoredStrings { version: string; locale: string; keys: string[]; strings: string[]; localeBundle: string | null }
type StoredSnapshot = StoredStrings & { entries: string[] };

/** The parsed file, or undefined when it is missing or not JSON; other failures (permissions, I/O) still throw. */
async function readJsonFile(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
/** A missing, unparsable or misshapen file reads as undefined, so one bad file re-baselines instead of failing every later run. */
async function readStrings(dir: string): Promise<StoredStrings | undefined> {
  const { version, locale, keys, strings, localeBundle } = asRecord(await readJsonFile(join(dir, 'strings.json')));
  if (typeof version !== 'string' || typeof locale !== 'string' || !isTexts(keys) || !isTexts(strings) || !(localeBundle === null || typeof localeBundle === 'string')) return undefined;
  return { version, locale, keys, strings, localeBundle };
}
async function readSnapshot(dir: string): Promise<StoredSnapshot | undefined> {
  const stored = await readStrings(dir);
  const { version, entries } = asRecord(await readJsonFile(join(dir, 'manifest.json')));
  return stored && typeof version === 'string' && isTexts(entries) ? { ...stored, version, entries } : undefined;
}

const collator = new Intl.Collator('en', { numeric: true });
const buildOf = (label: string) => /\((\d+)\)$/.exec(label)?.[1];
/** Whether `label` names an older build than `than`: by build number when both have one, otherwise by natural-order text. */
function isOlderBuild(label: string, than: string): boolean {
  const a = buildOf(label), b = buildOf(than);
  return a !== undefined && b !== undefined ? BigInt(a) < BigInt(b) : collator.compare(label, than) < 0;
}

/** The part of the result that tells whether the locale bundle was found: its key count and path, or 0 and nothing. */
const bundleReport = (snapshot: { keys: string[]; localeBundle: string | null }): { keys: number; localeBundle?: string } =>
  snapshot.localeBundle === null ? { keys: 0 } : { keys: snapshot.keys.length, localeBundle: snapshot.localeBundle };

function clip(text: string): string {
  const flat = [...text.replace(/\s+/g, ' ').trim()];
  return flat.length > MAX_MESSAGE ? `${flat.slice(0, MAX_MESSAGE - 1).join('')}…` : flat.join('');
}
/** Whole lines up to MAX_SUMMARY characters, then a "…另有 N 项" tail for the rest; the tail counts against the limit. */
function clipLines(lines: string[]): string {
  const whole = lines.join('\n');
  if (whole.length <= MAX_SUMMARY) return whole;
  const tail = (left: number) => `…另有 ${left} 项`;
  let used = 0, kept = 0;
  for (const line of lines) {
    const next = used + (kept > 0 ? 1 : 0) + line.length;
    // Keep a line only if it still fits together with the tail for everything after it.
    if (next + 1 + tail(lines.length - kept - 1).length > MAX_SUMMARY) break;
    used = next; kept++;
  }
  return [...lines.slice(0, kept), tail(lines.length - kept)].join('\n');
}

export async function collectDesktop(store: CandidateStore, snapshotDir: string, plistPath: string, locale: string, run?: PlutilRunner, signal?: AbortSignal): Promise<DesktopCollection> {
  signal?.throwIfAborted();
  // No ChatGPT.app on this machine: nothing to report. Any other failure to look is a real error.
  if (!await exists(plistPath)) return { version: '', changed: false, added: 0, keys: 0 };
  const last = await store.checkpoint('lastDesktopVersion');
  const label = versionLabel(await readBundleVersion(plistPath, run, signal));
  signal?.throwIfAborted();
  if (last === label) {
    // The plist read is cheap and the archive stays closed while the version is unchanged: the stored snapshot says what this locale yielded.
    const stored = await readStrings(snapshotPath(snapshotDir, last));
    if (stored?.locale === locale) return { version: last, changed: false, added: 0, ...bundleReport(stored) };
    // The snapshot is gone, damaged, or was taken for another locale: take it again below.
  }
  const current = await snapshotDesktop(plistPath, locale, run, signal);
  signal?.throwIfAborted();
  // `last` names the previous snapshot directory. Without a readable one this is a first run: baseline only. A build older than
  // the checkpoint is a downgrade, where everything the newer one dropped would look new, so there is no base then either.
  const previous = last ? await readSnapshot(snapshotPath(snapshotDir, last)) : undefined;
  const base = last && previous && !isOlderBuild(current.version, last) ? previous : undefined;
  // Keys only compare within one locale.
  const keyBase = base?.locale === locale ? base.keys : [];
  const dir = snapshotPath(snapshotDir, current.version);
  await writeJsonAtomic(join(dir, 'manifest.json'), { version: current.version, entries: current.entries });
  signal?.throwIfAborted();
  // A version without keys hands the last non-empty list on as the base for the next diff; `localeBundle: null` marks it as carried over.
  await writeJsonAtomic(join(dir, 'strings.json'), {
    version: current.version, locale, keys: current.keys.length > 0 ? current.keys : keyBase, strings: current.strings, localeBundle: current.localeBundle,
  });
  signal?.throwIfAborted();
  let added = 0, keysReset = false;
  if (last && base) {
    const diff = diffManifests({ ...base, keys: keyBase }, current);
    for (const chunk of diff.addedChunks) {
      signal?.throwIfAborted();
      // `ref` is the stable hash-free name; the excerpt names the real archive path(s) of this version, so nothing has to be re-matched.
      const realPaths = current.entries.filter(path => stripHash(path) === chunk);
      const { created } = await store.upsert({
        source: 'desktop', key: `chunk:${chunk}:${current.version}`, title: `桌面端新模块 ${chunk.split('/').at(-1)}`,
        summary: `ChatGPT.app ${last} → ${current.version} 新增前端模块。`, evidence: [{ kind: 'chunk', ref: chunk, excerpt: realPaths.join('\n') }], window: { version: current.version },
      });
      if (created) added++;
    }
    // Without a base key list every key would look new, and a list that turns over by more than half is a new bundle layout, not that many features.
    keysReset = keyBase.length > 0 && diff.addedKeys.length * 2 > keyBase.length;
    const groups = new Map<string, string[]>();
    for (const key of keyBase.length > 0 && !keysReset ? diff.addedKeys : []) {
      const group = keyGroup(key), members = groups.get(group);
      if (members) members.push(key); else groups.set(group, [key]);
    }
    for (const [group, keys] of groups) {
      signal?.throwIfAborted();
      const evidence = keys.map((key): Evidence => {
        const text = current.messages.get(key);
        return text ? { kind: 'i18n', ref: key, excerpt: clip(text) } : { kind: 'i18n', ref: key };
      });
      const { created } = await store.upsert({
        source: 'desktop', key: `i18n:${group}:${current.version}`, title: `桌面端新文案组 ${group}`,
        summary: clipLines(evidence.map(e => e.excerpt ? `${e.ref}: ${e.excerpt}` : e.ref)), evidence, window: { version: current.version },
      });
      if (created) added++;
    }
  }
  signal?.throwIfAborted();
  await store.setCheckpoint('lastDesktopVersion', current.version);
  return { version: current.version, changed: true, added, ...bundleReport(current), ...(keysReset ? { keysReset: true as const } : {}) };
}
