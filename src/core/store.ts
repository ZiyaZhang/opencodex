import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { canTransition, fingerprintOf, transition, type Candidate, type Evidence, type Source, type Status } from './candidate.js';
import { ValidationError, check } from './check.js';

export interface UpsertInput { source: Source; key: string; title: string; summary: string; evidence: Evidence[]; window?: Candidate['window'] }
export type Checkpoints = Record<string, string | undefined>;

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path);
  } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}

/** Reads one JSON object. A damaged file is named by its absolute path so it can be found and repaired by hand. */
async function readJson<T extends object>(path: string): Promise<T> {
  const text = await readFile(path, 'utf8');
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`Corrupt JSON in ${resolve(path)}: ${(error as Error).message}`, { cause: error }); }
  check(typeof value === 'object' && value !== null && !Array.isArray(value), `${resolve(path)} must hold a JSON object`);
  return value as T;
}

/** JSON text is what ends up on disk, so comparing it treats an `undefined` optional field the same as an absent one. */
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Checkpoint names become keys in state.json and values are tags, versions or hashes, so both are held to a plain single-line shape. */
const CHECKPOINT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
function checkCheckpointName(name: string): void {
  check(typeof name === 'string' && CHECKPOINT_NAME.test(name), `Invalid checkpoint name ${JSON.stringify(name)}: use up to 64 letters, digits, "_" or "-", starting with a letter`);
}
function checkCheckpointValue(name: string, value: string): void {
  check(typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\p{Cc}\u2028\u2029]/u.test(value),
    `Invalid value for checkpoint ${name}: expected a non-empty single line of at most 512 characters without control characters`);
}

/** One directory, one JSON file per candidate, one state.json for checkpoints. No locks: one Host owns the directory. */
export class CandidateStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, private readonly now: () => Date = () => new Date()) {}
  private get candidatesDir() { return join(this.directory, 'candidates'); }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
  async list(filter: { status?: Status; source?: Source } = {}): Promise<Candidate[]> {
    await mkdir(this.candidatesDir, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.candidatesDir)).filter(name => name.endsWith('.json'));
    const items = await Promise.all(files.map(name => readJson<Candidate>(join(this.candidatesDir, name))));
    return items.filter(c => (!filter.status || c.status === filter.status) && (!filter.source || c.source === filter.source))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  /** Throws a ValidationError for a malformed or unknown id, and an Error naming the file when that file is damaged. */
  async get(id: string): Promise<Candidate> {
    check(/^[0-9a-f-]{36}$/.test(id), 'candidate id must be a UUID');
    try { return await readJson<Candidate>(join(this.candidatesDir, `${id}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ValidationError(`Unknown candidate ${id}`); throw error; }
  }
  async findByFingerprint(fingerprint: string): Promise<Candidate | undefined> {
    return (await this.list()).find(c => c.fingerprint === fingerprint);
  }
  /** Insert or refresh by fingerprint; `created` lets collectors count genuinely new candidates. A refresh that would change nothing is skipped, so `updatedAt` moves only when the content does. */
  upsert(input: UpsertInput): Promise<{ candidate: Candidate; created: boolean }> {
    return this.serial(async () => {
      const fingerprint = fingerprintOf(input.source, input.key);
      const existing = await this.findByFingerprint(fingerprint);
      const releaseWindow = input.window ?? existing?.window;
      if (existing && existing.title === input.title && existing.summary === input.summary && sameJson(existing.evidence, input.evidence) && sameJson(existing.window, releaseWindow)) {
        return { candidate: existing, created: false };
      }
      const at = this.now().toISOString();
      const candidate: Candidate = existing
        ? { ...existing, title: input.title, summary: input.summary, evidence: input.evidence, ...(releaseWindow && { window: releaseWindow }), updatedAt: at }
        : { id: randomUUID(), fingerprint, source: input.source, title: input.title, summary: input.summary, evidence: input.evidence, ...(releaseWindow && { window: releaseWindow }), status: 'new', createdAt: at, updatedAt: at };
      await this.save(candidate);
      return { candidate, created: !existing };
    });
  }
  transition(id: string, status: Status): Promise<Candidate> {
    return this.serial(async () => { const next = transition(await this.get(id), status, this.now().toISOString()); await this.save(next); return next; });
  }
  /** Edits the non-identity fields of a candidate. The callback may not change who the candidate is, and a status move must be an allowed one; for a plain status move use `transition`. */
  patch(id: string, update: (candidate: Candidate) => Candidate): Promise<Candidate> {
    return this.serial(async () => {
      const current = await this.get(id);
      // The callback gets a copy, so mutating its argument in place cannot hide a change from the comparisons below.
      const next = { ...update(structuredClone(current)), updatedAt: this.now().toISOString() };
      for (const field of ['id', 'fingerprint', 'source', 'createdAt'] as const) check(next[field] === current[field], `patch must not change the candidate ${field}`);
      if (next.status !== current.status) check(canTransition(current.status, next.status), `Invalid transition ${current.status} -> ${next.status}`);
      await this.save(next);
      return next;
    });
  }
  async checkpoint(name: string): Promise<string | undefined> {
    checkCheckpointName(name);
    const state = await this.readState();
    return Object.hasOwn(state, name) ? state[name] : undefined;
  }
  async checkpoints(): Promise<Checkpoints> { return this.readState(); }
  async setCheckpoint(name: string, value: string): Promise<void> {
    checkCheckpointName(name);
    checkCheckpointValue(name, value);
    await this.serial(async () => { const state = await this.readState(); state[name] = value; await writeJsonAtomic(join(this.directory, 'state.json'), state); });
  }
  private async readState(): Promise<Checkpoints> {
    try { return await readJson<Checkpoints>(join(this.directory, 'state.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  private async save(candidate: Candidate): Promise<void> {
    await mkdir(this.candidatesDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(join(this.candidatesDir, `${candidate.id}.json`), candidate);
  }
}
