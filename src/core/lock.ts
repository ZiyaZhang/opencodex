/**
 * The data-directory lock, `lock.json`: which DSH process is checking or researching in the directory, so that two processes on the same
 * data (DSH started twice, a scheduled run beside the desktop app) never run those at the same time. It serializes checks and research
 * only; other writes, such as an ignore, may still meet another process's in the directory.
 */
import { randomUUID } from 'node:crypto';
import { constants, copyFile, link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ValidationError } from './check.js';
import { writeJsonAtomic } from './store.js';

export type LockKind = 'check' | 'research';
/** Who holds the lock, as a refusal names it. */
export interface LockHolder { pid: number; kind: LockKind; startedAt: string }
/** What `lock.json` holds: the holder, its last heartbeat and its machine. */
export interface LockRecord extends LockHolder { heartbeatAt: string; hostname: string }
/** A hold, whose `signal` aborts if another process takes the lock over (this one stood still past the stale limit), or a refusal. */
export type LockResult = { held: true; release(): Promise<void>; signal: AbortSignal } | { held: false; by: LockHolder };
export interface LockTimers { set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
export interface LockOptions {
  /** The clock of `startedAt`, of the heartbeats and of their age; the system clock by default. */
  now?: () => Date;
  /** The timers of the heartbeat and of the wait before a second look at a holder that stopped beating; Node's timers, unref'd, by default. */
  timers?: LockTimers;
  /** Ends that wait. */
  signal?: AbortSignal;
  /** A test seam: puts a new lock file in place, failing with EEXIST when there is one; `createLockFile` by default. */
  create?: (path: string, text: string) => Promise<void>;
  /** A test seam: moves the lock file a takeover replaces out of the way; `rename` by default. */
  move?: (from: string, to: string) => Promise<void>;
  /** A test seam: the pause between the looks that name the process a race was lost to; 20 ms by default. */
  rereadMs?: number;
}

const FILE = 'lock.json', STALE_FILE = 'lock.stale.json';
/** How often a holder rewrites `heartbeatAt`. */
const HEARTBEAT_MS = 30_000;
/** A heartbeat older than this means the holder stopped: it is frozen (a sleeping machine) or hung. */
const STALE_MS = 5 * 60_000;
/** The wait before a second look at a live holder that stopped beating: two heartbeats, so that one just woken from sleep has beaten by then. */
const SECOND_LOOK_MS = 2 * HEARTBEAT_MS;
/**
 * Looks at the file after a lost race, to name the winner, and the pause between them: the winner may still be between moving the old file
 * aside and putting its own in place.
 */
const WINNER_LOOKS = 5, REREAD_MS = 20;
/** The pid of a winner whose file never read whole. No holder has it (a record with pid 0 counts as damaged), so it is never taken for a real one. */
const UNKNOWN_PID = 0;
/** What link() fails with where the file system has no hard links (exFAT, some network drives). */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
const NODE_TIMERS: LockTimers = { set: (run, ms) => setTimeout(run, ms).unref(), clear: handle => clearTimeout(handle as NodeJS.Timeout) };
const KIND_TEXT: Record<LockKind, string> = { check: '检查', research: '调研' };

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code ?? '';

/** `iso` in this machine's time zone, as the page shows times. */
function localTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** A run refused because another live DSH process holds the data directory. A ValidationError, so the page shows its message as it is. */
export class LockedError extends ValidationError {
  constructor(readonly by: LockHolder) {
    super(by.pid === UNKNOWN_PID ? '另一个 DSH 进程正在使用数据目录' : `另一个 DSH 进程正在${KIND_TEXT[by.kind]}（pid ${by.pid}，开始于 ${localTime(by.startedAt)}）`);
    this.name = 'LockedError';
  }
}

/** Creates `path` with `text` and syncs it, failing with EEXIST when `path` exists. */
async function createSynced(path: string, text: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}

/**
 * Puts `text` at `path` only where there is no file, whole or not at all: it is written and synced to a temp file beside `path`, then
 * linked there, which fails with EEXIST when `path` exists. Another process never sees a lock file half written, so never takes one over
 * as damaged while its writer is still at it. A file system without hard links gets the plain exclusive create instead, and that window.
 */
export async function createLockFile(path: string, text: string): Promise<void> {
  const temp = join(dirname(path), `lock.${process.pid}.${randomUUID()}.tmp`);
  try {
    await createSynced(temp, text);
    try { await link(temp, path); } catch (error) {
      if (!NO_HARD_LINKS.has(codeOf(error))) throw error;
      await createSynced(path, text);
    }
  } finally {
    await unlink(temp).catch(() => undefined); // a temp file left over is harmless: nothing reads lock.*.tmp
  }
}

/** This process's hold on one directory's lock file, shared by every run that took it; `lost` aborts once another process takes it over. */
interface Hold { count: number; path: string; record: LockRecord; now: () => Date; timers: LockTimers; heartbeat?: unknown; lost: AbortController }
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

/**
 * The lock file: its text, or none when it is missing, and the record in it, or none when it is damaged (anything that is no lock record,
 * to be treated as missing). Other read failures throw.
 */
async function readLock(path: string): Promise<{ text?: string; record?: LockRecord }> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if (codeOf(error) === 'ENOENT') return {};
    throw error;
  }
  try { return { text, record: recordOf(JSON.parse(text)) }; } catch { return { text }; }
}

