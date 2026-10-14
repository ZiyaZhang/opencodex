/** Bounded, model-free discovery of individual product announcements. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenCodexStore } from '../core/index.js';
import { parseChangelog } from './changelog-parser.js';

export const DISCOVERY_SOURCES = [
  { id: 'codex-changelog', title: 'Codex product changelog', url: 'https://learn.chatgpt.com/docs/changelog/rss.xml', fallbackUrl: 'https://learn.chatgpt.com/docs/changelog', pageUrl: 'https://learn.chatgpt.com/docs/changelog' },
] as const;
interface Observation { hash: string; etag?: string; checkedAt: string; url?: string }
interface DiscoveryState { schemaVersion: 2; sources: Record<string, Observation> }
export interface ScanResult { baseline: number; unchanged: number; changed: number; discovered?: number; errors: string[] }
const MAX_BYTES = 1_500_000;

/** Read at most MAX_BYTES; reject redirects so a source cannot become a local-network request. */
export async function fetchDiscoverySource(url: string, etag: string | undefined, signal: AbortSignal): Promise<{ notModified: boolean; hash?: string; etag?: string; content?: string }> {
  const response = await fetch(url, {
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { Accept: 'application/rss+xml,application/xml,text/html,text/markdown', 'User-Agent': 'OpenCodex-discovery/0.1', ...(etag ? { 'If-None-Match': etag } : {}) },
  });
  if (response.status === 304) {
    if (!etag) throw new Error('Unexpected 304 without a compatible saved feature checkpoint');
    return { notModified: true };
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') ?? '0') > MAX_BYTES) throw new Error('Source exceeds discovery byte limit');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty source response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('Source exceeds discovery byte limit');
      chunks.push(item.value);
    }
  } finally { await reader.cancel(); }
  const content = Buffer.concat(chunks).toString('utf8');
  const normalized = content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/\s+/g, ' ').trim();
  return { notModified: false, content, hash: createHash('sha256').update(normalized).digest('hex'), ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}) };
}

/** Persist feature checkpoints only after every candidate was durably saved. */
export async function scanSources(directory: string, store: OpenCodexStore, signal: AbortSignal): Promise<ScanResult> {
  const file = join(directory, 'discovery.json');
  let state: DiscoveryState;
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as { schemaVersion: number; sources: Record<string, Observation> };
    if (![1, 2].includes(saved.schemaVersion) || !saved.sources || typeof saved.sources !== 'object' || Array.isArray(saved.sources)) throw new Error('Invalid discovery state');
    // Version 1 retained only whole-page hashes. Its ETags cannot suppress the first feature parse.
    state = { schemaVersion: 2, sources: saved.schemaVersion === 2 ? saved.sources : {} };
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    state = { schemaVersion: 2, sources: {} };
  }
  const result: ScanResult = { baseline: 0, unchanged: 0, changed: 0, discovered: 0, errors: [] };
  for (const source of DISCOVERY_SOURCES) {
    signal.throwIfAborted();
    const previous = state.sources[source.id];
    try {
      let successfulUrl = source.url as string;
      const readFeatures = async (url: string) => {
        const fetched = await fetchDiscoverySource(url, previous?.url === url ? previous.etag : undefined, signal);
        if (fetched.notModified) return { fetched, features: [] };
        if (!fetched.hash || fetched.content === undefined) throw new Error('Missing source content or hash');
        return { fetched, features: parseChangelog(fetched.content, source.pageUrl) };
      };
      let observed;
      try { observed = await readFeatures(source.url); }
      catch (rssError) {
        signal.throwIfAborted();
        successfulUrl = source.fallbackUrl;
        try { observed = await readFeatures(source.fallbackUrl); }
        catch (htmlError) { throw new Error(`RSS: ${rssError instanceof Error ? rssError.message : String(rssError)}; HTML: ${htmlError instanceof Error ? htmlError.message : String(htmlError)}`); }
      }
      const { fetched, features } = observed;
      if (fetched.notModified) { result.unchanged++; continue; }
      if (!fetched.hash || fetched.content === undefined) throw new Error('Missing source content or hash');
      const known = new Set(store.snapshot().candidates.map(candidate => candidate.fingerprint));
      for (const feature of features) {
        signal.throwIfAborted();
        await store.saveCandidate({ ...feature, sourceType: 'public-source' });
        if (!known.has(feature.fingerprint)) { result.discovered!++; known.add(feature.fingerprint); }
      }
      // Retire only untouched legacy page-hash notices; selections and their jobs are preserved.
      for (const candidate of store.snapshot().candidates) {
        if (candidate.status === 'new' && /^(?:codex-changelog|codex-cli-releases):[a-f0-9]{64}$/.test(candidate.fingerprint)) {
          await store.saveCandidate({ title: candidate.title, description: candidate.description, sourceUrl: candidate.sourceUrl, fingerprint: candidate.fingerprint, status: 'dismissed', ...(candidate.sourceType ? { sourceType: candidate.sourceType } : {}) });
        }
      }
      if (!previous) result.baseline++;
      else if (previous.hash === fetched.hash) result.unchanged++;
      else result.changed++;
      state.sources[source.id] = { hash: fetched.hash, checkedAt: new Date().toISOString(), url: successfulUrl, ...(fetched.etag ? { etag: fetched.etag } : {}) };
      await mkdir(directory, { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
      await rename(temp, file);
    } catch (error) {
      signal.throwIfAborted();
      result.errors.push(`${source.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
