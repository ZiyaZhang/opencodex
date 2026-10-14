/** Install accepted artifacts through the native manager of the current DSH profile. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangeResult, PluginInstallRequestId, PluginManager } from '@deepseek-ai/dsh-plugin-manager';
import type { OpenCodexStore } from '../core/store.js';
import { readRegisteredPlugin } from './plugin-download.js';

type Manager = Pick<PluginManager, 'listBundles' | 'installBundle' | 'setBundleEnabled' | 'cancelInstall'>;
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

/** Retained file: pnpm saves this file: source in the profile for future reinstalls. */
async function retainPackage(directory: string, digest: string, bytes: Buffer): Promise<string> {
  let path = await realpath(directory);
  for (const part of ['installed-packages', digest]) {
    path = join(path, part); await mkdir(path, { recursive: true, mode: 0o700 });
    if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('Installation storage must not contain symlinks');
  }
  path = join(path, 'plugin.tgz');
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes.length || createHash('sha256').update(await readFile(path)).digest('hex') !== digest) throw new Error('Retained installation package does not match its verified digest');
  return path;
}

export class PluginInstaller {
  private readonly pending = new Map<string, Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly store: OpenCodexStore, private readonly directory: string, private readonly manager: () => Manager | undefined, private readonly signal: AbortSignal) {}

  /** Coalesce repeat delivery and serialize native mutations of this profile. */
  install(jobId: string): Promise<void> {
    const pending = this.pending.get(jobId);
    if (pending) return pending;
    const operation = this.queue.catch(() => undefined).then(() => this.run(jobId));
    this.queue = operation; this.pending.set(jobId, operation);
    void operation.finally(() => { if (this.pending.get(jobId) === operation) this.pending.delete(jobId); }).catch(() => undefined);
    return operation;
  }

  async whenIdle(): Promise<void> { await this.queue.catch(() => undefined); }

  private async run(jobId: string): Promise<void> {
    this.signal.throwIfAborted();
    if (this.store.getJob(jobId).status === 'installed') return;
    const journal = await this.store.beginInstallation(jobId);
    let metadata: { packageName: string; version: string } | undefined;
    let dispatched = false;
    try {
      await this.store.assertInstallable(jobId);
      const { bytes, inspection } = await readRegisteredPlugin(this.store, jobId, journal.artifactId, this.signal);
      metadata = { packageName: inspection.packageName, version: inspection.version };
      const manager = this.manager();
      if (!manager) throw new Error('当前 DSH 未提供插件管理服务。启用 DSH 插件管理后可重试，生成的包已保留。');
      const path = await retainPackage(this.directory, journal.artifactSha256, bytes);
      const bundle = (await manager.listBundles()).find(item => item.name === metadata!.packageName);
      const sameSource = bundle?.source === path || bundle?.source === `file:${path}`;
      if (bundle && (bundle.installed || bundle.availability !== 'missing') && (!sameSource || bundle.version !== metadata.version)) throw new Error(`包名 ${metadata.packageName} 已被其他安装占用。请为这项功能生成独立包名，或在 DSH 插件管理中处理版本替换。`);
      this.signal.throwIfAborted();
      // Retrying an interrupted call with this exact retained package must not reinstall it.
      const cancel = () => { void manager.cancelInstall(journal.requestId as PluginInstallRequestId).catch(() => undefined); };
      this.signal.addEventListener('abort', cancel, { once: true });
      let result: ChangeResult;
      try {
        dispatched = true;
        result = sameSource && bundle?.installed
          ? await manager.setBundleEnabled(metadata.packageName, true)
          : await manager.installBundle(path, { enabled: true, saveExact: true, requestId: journal.requestId as PluginInstallRequestId });
      } finally { this.signal.removeEventListener('abort', cancel); }
      const successful = ['applied', 'restart-required'].includes(result.application)
        && !result.error && result.enabled === true && result.target === metadata.packageName
        && (result.bundle === undefined || result.bundle === metadata.packageName)
        && (result.version === undefined || result.version === metadata.version);
      await this.store.finishInstallation(jobId, journal.requestId, {
        ...metadata, status: successful ? 'installed' : 'failed', application: result.application,
        ...(!successful ? { error: result.error?.diagnostic || (result.application === 'overridden' ? '插件启用被其他 DSH 配置覆盖，请在插件管理中查看。' : `DSH 未完成安装和启用（${result.application} / ${result.stage}）。${result.pendingBuilds?.length ? ` 依赖需要在插件管理中授权构建：${result.pendingBuilds.join(', ')}。` : ''}`) } : {}),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        ...(result.packageResult?.logPath ? { logPath: result.packageResult.logPath } : {}),
      });
    } catch (error) {
      await this.store.finishInstallation(jobId, journal.requestId, { ...metadata, status: dispatched || this.signal.aborted ? 'interrupted' : 'failed', error: errorText(error).slice(0, 4000) });
    }
  }
}
