/** Native package-management integration only; synthetic acceptance is not UI evidence. */
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-plugin-manager';
import { OpenCodexStore } from '../../../src/core/store.js';
import { PluginInstaller } from '../../../src/host/plugin-install.js';
import { inspectTarball } from '../../../src/host/artifact.js';
import { verifyingPlugin } from '../../helpers/plugin-fixture.js';

export const inject = ['pluginManager'];
export function apply(ctx: Context, config: { home: string; archive: string; phase: string }) {
  const timer = setTimeout(() => { void run().catch(async error => {
    await writeFile(join(config.home, `${config.phase}.json`), JSON.stringify({ passed: false, error: String(error), stack: error.stack }, null, 2));
  }); }, 1000);
  ctx.effect(() => () => clearTimeout(timer));
  async function run() {
    assert.equal(await realpath(process.env.DSH_HOME!), await realpath(config.home));
    assert.equal(await readFile(join(config.home, 'native-install-fixture'), 'utf8'), 'isolated native installation fixture');
    const bytes = await readFile(config.archive), manifest = inspectTarball(bytes);
    const before = (await ctx.pluginManager.listBundles()).find(bundle => bundle.name === manifest.packageName);
    assert.ok(!(await ctx.pluginManager.listBundles()).some(bundle => bundle.name === 'dsh-opencodex' && bundle.enabled));
    const entries = (await ctx.pluginManager.listPlugins()).filter(entry => entry.moduleName === manifest.packageName);
    let result: unknown;
    if (config.phase === 'install') {
      assert.ok(!before?.installed);
      const store = await OpenCodexStore.open({ directory: join(config.home, 'installation-journal') });
      try {
        const fixture = await verifyingPlugin(store, bytes);
        for (const scope of ['behavior', 'visual', 'lifecycle'] as const) await store.recordVerification(fixture.jobId, fixture.verification(scope));
        await store.transitionJob(fixture.jobId, 'ready');
        await new PluginInstaller(store, join(config.home, 'installation-journal'), () => ctx.pluginManager, new AbortController().signal).install(fixture.jobId);
        const job = store.getJob(fixture.jobId); result = job.installation;
        assert.equal(job.status, 'installed', JSON.stringify(result));
      } finally { await store.close(); }
    } else if (config.phase === 'disable' || config.phase === 'remove') {
      assert.equal(before?.enabled, true); assert.equal(before?.installed, true);
      assert.ok(entries.some(entry => entry.enabled && entry.fiberPhase === 'active'), 'Generated plugin must load after a real restart without OpenCodex');
      result = config.phase === 'disable' ? await ctx.pluginManager.setBundleEnabled(manifest.packageName, false) : await ctx.pluginManager.removeBundle(manifest.packageName);
    } else if (config.phase === 'enable') {
      assert.equal(before?.enabled, false); assert.equal(before?.installed, true);
      assert.ok(!entries.some(entry => entry.enabled && entry.fiberPhase === 'active'));
      result = await ctx.pluginManager.setBundleEnabled(manifest.packageName, true);
    } else {
      assert.equal(config.phase, 'removed'); assert.ok(!before?.installed && !before?.enabled);
      assert.equal(entries.length, 0);
    }
    if (result && typeof result === 'object' && 'application' in result) assert.ok(['applied', 'restart-required'].includes(String(result.application)), JSON.stringify(result));
    const after = (await ctx.pluginManager.listBundles()).find(bundle => bundle.name === manifest.packageName);
    await writeFile(join(config.home, `${config.phase}.json`), JSON.stringify({ passed: true, phase: config.phase, packageName: manifest.packageName, version: manifest.version, before, entries, result, after, scope: 'Native installation, persistence and plugin lifecycle only. Synthetic acceptance records do not establish feature behavior or visual parity.' }, null, 2));
  }
}
