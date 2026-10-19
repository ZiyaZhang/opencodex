/**
 * The settings page: paths, models, sessions, checking and research. The three models are picked from the models DSH lists, by provider,
 * and saved as `{ provider, model }` routes; where DSH lists none, or the Host cannot list them, they are typed as `provider/model`.
 */
import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { DEFAULT_SETTINGS, type AutoResearch, type ModelRoute, type Settings } from '../core/settings.js';
import type { Call, ModelCatalog } from './contract.js';
import { Icon } from './icons.js';
import { useUi } from './ui-context.js';

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A model route as its option's value: `provider/model`. */
export const routeText = ({ provider, model }: ModelRoute) => `${provider}/${model}`;
/** A `provider/model` value as a route, split at the first `/`: provider ids have none, model ids can (`openrouter/anthropic/…`). */
export function routeOf(text: string): ModelRoute {
  const at = text.indexOf('/');
  return at < 0 ? { provider: text.trim(), model: '' } : { provider: text.slice(0, at).trim(), model: text.slice(at + 1).trim() };
}

type ModelKey = 'classifyModel' | 'reportModel' | 'startModel';
/** The settings form's fields as the controls hold them: text, and the model routes as `provider/model`. */
export interface SettingsDraft {
  dshMirrorPath: string; desktopPlistPath: string; desktopLocale: string;
  classifyModel: string; reportModel: string; startModel: string;
  reportPreset: string; startPreset: string; dailyReportLimit: string; checkIntervalHours: string;
  autoResearch: AutoResearch;
}
/**
 * Right after the plugin is reinstalled the page can still be talking to the previous Host, whose settings have no `autoResearch`; it is
 * shown with the Host's default, and goes out only when the user changes it (that Host refuses the field).
 */
const autoResearchOf = (settings: Settings): AutoResearch => settings.autoResearch ?? DEFAULT_SETTINGS.autoResearch;
export const draftOf = (settings: Settings): SettingsDraft => ({
  dshMirrorPath: settings.dshMirrorPath, desktopPlistPath: settings.desktopPlistPath, desktopLocale: settings.desktopLocale,
  classifyModel: routeText(settings.classifyModel), reportModel: routeText(settings.reportModel), startModel: routeText(settings.startModel),
  reportPreset: settings.reportPreset, startPreset: settings.startPreset,
  dailyReportLimit: String(settings.dailyReportLimit), checkIntervalHours: String(settings.checkIntervalHours),
  autoResearch: autoResearchOf(settings),
});
/** The settings the draft changes: trimmed, numbers as numbers, a changed route whole. The Host checks the values. */
export function settingsPatch(current: Settings, draft: SettingsDraft): Partial<Settings> {
  const before: Settings = { ...current, autoResearch: autoResearchOf(current) };
  const next: Settings = {
    ...before,
    dshMirrorPath: draft.dshMirrorPath.trim(), desktopPlistPath: draft.desktopPlistPath.trim(), desktopLocale: draft.desktopLocale.trim(),
    classifyModel: routeOf(draft.classifyModel), reportModel: routeOf(draft.reportModel), startModel: routeOf(draft.startModel),
    reportPreset: draft.reportPreset.trim(), startPreset: draft.startPreset.trim(),
    dailyReportLimit: Number(draft.dailyReportLimit), checkIntervalHours: Number(draft.checkIntervalHours), autoResearch: draft.autoResearch,
  };
  const changed = (Object.keys(next) as (keyof Settings)[]).filter(key => JSON.stringify(next[key]) !== JSON.stringify(before[key]));
  return Object.fromEntries(changed.map(key => [key, next[key]])) as Partial<Settings>;
}

export interface ModelChoices {
  /** One group per provider that lists models, each model under the name DSH gives it. */
  groups: Array<{ provider: string; label: string; options: Array<{ value: string; label: string }> }>;
  /** The values the field has to offer that DSH does not list: the saved route, or one picked before the list changed. */
  missing: Array<{ value: string; label: string }>;
}
export function modelChoices(catalog: ModelCatalog, values: readonly string[]): ModelChoices {
  const groups = catalog.filter(entry => entry.models.length > 0).map(entry => ({
    provider: entry.provider, label: entry.providerName || entry.provider,
    options: entry.models.map(model => ({ value: `${entry.provider}/${model.id}`, label: model.name || model.id })),
  }));
  const listed = new Set(groups.flatMap(group => group.options.map(option => option.value)));
  const missing = [...new Set(values)].filter(value => !listed.has(value)).map(value => ({ value, label: `${value}（不在列表里）` }));
  return { groups, missing };
}

