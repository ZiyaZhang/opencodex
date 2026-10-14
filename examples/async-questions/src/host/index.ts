import type { Context } from '@deepseek-ai/cordis';

// A Host entry activates the package and lets DSH discover its Client entry.
// Add Host services only when the selected feature actually requires them.
export function apply(ctx: Context): void {
  void ctx;
}
