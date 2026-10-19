/** The `brief` action: what a start would send, for the page to show, and let the user edit, before anything is opened. */
import { ValidationError } from '../../core/check.js';
import { defaultInstructions, readReportForStart } from '../start.js';
import { busyRefusal, type HostContext } from './context.js';
import { checkStart } from './start.js';

/** The task instructions a start sends unless the page edits them, and what goes with them, which no edit changes. */
export interface Brief {
  instructions: string;
  /** One line each: the report, its evidence, the mirror (read only) and the session's working directory; data-directory paths are relative. */
  attachments: string[];
}

/**
 * The brief of candidate `id`. It is refused as a start is, in the same words and as a bad request: while a task runs on the candidate
 * (`busyRefusal`), first, as in a start, and without reading the report, which a rerun moves aside until its session writes the new one;
 * then when the candidate cannot start (`checkStart`), and when its report file is misplaced, missing or empty (`readReportForStart`,
 * which reads it as the start does). A start may still be refused while the session of the last start runs, which a brief does not look
 * at, as it changes from one moment to the next. Nothing is opened or changed.
 */
export async function brief(ctx: HostContext, id: string): Promise<Brief> {
  const running = ctx.busy.get(id);
  if (running) throw new ValidationError(busyRefusal(running));
  const candidate = await ctx.store.get(id);
  const { mirror, report } = checkStart(candidate, ctx.settings());
  await readReportForStart(ctx.directory, id, report.path);
  return {
    instructions: defaultInstructions(),
    attachments: [`报告 reports/${id}/report.md`, `证据目录 reports/${id}/evidence/`, `DSH 镜像 ${mirror}（只读）`, `工作目录 work/${id}/`],
  };
}
