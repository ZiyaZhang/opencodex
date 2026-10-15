/** settings.json: read when the Host starts, written by the `settings` action. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, mergeSettings, type Settings, type SettingsPatch } from '../../core/settings.js';
import { writeJsonAtomic } from '../../core/store.js';
import { messageOf, type HostContext } from './context.js';
import { rebuildIndex } from './index.js';

const fileOf = (directory: string) => join(directory, 'settings.json');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The settings in `<directory>/settings.json`, with the defaults filling the keys an older file lacks; a missing file is written with the
 * defaults. A file that is no JSON object, or that holds an invalid value, throws an Error naming the file and the problem: the plugin does
 * not start on settings nobody chose.
 */
export async function loadSettings(directory: string): Promise<Readonly<Settings>> {
  const path = fileOf(directory);
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeJsonAtomic(path, DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) {
    throw new Error(`OpenCodex 设置文件 ${path} 不是合法的 JSON，改好或删掉它再启用插件：${messageOf(error)}`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`OpenCodex 设置文件 ${path} 必须是一个 JSON 对象，改好或删掉它再启用插件`);
  try { return mergeSettings(DEFAULT_SETTINGS, value as SettingsPatch); } catch (error) {
    throw new Error(`OpenCodex 设置文件 ${path} 里有无效的设置，改好或删掉它再启用插件：${messageOf(error)}`, { cause: error });
  }
}

/**
 * The `settings` action: the patch over the settings in force, validated, written to settings.json, then put in force (which re-arms the
 * check timer). Writes run one at a time. A new mirror path is indexed right away, with `force`: the index of another mirror may well be
 * smaller, and the guard against a shrinking index would refuse it at every check. A failed build leaves the settings saved and says so.
 */
export async function updateSettings(ctx: HostContext, patch: SettingsPatch): Promise<void> {
  const moved = await ctx.lanes.settings.run(async () => {
    const before = ctx.settings();
    const next = mergeSettings(before, patch);
    await writeJsonAtomic(fileOf(ctx.directory), next);
    ctx.setSettings(next);
    return next.dshMirrorPath !== '' && next.dshMirrorPath !== before.dshMirrorPath;
  });
  if (!moved) return;
  try { await rebuildIndex(ctx); } catch (error) {
    throw new Error(`设置已保存，但用新的镜像路径建 DSH 索引失败：${messageOf(error)}`, { cause: error });
  }
}
