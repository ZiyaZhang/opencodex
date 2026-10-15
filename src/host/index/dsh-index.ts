import { execFile } from 'node:child_process';
import type { Dirent, Stats } from 'node:fs';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, posix, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { check } from '../../core/check.js';

const execFileAsync = promisify(execFile);

/**
 * One searchable item of the mirror. `(kind, id)` identifies it within an index: a package's id is its directory
 * (`packages/<group>/<name>`), a config entry's the `@scope/name` of its catalog section, a note's its relative path.
 * `path` is where to read it, relative to the mirror root with `/` separators; every config entry lives in
 * `docs/config-catalog.md`, so `path` alone is not a key.
 */
export interface IndexEntry { kind: 'package' | 'config' | 'note' | 'doc'; id: string; title: string; path: string; text: string }
/** `version` is the shape of the index (see `isDshIndex`); `mirror` is the path it was built from, exactly as given. */
export interface DshIndex { version: 1; builtAt: string; commit: string; mirror: string; entries: IndexEntry[] }

const SUMMARY_LIMIT = 1_200;
const TEXT_LIMIT = 1_500;
const NOTE_STATUSES = ['implemented', 'proposed'];
const TITLE_WEIGHT = 3;
const TEXT_WEIGHT = 1;
/** Every note title opens with this; left in, it would make `agent` and `note` match all of them. */
const NOTE_PREFIX = /^Agent Note:\s*/i;
const CATALOG_PATH = 'docs/config-catalog.md';
const PACKAGE_NAME = /^@[\w.-]+\/[\w.-]+$/;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');

async function readText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); } catch (error) { if (isMissing(error)) return undefined; throw error; }
}
async function listDirectory(dir: string): Promise<Dirent[]> {
  try { return await readdir(dir, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return []; throw error; }
}
/** `lstat` of `root/<parts>`, or undefined when it is missing or when it or any directory on the way below `root` is a symlink. */
async function plainStat(root: string, ...parts: string[]): Promise<{ path: string; stats: Stats } | undefined> {
  let path = root;
  let stats: Stats | undefined;
  for (const part of parts) {
    path = join(path, part);
    try { stats = await lstat(path); } catch (error) { if (isMissing(error)) return undefined; throw error; }
    if (stats.isSymbolicLink()) return undefined;
  }
  return stats && { path, stats };
}

/**
 * Regular files below `dir`, at most `depth` directory levels down, in name order, so the index never depends on readdir order.
 * A missing `dir` yields nothing. Symlinks are never followed: a dangling one cannot fail the walk, and a linked directory
 * can neither loop, nor lead out of the mirror, nor list the same README twice.
 */
async function* walk(dir: string, depth: number): AsyncGenerator<string> {
  for (const entry of (await listDirectory(dir)).sort((a, b) => compare(a.name, b.name))) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { if (depth > 0) yield* walk(full, depth - 1); } else if (entry.isFile()) yield full;
  }
}

