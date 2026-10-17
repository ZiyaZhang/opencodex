// Type-only guard with no runtime test: `npm run typecheck` compiles it because tsconfig includes `tests`.
// A slot component's props are derived from `@deepseek-ai/dsh-client-store` types. If that package stops
// resolving they degrade to `any`, the error below disappears, and tsc reports the unused directive (TS2578).
import type { Context } from '@deepseek-ai/cordis';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { Ui } from '../src/client/ui.ts';

export function guard(ctx: Context) {
  // @ts-expect-error a component may not require props inject does not supply
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'x' as MainPanelId, inject: () => ({ call: 1 }) }, (_: { call: number; needed: string }) => null));
}

// The same for the DSH controls: `Ui` takes its types from `@deepseek-ai/dsh-client-ui-primitives`. If that package stops resolving,
// `Ui` degrades to `any`, the props the page gives the controls (a variant, a tone, a state) go unchecked, and this directive is unused.
export function controlsGuard(ui: Ui) {
  // @ts-expect-error a Tag has only the tones the primitives define
  ui.Tag({ tone: 'loud' });
}
