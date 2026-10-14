/** Bounded, model-free version discovery. A first observation is only a baseline. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenCodexStore } from '../core/index.js';

export const DISCOVERY_SOURCES = [
  { id: 'codex-changelog', title: 'Codex changelog', url: 'https://learn.chatgpt.com/docs/changelog.md' },
  { id: 'codex-cli-releases', title: 'Codex CLI releases', url: 'https://api.github.com/repos/openai/codex/releases?per_page=10' },
] as const;
interface Observation { hash: string; etag?: string; checkedAt: string; }
interface DiscoveryState { schemaVersion: 1; sources: Record<string, Observation> }
export interface ScanResult { baseline: number; unchanged: number; changed: number; errors: string[] }
const MAX_BYTES = 1_500_000;

/** Read at most MAX_BYTES; reject redirects so a source cannot become a local-network request. */
export async function fetchDiscoverySource(url: string, etag: string | undefined, signal: AbortSignal): Promise<{ notModified: boolean; hash?: string; etag?: string }> {
  const response = await fetch(url, {
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { Accept: 'text/markdown,text/html,application/json', 'User-Agent': 'OpenCodex-discovery/0.1', ...(etag ? { 'If-None-Match': etag } : {}) },
  });
  if (response.status === 304) return { notModified: true };
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
  // Ignore script/style build hashes and whitespace. A change remains an unverified source signal.
  let normalized: string;
  if (response.headers.get('content-type')?.includes('json')) {
    const releases: unknown = JSON.parse(content);
    if (!Array.isArray(releases)) throw new Error('Expected GitHub release list');
    normalized = JSON.stringify(releases.map(value => {
      if (!value || typeof value !== 'object') throw new Error('Invalid release entry');
      const release = value as Record<string, unknown>;
      return { id: release.id, tag: release.tag_name, title: release.name, body: release.body, publishedAt: release.published_at, prerelease: release.prerelease };
    }));
  } else normalized = content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { notModified: false, hash: createHash('sha256').update(normalized).digest('hex'), ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}) };
}

/** Persist source checkpoints only after each candidate was saved successfully. */
export async function scanSources(directory: string, store: OpenCodexStore, signal: AbortSignal): Promise<ScanResult> {
  const file = join(directory, 'discovery.json');
  let state: DiscoveryState;
  try {
    state = JSON.parse(await readFile(file, 'utf8')) as DiscoveryState;
    if (state.schemaVersion !== 1 || !state.sources || typeof state.sources !== 'object') throw new Error('Invalid discovery state');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    state = { schemaVersion: 1, sources: {} };
  }
  const result: ScanResult = { baseline: 0, unchanged: 0, changed: 0, errors: [] };
  for (const source of DISCOVERY_SOURCES) {
    signal.throwIfAborted();
    const previous = state.sources[source.id];
    try {
      const fetched = await fetchDiscoverySource(source.url, previous?.etag, signal);
      if (fetched.notModified) { result.unchanged++; continue; }
      if (!fetched.hash) throw new Error('Missing source hash');
      if (!previous) result.baseline++;
      else if (previous.hash === fetched.hash) result.unchanged++;
      else {
        await store.saveCandidate({
          title: `${source.title} changed — unverified`,
          description: 'The official source content changed. This may be a feature, a fix, documentation or page formatting; it has not been tested. Select this item to investigate within a chosen budget.',
          sourceUrl: source.url, fingerprint: `${source.id}:${fetched.hash}`,
        });
        result.changed++;
      }
      state.sources[source.id] = { hash: fetched.hash, checkedAt: new Date().toISOString(), ...(fetched.etag ? { etag: fetched.etag } : {}) };
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
