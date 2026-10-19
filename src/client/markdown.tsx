/**
 * The report viewer. A report can quote third-party text, and the creator session gets the same file as its task, so nothing in it may be
 * hidden from whoever reads it here: the sanitizer keeps only the elements Markdown produces and no attribute that can hide text, the page
 * says how much it did not show (HTML the sanitizer removed, link definitions, characters nobody can see), and the raw text is one click away.
 */
import { useMemo, useState, type MouseEvent } from 'react';
import { Marked } from 'marked';
import DOMPurify, { type Config } from 'dompurify';
import { useUi } from './ui-context.js';

/** What `renderMarkdown` needs from DOMPurify. DOMPurify needs a DOM; tests pass an instance made on a jsdom window. */
export interface Sanitizer {
  sanitize(html: string, config: Config): string;
  /** What the last `sanitize` call removed, as `{ element }` and `{ attribute, from }` entries. */
  readonly removed: readonly unknown[];
}

/**
 * The elements marked emits for a report (headings, paragraphs, lists, tables, code, quotes, links) and a few inline ones. Anything else is
 * removed with its text kept, except the elements whose content never shows (script, style, title, template and the like), which go whole.
 * `body` is the root DOMPurify walks, so it is allowed, or every report would count one removal. `FORCE_BODY` parses raw HTML at the very
 * start of a report into the body: without it a leading `<title>`, `<style>`, `<meta>` or `<script>` lands in `<head>`, which DOMPurify never
 * walks, and disappears without being counted.
 */
export const PURIFY_CONFIG: Config = {
  ALLOWED_TAGS: ['body', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'em', 'strong', 'del', 'a', 'b', 'i', 's', 'sub', 'sup', 'kbd'],
  ALLOWED_ATTR: ['href', 'align', 'start'],
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'],
  FORBID_ATTR: ['style', 'hidden'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  FORCE_BODY: true,
};

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ESCAPES[char]!);

/** marked with the two renderers whose output would otherwise lose an attribute to the sanitizer: code blocks drop the `language-` class, task boxes become text. */
const markdown = new Marked({
  async: false,
  renderer: {
    code({ text, escaped }) {
      const body = `${text.replace(/\n$/, '')}\n`;
      return `<pre><code>${escaped ? body : escapeHtml(body)}</code></pre>\n`;
    },
    checkbox({ checked }) { return checked ? '☑' : '☐'; },
  },
});

/** DOMPurify where there is a DOM to run it on, else nothing. */
const browserSanitizer = (): Sanitizer | undefined => (DOMPurify.isSupported ? DOMPurify : undefined);
/** The `<remove>` element `FORCE_BODY` puts in front of the report and takes out first: not something the report held. */
const isSentinel = (entry: unknown) => (entry as { element?: { nodeName?: string } } | null | undefined)?.element?.nodeName === 'REMOVE';

/**
 * The report as sanitized HTML, and how many elements and attributes the sanitizer removed from it; `undefined` where no sanitizer can run,
 * so the caller shows the text as it is rather than HTML nobody checked.
 */
export function renderMarkdown(text: string, sanitizer: Sanitizer | undefined = browserSanitizer()): { html: string; removed: number } | undefined {
  if (!sanitizer) return undefined;
  const parsed = markdown.parse(text) as string;
  // DOMPurify turns empty input into a comment of its own, then counts removing it.
  if (parsed === '') return { html: '', removed: 0 };
  const html = sanitizer.sanitize(parsed, PURIFY_CONFIG);
  return { html, removed: sanitizer.removed.filter((entry, index) => !(index === 0 && isSentinel(entry))).length };
}

/** A link reference definition (`[label]: url`, `[//]: # (comment)`) behind any indent, quote markers and list bullets: marked shows none of it. */
const LINK_DEFINITION = /^(?:[ \t>]|(?:[*+-]|\d{1,9}[.)])[ \t])*\[(?!\s*\])(?:\\.|[^\[\]\\])+\]:/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** How many lines of `text`, outside what looks like fenced code, are link reference definitions; a repeated label counts each time. */
function definitionLines(text: string): number {
  let count = 0, open: string | undefined;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const fence = FENCE.exec(line)?.[1];
    if (fence !== undefined && (open === undefined || (fence[0] === open[0] && fence.length >= open.length))) {
      open = open === undefined ? fence : undefined;
      continue;
    }
    if (open === undefined && LINK_DEFINITION.test(line)) count++;
  }
  return count;
}

/**
 * How many link reference definitions `text` holds, which marked shows none of. Two counts, the larger wins: the line count sees a label
 * defined twice (marked keeps one entry per label), marked's own lexer sees what the lines cannot (a label split over two lines, a definition
 * after a line that only looks like a fence, or after a fence-like line inside raw HTML).
 */
