/**
 * The data-directory lock, `lock.json`: which DSH process is checking or researching in the directory, so that two processes on the same
 * data (DSH started twice, a scheduled run beside the desktop app) never run those at the same time. It serializes checks and research
 * only; other writes, such as an ignore, may still meet another process's in the directory.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ValidationError } from './check.js';
import { writeJsonAtomic } from './store.js';

export type LockKind = 'check' | 'research';
/** Who holds the lock, as a refusal names it. */
export interface LockHolder { pid: number; kind: LockKind; startedAt: string }
/** What `lock.json` holds: the holder, its last heartbeat and its machine. */
export interface LockRecord extends LockHolder { heartbeatAt: string; hostname: string }
export type LockResult = { held: true; release(): Promise<void> } | { held: false; by: LockHolder };
export interface LockTimers { set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
export interface LockOptions {
  /** The clock of `startedAt`, of the heartbeats and of their age; the system clock by default. */
  now?: () => Date;
  /** The timers of the heartbeat and of the wait before a second look at a holder that stopped beating; Node's timers, unref'd, by default. */
  timers?: LockTimers;
  /** Ends that wait. */
  signal?: AbortSignal;
  /** Writes a new lock file, failing with EEXIST when one exists (`wx`). Tests wrap it to let another process act before the read-back. */
  create?: (path: string, text: string) => Promise<void>;
}

const FILE = 'lock.json', STALE_FILE = 'lock.stale.json';
/** How often a holder rewrites `heartbeatAt`. */
const HEARTBEAT_MS = 30_000;
/** A heartbeat older than this means the holder stopped: it is frozen (a sleeping machine) or hung. */
const STALE_MS = 5 * 60_000;
/**
 * Looks at the file per acquisition. One takes three at most (the second look after the wait, a takeover lost to another process, the look
 * that then names that process); more means the file keeps changing under it.
 */
const LOOKS = 5;
const NODE_TIMERS: LockTimers = { set: (run, ms) => setTimeout(run, ms).unref(), clear: handle => clearTimeout(handle as NodeJS.Timeout) };
const createFile = (path: string, text: string) => writeFile(path, text, { flag: 'wx', mode: 0o600 });
const KIND_TEXT: Record<LockKind, string> = { check: '检查', research: '调研' };

/** `iso` in this machine's time zone, as the page shows times. */
function localTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** A run refused because another live DSH process holds the data directory. A ValidationError, so the page shows its message as it is. */
export class LockedError extends ValidationError {
  constructor(readonly by: LockHolder) {
    super(`另一个 DSH 进程正在${KIND_TEXT[by.kind]}（pid ${by.pid}，开始于 ${localTime(by.startedAt)}）`);
    this.name = 'LockedError';
  }
}

/** This process's hold on one directory's lock file, shared by every run that took it. */
interface Hold { count: number; path: string; record: LockRecord; now: () => Date; timers: LockTimers; heartbeat?: unknown }
/** By resolved directory. */
const holds = new Map<string, Hold>();
/** Per resolved directory: acquisitions, heartbeats and releases run one at a time, so none reads the file while another is changing it. */
const queues = new Map<string, Promise<void>>();

function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(work);
  const settled = run.then(() => undefined, () => undefined);
  queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return run;
}

function recordOf(value: unknown): LockRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { pid, kind, startedAt, heartbeatAt, hostname: host } = value as Record<string, unknown>;
  // pid 0 and negative pids name process groups for kill(), so they are no holder.
  const whole = Number.isInteger(pid) && (pid as number) > 0 && typeof kind === 'string' && Object.hasOwn(KIND_TEXT, kind) && typeof startedAt === 'string'
    && typeof heartbeatAt === 'string' && !Number.isNaN(Date.parse(heartbeatAt)) && typeof host === 'string';
  return whole ? { pid, kind, startedAt, heartbeatAt, hostname: host } as LockRecord : undefined;
}

/** The lock file: missing, damaged (anything that is no lock record, to be treated as missing), or a record. Other read failures throw. */
async function readLock(path: string): Promise<{ exists: boolean; record?: LockRecord }> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
  try { return { exists: true, record: recordOf(JSON.parse(text)) }; } catch { return { exists: true }; }
}

/** Whether a process with `pid` exists: signal 0 sends nothing, and only ESRCH says there is none (EPERM is another user's live process). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

const fresh = (record: LockRecord, now: Date) => now.getTime() - Date.parse(record.heartbeatAt) <= STALE_MS;
const holderOf = ({ pid, kind, startedAt }: LockRecord): LockHolder => ({ pid, kind, startedAt });
/** The same hold: a file this process wrote, not one written after it by another process or by an earlier hold of this one. */
const same = (a: LockRecord, b: LockRecord) => a.pid === b.pid && a.startedAt === b.startedAt;

