/** Runs only inside a disposable DSH profile. It has no OpenCodex service or model credentials. */
import assert from 'node:assert/strict';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-plugin-manager';

export const inject = ['pluginManager'];
export interface ProbeConfig { home: string; archive: string; packageName: string; version: string; phase: string; nonce: string }
export function apply(ctx: Context, config: ProbeConfig) {
  const timer = setTimeout(() => { void run().catch(error => save({ passed: false, error: String(error) })).catch(error => ctx.logger.warn(String(error))); }, 500);
  ctx.effect(() => () => clearTimeout(timer));
  const save = async (value: object) => {
    const temporary = join(config.home, `${config.phase}.tmp`);
    await writeFile(temporary, JSON.stringify({ ...value, phase: config.phase, nonce: config.nonce }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(config.home, `${config.phase}.json`));
  };
  async function run() {
    assert.equal(await realpath(process.env.DSH_HOME!), await realpath(config.home));
    assert.equal(await readFile(join(config.home, 'opencodex-verification'), 'utf8'), config.nonce);
    const bundles = await ctx.pluginManager.listBundles();
    assert.ok(!bundles.some(bundle => bundle.name === 'dsh-opencodex' && bundle.enabled));
    const before = bundles.find(bundle => bundle.name === config.packageName);
    let entries = (await ctx.pluginManager.listPlugins()).filter(entry => entry.moduleName === config.packageName);
    if (['disable', 'remove'].includes(config.phase)) {
      for (let i = 0; i < 100 && !entries.some(entry => entry.enabled && entry.fiberPhase === 'active'); i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        entries = (await ctx.pluginManager.listPlugins()).filter(entry => entry.moduleName === config.packageName);
      }
    }
    let result;
    if (config.phase === 'install') {
      assert.ok(!before?.installed);
      result = await ctx.pluginManager.installBundle(config.archive, { enabled: true, saveExact: true });
    } else if (config.phase === 'disable' || config.phase === 'remove') {
      assert.equal(before?.enabled, true); assert.equal(before?.installed, true); assert.equal(before?.version, config.version);
      assert.ok(entries.some(entry => entry.enabled && entry.fiberPhase === 'active'), 'Generated plugin failed to activate after restart');
      result = config.phase === 'disable' ? await ctx.pluginManager.setBundleEnabled(config.packageName, false) : await ctx.pluginManager.removeBundle(config.packageName);
    } else if (config.phase === 'enable') {
      assert.equal(before?.enabled, false); assert.equal(before?.installed, true);
      assert.ok(!entries.some(entry => entry.enabled && entry.fiberPhase === 'active'));
      result = await ctx.pluginManager.setBundleEnabled(config.packageName, true);
    } else {
      assert.equal(config.phase, 'removed'); assert.ok(!before?.installed && !before?.enabled); assert.equal(entries.length, 0);
    }
    if (result) assert.ok(['applied', 'restart-required'].includes(result.application), `Native ${config.phase} result: ${result.application}`);
    const after = (await ctx.pluginManager.listBundles()).find(bundle => bundle.name === config.packageName);
    if (config.phase === 'install' || config.phase === 'enable') { assert.equal(after?.installed, true); assert.equal(after?.enabled, true); }
    if (config.phase === 'disable') assert.equal(after?.enabled, false);
    if (config.phase === 'remove') assert.ok(!after?.installed);
    await save({ passed: true, packageName: config.packageName, version: config.version, entries: entries.map(e => ({ name: e.moduleName, phase: e.fiberPhase, enabled: e.enabled })), application: result?.application });
  }
}