interface Heading { index: number; level: 1 | 2; title: string }
interface Markdown { lines: string[]; start: number; headings: Heading[]; description: string | undefined }
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^(#{1,2})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
/** The language switch and status lines notes and READMEs open with, before any content. */
const BOILERPLATE = /^(?:Status:.*|English \| \[.*\]\(.*\))$/;

/** The `description:` of a YAML front matter block (double-quoted as the mirror writes it, single-quoted or bare). */
function descriptionOf(frontMatter: string[]): string | undefined {
  const raw = frontMatter.find(line => line.startsWith('description:'))?.slice('description:'.length).trim();
  if (!raw) return undefined;
  if (raw.startsWith('"')) {
    try { const value: unknown = JSON.parse(raw); return typeof value === 'string' ? value : undefined; } catch { return raw.replace(/^"|"$/g, ''); }
  }
  if (raw.startsWith("'")) return raw.replace(/^'|'$/g, '').replace(/''/g, "'");
  return /^[>|][+-]?$/.test(raw) ? undefined : raw; // block scalars are not supported
}

/** Lines of a Markdown file, its level-1/2 headings and its front matter description. Front matter and fenced code (shell comments, sample READMEs) never count as headings. */
function parseMarkdown(source: string): Markdown {
  const lines = source.replace(/^\u{FEFF}/u, '').split(/\r?\n/);
  const closing = lines[0]?.trim() === '---' ? lines.findIndex((line, i) => i > 0 && line.trim() === '---') : -1;
  const start = closing + 1;
  const headings: Heading[] = [];
  let fence: string | undefined;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = FENCE.exec(line);
    if (fence) { if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined; continue; }
    if (marker) { fence = marker[1]!; continue; }
    const heading = HEADING.exec(line);
    if (heading) headings.push({ index, level: heading[1]!.length as 1 | 2, title: heading[2]!.replace(/`/g, '').trim() });
  }
  return { lines, start, headings, description: closing > 0 ? descriptionOf(lines.slice(1, closing)) : undefined };
}
const titleOf = (doc: Markdown, fallback: string) => doc.headings.find(h => h.level === 1)?.title || fallback;

/** Drops markup that renders as nothing (generated-section markers, anchors) and folds all whitespace. */
const collapse = (text: string) => text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<a id="[^"]*"><\/a>/g, ' ').replace(/\s+/g, ' ').trim();
/** Cuts to `limit` UTF-16 units without leaving half of a surrogate pair at the end. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return (/[\u{D800}-\u{DBFF}]$/u.test(cut) ? cut.slice(0, -1) : cut).trimEnd();
}
/** Lines [from, to) as one clean line of text, without the file's own title line (`title` carries it) and without the status and language lines it opens with. */
function textBetween(doc: Markdown, from: number, to: number): string {
  const title = doc.headings.find(h => h.level === 1)?.index;
  const lines = doc.lines.slice(from, to).filter((_, i) => from + i !== title);
  let lead = 0;
  while (lead < lines.length && (!lines[lead]!.trim() || BOILERPLATE.test(lines[lead]!.trim()))) lead++;
  return collapse(lines.slice(lead).join('\n'));
}
/** The front matter description followed by the `## Summary` section; a README with no (or an empty) Summary falls back to its leading text, everything before the first `##` heading. */
function packageText(doc: Markdown): string {
  const at = doc.headings.findIndex(h => h.level === 2 && /^summary$/i.test(h.title));
  const summary = at < 0 ? '' : textBetween(doc, doc.headings[at]!.index + 1, doc.headings[at + 1]?.index ?? doc.lines.length);
  const body = summary || textBetween(doc, doc.start, doc.headings.find(h => h.level === 2)?.index ?? doc.lines.length);
  const description = doc.description ? collapse(doc.description) : '';
  return clip(description && !body.includes(description) ? `${description} ${body}`.trim() : body, SUMMARY_LIMIT);
}

/** HEAD of the mirror. A folder that merely sits inside another repository is not a checkout of its own and must not report that repository's HEAD. */
async function commitOf(mirror: string): Promise<string> {
  try {
    await stat(join(mirror, '.git'));
    // Git hooks export GIT_DIR and GIT_INDEX_FILE; inherited, they would make `git -C <mirror>` answer for another repository.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    const { stdout } = await execFileAsync('git', ['-C', mirror, 'rev-parse', 'HEAD'], { env, timeout: 10_000 });
    return stdout.trim() || 'unknown';
  } catch { return 'unknown'; }
}

/**
 * Reads the official DSH mirror (read-only: nothing is ever written into it) into one flat list:
 * package README summaries, `docs/config-catalog.md` sections and `.agents/notes/{implemented,proposed}` notes.
 * `mirror` must be an existing directory; pieces missing inside it (no `packages/`, no catalog, no notes) contribute nothing,
 * and so do pieces behind a symlink. `commit` is 'unknown' unless HEAD was the same before and after the read.
 */
export async function buildDshIndex(mirror: string): Promise<DshIndex> {
  const root = await stat(mirror).catch(error => { if (isMissing(error)) return undefined; throw error; });
  check(root?.isDirectory(), `DSH mirror must be an existing directory: ${mirror}`);
  const relPath = (file: string) => relative(mirror, file).split(sep).join('/');
  const entries: IndexEntry[] = [];
  const commit = await commitOf(mirror);

  // A package is exactly packages/<group>/<name>/README.md. Group READMEs (packages/<group>/README.md) and READMEs inside a package's own tests/ or src/ are not packages.
  const packages = await plainStat(mirror, 'packages');
  if (packages?.stats.isDirectory()) {
    for await (const file of walk(packages.path, 2)) {
      const path = relPath(file);
      if (!path.endsWith('/README.md') || path.split('/').length !== 4) continue;
      const markdown = await readText(file);
      if (markdown === undefined) continue; // removed while the mirror was being reset
      const doc = parseMarkdown(markdown);
      entries.push({ kind: 'package', id: posix.dirname(path), title: titleOf(doc, path), path, text: packageText(doc) });
    }
  }

  const catalogFile = await plainStat(mirror, ...CATALOG_PATH.split('/'));
  const catalog = catalogFile?.stats.isFile() ? await readText(catalogFile.path) : undefined;
  if (catalog !== undefined) {
    const doc = parseMarkdown(catalog);
    for (const heading of doc.headings) {
      if (heading.level !== 2 || !PACKAGE_NAME.test(heading.title)) continue; // the appendix tables (no config, seams, libraries) list packages, they are not entries
      const end = doc.headings.find(h => h.index > heading.index)?.index ?? doc.lines.length;
      entries.push({ kind: 'config', id: heading.title, title: heading.title, path: CATALOG_PATH, text: clip(textBetween(doc, heading.index + 1, end), TEXT_LIMIT) });
    }
  }

  for (const status of NOTE_STATUSES) {
    const notes = await plainStat(mirror, '.agents', 'notes', status);
    if (!notes?.stats.isDirectory()) continue;
    for await (const file of walk(notes.path, 2)) {
      const name = basename(file); // the file name only: the mirror's own path may contain any word
      if (!name.endsWith('.md') || name.endsWith('.zh.md') || /^(AGENTS|CLAUDE)\.md$/.test(name)) continue;
      const markdown = await readText(file);
      if (markdown === undefined) continue;
      const doc = parseMarkdown(markdown);
      const path = relPath(file);
      const title = titleOf(doc, path);
      entries.push({ kind: 'note', id: path, title: title.replace(NOTE_PREFIX, '') || title, path, text: clip(textBetween(doc, doc.start, doc.lines.length), TEXT_LIMIT) });
    }
  }

  return { version: 1, builtAt: new Date().toISOString(), commit: commit === await commitOf(mirror) ? commit : 'unknown', mirror, entries };
}

const KINDS: readonly unknown[] = ['package', 'config', 'note', 'doc'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isEntry = (value: unknown): value is IndexEntry => isRecord(value) && KINDS.includes(value.kind) && ['id', 'title', 'path', 'text'].every(key => typeof value[key] === 'string');
/** Shape check for an index read back from disk: version 1, string fields and well-formed entries. An older or foreign file fails it and should be rebuilt. */
export function isDshIndex(value: unknown): value is DshIndex {
  return isRecord(value) && value.version === 1 && ['builtAt', 'commit', 'mirror'].every(key => typeof value[key] === 'string') && Array.isArray(value.entries) && value.entries.every(isEntry);
}

const STOPWORDS = new Set('the and for are but not you your can was has its may our from with this that have will been they their there which into than then them these those what when where to in of on at by is it as be or if so we an'.split(' '));
/** A run of CJK characters, or of Latin letters and digits; everything else (punctuation, other scripts) only separates. */
const RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[A-Za-z\d]+/gu;
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** The `@scope/` of a package name is the same on every package, so it must not make `ai` or `deepseek` match them all. */
const SCOPE = /@[\w.-]+\//g;
const runsOf = (text: string) => text.replace(SCOPE, ' ').match(RUN) ?? [];
const camelParts = (run: string) => run.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ');
/** Plural tolerance: both sides drop one trailing `s`, so `tools` finds `tool` and the other way round. */
const stem = (word: string) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);

/** Query words: split at script boundaries, punctuation and CamelCase; one-character words, stopwords and pure numbers carry no signal and are dropped. */
function termsOf(query: string): string[] {
  const terms = new Set<string>();
  for (const run of runsOf(query)) {
    for (const part of camelParts(run)) {
      const word = part.toLowerCase();
      if (word.length < 2 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
      terms.add(CJK.test(word) ? word : stem(word));
    }
  }
  return [...terms];
}

interface Field { words: Set<string>; cjk: string[] }
/** Whole words of a title or text: each Latin run both as written and split at CamelCase, so `WorktreeConfig` answers to `worktreeconfig`, `worktree` and `config`. CJK runs are kept whole. */
function fieldOf(text: string): Field {
  const words = new Set<string>(), cjk: string[] = [];
  for (const run of runsOf(text)) {
    if (CJK.test(run)) { cjk.push(run); continue; }
    words.add(stem(run.toLowerCase()));
    for (const part of camelParts(run)) words.add(stem(part.toLowerCase()));
  }
  return { words, cjk };
}
// Word sets are derived on first use and live only as long as the entry; they are never part of the index that gets written out. Entries are treated as immutable.
const fields = new WeakMap<IndexEntry, { title: Field; text: Field }>();
function fieldsOf(entry: IndexEntry) {
  let cached = fields.get(entry);
  if (!cached) fields.set(entry, cached = { title: fieldOf(entry.title), text: fieldOf(entry.text) });
  return cached;
}
// CJK text has no spaces, so a CJK query word matches inside a run; a Latin one must be a whole word.
const hasTerm = (field: Field, term: string) => (CJK.test(term) ? field.cjk.some(run => run.includes(term)) : field.words.has(term));

/**
 * A query word is worth more the fewer entries of the whole index hold it: its weight is ln(1 + entries / holders), so `tools`, a word of
 * 33 package titles, counts for less than `worktree`, a word of five entries. The word then scores 3 times its weight as a whole word of
 * the entry title and 1 times it as a whole word of the text. The weights come from the whole index whatever `kind` limits the ranking
 * to, so the filter never reorders what it keeps. Best `limit` entries first; equal scores order by path, then id.
 */
export function searchIndex(index: DshIndex, query: string, limit = 5, kind?: IndexEntry['kind']): IndexEntry[] {
  const terms = termsOf(query);
  if (terms.length === 0 || !(limit >= 1)) return [];
  const points = index.entries.map(entry => {
    const { title, text } = fieldsOf(entry);
    return terms.map(term => (hasTerm(title, term) ? TITLE_WEIGHT : 0) + (hasTerm(text, term) ? TEXT_WEIGHT : 0));
  });
  const weights = terms.map((_, i) => Math.log(1 + index.entries.length / Math.max(1, points.filter(row => row[i]! > 0).length)));
  const hits: { entry: IndexEntry; score: number }[] = [];
  index.entries.forEach((entry, i) => {
    if (kind && entry.kind !== kind) return;
    const score = points[i]!.reduce((sum, earned, j) => sum + earned * weights[j]!, 0);
    if (score > 0) hits.push({ entry, score });
  });
  hits.sort((a, b) => b.score - a.score || compare(a.entry.path, b.entry.path) || compare(a.entry.id, b.entry.id));
  return hits.slice(0, limit).map(hit => hit.entry);
}
