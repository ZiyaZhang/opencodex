/** The `report` action: the evidence pack, one analyst session, then the report recorded on the candidate. */
import { join } from 'node:path';
import { canTransition, transition, type Candidate, type Evidence, type Status } from '../../core/candidate.js';
import { GitHubError, type GitHubClient } from '../github.js';
import { buildEvidencePack, diffsFor, dshHitsFor } from '../report/evidence-pack.js';
import { generateReport } from '../report/report-session.js';
import { excerptOf } from '../sources/codex-releases.js';
import { exclusive, messageOf, mirrorOf, type HostContext } from './context.js';

/** The checkpoint that counts the reports finished on a UTC day; checkpoint names allow no `:`, hence `reportsOn-2026-10-15`. */
const counterOf = (day: string) => `reportsOn-${day}`;

function refusal(status: Status): string {
  return status === 'ignored' ? '已忽略的候选不能生成报告，先恢复它' : `状态为 ${status} 的候选不能生成报告`;
}

async function finishedOn(ctx: HostContext, day: string): Promise<number> {
  const value = await ctx.store.checkpoint(counterOf(day));
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw new Error(`state.json 里的 ${counterOf(day)} 不是数字：${value}`);
  return Number(value);
}

/** Counts the report in against the daily limit, the reports still running included, or refuses it. */
function admit(ctx: HostContext, day: string, limit: number): Promise<void> {
  return ctx.lanes.reports.run(async () => {
    const finished = await finishedOn(ctx, day);
    if (finished + ctx.reportsRunning >= limit) {
      throw new Error(`今天（UTC）已生成 ${finished} 份报告${ctx.reportsRunning ? `、还有 ${ctx.reportsRunning} 份在生成` : ''}，达到每日上限 ${limit} 份；明天再试，或在设置里调高每日报告上限`);
    }
    ctx.reportsRunning++;
  });
}

/** Lets the report go from the running count; a recorded one goes into the day's counter in the same step. */
function release(ctx: HostContext, day: string, recorded: boolean): Promise<void> {
  return ctx.lanes.reports.run(async () => {
    try { if (recorded) await ctx.store.setCheckpoint(counterOf(day), String(await finishedOn(ctx, day) + 1)); } finally { ctx.reportsRunning--; }
  });
}

/**
 * Gives the bare pull request entries of the candidate (a `#N` without a URL, which a failed or rate-limited lookup leaves) the URL and
 * excerpt a lookup gives, and saves them on the candidate with one patch. A lookup that fails again keeps its entry bare and adds a line
 * to `gaps`; after a rate limit no more are asked.
 */
async function withPullRequests(ctx: HostContext, candidate: Candidate, github: GitHubClient, gaps: string[]): Promise<Candidate> {
  const refs = [...new Set(candidate.evidence.filter(entry => entry.kind === 'pr' && entry.url === undefined).map(entry => entry.ref))];
  const found = new Map<string, Evidence>();
  let limited = false;
  for (const ref of refs) {
    const number = /^#(\d+)$/.exec(ref)?.[1];
    if (number === undefined) continue;
    if (limited) { gaps.push(`no details for ${ref}: not asked after the GitHub rate limit`); continue; }
    ctx.signal.throwIfAborted();
    try {
      const pr = await github.pullRequest(Number(number), ctx.signal);
      found.set(ref, { kind: 'pr', ref, url: pr.url, excerpt: excerptOf(pr) });
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      limited = error instanceof GitHubError && error.rateLimited;
      gaps.push(`no details for ${ref}: ${messageOf(error)}`);
    }
  }
  if (found.size === 0) return candidate;
  return ctx.store.patch(candidate.id, current => ({
    ...current, evidence: current.evidence.map(entry => (entry.kind === 'pr' && entry.url === undefined ? found.get(entry.ref) ?? entry : entry)),
  }));
}

/**
 * Writes the gap report of candidate `id`. Refused before anything happens when its status cannot move to `reported`, when no mirror path
 * is set, when the candidate has a task running, and when the day's reports (finished and running) reach `dailyReportLimit`. Then the bare
 * pull request entries are repaired, the evidence pack is built in `reports/<id>/evidence/` (index hits, diffs, and what could not be read),
 * one analyst session writes `reports/<id>/report.md`, and one patch moves the candidate to `reported` with the report record. Only a
 * recorded report counts toward the day. A session failure rejects with `generateReport`'s `ReportSessionError`, whose message names the
 * session (`（会话 <id>）`).
 */
export async function report(ctx: HostContext, id: string): Promise<void> {
  await exclusive(ctx, id, 'report', async () => {
    const candidate = await ctx.store.get(id);
    if (!canTransition(candidate.status, 'reported')) throw new Error(refusal(candidate.status));
    const settings = ctx.settings();
    const mirror = mirrorOf(settings);
    const day = ctx.now().toISOString().slice(0, 10);
    await admit(ctx, day, settings.dailyReportLimit);
    let recorded = false;
    try {
      const github = ctx.github();
      const gaps: string[] = [];
      const repaired = await withPullRequests(ctx, candidate, github, gaps);
      const { index } = ctx;
      if (!index) gaps.push('no DSH index hits: the index has not been built yet');
      const dshHits = index ? dshHitsFor(index, repaired) : [];
      const diffs = await diffsFor(repaired, { github, snapshotDir: join(ctx.directory, 'snapshots'), onError: gap => gaps.push(gap) }, ctx.signal);
      const reportDir = join(ctx.directory, 'reports', id);
      await buildEvidencePack({ directory: reportDir, candidate: repaired, diffs, dshHits, mirror, gaps });
      const record = await generateReport(ctx.services, {
        candidate: repaired, reportDir, mirror, model: settings.reportModel, signal: ctx.signal,
        ...(settings.reportPreset && { preset: settings.reportPreset }), ...(ctx.reportPollMs !== undefined && { pollMs: ctx.reportPollMs }),
      });
      ctx.signal.throwIfAborted();
      const at = ctx.now().toISOString();
      await ctx.store.patch(id, current => ({ ...transition(current, 'reported', at), report: record }));
      recorded = true;
    } finally {
      await release(ctx, day, recorded);
    }
  });
}