/** Whether a process with `pid` exists: signal 0 sends nothing, and only ESRCH says there is none (EPERM is another user's live process). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return codeOf(error) !== 'ESRCH'; }
}

const fresh = (record: LockRecord, now: Date) => now.getTime() - Date.parse(record.heartbeatAt) <= STALE_MS;
const holderOf = ({ pid, kind, startedAt }: LockRecord): LockHolder => ({ pid, kind, startedAt });
/** The same hold: a file this process wrote, not one written after it by another process or by an earlier hold of this one. */
const same = (a: LockRecord, b: LockRecord) => a.pid === b.pid && a.startedAt === b.startedAt;
/** A record of another process that is alive: one that may keep the lock, if it beats. */
const otherLive = (record: LockRecord | undefined): record is LockRecord => record !== undefined && record.pid !== process.pid && alive(record.pid);

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
 * The process a race for `path` was lost to, from the file it put there. It never throws and never takes anything over: a file that does
 * not read whole in five looks is still a refusal, by a holder of unknown pid.
 */
async function winner(path: string, options: LockOptions, now: () => Date): Promise<LockHolder> {
  for (let look = 0; look < WINNER_LOOKS; look++) {
    if (look > 0) await sleep(options.rereadMs ?? REREAD_MS);
    try {
      const { record } = await readLock(path);
      if (record) return holderOf(record);
    } catch {
      // A file that cannot be read names nobody; the next look may.
    }
  }
  return { pid: UNKNOWN_PID, kind: 'check', startedAt: now().toISOString() };
}

/**
 * Puts a lock file moved aside by mistake back at `path`, unless another one is there by now (EEXIST: that one stands), and drops the
 * aside copy. Never throws: whatever stops it, its holder finds out at its next heartbeat.
 */
async function putBack(aside: string, path: string): Promise<void> {
  try { await link(aside, path); } catch (error) {
    if (NO_HARD_LINKS.has(codeOf(error))) await copyFile(aside, path, constants.COPYFILE_EXCL).catch(() => undefined);
  }
  await unlink(aside).catch(() => undefined);
}

/**
 * Moves the lock file a takeover replaces to lock.stale.json, making sure it is the file judged: another process may have taken the lock
 * over since the look, and moving its lock would leave both holding. The file goes to a name of this process's own first and is compared
 * with the text judged; a different one goes back, and the race is lost (false). A file already gone is another process's move: the
 * create decides.
 */
async function moveAside(path: string, judged: string, options: LockOptions): Promise<boolean> {
  const aside = join(dirname(path), `lock.${process.pid}.${randomUUID()}.aside`);
  try { await (options.move ?? rename)(path, aside); } catch (error) {
    if (codeOf(error) === 'ENOENT') return true;
    throw error;
  }
  if (await readFile(aside, 'utf8').catch(() => undefined) !== judged) {
    await putBack(aside, path);
    return false;
  }
  await rename(aside, join(dirname(path), STALE_FILE));
  return true;
}