/** Waits `ms` on `timers`; an abort of `signal` clears the timer and rejects with its reason. */
function pause(ms: number, timers: LockTimers, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { timers.clear(handle); reject(signal!.reason); };
    const handle = timers.set(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Makes `path` this process's lock file, or names the live process that keeps it. A holder that is alive with a heartbeat under 5 minutes
 * old keeps it; one whose heartbeat is older but whose pid is alive is looked at again a heartbeat (30 seconds) later and kept only if it
 * beat meanwhile; a holder that is gone, a damaged file and one this process left without a hold are taken over at once. A takeover moves
 * the old file to lock.stale.json, creates the new one with `wx` and reads it back: a file that is not this one then means another process
 * got there first, and the next look names it.
 */
async function claim(path: string, kind: LockKind, options: LockOptions): Promise<{ record: LockRecord } | { held: false; by: LockHolder }> {
  const now = options.now ?? (() => new Date());
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let lookedAgain = false;
  for (let look = 0; look < LOOKS; look++) {
    const found = await readLock(path);
    const holder = found.record;
    if (holder && holder.pid !== process.pid && alive(holder.pid)) {
      if (fresh(holder, now())) return { held: false, by: holderOf(holder) };
      if (!lookedAgain) {
        lookedAgain = true;
        await pause(HEARTBEAT_MS, options.timers ?? NODE_TIMERS, options.signal);
        continue;
      }
    }
    const at = now().toISOString();
    const record: LockRecord = { pid: process.pid, kind, startedAt: at, heartbeatAt: at, hostname: hostname() };
    if (found.exists) {
      try { await rename(path, join(dirname(path), STALE_FILE)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; // another process moved it first; the create below decides
      }
    }
    try {
      await (options.create ?? createFile)(path, `${JSON.stringify(record, null, 2)}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    const back = (await readLock(path)).record;
    if (back && same(back, record)) return { record };
  }
  throw new Error(`数据目录锁 ${path} 一直在被别的进程改写，没能拿到`);
}

/** Rewrites the heartbeat of `hold` every 30 seconds while the hold lasts, and stops once the file is no longer this process's. */
function beat(key: string, hold: Hold): void {
  hold.heartbeat = hold.timers.set(() => {
    void serial(key, async () => {
      if (holds.get(key) !== hold) return;
      try {
        const current = (await readLock(hold.path)).record;
        // Another process took over while this one stood still (a sleeping machine): its lock is left alone, and this hold beats no more.
        if (!current || !same(current, hold.record)) return;
        hold.record = { ...hold.record, heartbeatAt: hold.now().toISOString() };
        await writeJsonAtomic(hold.path, hold.record);
      } catch {
        // The next beat tries again. Missing five minutes of them lets another process take over, as it should for a holder that cannot write.
      }
      beat(key, hold);
    });
  }, HEARTBEAT_MS);
}

/** A release of one acquisition: the last one stops the heartbeat and deletes the file, unless another process has taken it over. Never rejects. */
function releaser(key: string, hold: Hold): () => Promise<void> {
  let released = false;
  return () => serial(key, async () => {
    if (released) return;
    released = true;
    if (--hold.count > 0) return;
    holds.delete(key);
    hold.timers.clear(hold.heartbeat);
    try {
      const current = (await readLock(hold.path)).record;
      if (current && same(current, hold.record)) await unlink(hold.path);
    } catch {
      // A file left behind beats no more, so the next process takes it over within five and a half minutes.
    }
  });
}

/**
 * Takes the lock of `directory` for `kind`. This process takes it again as often as it likes, for either kind (the file keeps the kind of
 * the run that took it), and only the last release deletes the file; another process is refused by `claim`'s rules, and the refusal names
 * it. While held, the heartbeat is rewritten every 30 seconds.
 */
export function acquireLock(directory: string, kind: LockKind, options: LockOptions = {}): Promise<LockResult> {
  const key = resolve(directory);
  return serial(key, async (): Promise<LockResult> => {
    let hold = holds.get(key);
    if (!hold) {
      const path = join(key, FILE);
      const claimed = await claim(path, kind, options);
      if (!('record' in claimed)) return claimed;
      hold = { count: 0, path, record: claimed.record, now: options.now ?? (() => new Date()), timers: options.timers ?? NODE_TIMERS };
      holds.set(key, hold);
      beat(key, hold);
    }
    hold.count++;
    return { held: true, release: releaser(key, hold) };
  });
}

/** Another live process holding the lock of `directory` with a fresh heartbeat, by the rule `acquireLock` refuses by, without a second look or a takeover. */
export async function lockHolder(directory: string, options: Pick<LockOptions, 'now'> = {}): Promise<LockHolder | undefined> {
  const { record } = await readLock(join(resolve(directory), FILE));
  const now = (options.now ?? (() => new Date()))();
  return record && record.pid !== process.pid && fresh(record, now) && alive(record.pid) ? holderOf(record) : undefined;
}
