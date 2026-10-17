/** The `report` action: the evidence pack, one analyst session, then the report recorded on the candidate. */
import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { canTransition, transition, type Candidate, type Evidence, type Status } from '../../core/candidate.js';
import { GitHubError, type GitHubClient } from '../github.js';
import { buildEvidencePack, diffsFor, dshHitsFor, type DiffFile } from '../report/evidence-pack.js';
import { generateReport } from '../report/report-session.js';
import { excerptOf } from '../sources/codex-releases.js';
import { exclusive, messageOf, mirrorOf, withDeadline, type HostContext } from './context.js';

/** The checkpoint that counts the analyst sessions started on a UTC day; checkpoint names allow no `:`, hence `reportsOn-2026-10-15`. */
const counterOf = (day: string) => `reportsOn-${day}`;
const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');

function refusal(status: Status): string {
  return status === 'ignored' ? '已忽略的候选不能生成报告，先恢复它' : `状态为 ${status} 的候选不能生成报告`;
}

async function startedOn(ctx: HostContext, day: string): Promise<number> {
  const value = await ctx.store.checkpoint(counterOf(day));
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw new Error(`state.json 里的 ${counterOf(day)} 不是数字：${value}`);
  return Number(value);
}

/**
 * A report refused because the day's analyst sessions, with the reports admitted and not yet at their session, reach `dailyReportLimit`.
 * A class of its own so that automatic research can tell it from a failure of the candidate: it stops the queue rather than going on.
 */
export class DailyLimitError extends Error {
  constructor(taken: number, limit: number) {
    super(`今天（UTC）的报告已有 ${taken} 份（含正在生成的），达到每日上限 ${limit} 份；明天再试，或在设置里调高每日报告上限`);
    this.name = 'DailyLimitError';
  }
}

/**
 * The daily limit counts analyst sessions: every one costs model tokens, the ones that time out or fail included. A report is admitted
 * when the sessions started today plus the reports admitted and not yet at their session stay under the limit; it counts once its
 * session is about to start (`countSession`), and leaves the admitted ones (`release`) if it ends before that. A run whose session never
 * came to exist (`create` refused it) gives its place back (`refund`). Each step runs in the counter's lane, so two reports cannot both
 * take the last place.
 */
function admit(ctx: HostContext, day: string, limit: number): Promise<void> {
  return ctx.lanes.reports.run(async () => {
    const taken = await startedOn(ctx, day) + ctx.reportsRunning;
    if (taken >= limit) throw new DailyLimitError(taken, limit);
    ctx.reportsRunning++;
  });
}
function countSession(ctx: HostContext, day: string): Promise<void> {
  return ctx.lanes.reports.run(async () => {
    await ctx.store.setCheckpoint(counterOf(day), String(await startedOn(ctx, day) + 1));
    ctx.reportsRunning--;
  });
}
function release(ctx: HostContext): Promise<void> {
  return ctx.lanes.reports.run(async () => { ctx.reportsRunning--; });
}
function refund(ctx: HostContext, day: string): Promise<void> {
  return ctx.lanes.reports.run(async () => {
    const started = await startedOn(ctx, day);
    if (started > 0) await ctx.store.setCheckpoint(counterOf(day), String(started - 1));
  });
}
/** Whether a failure of `generateReport` came after its session existed: from then on it rejects with a `ReportSessionError` naming it. */
const hadSession = (error: unknown) => typeof error === 'object' && error !== null && typeof (error as { sessionId?: unknown }).sessionId === 'string';

/**
 * Gives the bare pull request entries of the candidate (a `#N` without a URL, which a failed or rate-limited lookup leaves) the URL and
 * excerpt a lookup gives, and saves them on the candidate with one patch. A lookup that fails again keeps its entry bare and adds a line
 * to `gaps`; after a rate limit no more are asked.
 */