/**
 * Makes `path` this process's lock file, or names the live process that keeps it. A holder that is alive with a heartbeat under 5 minutes
 * old keeps it; one whose heartbeat is older but whose pid is alive is looked at again two heartbeats (a minute) later and kept only if it
 * beat meanwhile; a holder that is gone, a damaged file and one this process left without a hold are taken over at once. A takeover moves
 * the old file aside (`moveAside`), puts the new one in place where there is none (`createLockFile`) and reads it back. A race lost to
 * another process, at the move, the create or the read-back, is a refusal naming the winner, never another takeover.
 */
async function claim(path: string, kind: LockKind, options: LockOptions): Promise<{ record: LockRecord } | { held: false; by: LockHolder }> {
  const now = options.now ?? (() => new Date());
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let found = await readLock(path);
  if (otherLive(found.record)) {
    if (fresh(found.record, now())) return { held: false, by: holderOf(found.record) };
    await pause(SECOND_LOOK_MS, options.timers ?? NODE_TIMERS, options.signal);
    found = await readLock(path);
    if (otherLive(found.record) && fresh(found.record, now())) return { held: false, by: holderOf(found.record) };
  }
  if (found.text !== undefined && !await moveAside(path, found.text, options)) return { held: false, by: await winner(path, options, now) };
  const at = now().toISOString();
  const record: LockRecord = { pid: process.pid, kind, startedAt: at, heartbeatAt: at, hostname: hostname() };
  try {
    await (options.create ?? createLockFile)(path, `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') throw error;
    return { held: false, by: await winner(path, options, now) };
  }
  // A process that judged the old file too may still have moved this one aside and put its own in place.
  const back = (await readLock(path)).record;
  if (back && same(back, record)) return { record };
  return { held: false, by: back ? holderOf(back) : await winner(path, options, now) };
}

/** Ends `hold` because another process took the lock over: the next acquisition claims anew, and the runs under it are told to stop. */
function lose(key: string, hold: Hold): void {
  if (holds.get(key) === hold) holds.delete(key);
  hold.lost.abort(new Error('数据目录锁被另一个 DSH 进程接管，已停止'));
}

/**
 * Rewrites the heartbeat of `hold` every 30 seconds while the hold lasts. A file that is missing or damaged skips one beat: another process
 * may have it aside for a look, and puts it back. One that is another process's ends the hold, and its lock is left alone.
 */
function beat(key: string, hold: Hold): void {
  hold.heartbeat = hold.timers.set(() => {
    void serial(key, async () => {
      if (holds.get(key) !== hold) return;
      try {
        const { record } = await readLock(hold.path);
        if (record && !same(record, hold.record)) { lose(key, hold); return; }
        if (record) {
          hold.record = { ...hold.record, heartbeatAt: hold.now().toISOString() };
          await writeJsonAtomic(hold.path, hold.record);
        }
      } catch {
        // The next beat tries again. Missing five minutes of them lets another process take over, as it should for a holder that cannot write.
      }
      beat(key, hold);
    });
  }, HEARTBEAT_MS);
}

/**
 * A release of one acquisition. The last one stops the heartbeat and deletes the file, unless another process has taken it over; a hold
 * that was lost leaves the one this process holds since alone. Never rejects.
 */
function releaser(key: string, hold: Hold): () => Promise<void> {
  let released = false;
  return () => serial(key, async () => {
    if (released) return;
    released = true;
    if (--hold.count > 0) return;
    if (holds.get(key) === hold) holds.delete(key);
    hold.timers.clear(hold.heartbeat);
    try {
      const { record } = await readLock(hold.path);
      if (record && same(record, hold.record)) await unlink(hold.path);
    } catch {
      // A file left behind beats no more, so the next process takes it over within six minutes.
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
      hold = { count: 0, path, record: claimed.record, now: options.now ?? (() => new Date()), timers: options.timers ?? NODE_TIMERS, lost: new AbortController() };
      holds.set(key, hold);
      beat(key, hold);
    }
    hold.count++;
    return { held: true, release: releaser(key, hold), signal: hold.lost.signal };
  });
}

/** Another live process holding the lock of `directory` with a fresh heartbeat, by the rule `acquireLock` refuses by, without a second look or a takeover. */
export async function lockHolder(directory: string, options: Pick<LockOptions, 'now'> = {}): Promise<LockHolder | undefined> {
  const { record } = await readLock(join(resolve(directory), FILE));
  const now = (options.now ?? (() => new Date()))();
  return record && record.pid !== process.pid && fresh(record, now) && alive(record.pid) ? holderOf(record) : undefined;
}
