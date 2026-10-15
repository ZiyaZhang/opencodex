import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface IndexEntry { kind: 'package' | 'config' | 'note' | 'doc'; id: string; title: string; path: string; text: string }
/** `mirror` is the path the index was built from, exactly as given; every entry `path` is relative to it and uses `/`. */
export interface DshIndex { builtAt: string; commit: string; mirror: string; entries: IndexEntry[] }

const SUMMARY_LIMIT = 1_200;
const TEXT_LIMIT = 1_500;
const NOTE_STATUSES = ['implemented', 'proposed'];
const TITLE_WEIGHT = 3;
const TEXT_WEIGHT = 1;
const CATALOG_PATH = 'docs/config-catalog.md';

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');

async function readText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); } catch (error) { if (isMissing(error)) return undefined; throw error; }
}
async function listDirectory(dir: string): Promise<Dirent[]> {
  try { return await readdir(dir, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return []; throw error; }
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
interface Markdown { lines: string[]; start: number; headings: Heading[] }
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^(#{1,2})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;

/** Lines of a Markdown file and its level-1/2 headings. Front matter and fenced code (shell comments, sample READMEs) never count as headings. */
function parseMarkdown(source: string): Markdown {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const start = lines[0]?.trim() === '---' ? lines.findIndex((line, i) => i > 0 && line.trim() === '---') + 1 : 0;
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
  return { lines, start, headings };
}
const titleOf = (doc: Markdown, fallback: string) => doc.headings.find(h => h.level === 1)?.title || fallback;

/** Drops markup that renders as nothing (generated-section markers, anchors) and folds all whitespace. */
const collapse = (text: string) => text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<a id="[^"]*"><\/a>/g, ' ').replace(/\s+/g, ' ').trim();
/** Cuts to `limit` UTF-16 units without leaving half of a surrogate pair at the end. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return (/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut).trimEnd();
}
/** Lines [from, to) as one clean line of text. The file's own title line is left out: `title` already carries it, and a title hit must count once. */
function excerpt(doc: Markdown, from: number, to: number, limit: number): string {
  const title = doc.headings.find(h => h.level === 1)?.index;
  return clip(collapse(doc.lines.slice(from, to).filter((_, i) => from + i !== title).join('\n')), limit);
}
/** The `## Summary` section; a README with no (or an empty) one falls back to its leading text, everything before the first `##` heading. */
function summaryOf(doc: Markdown): string {
  const at = doc.headings.findIndex(h => h.level === 2 && /^summary$/i.test(h.title));
  const summary = at < 0 ? '' : excerpt(doc, doc.headings[at]!.index + 1, doc.headings[at + 1]?.index ?? doc.lines.length, SUMMARY_LIMIT);
  return summary || excerpt(doc, doc.start, doc.headings.find(h => h.level === 2)?.index ?? doc.lines.length, SUMMARY_LIMIT);
}

/** HEAD of the mirror. A folder that merely sits inside another repository is not a checkout of its own and must not report that repository's HEAD. */
async function commitOf(mirror: string): Promise<string> {
  try {
    await stat(join(mirror, '.git'));
    const { stdout } = await execFileAsync('git', ['-C', mirror, 'rev-parse', 'HEAD'], { timeout: 10_000 });
    return stdout.trim() || 'unknown';
  } catch { return 'unknown'; }
}

/**
 * Reads the official DSH mirror (read-only: nothing is ever written into it) into one flat list:
 * package README summaries, `docs/config-catalog.md` sections and `.agents/notes/{implemented,proposed}` notes.
 * Missing pieces (no `packages/`, no catalog, no notes) simply contribute no entries.
 */
export async function buildDshIndex(mirror: string): Promise<DshIndex> {
  const relPath = (file: string) => relative(mirror, file).split(sep).join('/');
  const entries: IndexEntry[] = [];

  // A package is exactly packages/<group>/<name>/README.md. Group READMEs (packages/<group>/README.md) and READMEs inside a package's own tests/ or src/ are not packages.
  for await (const file of walk(join(mirror, 'packages'), 2)) {
    const path = relPath(file);
    if (!path.endsWith('/README.md') || path.split('/').length !== 4) continue;
    const markdown = await readText(file);
    if (markdown === undefined) continue; // removed while the mirror was being reset
    const doc = parseMarkdown(markdown);
    const title = titleOf(doc, path);
    entries.push({ kind: 'package', id: title, title, path, text: summaryOf(doc) });
  }

  const catalog = await readText(join(mirror, CATALOG_PATH));
  if (catalog !== undefined) {
    const doc = parseMarkdown(catalog);
    for (const heading of doc.headings.filter(h => h.level === 2)) {
      const end = doc.headings.find(h => h.index > heading.index)?.index ?? doc.lines.length;
      entries.push({ kind: 'config', id: heading.title, title: heading.title, path: CATALOG_PATH, text: excerpt(doc, heading.index + 1, end, TEXT_LIMIT) });
    }
  }

  for (const status of NOTE_STATUSES) {
    for await (const file of walk(join(mirror, '.agents', 'notes', status), 2)) {
      const name = basename(file); // the file name only: the mirror's own path may contain any word
      if (!name.endsWith('.md') || name.endsWith('.zh.md') || /^(AGENTS|CLAUDE)\.md$/.test(name)) continue;
      const markdown = await readText(file);
      if (markdown === undefined) continue;
      const doc = parseMarkdown(markdown);
      const path = relPath(file);
      entries.push({ kind: 'note', id: path, title: `${titleOf(doc, path)} [${status}]`, path, text: excerpt(doc, doc.start, doc.lines.length, TEXT_LIMIT) });
    }
  }

  return { builtAt: new Date().toISOString(), commit: await commitOf(mirror), mirror, entries };
}

/** Lower-case words of a query: split on anything that is not a letter, digit or CJK character, and at camelCase seams. One-character words carry no signal and are dropped. */
function termsOf(query: string): string[] {
  const words = query
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d\u4e00-\u9fff]+/);
  return [...new Set(words.filter(word => word.length >= 2))];
}

/** Each query word scores 3 when it occurs in the entry title and 1 when it occurs in the text. Best `limit` entries first; equal scores order by path, then id. */
export function searchIndex(index: DshIndex, query: string, limit = 5): IndexEntry[] {
  const terms = termsOf(query);
  if (terms.length === 0 || !(limit >= 1)) return [];
  const hits: { entry: IndexEntry; score: number }[] = [];
  for (const entry of index.entries) {
    const title = entry.title.toLowerCase(), text = entry.text.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (title.includes(term) ? TITLE_WEIGHT : 0) + (text.includes(term) ? TEXT_WEIGHT : 0), 0);
    if (score > 0) hits.push({ entry, score });
  }
  hits.sort((a, b) => b.score - a.score || compare(a.entry.path, b.entry.path) || compare(a.entry.id, b.entry.id));
  return hits.slice(0, limit).map(hit => hit.entry);
}
