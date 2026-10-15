import type { Job, StoreState } from '../core/types.js';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenCodexStore } from '../core/store.js';
import type { ResourceReader } from './resources.js';

import { researchAllowance } from '../core/research.js';
export { researchAllowance, researchAdmissionError } from '../core/research.js';

export async function developmentRecipe(reader: ResourceReader, job: Job): Promise<string> {
  if (job.status !== 'building') return '';
  const target = `${job.title} ${job.description}`;
  const id = /ask_user_question|question card|问题卡|非阻断提问/i.test(target) ? 'async-questions'
    : /猜你想问|ghost text|prompt prediction|灰字补全/i.test(target) ? 'prompt-prediction'
    : /session communication|会话通信|跨.*会话/i.test(target) ? 'session-communication' : undefined;
  if (!id) return '';
  const index = await reader.readForAgent(id);
  const offset = index.action === 'index' ? index.headings?.find(heading => heading.level === 2)?.offset ?? 0 : 0;
  const excerpt = await reader.readForAgent(id, { action: 'read', offset, maxCharacters: 3500 });
  return `\n\nBundled implementation guidance (a starting hypothesis, not runtime proof):\n${JSON.stringify(excerpt)}\nUse the existing plugin scaffold. Read only a missing contract or compiler error, then write and test code. Source entries are plugin/src/client/index.tsx and plugin/src/host/index.ts; standard commands in plugin are npm ci, npm run build, npm test, npm run package. The package belongs in plugin/release/.`;
}

/** User requirements are a source document, never a claim about observed Codex behavior. */
export async function seedRequestEvidence(store: OpenCodexStore, job: Job): Promise<void> {
  if (job.source !== 'user' || !job.workdir) return;
  const content = `# Requested feature\n\n${job.title}\n\n${job.description}\n\nThis document records the user's requirements. It does not establish observed Codex behavior, an available DSH extension, or successful acceptance.\n`;
  const digest = createHash('sha256').update(content).digest('hex');
  const path = `${job.id}/sources/request-${digest}.md`, target = join(store.artifactRoot, path);
  await mkdir(join(job.workdir, 'sources'), { recursive: true, mode: 0o700 });
  try { await writeFile(target, content, { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(target)).isFile() || (await readFile(target, 'utf8')) !== content) throw error; }
  if (!store.snapshot().evidence.some(e => e.jobId === job.id && e.localPath === path && e.sha256 === digest)) {
    await store.addEvidence(job.id, { kind: 'observed', localPath: path, claim: 'Host retained the user-supplied feature requirements as a source document. This establishes the requested behavior only, not an observation of Codex, DSH compatibility or acceptance.' });
  }
}

export interface ExecutionPreflight { automaticAcceptance: boolean; manualAcceptance: boolean; blockers: string[] }
export function executionPreflight(job: Job, verifier: boolean, installer: boolean): ExecutionPreflight {
  const manualAcceptance = job.acceptanceMode === 'manual';
  const blockers: string[] = [];
  if (job.mode === 'reconstruct' && !manualAcceptance) {
    if (!verifier) blockers.push('尚未配置独立功能验收器；请先配置，或明确选择人工验收后生成实验包。');
    if (!installer) blockers.push('当前宿主没有可用的 DSH 插件管理服务。');
  }
  return { automaticAcceptance: verifier && installer && !manualAcceptance, manualAcceptance, blockers };
}

/** A bounded handoff is supplied directly, instead of making every session rediscover its records. */
export function executionBrief(state: StoreState, job: Job, preflight: ExecutionPreflight): string {
  const candidate = state.candidates.find(candidate => candidate.id === job.candidateId);
  const evidence = state.evidence.filter(e => e.jobId === job.id);
  const source = evidence.filter(e => e.localPath?.includes('/sources/feature-'));
  const retained = [...source, ...evidence.filter(e => !source.includes(e) && !e.localPath?.match(/\/sources\/[a-f0-9]{64}\.txt$/)).slice(-6)];
  const spec = state.specs.filter(s => s.jobId === job.id).at(-1);
  return JSON.stringify({ preflight, research: researchAllowance(state, job),
    ...(candidate ? { selectedSource: { title: candidate.title, excerpt: candidate.description.slice(0, 6000), url: candidate.sourceUrl, sourceDigest: candidate.sourceSnapshot?.sha256 } } : {}),
    evidence: retained.map(e => ({ id: e.id, kind: e.kind, claim: e.claim.slice(0, 1600), path: e.localPath?.replace(`${job.id}/`, ''), url: e.sourceUrl })),
    ...(spec ? { specification: { id: spec.id, title: spec.title, behavior: spec.behavior, visual: spec.visual, lifecycle: spec.lifecycle, gaps: spec.gaps } } : {}),
    next: spec ? 'Continue the implementation from this specification. Read only a missing declaration or a compiler error.' : 'The source and evidence IDs are already supplied. Submit the behavioral plan before broad SDK exploration. Keep unresolved implementation and acceptance details in gaps.' }, null, 2);
}
