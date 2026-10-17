import { check, isRecord } from './check.js';

export interface ModelRoute { provider: string; model: string }
export interface Settings {
  channel: 'stable';
  desktopPlistPath: string;
  desktopLocale: string;
  dshMirrorPath: string;
  classifyModel: ModelRoute;
  /** Decision F: the analyst session is switched to this route right after creation. */
  reportModel: ModelRoute;
  reportPreset: string;
  startPreset: string;
  /** The creator session is switched to this route right after creation, as the analyst session is to `reportModel`. */
  startModel: ModelRoute;
  dailyReportLimit: number;
  checkIntervalHours: number;
}
export type SettingsPatch = Partial<Settings>;

/**
 * The longest check interval. A Node timer longer than 2^31 - 1 ms (about 596 hours) fires at once instead, so an interval past that would
 * turn the daily check into a busy loop against GitHub; a week is the longest interval that still makes sense for a feed that ships most days.
 */
const MAX_CHECK_INTERVAL_HOURS = 168;

/** An absolute path, or empty for "off". */
const isPathSetting = (value: unknown): boolean => typeof value === 'string' && (value === '' || value.startsWith('/'));
const isRoute = (value: unknown): value is ModelRoute =>
  isRecord(value) && typeof value.provider === 'string' && value.provider.length > 0 && typeof value.model === 'string' && value.model.length > 0;

/** A frozen copy whose model routes are frozen copies too, holding only `provider` and `model`. Call it on validated settings only. */
function frozen(settings: Settings): Readonly<Settings> {
  const route = ({ provider, model }: ModelRoute): ModelRoute => Object.freeze({ provider, model });
  return Object.freeze({
    ...settings, classifyModel: route(settings.classifyModel), reportModel: route(settings.reportModel), startModel: route(settings.startModel),
  });
}

/** The route reports and creator sessions run on unless the settings say otherwise. */
const PRO: ModelRoute = { provider: 'deepseek-official', model: 'deepseek-v4-pro' };
export const DEFAULT_SETTINGS: Readonly<Settings> = frozen({
  channel: 'stable', desktopPlistPath: '/Applications/ChatGPT.app/Contents/Info.plist', desktopLocale: 'zh-CN', dshMirrorPath: '',
  classifyModel: { provider: 'deepseek-official', model: 'deepseek-flash' }, reportModel: PRO,
  reportPreset: '', startPreset: 'cordis', startModel: PRO, dailyReportLimit: 10, checkIntervalHours: 24,
});
const KEYS = Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>;

/**
 * Checks every value, its type included, so settings that come from JSON fail with a ValidationError rather than a TypeError.
 * Keys outside `Settings` are not looked at: the Host refuses them where requests come in.
 */
export function validateSettings(value: Settings): void {
  check(isRecord(value), 'settings must be an object');
  check(value.channel === 'stable', 'channel must be stable');
  check(isPathSetting(value.desktopPlistPath), 'desktopPlistPath must be absolute or empty');
  check(isPathSetting(value.dshMirrorPath), 'dshMirrorPath must be absolute or empty');
  check(typeof value.desktopLocale === 'string' && /^[a-z][\w-]*$/i.test(value.desktopLocale), 'desktopLocale must be a locale id');
  check(Number.isInteger(value.dailyReportLimit) && value.dailyReportLimit >= 1, 'dailyReportLimit must be an integer >= 1');
  check(Number.isInteger(value.checkIntervalHours) && value.checkIntervalHours >= 1 && value.checkIntervalHours <= MAX_CHECK_INTERVAL_HOURS,
    `checkIntervalHours must be an integer from 1 to ${MAX_CHECK_INTERVAL_HOURS}`);
  check(isRoute(value.classifyModel), 'classifyModel needs a provider and a model');
  check(isRoute(value.reportModel), 'reportModel needs a provider and a model');
  check(typeof value.reportPreset === 'string', 'reportPreset must be a string');
  check(typeof value.startPreset === 'string', 'startPreset must be a string');
  check(isRoute(value.startModel), 'startModel needs a provider and a model');
}

/**
 * `current` with the fields of `patch` laid over it, validated, as a new frozen object; neither argument is changed.
 * Only the fields of `Settings` are read, so stray keys never reach settings.json, and a field set to `undefined` keeps its current value.
 * A model route in the patch replaces the whole route. Settings read from an older file are completed with `mergeSettings(DEFAULT_SETTINGS, fromFile)`.
 */
export function mergeSettings(current: Readonly<Settings>, patch: SettingsPatch): Readonly<Settings> {
  check(isRecord(patch), 'settings patch must be an object');
  const merged = Object.fromEntries(KEYS.map(key => [key, patch[key] === undefined ? current[key] : patch[key]])) as unknown as Settings;
  validateSettings(merged);
  return frozen(merged);
}
