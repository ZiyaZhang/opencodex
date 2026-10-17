/** The `models` action: the providers DSH has registered and their models, for the model fields of the settings page. */
import { messageOf, type HostContext } from './context.js';

/** One entry per provider DSH has registered, in DSH's order, each with its models in the adapter's order; `providerName` is what DSH shows. */
export type ModelCatalog = Array<{ provider: string; providerName: string; models: Array<{ id: string; name: string }> }>;

/** How long a model list is served from memory: the page asks each time the settings open, and DSH's providers seldom change. */
const KEEP_MS = 5 * 60_000;

/**
 * DSH's providers and their models. A provider is named by the display name its configuration declares, else by the name it registered
 * under. Every provider is asked at once; one whose list fails is listed without models, and `notice` says why. A list in which every
 * provider answered is kept for five minutes by the Host clock, and a saved setting drops it (see `updateSettings`). A list with a failure
 * is not kept, so the next call asks again rather than showing the failure for five minutes.
 */
export async function models(ctx: HostContext): Promise<{ models: ModelCatalog; notice?: string }> {
  const now = ctx.now().getTime();
  const kept = ctx.modelCatalog;
  if (kept && now >= kept.at && now - kept.at < KEEP_MS) return { models: kept.models };
  // Called on the service object itself: through Cordis, that is what keeps the methods' `this`.
  const { llm } = ctx.services;
  const names = new Map(llm.listConfigurableProviders().map(entry => [entry.provider, entry.displayName]));
  const answers = await Promise.all(llm.listProviders().map(async ({ id, name }) => {
    const providerName = names.get(id) || name;
    try {
      const listed = await llm.listModels(id);
      return { entry: { provider: id, providerName, models: listed.map(model => ({ id: model.id, name: model.name })) } };
    } catch (error) {
      return { entry: { provider: id, providerName, models: [] }, failure: `${providerName} 的模型列表没取到：${messageOf(error)}` };
    }
  }));
  const catalog: ModelCatalog = answers.map(answer => answer.entry);
  const failures = answers.flatMap(answer => (answer.failure === undefined ? [] : [answer.failure]));
  if (failures.length > 0) return { models: catalog, notice: failures.join('；') };
  ctx.modelCatalog = { at: now, models: catalog };
  return { models: catalog };
}
