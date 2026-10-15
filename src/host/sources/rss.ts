/** Source 4: the official changelog RSS, read only for desktop and cloud product announcements.
 * The shared changelog parser already drops model notices, iOS entries and CLI releases (bar CLI bullets that name a runtime feature); CLI features come from the GitHub source.
 */
import { createHash } from 'node:crypto';
import type { CandidateStore } from '../../core/store.js';
import { parseChangelog, type ChangelogFeature } from '../changelog-parser.js';
import { publicNetwork } from '../public-network.js';

// Answers 308 and redirects to https://learn.chatgpt.com/docs/changelog/rss.xml; fetch follows it.
export const RSS_URL = 'https://developers.openai.com/codex/changelog/rss.xml';
const PAGE_URL = 'https://developers.openai.com/codex/changelog';
const USER_AGENT = 'dsh-opencodex/0.3';
/** The feed is under 1 MB today; a body past this cap is not the changelog and is never hashed or parsed. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function rssCandidates(xml: string, pageUrl: string, now = new Date()): ChangelogFeature[] {
  return parseChangelog(xml, pageUrl, { now, maxAgeDays: 120, maxReleases: 40, maxFeatures: 120 });
}

/** Reads the body as UTF-8 text; the stream is cancelled the moment it crosses the cap, so an oversized upstream is not read to its end. */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`RSS body exceeds ${MAX_BODY_BYTES / 2 ** 20} MB`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Fetches the feed, stores each announcement as an `rss` candidate and returns how many were new.
 * A body whose sha256 matches the saved `rssHash` is skipped before parsing; the hash is saved only after every upsert succeeded, so a failed run is retried whole.
 * `fetcher` replaces the proxy-aware public network (tests); `now` anchors the parser's 120-day window.
 */
export async function collectRss(store: CandidateStore, signal: AbortSignal, fetcher?: typeof fetch, now = new Date()): Promise<number> {
  const network = fetcher ? { fetch: fetcher, close: async () => {} } : await publicNetwork(signal);
  try {
    const response = await network.fetch(RSS_URL, { signal, headers: { Accept: 'application/rss+xml', 'User-Agent': USER_AGENT } });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`RSS HTTP ${response.status}`);
    }
    const xml = await readCapped(response);
    const hash = createHash('sha256').update(xml).digest('hex');
    if (await store.checkpoint('rssHash') === hash) return 0;
    let added = 0;
    for (const item of rssCandidates(xml, PAGE_URL, now)) {
      const { created } = await store.upsert({
        source: 'rss', key: item.fingerprint, title: item.title, summary: item.description,
        evidence: [{ kind: 'rss', ref: item.releaseTitle, url: item.sourceUrl, excerpt: item.description.slice(0, 1_000) }],
      });
      if (created) added++;
    }
    await store.setCheckpoint('rssHash', hash);
    return added;
  } finally { await network.close(); }
}
