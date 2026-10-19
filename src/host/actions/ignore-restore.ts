/** The `ignore` and `restore` actions: plain status moves. */
import { canTransition, type Status } from '../../core/candidate.js';
import { exclusive, type HostContext } from './context.js';

/** Moves candidate `id` to `to` after checking the move, refusing with `refusal(status)` when it is not allowed or while the candidate has a task running. */
async function move(ctx: HostContext, id: string, to: Status, refusal: (status: Status) => string): Promise<void> {
  await exclusive(ctx, id, 'status', async () => {
    const candidate = await ctx.store.get(id);
    if (!canTransition(candidate.status, to)) throw new Error(refusal(candidate.status));
    await ctx.store.transition(id, to);
  });
}

/** `new`, `reported` or `started` to `ignored`. */
export function ignore(ctx: HostContext, id: string): Promise<void> {
  return move(ctx, id, 'ignored', status => (status === 'ignored' ? '这条动态已经忽略了' : `状态为 ${status} 的动态不能忽略`));
}

/** `ignored` back to `new`; the report, the session record and the classification stay. */
export function restore(ctx: HostContext, id: string): Promise<void> {
  return move(ctx, id, 'new', () => '只有已忽略的动态可以恢复');
}
