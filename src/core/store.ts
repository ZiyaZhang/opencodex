import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fingerprintOf, transition, type Candidate, type Evidence, type Source, type Status } from './candidate.js';
import { check } from './check.js';

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
    const items = await Promise.all(files.map(async name => JSON.parse(await readFile(join(this.candidatesDir, name), 'utf8')) as Candidate));
    return items.filter(c => (!filter.status || c.status === filter.status) && (!filter.source || c.source === filter.source))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async get(id: string): Promise<Candidate> {
    check(/^[0-9a-f-]{36}$/.test(id), 'candidate id must be a UUID');
    return JSON.parse(await readFile(join(this.candidatesDir, `${id}.json`), 'utf8')) as Candidate;
  }
  async findByFingerprint(fingerprint: string): Promise<Candidate | undefined> {
    return (await this.list()).find(c => c.fingerprint === fingerprint);
  }
  /** Insert or refresh by fingerprint; `created` lets collectors count genuinely new candidates. */
  upsert(input: UpsertInput): Promise<{ candidate: Candidate; created: boolean }> {
    return this.serial(async () => {
      const fingerprint = fingerprintOf(input.source, input.key);
      const at = this.now().toISOString();
      const existing = await this.findByFingerprint(fingerprint);
      const releaseWindow = input.window ?? existing?.window;
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
  patch(id: string, update: (candidate: Candidate) => Candidate): Promise<Candidate> {
    return this.serial(async () => { const next = { ...update(await this.get(id)), updatedAt: this.now().toISOString() }; await this.save(next); return next; });
  }
  async checkpoint(name: string): Promise<string | undefined> { return (await this.readState())[name]; }
  async checkpoints(): Promise<Checkpoints> { return this.readState(); }
  setCheckpoint(name: string, value: string): Promise<void> {
    return this.serial(async () => { const state = await this.readState(); state[name] = value; await writeJsonAtomic(join(this.directory, 'state.json'), state); });
  }
  private async readState(): Promise<Checkpoints> {
    try {
      const state: unknown = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
      check(typeof state === 'object' && state !== null && !Array.isArray(state), 'state.json must hold a JSON object');
      return state as Checkpoints;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  private async save(candidate: Candidate): Promise<void> {
    await mkdir(this.candidatesDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(join(this.candidatesDir, `${candidate.id}.json`), candidate);
  }
}
