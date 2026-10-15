/** Small, versioned public-SDK views; never recursively inventory the framework. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { OpenCodexStore } from '../core/store.js';

export const SDK_PACKAGES = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-user-questions', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-compaction', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-token-meter'] as const;
export async function inspectSdk(input: { package: string; path?: string; symbol?: string; offset?: number }, workdir?: string) {
  if (!SDK_PACKAGES.includes(input.package as typeof SDK_PACKAGES[number])) throw new Error(`Choose one SDK package: ${SDK_PACKAGES.join(', ')}`);
  if (input.symbol !== undefined && (!input.symbol.trim() || input.symbol.length > 120)) throw new Error('SDK symbol must be 1–120 characters');
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0)) throw new Error('SDK offset must be a nonnegative integer');
  const resolvers = [createRequire(import.meta.url), ...(workdir ? [createRequire(join(workdir, 'plugin/package.json'))] : [])];
  let manifestPath: string | undefined;
  for (const resolver of resolvers) { try { manifestPath = resolver.resolve(`${input.package}/package.json`); break; } catch { /* Next known package location. */ } }
  if (!manifestPath) return { package: input.package, available: false as const, next: 'The package is not installed in this host or feature workspace. Install the declared template dependencies before requesting its types.' };
  const root = await realpath(dirname(manifestPath));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entries = Object.entries(manifest.exports ?? {}).flatMap(([entry, value]) => typeof value === 'object' && value && 'types' in value && typeof value.types === 'string' ? [{ entry, path: value.types.replace(/^\.\//, '') }] : []);
  const preferredEntry = input.package.startsWith('@deepseek-ai/dsh-client-') ? './client' : '.';
  const path = input.path ?? entries.find(entry => entry.entry === preferredEntry)?.path ?? entries.find(entry => entry.entry === '.')?.path;
  if (!path || !/^lib\/[\w./-]+\.d\.ts$/.test(path) || path.split('/').includes('..')) throw new Error('SDK reads accept a declaration path from the returned package index');
  const file = await realpath(join(root, path)), rel = relative(root, file);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('SDK declaration escaped its package');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 500_000) throw new Error('SDK declaration exceeds the bounded read limit');
  const source = await readFile(file, 'utf8'), sha256 = createHash('sha256').update(source).digest('hex');
  const match = input.symbol ? source.indexOf(input.symbol) : -1;
  const offset = input.offset ?? (match >= 0 ? Math.max(0, match - 500) : 0);
  const content = source.slice(offset, offset + 5000);
  const related = [...source.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)].slice(0, 30).map(match => join(dirname(path), match[1]!.replace(/(?<!\.d)\.(?:js|ts)$/, '.d.ts')));
  return { package: manifest.name, version: manifest.version, available: true as const, entries, path, sha256, offset, totalCharacters: source.length, content, ...(offset + content.length < source.length ? { nextOffset: offset + content.length } : {}), ...(input.symbol ? { symbolFound: match >= 0, searchScope: path } : {}), related, note: 'Public type declarations establish signatures, not observed behavior. Follow only the declaration that resolves the next implementation decision.' };
}

/** Retained views survive context handoffs; a repeated view reuses its evidence ID. */
export async function inspectJobSdk(store: OpenCodexStore, jobId: string, input: Parameters<typeof inspectSdk>[0]) {
  const result = await inspectSdk(input, store.getJob(jobId).workdir);
  if (!result.available) return result;
  // Keep declaration newlines literal. File readers often truncate a single long
  // JSON string before the caller can reach the exported signatures.
  const { content, ...metadata } = result;
  const bytes = Buffer.from(`# Public SDK declaration\n\n${JSON.stringify(metadata, null, 2)}\n\n## Declaration excerpt\n\n${content}\n`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const path = `${jobId}/sdk/${digest}.md`, target = join(store.artifactRoot, path);
  const existing = store.snapshot().evidence.find(item => item.jobId === jobId && item.localPath === path && item.sha256 === digest);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try { await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(target)).isFile() || !(await readFile(target)).equals(bytes)) throw error; }
  const evidence = existing ?? await store.addEvidence(jobId, { kind: 'observed', localPath: path, claim: `Public SDK declaration ${result.package}@${result.version}, ${result.path}, characters ${result.offset}–${result.offset + result.content.length}, source digest ${result.sha256}. This establishes only the returned signature, not runtime behavior or feature equivalence.` });
  return { ...result, evidenceId: evidence.id, savedView: relative(store.getJob(jobId).workdir!, target) };
}
