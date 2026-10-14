import type { Context } from '@deepseek-ai/cordis';
import type { ReactNode } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';

export const inject = ['slots'];

const MARKER_ATTR = 'data-dsh-async-question-marker';
const SLOT_ID = 'dsh-opencodex-async-questions';

const CSS = `
/* dsh-opencodex-async-questions */
/* Scope: only a composer seat containing our marker (a pending plain question). */
[${MARKER_ATTR}] {
  display: none !important;
}

[data-composer-seat]:has([${MARKER_ATTR}]) {
  display: flex !important;
  flex-direction: column !important;
}

/* Real DOM: seat > slot outlet > chain-overlay-fallback wrapper. The outlet
   uses display:contents (does not change parent/child relationships), so the
   fallback is NOT a direct child of the seat. Reveal it one level deeper. */
[data-composer-seat]:has([${MARKER_ATTR}]) [data-slot="conversation.composer"] > [data-chain-overlay-fallback="conversation.composer"] {
  display: contents !important;
}

/* Put the elected question card above the ordinary composer in visual order.
   The question card is emitted AFTER the fallback, behind its own outlet. */
[data-composer-seat]:has([${MARKER_ATTR}]) [data-slot="conversation.composer"] > [data-question-key] {
  order: -1;
}
`;

/**
 * Marker contribution to `conversation.composer.dock`. This dock lives inside the
 * retained composer seat tree, so the marker stays mounted even while the hidden
 * `conversation.composer` fallback wrapper is display:none. The marker only
 * renders when the current session has a plain pending `question`; plan-review,
 * approvals, offline blockers, and other pending kinds never render it, so their
 * fallback stays hidden.
 */
function QuestionMarker(props: PropsRuntime<'conversation.composer.dock'>): ReactNode {
  const { sessionId, useSessionStatus } = props;
  const isQuestion = useSessionStatus((snapshot) => {
    if (sessionId === undefined) return false;
    return snapshot.get(sessionId)?.pendingInteraction?.kind === 'question';
  });
  if (!isQuestion) return null;
  // A zero-size, display:none marker. Its presence alone drives the scoped CSS.
  return <span {...{ [MARKER_ATTR]: '' }} aria-hidden="true" />;
}

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register({
      name: 'conversation.composer.dock',
      id: SLOT_ID,
      order: 0,
    }, QuestionMarker),
  );

  // Own stylesheet: removed exactly on unload so the default takeover returns.
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {};
    const style = document.createElement('style');
    style.setAttribute(MARKER_ATTR, SLOT_ID);
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  });
}
