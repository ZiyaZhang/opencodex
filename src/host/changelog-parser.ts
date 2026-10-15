/** A bounded, deterministic reader for the official dated product changelog.
 * It extracts announcements, not proof that a feature exists in the local app.
 */
import { createHash } from 'node:crypto';

export interface ChangelogFeature {
  title: string;
  description: string;
  sourceUrl: string;
  fingerprint: string;
  publishedAt: string;
  releaseTitle: string;
}
export interface ChangelogOptions { now?: Date; maxReleases?: number; maxFeatures?: number; maxAgeDays?: number }
/** Bump when the output for the same feed changes: the RSS source folds it into the hash that decides whether a feed was already read, so a parser fix takes effect on the next run. */
export const PARSER_VERSION = '1';
/** `raw` is the block as written, link targets included; only the relevance gate reads it. `title` marks the heading that repeats the item title. */
interface Block { kind: 'heading' | 'item' | 'text'; text: string; raw: string; anchor?: string; title?: true }
interface Release { date: string; title: string; anchor?: string; url?: string; blocks: Block[] }
interface TextLine { text: string; code: boolean }
const GENERIC = /^(?:new features?|features?|what[’']?s new|highlights?|improvements?|新增功能|新功能)$/i;
// Whole section names only: "Install the ChatGPT desktop app on Linux" is an announcement, "Installation" is boilerplate.
const SKIP_SECTION = new RegExp(`^(?:${[
  // "Bug fixes", "Improvements and bug fixes", "Other improvements and bug fixes", "Performance improvements and bug fixes", "Bug fixes & improvements"
  String.raw`(?:other |additional )?(?:performance )?(?:improvements? (?:and|&) )?bug ?fix(?:es)?(?: (?:and|&) (?:performance )?improvements?)?`,
  String.raw`(?:fixes|improvements?) (?:and|&) (?:fixes|improvements?)`,
  'security fixes', 'performance(?: improvements?)?', 'chores?', 'changelog', 'install(?:ation)?',
  'availability(?: and pricing(?: updates?)?)?', 'pricing(?: updates?)?', '修复', '性能', '安装',
].join('|')})$`, 'i');
/** The skipped sections whose runtime-feature bullets still count. */
const PERFORMANCE_SECTION = /^(?:performance(?: improvements?)?|性能)$/i;
const RELEVANT = /\bCodex\b|desktop|桌面/i;
const SKIP_RELEASE = /\b(?:mobile|iOS|Android)\b|\b(?:deprecated|removed|retired|security update)\b|^(?:introducing\s+)?GPT[-\s]|\b(?:model|models)\b.*\b(?:retir|available|release)|\bultrafast\b.*\b(?:Codex|ChatGPT)\b/i;
const RUNTIME_SURFACE = /\b(?:CLI|SDK|API)\b/i;
const RUNTIME_FEATURE = /\b(?:compaction|checkpoint|context (?:compression|management)|background (?:compression|compaction)|async(?:hronous)? (?:compaction|tools?|execution)|tool cancellation)\b|异步压缩|后台压缩|上下文压缩|检查点/i;
const NON_FEATURE = /^(?:(?:additional|various|general)\s+)?(?:performance improvements?|bug fixes?|stability improvements?)\b|^(?:fixed?|fixes|resolved?|corrected)\b|^(?:support for|introducing|added support for)\s+GPT[-\s]|^(?:full changelog|learn more|view details|download|npm install|\$ npm)/i;

const HEADING = /^#{1,6}\s+(.+)$/;
const LIST_ITEM = /^(?:[-*]|\d+[.)])\s+/;
const FENCE = /^(?:```|~~~)/;
/** A trailing pull request reference such as `(#123)`, `(#12, #34)` or `(#123).`: stripped whole, the period stays, so no length cap can leave half of it. */
const PR_REFS = /\s*\(#\d+(?:\s*,\s*#\d+)*\)(\.?)\s*$/;
const CODE_SPAN = /(?<!`)(`+)(?!`)([\s\S]+?)(?<!`)\1(?!`)/g;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const TITLE_LIMIT = 150, DESCRIPTION_LIMIT = 1000;
/** An item body is cut here before it is parsed: some of the patterns below still take time quadratic in the length of malformed input. Characters, not bytes. */
const ITEM_BODY_LIMIT = 64 * 1024;

/**
 * At most `limit` code points. A longer text is cut at a word boundary and ends in `…`, which counts toward the limit.
 * A single token longer than the limit is cut where it stands, never inside a surrogate pair.
 */
export function clip(text: string, limit: number): string {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  let end = limit - 1;
  if (!/\s/u.test(chars[end]!)) {
    const space = chars.slice(0, end).findLastIndex(char => /\s/u.test(char));
    if (space > 0) end = space;
  }
  const kept = chars.slice(0, end).join('').replace(/[\s,;:([{\-–—]+$/u, '');
  return `${kept || chars.slice(0, limit - 1).join('')}…`;
}

function entities(text: string): string {
  return text.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
    const point = code[0]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, key: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[key]!);
}
function plain(value: string): string {
  // Code spans are literal text: set them aside so tag and emphasis handling cannot touch `snake_case` or `<placeholder>`. Only their entities are decoded.
  const spans: string[] = [];
  const text = value.replace(/[\uE000\uE001]/g, '').replace(CODE_SPAN, (_, _ticks: string, code: string) => `\uE000${spans.push(entities(code)) - 1}\uE001`)
    .replace(/!\[[^\]]{0,512}\]\([^)]{0,2048}\)/g, '')
    .replace(/\[([^\]]{1,512})\]\([^)]{0,2048}\)/g, '$1').replace(/<[^>]{0,2048}>/g, '');
  return entities(text).replace(/[*`]/g, '')
    // An underscore between two word characters belongs to the word (`tui.mouse_scroll_speed`); any other run is an emphasis marker.
    .replace(/_+/g, (run, at: number, all: string) => WORD_CHAR.test(all[at - 1] ?? '') && WORD_CHAR.test(all[at + run.length] ?? '') ? run : '')
    .replace(/\uE000(\d+)\uE001/g, (_, index: string) => spans[Number(index)]!).replace(/\s+/g, ' ').trim();
}
function attribute(tag: string, name: string): string | undefined {
  // The name must start a token: `data-id="5"` is not an `id`.
  return tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
}
function linesFor(content: string): string[] {
  // RSS fragments commonly contain only paragraphs and lists, without a document or heading.
  if (!/<(?:html|main|article|section|time|h[1-6]|p|ul|ol|li|div|blockquote|table)\b/i.test(content)) return content.split(/\r?\n/);
  let html = content.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|nav|footer)\b[^>]{0,512}>[\s\S]*?<\/\1>/gi, '');
  const main = html.match(/<main\b[^>]{0,512}>([\s\S]*?)<\/main>/i);
  if (main) html = main[1]!;
  html = html.replace(/<time\b([^>]{0,512})>([\s\S]{0,512}?)<\/time>/gi, (tag, attrs: string, body: string) => {
    const date = attribute(attrs, 'datetime')?.slice(0, 10) ?? plain(body);
    return `\n@@date:${date}\n`;
  });
  // Preserve original IDs. Never invent a deep-link from a guessed slug.
  html = html.replace(/<(?:article|section|li|div|a)\b[^>]{0,2048}>/gi, tag => {
    const id = attribute(tag, 'id') ?? attribute(tag, 'name');
    return `${id ? `\n@@anchor:${id}\n` : ''}${/^<li\b/i.test(tag) ? '\n- ' : ''}`;
  });
  html = html.replace(/<h([1-6])\b([^>]{0,512})>([\s\S]{0,2048}?)<\/h\1>/gi, (_, level: string, attrs: string, body: string) => {
    const id = attribute(attrs, 'id');
    return `\n${id ? `@@anchor:${id}\n` : ''}${'#'.repeat(Number(level))} ${plain(body)}\n`;
  }).replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|li|div|section|article|ul|ol)>/gi, '\n').replace(/<p\b[^>]{0,512}>/gi, '\n').replace(/<[^>]{0,2048}>/g, '');
  return html.split(/\r?\n/);
}
function releasesFor(content: string): Release[] {
  if (/<rss\b/i.test(content)) return rssReleases(content);
  const releases: Release[] = [];
  let current: Release | undefined, anchor: string | undefined;
  for (const raw of linesFor(content)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('@@anchor:')) { anchor = line.slice(9); continue; }
    const date = line.match(/^(?:@@date:|[-*]\s+)?(\d{4}-\d{2}-\d{2})\s*$/)?.[1];
    if (date) {
      if (!Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) continue;
      current = { date, title: '', ...(anchor ? { anchor } : {}), blocks: [] };
      releases.push(current); anchor = undefined; continue;
    }
    if (!current) continue;
    const heading = line.match(HEADING);
    if (heading) {
      // Markdown may supply an explicit ID. This is source data, not an inferred slug.
      const explicit = heading[1]!.match(/\s*\{#([^}]+)\}\s*$/);
      const text = plain(heading[1]!.replace(/\s*\{#[^}]+\}\s*$/, ''));
      const id = explicit?.[1] ?? anchor;
      if (!current.title) { current.title = text; if (id) current.anchor = id; }
      else current.blocks.push({ kind: 'heading', text, raw: heading[1]!, ...(id ? { anchor: id } : {}) });
      anchor = undefined; continue;
    }
    const text = plain(line.replace(LIST_ITEM, ''));
    if (text && current.title) current.blocks.push({ kind: LIST_ITEM.test(line) ? 'item' : 'text', text, raw: line });
    anchor = undefined;
  }
  return releases.filter(release => release.title);
}
/**
 * RSS bodies are hard-wrapped Markdown, so one bullet or paragraph spans several physical lines.
 * A line continues the one before it, joined with one space, unless it is blank, a heading, a code fence, a `@@` marker line from `linesFor`, or the start of a new list item.
 * Lines inside a code fence are flagged as code and stand alone; the fence lines themselves only end the line before.
 * A `@@anchor:` marker in the middle of a sentence is dropped, so an inline `<a id|name>` does not cut the bullet around it.
 */
function unwrap(lines: string[]): TextLine[] {
  const out: TextLine[] = [];
  let open = false, fenced = false;
  const continues = (line: string | undefined) => !!line && !line.startsWith('@@') && !HEADING.test(line) && !FENCE.test(line) && !LIST_ITEM.test(line);
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!.trim();
    if (FENCE.test(line)) { fenced = !fenced; out.push({ text: '', code: false }); open = false; continue; }
    if (fenced) { out.push({ text: line, code: true }); continue; }
    if (open && line.startsWith('@@anchor:')) {
      let next = at + 1;
      while (lines[next]?.trim().startsWith('@@anchor:')) next++;
      if (continues(lines[next]?.trim())) { at = next - 1; continue; }
    }
    if (!line || line.startsWith('@@') || HEADING.test(line)) { out.push({ text: line, code: false }); open = false; }
    else if (open && !LIST_ITEM.test(line)) out[out.length - 1]!.text += ` ${line}`;
    else { out.push({ text: line, code: false }); open = true; }
  }
  return out;
}
/** The inner text of every `<item>`. Plain scans, not one lazy pattern: an unclosed `<item>` must cost one pass over the feed, not one pass per opener. */
function* itemsOf(content: string): Generator<string> {
  const open = /<item\b[^>]{0,256}>/gi, close = /<\/item>/gi;
  for (let at = 0; ;) {
    open.lastIndex = at;
    if (!open.exec(content)) return;
    const from = open.lastIndex;
    close.lastIndex = from;
    const end = close.exec(content);
    if (!end) return;
    yield content.slice(from, end.index);
    at = close.lastIndex;
  }
}
/** The text of the first `<name>` element of an item, with a CDATA wrapper removed. */
function fieldOf(item: string, name: string): string | undefined {
  const start = new RegExp(`<${name}\\b[^>]{0,512}>`, 'i').exec(item);
  if (!start) return undefined;
  const from = start.index + start[0].length;
  const close = new RegExp(`</${name}>`, 'gi');
  close.lastIndex = from;
  const end = close.exec(item);
  return end ? item.slice(from, end.index).trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1') : undefined;
}
/** A body past the limit ends at its last line break before it, so no half bullet or half tag is parsed. */
function capBody(body: string): string {
  if (body.length <= ITEM_BODY_LIMIT) return body;
  const cut = body.lastIndexOf('\n', ITEM_BODY_LIMIT);
  return body.slice(0, cut > 0 ? cut : ITEM_BODY_LIMIT);
}
function rssReleases(content: string): Release[] {
  const releases: Release[] = [];
  for (const item of itemsOf(content)) {
    const title = plain(fieldOf(item, 'title') ?? ''), rawDate = fieldOf(item, 'pubDate');
    const stamp = rawDate ? Date.parse(plain(rawDate)) : NaN;
    if (!title || !Number.isFinite(stamp)) continue;
    const rawLink = plain(fieldOf(item, 'link') ?? '');
    let url: string | undefined;
    try { const parsed = new URL(rawLink); if (parsed.protocol === 'https:' && ['learn.chatgpt.com', 'developers.openai.com'].includes(parsed.hostname)) url = parsed.href; } catch { /* No guessed URL. */ }
    const rawBody = capBody(fieldOf(item, 'content:encoded') ?? fieldOf(item, 'description') ?? '');
    // RSS descriptions may be CDATA HTML or entity-escaped HTML.
    const body = rawBody.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const blocks: Block[] = [];
    let anchor: string | undefined;
    for (const { text: line, code } of unwrap(linesFor(body))) {
      if (!code && line.startsWith('@@anchor:')) { anchor = line.slice(9); continue; }
      const heading = code ? null : line.match(HEADING);
      const headingText = heading ? plain(heading[1]!) : '';
      const text = heading ? headingText : code ? line.replace(/\s+/g, ' ') : plain(line.replace(LIST_ITEM, '')).replace(PR_REFS, '$1');
      // The body usually opens with the item title again: that heading is the item itself, so it names no section to skip.
      if (text) blocks.push({ kind: heading ? 'heading' : !code && LIST_ITEM.test(line) ? 'item' : 'text', text, raw: line, ...(heading && anchor ? { anchor } : {}), ...(heading && text.toLowerCase() === title.toLowerCase() ? { title: true as const } : {}) });
      anchor = undefined;
    }
    releases.push({ date: new Date(stamp).toISOString().slice(0, 10), title, ...(url ? { url } : {}), blocks });
  }
  return releases;
}
function titleFor(text: string): string {
  return text.match(/^(.{4,85}?):\s/)?.[1] ?? text.split(/(?<=[.!?])\s+/)[0]!;
}
function linkFor(sourceUrl: string, anchor?: string): string {
  const url = new URL(sourceUrl); url.hash = anchor ?? ''; return url.toString();
}

export function parseChangelog(content: string, sourceUrl: string, options: ChangelogOptions = {}): ChangelogFeature[] {
  const releases = releasesFor(content);
  if (!releases.length) throw new Error('Official changelog format was not recognized; no checkpoint or generic feature was created');
  const now = options.now ?? new Date();
  const oldest = now.getTime() - (options.maxAgeDays ?? 90) * 86_400_000;
  const maxReleases = options.maxReleases ?? 8, maxFeatures = options.maxFeatures ?? 32;
  const features: ChangelogFeature[] = [], seen = new Set<string>();
  let acceptedReleases = 0;
  for (const release of releases) {
    const publishedAt = `${release.date}T00:00:00.000Z`;
    const stamp = Date.parse(publishedAt);
    if (stamp < oldest || stamp > now.getTime() + 86_400_000 || SKIP_RELEASE.test(release.title)) continue;
    // The gate reads the blocks as written: a /codex/ link target is a Codex announcement even when no word of the text says so.
    if (!RELEVANT.test(`${release.title} ${release.blocks.map(block => block.raw).join(' ')}`)) continue;
    const before = features.length;
    const append = (heading: string, body: string, anchor?: string) => {
      const title = clip(heading, TITLE_LIMIT);
      if (features.length >= maxFeatures || title.length < 5 || NON_FEATURE.test(title)) return;
      if (RUNTIME_SURFACE.test(release.title) && !RUNTIME_FEATURE.test(`${title} ${body}`)) return;
      const normalizedTitle = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const fingerprint = `codex-feature:${createHash('sha256').update(`${release.date}\n${normalizedTitle}`).digest('hex')}`;
      if (seen.has(fingerprint)) return;
      seen.add(fingerprint);
      features.push({ title, description: clip(body, DESCRIPTION_LIMIT), sourceUrl: release.url ? (anchor ? linkFor(release.url, anchor) : release.url) : linkFor(sourceUrl, anchor ?? release.anchor), fingerprint, publishedAt, releaseTitle: release.title });
    };
    // `parts` holds paragraphs and bullets in the order they appear, for a section that becomes one feature.
    let section = '', ownTitle = false, sectionAnchor: string | undefined, paragraphs: string[] = [], items: string[] = [], parts: string[] = [];
    const flush = () => {
      const name = ownTitle ? release.title : section.replace(/[\s:：]+$/u, '');
      if (!ownTitle && SKIP_SECTION.test(name)) {
        if (PERFORMANCE_SECTION.test(name)) for (const text of parts) if (RUNTIME_FEATURE.test(text)) append(titleFor(text), text, sectionAnchor);
        return;
      }
      if (name && !GENERIC.test(name)) {
        if (parts.length) append(name, parts.join(' '), sectionAnchor);
      } else {
        for (const item of items) append(titleFor(item), item);
        if (!items.length && paragraphs.length && !/^(?:Codex|ChatGPT) (?:desktop )?app\s+[\d.]/i.test(release.title)) append(release.title, paragraphs.join(' '));
      }
    };
    for (const block of release.blocks) {
      if (block.kind === 'heading') { flush(); section = block.text; ownTitle = !!block.title; sectionAnchor = block.anchor; paragraphs = []; items = []; parts = []; }
      else if (block.kind === 'item') { items.push(block.text); parts.push(block.text); }
      else if (!NON_FEATURE.test(block.text)) { paragraphs.push(block.text); parts.push(block.text); }
    }
    flush();
    if (features.length > before && ++acceptedReleases >= maxReleases) break;
    if (features.length >= maxFeatures) break;
  }
  return features;
}
