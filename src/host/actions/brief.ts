/** The `brief` action: what a start would send, for the page to show, and let the user edit, before anything is opened. */
import { defaultInstructions, readReportForStart } from '../start.js';
import type { HostContext } from './context.js';
import { checkStart } from './start.js';

/** The task instructions a start sends unless the page edits them, and what goes with them, which no edit changes. */
export interface Brief {
  instructions: string;
  /** One line each: the report, its evidence, the mirror (read only) and the session's working directory; data-directory paths are relative. */
  attachments: string[];
}

/**
 * The brief of candidate `id`. It is refused as a start is, as a bad request with the reason, when the candidate cannot start
 * (`checkStart`) and when its report file is misplaced, missing or empty (`readReportForStart`, which reads it as the start does). A start
 * may still be refused for what changes from one moment to the next, which a brief does not look at: another task running on the
 * candidate, or the session of the last start still running. Nothing is opened or changed.
 */
export async function brief(ctx: HostContext, id: string): Promise<Brief> {
  const candidate = await ctx.store.get(id);
  const { mirror, report } = checkStart(candidate, ctx.settings());
  await readReportForStart(ctx.directory, id, report.path);
  return {
    instructions: defaultInstructions(),
    attachments: [`报告 reports/${id}/report.md`, `证据目录 reports/${id}/evidence/`, `DSH 镜像 ${mirror}（只读）`, `工作目录 work/${id}/`],
  };
}