export function linkDefinitions(text: string): number {
  return Math.max(definitionLines(text), Object.keys(markdown.lexer(text).links).length);
}

/** Characters a reader cannot see but a model reads: zero-width marks and joiners, bidirectional controls, the BOM, tag characters, supplementary variation selectors. */
const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
/** Named character references for those characters. Named ones count only with their `;`, as HTML reads them; numeric ones count without. */
const HIDDEN_NAMES: Record<string, number> = {
  ZeroWidthSpace: 0x200b, NegativeVeryThinSpace: 0x200b, NegativeThinSpace: 0x200b, NegativeMediumSpace: 0x200b, NegativeThickSpace: 0x200b,
  zwnj: 0x200c, zwj: 0x200d, lrm: 0x200e, rlm: 0x200f, NoBreak: 0x2060, af: 0x2061, ApplyFunction: 0x2061, it: 0x2062,
  InvisibleTimes: 0x2062, ic: 0x2063, InvisibleComma: 0x2063,
};
const ENTITY = /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*);)/g;
const isHidden = (codePoint: number) => codePoint <= 0x10ffff && String.fromCodePoint(codePoint).match(HIDDEN) !== null;
/** Invisible characters in `text`, written as they are or as HTML character references (`&#x200B;`, `&#8238;`, `&zwj;`), which the page decodes. */
export function hiddenCharacters(text: string): number {
  let encoded = 0;
  for (const [, hex, decimal, name] of text.matchAll(ENTITY)) {
    const codePoint = hex !== undefined ? parseInt(hex, 16) : decimal !== undefined ? Number(decimal) : HIDDEN_NAMES[name!];
    if (codePoint !== undefined && isHidden(codePoint)) encoded++;
  }
  return (text.match(HIDDEN)?.length ?? 0) + encoded;
}
/** The text with each invisible character written out as `⟦U+XXXX⟧`. */
export const revealHidden = (text: string): string =>
  text.replace(HIDDEN, char => `⟦U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟧`);

/** Links in a report open in a new tab: a plain click would take the whole DSH window away. Anything but http(s) stays put. */
function openLink(event: MouseEvent<HTMLElement>): void {
  const anchor = event.target instanceof Element ? event.target.closest('a') : null;
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute('href') ?? '';
  if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
}

/** A report, formatted, with what the formatting does not show counted above it and the raw text behind 看原文. `sanitizer` is for tests. */
export function Markdown({ text, sanitizer }: { text: string; sanitizer?: Sanitizer }) {
  const { Button } = useUi();
  const [raw, setRaw] = useState(false);
  // A report marked cannot parse shows as raw text rather than taking the page down.
  const rendered = useMemo(() => { try { return renderMarkdown(text, sanitizer); } catch { return undefined; } }, [text, sanitizer]);
  // A report that comes out of the sanitizer without any text (a leading `<frameset>` takes the whole body with it) is shown as it is.
  const blank = rendered !== undefined && text.trim() !== '' && rendered.html.replace(/<[^>]*>/g, '').trim() === '';
  const formatted = blank ? undefined : rendered;
  const definitions = useMemo(() => { try { return linkDefinitions(text); } catch { return 0; } }, [text]);
  const hidden = useMemo(() => hiddenCharacters(text), [text]);
  const unshown = formatted ? [
    formatted.removed > 0 ? `有 ${formatted.removed} 处 HTML 标签或属性没有显示` : '',
    definitions > 0 ? `有 ${definitions} 行链接定义没有显示` : '',
  ].filter(Boolean) : [];
  const notes = [
    blank ? '排版后没有一个字能显示，下面是原文。' : '',
    unshown.length > 0 ? `${unshown.join('；')}，原文里能看到。` : '',
    hidden > 0 ? `有 ${hidden} 个看不见的字符，原文里能看到。` : '',
  ].filter(Boolean);
  return <div className="oc-report-body">
    {(notes.length > 0 || formatted) && <div className="oc-report-tools">
      {notes.map(note => <p key={note} className="oc-warning" role="note">{note}</p>)}
      {formatted && <Button variant="ghost" size="sm" aria-pressed={raw} onClick={() => setRaw(value => !value)}>{raw ? '看排版' : '看原文'}</Button>}
    </div>}
    {raw || !formatted
      ? <pre className="oc-raw">{revealHidden(text)}</pre>
      : <div className="oc-markdown" onClick={openLink} dangerouslySetInnerHTML={{ __html: formatted.html }} />}
  </div>;
}
