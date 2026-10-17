/** The `start` action: a creator-mode session for a reported candidate, recorded on it; and the checks `brief` shares with it. */
import { SessionId } from '@deepseek-ai/dsh-session';
import { canTransition, transition, type Candidate, type Status } from '../../core/candidate.js';
import { ValidationError } from '../../core/check.js';
import type { ModelRoute, Settings } from '../../core/settings.js';
import { startWork } from '../start.js';
import { exclusive, messageOf, mirrorOf, type HostContext } from './context.js';

/** Why a candidate in `status` cannot start; a `new` one has no report to start from, or (restored) must be reported again. */
export function refusal(status: Status): string {
  if (status === 'new') return '先生成报告再开工';
  if (status === 'ignored') return '已忽略的候选不能开工，先恢复它';
  return `状态为 ${status} 的候选不能开工`;
}

/**
 * The checks a start and its brief share, in this order: a status that can move to `started`, a report (a record that lost it is refused
 * as a new one is), a mirror path in the settings. Each refusal is a ValidationError, so the page gets it as a bad request with the reason.
 * Returns the mirror path.
 */
export function checkStart(candidate: Candidate, settings: Readonly<Settings>): string {
  if (!canTransition(candidate.status, 'started')) throw new ValidationError(refusal(candidate.status));
  if (!candidate.report) throw new ValidationError(refusal('new'));
  try { return mirrorOf(settings); } catch (error) { throw new ValidationError(messageOf(error)); }
}

/** What one start may take instead of the default task instructions, `startModel` and `startPreset`; none of it is saved. */
export interface StartOverrides {
  /** The task instructions as the page edited them from `brief`'s (`parseRequest` trims them and keeps them to 4,000 code points). */
  instructions?: string;
  model?: ModelRoute;
  /** Empty for DSH's default preset, as in the settings. */
  preset?: string;
}

/**
 * Opens a creator-mode session (`startPreset`, on `startModel`, unless `overrides` says otherwise) for candidate `id` with its report as the
 * task, and returns the session id. Refused before anything is created when `checkStart` refuses, when the candidate has a task running, and
 * when the session of the last start is still running, whatever the status is now (`started -> started` opens another session, so two
 * clicks would open two; a report rerun moves a started candidate back to `reported` while its session may still work). Then
 * one patch moves the candidate to `started` and records the session. A session that exists but did not get its task, or that works
 * without being recorded, is named in the error.
 */
export async function start(ctx: HostContext, id: string, overrides: StartOverrides = {}): Promise<string> {
  return exclusive(ctx, id, 'start', async () => {
    const candidate = await ctx.store.get(id);
    const settings = ctx.settings();
    const mirror = checkStart(candidate, settings);
    const previous = candidate.started?.sessionId;
    if (previous !== undefined && ctx.services.agents.get(SessionId(previous))?.status === 'running') throw new Error(`上一个开工会话还在运行（会话 ${previous}）`);
    // A failure once the session exists is a StartWorkError whose message names the session.
    const { sessionId } = await startWork(ctx.services, {
      candidate, directory: ctx.directory, mirror, signal: ctx.signal, instructions: overrides.instructions,
      preset: overrides.preset ?? settings.startPreset, model: overrides.model ?? settings.startModel,
    });
    const at = ctx.now().toISOString();
    try {
      await ctx.store.patch(id, current => ({ ...transition(current, 'started', at), started: { sessionId, at } }));
    } catch (error) {
      throw new Error(`开工会话 ${sessionId} 已经开始工作，但没能记到候选上：${messageOf(error)}`, { cause: error });
    }
    return sessionId;
  });
}
