/** The `readReport` action. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostContext } from './context.js';

const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');

/**
 * The report of candidate `id`, read from `reports/<id>/report.md` (the one place reports are written, so a damaged `report.path` cannot
 * point elsewhere). When the file is not there the text is empty and `notice` says why: never generated, being generated (a rerun moves
 * the old file aside first), or gone.
 */
export async function readReport(ctx: HostContext, id: string): Promise<{ id: string; markdown: string; notice?: string }> {
  const candidate = await ctx.store.get(id);
  try {
    return { id, markdown: await readFile(join(ctx.directory, 'reports', id, 'report.md'), 'utf8') };
  } catch (error) {
    if (!isMissing(error)) throw error;
    const notice = ctx.busy.get(id) === 'report' ? '报告正在生成，生成完再看'
      : candidate.report ? '报告文件不存在，请重新生成'
      : '这条候选还没有报告';
    return { id, markdown: '', notice };
  }
}