/** What a page part knows of DSH's models: still asking, the catalog (empty when DSH lists none), or why it could not be read. */
export type ModelsState = { status: 'loading' } | { status: 'ready'; catalog: ModelCatalog; notice?: string } | { status: 'failed'; error: string };
/**
 * Asks the Host for DSH's models once, when the component mounts (the settings, or the detail's 执行, opening); the Host keeps the list
 * for 5 minutes.
 */
export function useModels(call: Call): ModelsState {
  const [state, setState] = useState<ModelsState>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    call({ action: 'models' }, controller.signal).then(
      response => { if (!controller.signal.aborted) setState({ status: 'ready', catalog: response.models ?? [], ...(response.notice && { notice: response.notice }) }); },
      error => { if (!controller.signal.aborted) setState({ status: 'failed', error: messageOf(error) }); },
    );
    return () => controller.abort();
  }, [call]);
  return state;
}
const listsModels = (models: ModelsState) => models.status === 'ready' && models.catalog.some(entry => entry.models.length > 0);

/** What the model fields cannot offer, and why: the list still loading, not read, or empty; a provider whose list failed. */
export function ModelsNotice({ models }: { models: ModelsState }) {
  if (models.status === 'loading') return <p className="oc-field-note oc-muted" role="status">正在读取 DSH 的模型列表…</p>;
  if (models.status === 'failed') return <p className="oc-warning" role="status">模型列表没取到：{models.error}；先按「提供方/模型」填写。</p>;
  return <>
    {!listsModels(models) && <p className="oc-warning" role="status">DSH 没有列出可选的模型；先按「提供方/模型」填写。</p>}
    {models.notice && <p className="oc-notice" role="status">{models.notice}</p>}
  </>;
}

/**
 * One model route: a select of DSH's models by provider, or, without a list, a text box of `provider/model`. The settings use it for their
 * three models, the detail's 执行 for the model of one start.
 */