async function withPullRequests(ctx: HostContext, candidate: Candidate, github: GitHubClient, gaps: string[], signal: AbortSignal): Promise<Candidate> {
  const refs = [...new Set(candidate.evidence.filter(entry => entry.kind === 'pr' && entry.url === undefined).map(entry => entry.ref))];
  const found = new Map<string, Evidence>();
  let limited = false;
  for (const ref of refs) {
    const number = /^#(\d+)$/.exec(ref)?.[1];
    if (number === undefined) continue;
    if (limited) { gaps.push(`no details for ${ref}: not asked after the GitHub rate limit`); continue; }
    signal.throwIfAborted();
    try {
      const pr = await github.pullRequest(Number(number), signal);
      found.set(ref, { kind: 'pr', ref, url: pr.url, excerpt: excerptOf(pr) });
    } catch (error) {
      if (signal.aborted) throw error;
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
 * Moves an earlier `evidence/` aside to `evidence.prev/`, replacing an older backup, and returns how to put it back and how to drop it;
 * undefined when there is no `evidence/`, in which case a backup already there is left alone. A failed rerun puts the earlier report back
 * (`report.prev.md`), and its evidence goes back with it.
 */
async function setEvidenceAside(reportDir: string): Promise<{ putBack(): Promise<void>; drop(): Promise<void> } | undefined> {
  const evidence = join(reportDir, 'evidence'), backup = join(reportDir, 'evidence.prev');
  const present = await stat(evidence).then(() => true, error => { if (isMissing(error)) return false; throw error; });
  if (!present) return undefined;
  await rm(backup, { recursive: true, force: true });
  await rename(evidence, backup);
  return {
    async putBack() { await rm(evidence, { recursive: true, force: true }); await rename(backup, evidence); },
    async drop() { await rm(backup, { recursive: true, force: true }); },
  };
}

/**
 * Writes the gap report of candidate `id`. Refused before anything happens when its status cannot move to `reported`, when no mirror path
 * is set, when the candidate has a task running, and when the day's analyst sessions, with the reports admitted before this one, reach
 * `dailyReportLimit` (a `DailyLimitError`). Then:
 * 1. the GitHub part, with 10 minutes (`timeouts.github`) to finish: the bare pull request entries are repaired, the diffs fetched;
 * 2. the evidence pack is built in `reports/<id>/evidence/` (index hits, diffs, and what could not be read), the earlier one set aside;
 * 3. one analyst session writes `reports/<id>/report.md` (it counts toward the day from here, unless it never came to exist); its failure
 *    is `generateReport`'s `ReportSessionError`, whose message names the session, and puts the earlier report and evidence back;
 * 4. one patch moves the candidate to `reported` with the report record. A finished report is recorded even when the plugin is unloading
 *    meanwhile, and a patch that fails names the session that wrote it.
 */
export async function report(ctx: HostContext, id: string): Promise<void> {
  await exclusive(ctx, id, 'report', async () => {
    const candidate = await ctx.store.get(id);
    if (!canTransition(candidate.status, 'reported')) throw new Error(refusal(candidate.status));
    const settings = ctx.settings();
    const mirror = mirrorOf(settings);
    const day = ctx.now().toISOString().slice(0, 10);
    await admit(ctx, day, settings.dailyReportLimit);
    let counted = false;
    try {
      const github = ctx.github();
      const gaps: string[] = [];
      const minutes = Math.round(ctx.timeouts.github / 60_000);
      const { repaired, diffs } = await withDeadline(ctx, ctx.timeouts.github, `从 GitHub 取证据超过 ${minutes} 分钟还没结束，已停止；稍后再生成`,
        async (signal): Promise<{ repaired: Candidate; diffs: DiffFile[] }> => {
          const repaired = await withPullRequests(ctx, candidate, github, gaps, signal);
          return { repaired, diffs: await diffsFor(repaired, { github, snapshotDir: join(ctx.directory, 'snapshots'), onError: gap => gaps.push(gap) }, signal) };
        });
      const { index } = ctx;
      if (!index) gaps.push('no DSH index hits: the index has not been built yet');
      const reportDir = join(ctx.directory, 'reports', id);
      const aside = await setEvidenceAside(reportDir);
      let record;
      try {
        await buildEvidencePack({ directory: reportDir, candidate: repaired, diffs, dshHits: index ? dshHitsFor(index, repaired) : [], mirror, gaps });
        await countSession(ctx, day);
        counted = true;
        record = await generateReport(ctx.services, {
          candidate: repaired, reportDir, mirror, model: settings.reportModel, signal: ctx.signal,
          ...(settings.reportPreset && { preset: settings.reportPreset }), ...(ctx.reportPollMs !== undefined && { pollMs: ctx.reportPollMs }),
        });
      } catch (error) {
        if (counted && !hadSession(error)) await refund(ctx, day);
        try { await aside?.putBack(); } catch (restoring) {
          throw new Error(`${messageOf(error)}；另外，上一份证据没能放回：${messageOf(restoring)}`, { cause: error });
        }
        throw error;
      }
      await aside?.drop();
      const at = ctx.now().toISOString();
      const done = record;
      try {
        await ctx.store.patch(id, current => ({ ...transition(current, 'reported', at), report: done }));
      } catch (error) {
        throw new Error(`报告已写好（分析会话 ${done.sessionId ?? '未知'}），但没能记到候选上：${messageOf(error)}`, { cause: error });
      }
    } finally {
      if (!counted) await release(ctx);
    }
  });
}
