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
interface Block { kind: 'heading' | 'item' | 'text'; text: string; anchor?: string }
interface Release { date: string; title: string; anchor?: string; url?: string; blocks: Block[] }
const GENERIC = /^(?:new features?|features?|what[’']?s new|highlights?|improvements?|新增功能|新功能)$/i;
const SKIP_SECTION = /bug\s*fix|performance|chore|changelog|install|availability|pricing|修复|性能|安装/i;
const SKIP_RELEASE = /\b(?:CLI|mobile|iOS|Android|SDK|API)\b|^(?:introducing\s+)?GPT[-\s]|\b(?:model|models)\b.*\b(?:retir|available|release)|\bultrafast\b.*\b(?:Codex|ChatGPT)\b/i;
const NON_FEATURE = /^(?:(?:additional|various|general)\s+)?(?:performance improvements?|bug fixes?|stability improvements?)\b|^(?:fixed?|fixes|resolved?|corrected)\b|^(?:support for|introducing|added support for)\s+GPT[-\s]|^(?:full changelog|learn more|view details|download|npm install|\$ npm)/i;

function plain(value: string): string {
  return value.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
      const point = code[0]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, key: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[key]!)
    .replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim();
}
function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
}
function linesFor(content: string): string[] {
  // RSS fragments commonly contain only paragraphs and lists, without a document or heading.
  if (!/<(?:html|main|article|section|time|h[1-6]|p|ul|ol|li|div|blockquote|table)\b/i.test(content)) return content.split(/\r?\n/);
  let html = content.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) html = main[1]!;
  html = html.replace(/<time\b([^>]*)>([\s\S]*?)<\/time>/gi, (tag, attrs: string, body: string) => {
    const date = attribute(attrs, 'datetime')?.slice(0, 10) ?? plain(body);
    return `\n@@date:${date}\n`;
  });
  // Preserve original IDs. Never invent a deep-link from a guessed slug.
  html = html.replace(/<(?:article|section|li|div|a)\b[^>]*>/gi, tag => {
    const id = attribute(tag, 'id') ?? attribute(tag, 'name');
    return `${id ? `\n@@anchor:${id}\n` : ''}${/^<li\b/i.test(tag) ? '\n- ' : ''}`;
  });
  html = html.replace(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi, (_, level: string, attrs: string, body: string) => {
    const id = attribute(attrs, 'id');
    return `\n${id ? `@@anchor:${id}\n` : ''}${'#'.repeat(Number(level))} ${plain(body)}\n`;
  }).replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|li|div|section|article|ul|ol)>/gi, '\n').replace(/<p\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '');
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
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      // Markdown may supply an explicit ID. This is source data, not an inferred slug.
      const explicit = heading[1]!.match(/\s*\{#([^}]+)\}\s*$/);
      const text = plain(heading[1]!.replace(/\s*\{#[^}]+\}\s*$/, ''));
      const id = explicit?.[1] ?? anchor;
      if (!current.title) { current.title = text; if (id) current.anchor = id; }
      else current.blocks.push({ kind: 'heading', text, ...(id ? { anchor: id } : {}) });
      anchor = undefined; continue;
    }
    const text = plain(line.replace(/^[-*]\s+/, ''));
    if (text && current.title) current.blocks.push({ kind: /^[-*]\s+/.test(line) ? 'item' : 'text', text });
    anchor = undefined;
  }
  return releases.filter(release => release.title);
}
function rssReleases(content: string): Release[] {
  const releases: Release[] = [];
  const field = (item: string, name: string) => item.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1]?.trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1');
  for (const match of content.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = match[1]!, title = plain(field(item, 'title') ?? ''), rawDate = field(item, 'pubDate');
    const stamp = rawDate ? Date.parse(plain(rawDate)) : NaN;
    if (!title || !Number.isFinite(stamp)) continue;
    const rawLink = plain(field(item, 'link') ?? '');
    let url: string | undefined;
    try { const parsed = new URL(rawLink); if (parsed.protocol === 'https:' && ['learn.chatgpt.com', 'developers.openai.com'].includes(parsed.hostname)) url = parsed.href; } catch { /* No guessed URL. */ }
    const rawBody = field(item, 'content:encoded') ?? field(item, 'description') ?? '';
    // RSS descriptions may be CDATA HTML or entity-escaped HTML.
    const body = rawBody.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const blocks: Block[] = [];
    let anchor: string | undefined;
    for (const raw of linesFor(body)) {
      const line = raw.trim();
      if (line.startsWith('@@anchor:')) { anchor = line.slice(9); continue; }
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      const text = plain((heading?.[1] ?? line).replace(/^[-*]\s+/, ''));
      if (text) blocks.push({ kind: heading ? 'heading' : /^[-*]\s+/.test(line) ? 'item' : 'text', text, ...(heading && anchor ? { anchor } : {}) });
      anchor = undefined;
    }
    releases.push({ date: new Date(stamp).toISOString().slice(0, 10), title, ...(url ? { url } : {}), blocks });
  }
  return releases;
}
function titleFor(text: string): string {
  const colon = text.match(/^(.{4,85}?):\s/);
  const title = colon?.[1] ?? text.split(/(?<=[.!?])\s+/)[0]!;
  return title.length > 150 ? `${title.slice(0, 147).trim()}…` : title;
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
    if (!/\bCodex\b|desktop|桌面/i.test(`${release.title} ${release.blocks.map(block => block.text).join(' ')}`)) continue;
    const before = features.length;
    const append = (title: string, body: string, anchor?: string) => {
      if (features.length >= maxFeatures || title.length < 5 || NON_FEATURE.test(title)) return;
      const normalizedTitle = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const fingerprint = `codex-feature:${createHash('sha256').update(`${release.date}\n${normalizedTitle}`).digest('hex')}`;
      if (seen.has(fingerprint)) return;
      seen.add(fingerprint);
      const scope = /desktop|codex app|桌面/i.test(`${release.title} ${body}`) ? '桌面应用' : '通用产品公告（平台需研究确认）';
      features.push({ title, description: `${body.slice(0, 1000)}\n\n来源范围：${scope}。官方更新记录中的功能线索；尚未在本机验证，也不代表已经完成复刻。`, sourceUrl: release.url ? (anchor ? linkFor(release.url, anchor) : release.url) : linkFor(sourceUrl, anchor ?? release.anchor), fingerprint, publishedAt, releaseTitle: release.title });
    };
    let section = '', sectionAnchor: string | undefined, paragraphs: string[] = [], items: string[] = [];
    const flush = () => {
      if (SKIP_SECTION.test(section)) return;
      if (section && !GENERIC.test(section)) {
        if (paragraphs.length || items.length) append(section, [...paragraphs, ...items].join(' '), sectionAnchor);
      } else {
        for (const item of items) append(titleFor(item), item);
        if (!items.length && paragraphs.length && !/^(?:Codex|ChatGPT) (?:desktop )?app\s+[\d.]/i.test(release.title)) append(release.title, paragraphs.join(' '));
      }
    };
    for (const block of release.blocks) {
      if (block.kind === 'heading') { flush(); section = block.text; sectionAnchor = block.anchor; paragraphs = []; items = []; }
      else if (block.kind === 'item') items.push(block.text);
      else if (!NON_FEATURE.test(block.text)) paragraphs.push(block.text);
    }
    flush();
    if (features.length > before && ++acceptedReleases >= maxReleases) break;
    if (features.length >= maxFeatures) break;
  }
  return features;
}