export function ModelField({ name, label, value, saved, models, change }: {
  name: ModelKey; label: string; value: string; saved: string; models: ModelsState; change: (value: string) => void;
}) {
  const { Input } = useUi();
  if (models.status === 'loading') {
    return <label><span className="oc-label">{label}</span><select name={name} value={value} disabled onChange={() => {}}><option value={value}>{value}</option></select></label>;
  }
  if (!listsModels(models)) {
    return <label><span className="oc-label">{label}</span><Input className="oc-field" name={name} value={value} spellCheck={false} placeholder="提供方/模型" onChange={event => change(event.target.value)} /></label>;
  }
  const { groups, missing } = modelChoices(models.status === 'ready' ? models.catalog : [], [value, saved]);
  return <label><span className="oc-label">{label}</span><select name={name} value={value} onChange={event => change(event.target.value)}>
    {groups.map(group => <optgroup key={group.provider} label={group.label}>
      {group.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </optgroup>)}
    {missing.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>;
}

export interface SettingsViewProps {
  settings: Settings;
  /** For the model list. */
  call: Call;
  saving: boolean;
  /** Why the last save failed. */
  error?: string;
  /** Sends the patch; true when it went through. */
  save: (patch: Partial<Settings>) => Promise<boolean>;
  back: () => void;
}

export function SettingsView({ settings, call, saving, error, save, back }: SettingsViewProps) {
  const { Button, Input } = useUi();
  const models = useModels(call);
  const [draft, setDraft] = useState(() => draftOf(settings));
  const [saved, setSaved] = useState(false);
  /** The last save's error describes values the user has edited since. */
  const [edited, setEdited] = useState(false);
  /** The settings the draft was last brought up to date with: a field that still holds its value there is one the user has not changed. */
  const base = useRef(draftOf(settings));
  const stored = JSON.stringify(settings);
  // New settings from the Host (after a save, or a refresh that brings a change made elsewhere) go into the fields the user has not
  // changed and the ones the user changed to just that value; what the user is still typing stays.
  useEffect(() => {
    const next = draftOf(JSON.parse(stored) as Settings), previous = base.current;
    base.current = next;
    setDraft(current => {
      const merged = { ...current };
      for (const key of Object.keys(next) as (keyof SettingsDraft)[]) {
        if (current[key] === previous[key] || current[key].trim() === next[key]) Object.assign(merged, { [key]: next[key] });
      }
      return merged;
    });
  }, [stored]);
  const patch = settingsPatch(settings, draft);
  const dirty = Object.keys(patch).length > 0;
  const set = <K extends keyof SettingsDraft>(name: K, value: SettingsDraft[K]) => {
    setSaved(false); setEdited(true); setDraft(current => ({ ...current, [name]: value }));
  };
  const field = (name: Exclude<keyof SettingsDraft, ModelKey | 'autoResearch'>, label: string, attributes: InputHTMLAttributes<HTMLInputElement> = {}) =>
    <label><span className="oc-label">{label}</span><Input className="oc-field" name={name} value={draft[name]} spellCheck={false} {...attributes} onChange={event => set(name, event.target.value)} /></label>;
  const model = (name: ModelKey, label: string) =>
    <ModelField name={name} label={label} value={draft[name]} saved={routeText(settings[name])} models={models} change={value => set(name, value)} />;
  const submit = async () => {
    if (!dirty || saving) return;
    setEdited(false);
    if (await save(patch)) setSaved(true);
  };
  return <section className="oc-settings" aria-labelledby="oc-settings-title">
    <Button variant="ghost" size="sm" className="oc-back-button" icon={<Icon name="back" />} onClick={back}>返回</Button>
    <h2 id="oc-settings-title" className="oc-settings-title">设置</h2>
    <form className="oc-form" onSubmit={event => { event.preventDefault(); return submit(); }}>
      <h3>镜像与桌面端</h3>
      {field('dshMirrorPath', 'DSH 镜像路径', { placeholder: '/Users/…/deepseek-harness' })}
      <p className="oc-hint">报告里的 DSH 引用都相对这个目录；改了以后马上重建索引。</p>
      {field('desktopPlistPath', '桌面端 Info.plist 路径')}
      <p className="oc-hint">ChatGPT.app 的 Info.plist；留空就不检查桌面端。</p>
      {field('desktopLocale', '桌面端文案语言', { placeholder: 'zh-CN' })}
      <h3>模型</h3>
      <ModelsNotice models={models} />
      {model('classifyModel', '归类模型')}
      {model('reportModel', '调研模型')}
      {model('startModel', '执行模型')}
      <h3>会话</h3>
      <div className="oc-two-columns">
        {field('reportPreset', '调研会话的 Agent 预设', { placeholder: '留空用 DSH 默认预设' })}
        {field('startPreset', '执行会话的 Agent 预设', { placeholder: '留空用 DSH 默认预设' })}
      </div>
      <p className="oc-hint">cordis 是创造模式。</p>
      <h3>检查与调研</h3>
      <div className="oc-two-columns">
        {field('checkIntervalHours', '检查间隔（小时）', { type: 'number', min: 1, max: 168, step: 1, required: true })}
        {field('dailyReportLimit', '每日报告上限（份）', { type: 'number', min: 1, step: 1, required: true })}
      </div>
      <label><span className="oc-label">自动调研</span><select name="autoResearch" value={draft.autoResearch} onChange={event => set('autoResearch', event.target.value as AutoResearch)}>
        <option value="off">关</option>
        <option value="high">相关度高</option>
        <option value="medium">相关度中及以上</option>
      </select></label>
      <p className="oc-hint">检查结束后，自动调研相关度达到这一档的新发现，份数算在每日报告上限里。</p>
      <div className="oc-form-actions">
        <Button type="submit" variant="outline" size="sm" disabled={saving || !dirty}>{saving ? '保存中…' : '保存'}</Button>
        {saved && !dirty && <span className="oc-muted" role="status">已保存</span>}
      </div>
      {error && !edited && <p className="oc-error" role="alert">{error}</p>}
    </form>
  </section>;
}
