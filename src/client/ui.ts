/**
 * The DSH controls the page is built from, imported from `@deepseek-ai/dsh-client-ui-primitives` here and nowhere else. The package loads
 * dozens of CSS modules and packages it does not declare, which only the DSH client provides at run time, so the page components take the
 * controls from `UiContext` (ui-context.ts): the plugin entry hands in this set, tests hand in stand-ins. The bundle keeps the package
 * external and imports its root only, because the module table DSH resolves a plugin's `require` against lists the bare package name and
 * no subpath.
 */
import { Button, Input, Pill, SegmentedTabs, StateDot, Switch, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';

export const UI = { Button, Input, Pill, SegmentedTabs, StateDot, Switch, Tag, Tooltip };
export type Ui = typeof UI;
export type { ButtonVariant, StateDotState, TagTone } from '@deepseek-ai/dsh-client-ui-primitives';
