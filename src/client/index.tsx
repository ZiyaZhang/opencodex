import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { OPEN_CODEX_REMOTE } from '../host/remote.js';
import { OpenCodexPage } from './page.js';
import { Icon } from './icons.js';
import styles from './style.css';

const PANEL = 'opencodex' as MainPanelId;
export const inject = ['slots', 'layout', 'remote', 'uiWorkspace'];

export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(OPEN_CODEX_REMOTE);
  ctx.effect(() => unmount, 'opencodex: remote');
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.opencodex = 'styles'; style.textContent = styles;
    document.head.append(style);
    return () => style.remove();
  }, 'opencodex: styles');
  /** Shows a session in the workspace: the creator-mode session `start` opened. */
  const openSession = (sessionId: string) => { ctx.uiWorkspace.openSession(sessionId as SessionId); };
  ctx.inject(['remote.opencodex'], ctx => {
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL,
    inject: () => ({ openSession, call: async (request: Parameters<typeof ctx.remote.opencodex.call>[0], signal?: AbortSignal) => {
      const result = await ctx.remote.opencodex.call(request, signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    } }),
  }, OpenCodexPage));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL, order: 1, label: () => 'OpenCodex',
  }, ({ size }: { size?: number }) => <Icon name="code" size={size ?? 18} />));
  });
}
