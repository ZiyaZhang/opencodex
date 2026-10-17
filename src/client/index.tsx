import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { OPEN_CODEX_REMOTE, type OpenCodexRequest } from '../host/remote.js';
import type { ClientRequest, ClientResponse } from './contract.js';
import { OpenCodexPage } from './page.js';
import { Icon } from './icons.js';
import styles from './style.css';
import { UI } from './ui.js';

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
  /**
   * The page's requests include what only a newer Host knows (the `models` action, the `autoResearch` setting), so its request type is
   * wider than the Remote's. The Host checks every request (`parseRequest`) and refuses what it does not know with a message the page shows.
   */
  const call = async (request: ClientRequest, signal?: AbortSignal): Promise<ClientResponse> => {
    const result = await ctx.remote.opencodex.call(request as OpenCodexRequest, signal);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL, inject: () => ({ openSession, call, ui: UI }),
  }, OpenCodexPage));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL, order: 1, label: () => 'OpenCodex',
  }, ({ size }: { size?: number }) => <Icon name="code" size={size ?? 18} />));
  });
}
