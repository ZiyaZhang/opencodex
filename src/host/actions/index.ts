/** The `rebuildIndex` action, which a change of the mirror path runs as well. */
import { refreshIndex } from '../collector.js';
import { mirrorOf, type HostContext } from './context.js';

/**
 * Rebuilds the DSH index from the mirror in the settings and puts it in use. The user asked for it, so `force` lets an index with far fewer
 * entries, or without a known commit, replace the previous one; an empty one never does. Builds run one at a time, each from the mirror
 * in the settings when it starts, so a build that follows a change of the mirror path never hands back the old mirror's index.
 */
export function rebuildIndex(ctx: HostContext): Promise<void> {
  return ctx.lanes.index.run(async () => {
    ctx.index = await refreshIndex(ctx.directory, ctx.store, mirrorOf(ctx.settings()), { force: true });
  });
}
