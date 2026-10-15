import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AcceptanceRun, Artifact, FeatureSpec, Job, VerificationScope } from '../core/types.js';
import { OpenCodexStore } from '../core/store.js';
import { inspectArtifact } from './artifact.js';
import { runNativeVerification, VerificationUnavailableError, type NativeVerificationInput, type NativeVerificationReport } from './native-verification.js';

export interface FeatureCheck {
  scope: VerificationScope; outcome: 'passed' | 'failed' | 'partial'; details: string;
  /** Every specification row is identified as scope:1, scope:2, ... . */
  assertionIds: string[]; screenshotIds?: string[];
}
/** Trusted, installed DSH adapter. Research tools cannot register or invoke a verifier. */
export interface FeatureVerifier {
  verify(input: { job: Job; spec: FeatureSpec; artifact: Artifact; directory: string; signal: AbortSignal }): Promise<FeatureCheck[]>;
}
declare module '@deepseek-ai/cordis' { interface Context { opencodexFeatureVerifier: FeatureVerifier } }
const scopes = ['behavior', 'visual', 'lifecycle'] as const;

export class AcceptanceController {
  private readonly operations = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly store: OpenCodexStore, private readonly options: {
    signal: AbortSignal; whenResearchIdle(job: Job): Promise<void>;
    verifier(): FeatureVerifier | undefined;
    accepted(id: string): Promise<void>;
    repair(id: string, details: string): Promise<void>;
    native?: (input: NativeVerificationInput) => Promise<NativeVerificationReport>;
  }) {}
  run(id: string): Promise<void> {
    const existing = this.operations.get(id); if (existing) return existing;
    const abort = new AbortController(); this.aborts.set(id, abort);
    const operation = this.tail.catch(() => undefined).then(() => this.execute(id, abort.signal));
    this.tail = operation; this.operations.set(id, operation);
    void operation.finally(() => { this.operations.delete(id); this.aborts.delete(id); }).catch(() => undefined);
    return operation;
  }
  cancel(id: string): void { this.aborts.get(id)?.abort(new Error('Acceptance stopped')); }
  async whenIdle(): Promise<void> { await Promise.allSettled([...this.operations.values()]); }
  private async execute(id: string, cancelled: AbortSignal): Promise<void> {
    if (this.store.getJob(id).status !== 'verifying') return;
    const remaining = this.store.getJob(id).budget.maxDurationMs - this.store.budgetSummary(id).elapsedMs;
    const signal = AbortSignal.any([this.options.signal, cancelled, AbortSignal.timeout(Math.max(1, Math.min(remaining, 10 * 60_000)))]);
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      this.options.whenResearchIdle(this.store.getJob(id)).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    if (this.store.getJob(id).status !== 'verifying') return;
    const run = await this.store.beginAcceptance(id);
    const state = this.store.snapshot(), job = this.store.getJob(id);
    const spec = state.specs.find(item => item.id === run.specId)!;
    const artifact = state.artifacts.find(item => item.id === run.artifactId)!;
    const relativeDirectory = `${id}/acceptance/${run.id}`, directory = join(this.store.artifactRoot, relativeDirectory);
    const reportPath = `${relativeDirectory}/report.json`;
    let native: NativeVerificationReport | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const archive = resolve(this.store.artifactRoot, artifact.path);
      await inspectArtifact(archive, artifact.sha256);
      native = await (this.options.native ?? runNativeVerification)({ archive, sha256: artifact.sha256, directory: join(directory, 'profile'), signal });
      if (!native.passed) throw new Error('Native lifecycle checks did not pass');
      signal.throwIfAborted();
      const provider = this.options.verifier();
      const proposed = provider ? await provider.verify({ job, spec, artifact, directory, signal }) : [];
      signal.throwIfAborted();
      this.assertCurrent(id, run);
      if (!Array.isArray(proposed) || proposed.some(check => !check || !scopes.includes(check.scope)) || new Set(proposed.map(check => check.scope)).size !== proposed.length) throw new VerificationUnavailableError('Invalid or duplicate verifier scopes; repair the verifier adapter');
      const checks = scopes.map(scope => {
        const report = proposed.find(check => check.scope === scope);
        const required = spec[scope].map((_, index) => `${scope}:${index + 1}`);
        if (!report) return { scope, outcome: 'partial' as const, assertionIds: [], details: scope === 'lifecycle' ? '原生安装、启用、禁用、重启及卸载检查通过；功能自身的状态恢复仍待验收。' : `缺少已配置的独立${scope === 'visual' ? '视觉对照' : '功能行为'}验收器。` };
        if (!['passed', 'failed', 'partial'].includes(report.outcome) || typeof report.details !== 'string' || !report.details.trim() || !Array.isArray(report.assertionIds)) throw new VerificationUnavailableError('Invalid verifier result; repair the verifier adapter');
        if (report.outcome === 'passed' && (required.some(assertion => !report.assertionIds.includes(assertion)) || report.assertionIds.some(assertion => !required.includes(assertion)))) throw new VerificationUnavailableError(`Verifier did not cover every ${scope} obligation`);
        return report;
      });
      await writeFile(join(directory, 'report.json'), JSON.stringify({ jobId: id, run, native, checks }, null, 2), { mode: 0o600, flag: 'wx' });
      const evidence = await this.store.addEvidence(id, { kind: 'observed', localPath: reportPath, claim: 'Host ran independent acceptance against the recorded package digest. The report separates native lifecycle results from feature behavior and visual comparison; partial scopes remain open.' });
      await this.store.registerArtifact(id, { kind: 'report', path: reportPath, label: '自动隔离验收报告' });
      for (const check of checks) {
        this.assertCurrent(id, run);
        const latest = this.store.snapshot().verifications.filter(v => v.jobId === id && v.specId === spec.id && v.artifactId === artifact.id && v.scope === check.scope).at(-1);
        if (latest?.outcome === 'passed' && check.outcome === 'partial') continue;
        try { await this.store.recordVerification(id, { artifactId: artifact.id, scope: check.scope, outcome: check.outcome, method: check.scope === 'visual' ? 'browser' : 'command', environment: 'isolated', details: check.details, evidenceIds: [evidence.id], ...(check.screenshotIds ? { screenshotIds: check.screenshotIds } : {}) }); }
        catch (error) { throw new VerificationUnavailableError(`Verifier evidence rejected: ${error instanceof Error ? error.message : String(error)}`); }
      }
      const latest = this.store.snapshot().verifications.filter(v => v.jobId === id && v.specId === spec.id && v.artifactId === artifact.id);
      const passed = scopes.every(scope => latest.filter(v => v.scope === scope).at(-1)?.outcome === 'passed');
      const failed = checks.some(check => check.outcome === 'failed');
      const details = passed ? '所有隔离验收项目通过，准备安装。' : checks.filter(check => check.outcome !== 'passed').map(check => check.details).join('\n');
      await this.store.finishAcceptance(id, run.id, { status: passed ? 'passed' : failed ? 'failed' : 'blocked', details, reportPath });
      if (passed) await this.options.accepted(id);
      else if (failed) await this.options.repair(id, details);
      else await this.store.transitionJob(id, 'blocked', { reason: details });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      const current = this.store.getJob(id);
      if (current.acceptance?.id !== run.id || current.acceptance.status !== 'running') throw error;
      const interrupted = signal.aborted || current.status !== 'verifying';
      const unavailable = error instanceof VerificationUnavailableError;
      const failurePath = `${relativeDirectory}/failure.json`;
      let failureSaved = false;
      try { await writeFile(join(directory, 'failure.json'), JSON.stringify({ jobId: id, run, native, interrupted, error: details }, null, 2), { mode: 0o600 }); failureSaved = true; }
      catch { /* Keep the durable run status even when its report directory is unwritable. */ }
      await this.store.finishAcceptance(id, run.id, { status: interrupted ? 'interrupted' : unavailable ? 'blocked' : 'failed', details, ...(failureSaved ? { reportPath: failurePath } : {}) });
      if (current.status === 'verifying') {
        if (interrupted) await this.store.transitionJob(id, 'paused', { reason: details });
        else if (unavailable) await this.store.transitionJob(id, 'blocked', { reason: details });
        else await this.options.repair(id, details);
      }
    }
  }
  private assertCurrent(id: string, run: AcceptanceRun): void {
    const state = this.store.snapshot(), job = this.store.getJob(id);
    if (job.status !== 'verifying' || job.artifactId !== run.artifactId || state.specs.filter(spec => spec.jobId === id).at(-1)?.id !== run.specId) throw new Error('Acceptance input or job state changed');
  }
}
