/**
 * `checks.jsonl`: one line per check, whichever process ran it, so the page can show the last check after DSH restarts and a check that
 * another DSH process ran on the same data. The Host keeps only its own last check in memory.
 */
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type CheckTrigger = 'startup' | 'timer' | 'manual' | 'run-once';
/** One line of the log: one check from its start to its end. */
export interface CheckLogEntry {
  /** When the check ended, and when it started (ISO). */
  at: string;
  startedAt: string;
  /** What started it: the first timer run after the Host starts, a later timer run, the `check` action, or a run-once start. */
  trigger: CheckTrigger;
  /** The process that ran it. */
  pid: number;
  /** The release window it covered, as the page shows it; null when there was no new stable release. */
  window: { fromTag?: string; toTag?: string } | null;
  /** New candidates per source. */
  added: { releases: number; files: number; desktop: number; rss: number };
  /** The check's `errors`, prefixes included. */
  errors: string[];
  /** The DSH index the check rebuilt, if it rebuilt one. */
  index?: { entries: number; commit: string };
}

const LOG = 'checks.jsonl', TURNED_OVER = 'checks.1.jsonl';
/** Past this size the log is turned over, so it stays small: at well under 1 KB a check, 2 MB is still thousands of checks. */
const TURNOVER_BYTES = 2 * 1024 * 1024;
/** How much of the end of the log is read for its last line: far more than one line, so a whole one is still found behind a damaged one. */
const TAIL_BYTES = 64 * 1024;
const TRIGGERS: ReadonlySet<string> = new Set<CheckTrigger>(['startup', 'timer', 'manual', 'run-once']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isTag = (value: unknown) => value === undefined || typeof value === 'string';

/** `value` when it is a whole log line of this shape (other fields are kept), else undefined: the page reads these fields without checking them. */
function entryOf(value: unknown): CheckLogEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { at, startedAt, trigger, pid, window, added, errors, index } = value;
  const whole = typeof at === 'string' && typeof startedAt === 'string' && typeof trigger === 'string' && TRIGGERS.has(trigger) && Number.isInteger(pid)
    && (window === null || (isRecord(window) && isTag(window.fromTag) && isTag(window.toTag)))
    && isRecord(added) && isCount(added.releases) && isCount(added.files) && isCount(added.desktop) && isCount(added.rss)
    && Array.isArray(errors) && errors.every(line => typeof line === 'string')
    && (index === undefined || (isRecord(index) && isCount(index.entries) && typeof index.commit === 'string'));
  return whole ? value as unknown as CheckLogEntry : undefined;
}

/**
 * Appends `entry` to `<directory>/checks.jsonl` as one line and syncs it to disk. A log over 2 MB is first renamed to checks.1.jsonl,
 * replacing the one before. Callers hold the data-directory lock, so two processes never turn the log over at once.
 */
export async function appendCheckLog(directory: string, entry: CheckLogEntry): Promise<void> {
  const path = join(directory, LOG);
  // JSON text holds no raw line break, so the entry is one line whatever its strings contain.
  const line = `${JSON.stringify(entry)}\n`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let size = 0;
  try { ({ size } = await stat(path)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (size > TURNOVER_BYTES) await rename(path, join(directory, TURNED_OVER));
  const handle = await open(path, 'a', 0o600);
  try { await handle.writeFile(line, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}

/**
 * The last whole line of `<directory>/checks.jsonl`, from its last 64 KB only. A damaged last line (a process that died while writing it)
 * gives way to the whole one before it. No log is no entry and no problem; a log that cannot be read, or whose end holds no whole line,
 * is no entry and a `problem` the page can show.
 */
export async function readLastCheckLog(directory: string): Promise<{ entry?: CheckLogEntry; problem?: string }> {
  const path = join(directory, LOG);
  let tail: string, cut: boolean;
  try {
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      if (size === 0) return {};
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      tail = buffer.toString('utf8', 0, bytesRead);
      cut = start > 0;
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return { problem: `检查日志 ${path} 没能读出来：${(error as Error).message}` };
  }
  const lines = tail.split('\n');
  // Where the tail starts inside the file, its first piece is the end of a line whose start was not read.
  if (cut) lines.shift();
  for (const line of lines.reverse()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const entry = entryOf(value);
    if (entry) return { entry };
  }
  return { problem: `检查日志 ${path} 的最后 64 KB 里没有一行完整的记录` };
}
