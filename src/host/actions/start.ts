/** The `start` action: a creator-mode session for a reported candidate, recorded on it. */
import { SessionId } from '@deepseek-ai/dsh-session';
import { canTransition, transition, type Status } from '../../core/candidate.js';
import { startWork } from '../start.js';
import { exclusive, messageOf, mirrorOf, type HostContext } from './context.js';

function refusal(status: Status): string {
  if (status === 'new') return '先生成报告再开工';
  if (status === 'ignored') return '已忽略的候选不能开工，先恢复它';
  return `状态为 ${status} 的候选不能开工`;
}

/**
 * Opens a creator-mode session (`startPreset`) for candidate `id` with its report as the task, and returns the session id. Refused before
 * anything is created when the status cannot move to `started`, when no mirror path is set, when the candidate has a task running, and
 * when the session of the last start is still running, whatever the status is now (`started -> started` opens another session, so two
 * clicks would open two; a report rerun moves a started candidate back to `reported` while its session may still work). Then
 * one patch moves the candidate to `started` and records the session. A session that exists but did not get its task, or that works
 * without being recorded, is named in the error.
 */
export async function start(ctx: HostContext, id: string): Promise<string> {
  return exclusive(ctx, id, 'start', async () => {
    const candidate = await ctx.store.get(id);
    if (!canTransition(candidate.status, 'started')) throw new Error(refusal(candidate.status));
    const settings = ctx.settings();
    const mirror = mirrorOf(settings);
    const previous = candidate.started?.sessionId;
    if (previous !== undefined && ctx.services.agents.get(SessionId(previous))?.status === 'running') throw new Error(`上一个开工会话还在运行（会话 ${previous}）`);
    // A failure once the session exists is a StartWorkError whose message names the session.
    const { sessionId } = await startWork(ctx.services, { candidate, directory: ctx.directory, preset: settings.startPreset, mirror, signal: ctx.signal });
    const at = ctx.now().toISOString();
    try {
      await ctx.store.patch(id, current => ({ ...transition(current, 'started', at), started: { sessionId, at } }));
    } catch (error) {
      throw new Error(`开工会话 ${sessionId} 已经开始工作，但没能记到候选上：${messageOf(error)}`, { cause: error });
    }
    return sessionId;
  });
}
