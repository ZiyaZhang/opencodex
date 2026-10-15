import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Evidence } from '../../core/candidate.js';
import { writeJsonAtomic, type CandidateStore } from '../../core/store.js';
import { listAsar, readAsarEntry } from './asar.js';
import { readBundleVersion, type PlutilRunner } from './plist.js';

export interface DesktopManifest {
  version: string; entries: string[]; keys: string[]; strings: string[];
  /** Key to message from the current locale bundle. `snapshotDesktop` fills it; it is not written to the snapshot files. */
  messages?: ReadonlyMap<string, string>;
}
export interface DesktopDiff { addedChunks: string[]; removedChunks: string[]; addedKeys: string[]; addedStrings: string[] }

const MAX_MESSAGE = 200, MAX_SUMMARY = 1_000;
// Unrolled loops: linear time, and a backslash-escaped quote stays inside its literal.
const TEMPLATE = /`([^`\\]*(?:\\[\s\S][^`\\]*)*)`/g;
const KEY = /"(codex\.[A-Za-z0-9_.-]{3,120})"\s*:/g;
const MESSAGE = /"(codex\.[A-Za-z0-9_.-]{3,120})"\s*:\s*(?:`([^`\\]*(?:\\[\s\S][^`\\]*)*)`|"([^"\\]*(?:\\[\s\S][^"\\]*)*)")/g;

export const stripHash = (path: string) => path.replace(/-[0-9a-f]{12}(\.[a-z0-9]+)$/i, '$1');
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

/** The locale bundle is `/webview/assets/<locale>-<12 hex>.js`; the locale is compared as text, never built into a pattern. */
function isLocaleBundle(path: string, locale: string): boolean {
  const prefix = `/webview/assets/${locale}-`;
  return path.startsWith(prefix) && /^[0-9a-f]{12}\.js$/.test(path.slice(prefix.length));
}

/** Reads the archive once; call only after the plist version changed. `run` replaces the plutil process, for tests off macOS. */
export async function snapshotDesktop(plistPath: string, locale: string, run?: PlutilRunner): Promise<DesktopManifest> {
  const label = versionLabel(await readBundleVersion(plistPath, run));
  // plistPath is <App>.app/Contents/Info.plist; the archive sits next to it in Contents/Resources.
  const asar = join(dirname(plistPath), 'Resources', 'app.asar');
  const listed = await listAsar(asar);
  const localeEntry = listed.find(e => isLocaleBundle(e.path, locale));
  const { strings, keys, messages } = localeEntry
    ? extractStrings((await readAsarEntry(asar, localeEntry)).toString('utf8'))
    : { strings: [], keys: [], messages: new Map<string, string>() };
  // An update swaps Info.plist and app.asar one after the other. A label that moved while we read means the two may not belong
  // together, and recording them as one version would hide that release's whole diff, so fail and let the next run retry.
  if (versionLabel(await readBundleVersion(plistPath, run)) !== label) throw new Error('ChatGPT.app changed while it was being read');
  return { version: label, entries: listed.map(e => e.path).sort(), keys, strings, messages };
}

const snapshotPath = (snapshotDir: string, label: string) => join(snapshotDir, 'desktop', label.replace(/[^\w.()-]/g, '_'));
const keyGroup = (key: string) => key.split('.').slice(0, 3).join('.');
const asRecord = (value: unknown) => (typeof value === 'object' && value !== null ? value : {}) as Partial<DesktopManifest>;

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/** A missing, unparsable or misshapen snapshot reads as undefined, so one bad file re-baselines instead of failing every later run. */
async function readSnapshot(dir: string): Promise<DesktopManifest | undefined> {
  try {
    const { version, entries } = asRecord(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));
    const { keys, strings } = asRecord(JSON.parse(await readFile(join(dir, 'strings.json'), 'utf8')));
    if (typeof version !== 'string' || !Array.isArray(entries) || !Array.isArray(keys) || !Array.isArray(strings)) return undefined;
    return { version, entries, keys, strings };
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function clip(text: string): string {
  const flat = [...text.replace(/\s+/g, ' ').trim()];
  return flat.length > MAX_MESSAGE ? `${flat.slice(0, MAX_MESSAGE - 1).join('')}…` : flat.join('');
}
/** Whole lines up to MAX_SUMMARY characters, then a count of what was left out. */
function clipLines(lines: string[]): string {
  let used = 0, kept = 0;
  for (const line of lines) { if (used + line.length + 1 > MAX_SUMMARY) break; used += line.length + 1; kept++; }
  return kept === lines.length ? lines.join('\n') : `${lines.slice(0, kept).join('\n')}\n…另有 ${lines.length - kept} 项`;
}

export async function collectDesktop(store: CandidateStore, snapshotDir: string, plistPath: string, locale: string, run?: PlutilRunner): Promise<{ version: string; changed: boolean; added: number }> {
  // No ChatGPT.app on this machine: nothing to report. Any other failure to look is a real error.
  if (!await exists(plistPath)) return { version: '', changed: false, added: 0 };
  const last = await store.checkpoint('lastDesktopVersion');
  // The plist read is cheap; the archive is not opened at all while the version is unchanged.
  if (last === versionLabel(await readBundleVersion(plistPath, run))) return { version: last, changed: false, added: 0 };
  const current = await snapshotDesktop(plistPath, locale, run);
  // `last` names the previous snapshot directory. Without a readable one this is a first run: baseline only.
  const previous = last ? await readSnapshot(snapshotPath(snapshotDir, last)) : undefined;
  const dir = snapshotPath(snapshotDir, current.version);
  await writeJsonAtomic(join(dir, 'manifest.json'), { version: current.version, entries: current.entries });
  await writeJsonAtomic(join(dir, 'strings.json'), { version: current.version, keys: current.keys, strings: current.strings });
  let added = 0;
  if (last && previous) {
    const diff = diffManifests(previous, current);
    for (const chunk of diff.addedChunks) {
      const { created } = await store.upsert({
        source: 'desktop', key: `chunk:${chunk}:${current.version}`, title: `桌面端新模块 ${chunk.split('/').at(-1)}`,
        summary: `ChatGPT.app ${last} → ${current.version} 新增前端模块。`, evidence: [{ kind: 'chunk', ref: chunk }], window: { version: current.version },
      });
      if (created) added++;
    }
    // A previous snapshot without keys (no locale bundle then) gives no baseline: every key would look new.
    const groups = new Map<string, string[]>();
    for (const key of previous.keys.length > 0 ? diff.addedKeys : []) {
      const group = keyGroup(key), members = groups.get(group);
      if (members) members.push(key); else groups.set(group, [key]);
    }
    for (const [group, keys] of groups) {
      const evidence = keys.map((key): Evidence => {
        const text = current.messages?.get(key);
        return text ? { kind: 'i18n', ref: key, excerpt: clip(text) } : { kind: 'i18n', ref: key };
      });
      const { created } = await store.upsert({
        source: 'desktop', key: `i18n:${group}:${current.version}`, title: `桌面端新文案组 ${group}`,
        summary: clipLines(evidence.map(e => e.excerpt ? `${e.ref}: ${e.excerpt}` : e.ref)), evidence, window: { version: current.version },
      });
      if (created) added++;
    }
  }
  await store.setCheckpoint('lastDesktopVersion', current.version);
  return { version: current.version, changed: true, added };
}
