/**
 * The detail's 执行: what a start sends to a creator-mode session, shown before anything is opened. The task instructions come from the
 * Host (`brief`) and can be edited; what goes with them is listed as the Host gives it; the model and the preset are picked for this start
 * only and never saved. A candidate already sent shows its session at the top and starts another one with what the form holds.
 */
import { useEffect, useState } from 'react';
import type { Candidate } from '../core/candidate.js';
import type { ModelRoute, Settings } from '../core/settings.js';
import { RowMessages, type CandidateAction, type RowState } from './CandidateRow.js';
import type { Brief, Call } from './contract.js';
import { time } from './labels.js';
import { ModelField, ModelsNotice, routeOf, routeText, useModels } from './SettingsView.js';
import { useUi } from './ui-context.js';

/** What one start sends besides the candidate: the task instructions as edited, and the model and the preset picked for it. */
export interface StartFields { instructions: string; model: ModelRoute; preset: string }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The brief as the pane knows it: still asking, the brief, or why the Host gave none (no report, an ignored candidate, no mirror path). */
type BriefState = { status: 'loading' } | { status: 'ready'; brief: Brief } | { status: 'refused'; message: string };

/**
 * Asks the Host for the brief of `candidate` when the pane opens. A refused one is asked for again when the candidate moves on (its first
 * report written, a restore), so the form shows up without leaving the pane; a brief once given is kept, as the user may be editing it.
 */
function useBrief(call: Call, candidate: Candidate): BriefState {
  const [state, setState] = useState<BriefState>({ status: 'loading' });
  const kept = state.status === 'ready';
  /** Changes when what the Host refused on may have changed; the effect reads it only to run again. */
  const moved = `${candidate.status} ${candidate.report?.generatedAt ?? ''}`;
  useEffect(() => {
    if (kept) return;
    const controller = new AbortController();
    call({ action: 'brief', id: candidate.id }, controller.signal).then(
      response => {
        if (controller.signal.aborted) return;
        setState(response.brief ? { status: 'ready', brief: response.brief } : { status: 'refused', message: 'OpenCodex 没有给出任务指令。' });
      },
      error => { if (!controller.signal.aborted) setState({ status: 'refused', message: messageOf(error) }); },
    );
    return () => controller.abort();
  }, [call, candidate.id, moved, kept]);
  return state;
}

export interface ExecutePaneProps {
  candidate: Candidate;
  /** For the defaults of the model and the preset. */
  settings: Settings;
  /** For the brief and the model list. */
  call: Call;
  busy?: CandidateAction;
  /** How the last start ended, when it did not end plainly; shown beside the button that sent it. */
  state: RowState;
  send: (fields: StartFields) => unknown;
  /** Shows the session the candidate was sent to; absent where the page cannot switch sessions. */
  showSession?: () => void;
}

export function ExecutePane({ candidate, settings, call, busy, state, send, showSession }: ExecutePaneProps) {
  const { Button, Input } = useUi();
  const brief = useBrief(call, candidate);
  const models = useModels(call);
  // Each field shows its default until the user changes it: the brief's instructions, the settings' start model and preset.
  const [instructions, setInstructions] = useState<string>();
  const [model, setModel] = useState<string>();
  const [preset, setPreset] = useState<string>();
  const savedModel = routeText(settings.startModel);
  const text = instructions ?? (brief.status === 'ready' ? brief.brief.instructions : '');
  const route = routeOf(model ?? savedModel), presetText = preset ?? settings.startPreset;
  // The Host refuses blank instructions and a route without both parts; the button waits for them rather than sending a refusal.
  const complete = brief.status === 'ready' && text.trim() !== '' && route.provider !== '' && route.model !== '';
  const disabled = !complete || busy !== undefined;
  const submit = () => { if (!disabled) send({ instructions: text, model: route, preset: presetText.trim() }); };
  const label = (idle: string) => (busy === 'start' ? '发送中…' : idle);
  const { started } = candidate;
  return <div className="oc-execute">
    {started && <>
      <div className="oc-execute-session">
        <p className="oc-execute-sent">
          <span>会话 {showSession
            ? <button type="button" className="oc-row-link" onClick={showSession}><code>{started.sessionId}</code></button>
            : <code>{started.sessionId}</code>}</span>
          <span>发送于 <time dateTime={started.at}>{time(started.at)}</time></span>
        </p>
        <Button variant="outline" size="sm" disabled={disabled} onClick={submit}>{label('再开一个会话')}</Button>
      </div>
      <RowMessages state={state} />
    </>}
    {brief.status === 'loading' && <p className="oc-muted" role="status">正在读取任务指令…</p>}
    {brief.status === 'refused' && <p className="oc-warning" role="status">{brief.message}</p>}
    {brief.status === 'ready' && <div className="oc-execute-form">
      <label><span className="oc-label">任务指令</span>
        <textarea className="oc-instructions" name="instructions" value={text} rows={12} spellCheck={false} onChange={event => setInstructions(event.target.value)} />
      </label>
      <p className="oc-hint">只有这一段能改，报告和下面这些会原样带上。</p>
      <h3>会一起带过去的</h3>
      <ul className="oc-attachments">{brief.brief.attachments.map(line => <li key={line}>{line}</li>)}</ul>
      <ModelsNotice models={models} />
      <div className="oc-two-columns">
        <ModelField name="startModel" label="模型" value={model ?? savedModel} saved={savedModel} models={models} change={setModel} />
        <label><span className="oc-label">Agent 预设</span><Input className="oc-field" name="startPreset" value={presetText} spellCheck={false}
          placeholder="留空用 DSH 默认预设" onChange={event => setPreset(event.target.value)} /></label>
      </div>
      <p className="oc-hint">模型和预设只用于这一次，不改设置。</p>
      <p className="oc-execute-note">会话在 workspace-write 沙箱里运行，能写自己的工作目录；安装 bundle 时 DSH 会弹一次审批。</p>
      {!started && <>
        {/* A button rather than a form: Enter in a field must not open a session. */}
        <div className="oc-form-actions"><Button variant="primary" size="sm" disabled={disabled} onClick={submit}>{label('发送并打开会话')}</Button></div>
        <RowMessages state={state} />
      </>}
    </div>}
  </div>;
}
