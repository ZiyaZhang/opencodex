import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';

export const inject = ['slots'];

// This typed, JSX-ready empty contribution is a wiring example, not a feature.
// Choose the actual feature's public slot and matching PropsRuntime type.
function Contribution(props: PropsRuntime<'conversation.composer.dock'>): null {
  void props;
  return null;
}

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: '__PLUGIN_NAME__',
    order: 0,
  }, Contribution));
  // Register effects with ctx.effect and return their cleanup on unload.
  // Add real behavior and checks before submitting this as a feature artifact.
}
