/** Lifecycle owner for an explicitly selected local version file. */
import type { OpenCodexStore } from '../core/index.js';
import { scanLocalVersion, watchLocalVersion, type LocalVersionScanResult } from './local-version.js';

export interface VersionMonitorStatus { selected: boolean; watching: boolean; version?: string; build?: string; error?: string }
export class VersionMonitor {
  private path = '';
  private disposeWatch?: () => void;
  private pathLifetime = new AbortController();
  private pending?: Promise<LocalVersionScanResult>;
  private lastCheckedAt = 0;
  private closed = false;
  private dirty = false;
  private current: VersionMonitorStatus = { selected: false, watching: false };
  constructor(private readonly directory: string, private readonly store: Promise<OpenCodexStore>, private readonly onCandidate: (id: string) => Promise<void>) {}
  status(): VersionMonitorStatus { return { ...this.current }; }
  async configure(path: string): Promise<void> {
    if (this.closed) return;
    if (path === this.path && (path === '' || this.disposeWatch)) return;
    this.dirty = false;
    this.pathLifetime.abort(new Error('Local version selection changed'));
    this.disposeWatch?.(); this.disposeWatch = undefined;
    this.path = path;
    await this.pending?.catch(() => undefined);
    if (this.path !== path || this.closed) return;
    this.pathLifetime = new AbortController();
    this.current = { selected: path !== '', watching: false };
    if (!path) return;
    try {
      this.disposeWatch = watchLocalVersion(path, () => { if (this.pending) { this.dirty = true; return; } void this.check().catch(error => { this.current.error = String(error); }); }, { onError: error => { this.disposeWatch?.(); this.disposeWatch = undefined; this.current = { ...this.current, watching: false, error: error.message }; } });
      this.current.watching = true;
    } catch (error) { this.current.error = error instanceof Error ? error.message : String(error); }
    await this.check();
  }
  check(signal?: AbortSignal): Promise<LocalVersionScanResult> {
    if (this.pending) return this.pending;
    if (this.closed || !this.path) return Promise.resolve({ baseline: 0, unchanged: 0, changed: 0, errors: [] });
    const path = this.path;
    const joined = signal ? AbortSignal.any([signal, this.pathLifetime.signal]) : this.pathLifetime.signal;
    const task = (async () => {
      const store = await this.store;
      const result = await scanLocalVersion(this.directory, store, { path }, joined);
      if (path !== this.path || this.closed) return result;
      this.lastCheckedAt = Date.now();
      this.current = { selected: true, watching: Boolean(this.disposeWatch), ...(result.version ? { version: result.version } : {}), ...(result.build ? { build: result.build } : {}), ...(result.errors.length ? { error: result.errors.join('; ') } : {}) };
      if (result.candidateId) await this.onCandidate(result.candidateId);
      return result;
    })();
    this.pending = task;
    void task.finally(() => {
      if (this.pending === task) this.pending = undefined;
      if (this.dirty && !this.closed && this.path === path) {
        this.dirty = false;
        void this.check().catch(error => { this.current.error = String(error); });
      }
    }).catch(() => undefined);
    return task;
  }
  async tick(intervalMinutes: number): Promise<void> {
    if (this.path && !this.closed && Date.now() - this.lastCheckedAt >= intervalMinutes * 60_000) await this.check();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.disposeWatch?.(); this.disposeWatch = undefined;
    this.pathLifetime.abort(new Error('OpenCodex local version monitor unloaded'));
    await this.pending?.catch(() => undefined);
  }
}
