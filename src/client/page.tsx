import { useCallback, useEffect, useRef, useState } from 'react';
import type { Artifact, Job, JobStatus, Settings, VerificationScope, Verification } from '../core/types.js';
import type { OpenCodexRequest, OpenCodexResponse } from '../host/remote.js';
import catalog from '../../resources/catalog.json';
import { Icon, type IconName } from './icons.js';

type Call = (request: OpenCodexRequest, signal?: AbortSignal) => Promise<OpenCodexResponse>;
type ReferenceImage = { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; dataBase64: string };
type Tab = 'research' | 'discover' | 'library' | 'settings';
const tabs: [Tab, string][] = [['research', '研究'], ['discover', '发现'], ['library', '资料'], ['settings', '设置']];
const tabIcons: Record<Tab, IconName> = { research: 'search', discover: 'radar', library: 'books', settings: 'settings' };
const labels: Record<JobStatus, string> = { detected: '发现候选', draft: '待开始', queued: '排队中', researching: '调查中', specifying: '编写规格', researched: '调查完成', building: '开发中', verifying: '待验收', ready: '可安装', covered: '已有能力可用', paused: '已暂停', blocked: '需要处理', failed: '失败', installed: '已安装', cancelled: '已取消' };
const active = new Set<JobStatus>(['queued', 'researching', 'specifying', 'building', 'verifying']);
const number = (value: number) => value.toLocaleString('zh-CN');
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const link = (value?: string) => value && /^https?:\/\//i.test(value) ? value : undefined;
const featureDescription = (value: string) => value.replace(/\n\nUser-supplied visual reference: reference\.(?:png|jpeg|webp) \(relative to this job's workspace\)\.[\s\S]*$/, '');

function Status({ status }: { status: JobStatus }) {
  const icon: IconName = status === 'paused' ? 'pause' : ['blocked', 'failed'].includes(status) ? 'warning'
    : ['ready', 'installed', 'covered', 'researched'].includes(status) ? 'check'
      : status === 'cancelled' ? 'close' : active.has(status) ? 'clock' : 'circle';
  return <span className={`oc-status oc-${status}`}><Icon name={icon} />{labels[status]}</span>;
}

function JobRow({ job, confirmed, open }: { job: Job; confirmed: number; open: () => void }) {
  return <button className="oc-job-row" onClick={open}>
    <span className="oc-job-symbol"><Icon name={job.mode === 'investigate' ? 'search' : 'code'} /></span>
    <span className="oc-job-content">
      <span className="oc-row-title"><strong>{job.title}</strong><Status status={job.status} /></span>
      <span className="oc-job-description">{featureDescription(job.description) || '尚无补充描述'}</span>
      <span className="oc-row-meta"><span><Icon name="clock" />{date(job.updatedAt)}</span><span><Icon name="gauge" /><span className="oc-numeric">{number(confirmed)} <span className="oc-separator">/</span> {number(job.budget.tokenLimit)}</span><span className="oc-unit">tokens</span></span></span>
    </span>
    <Icon name="next" className="oc-row-arrow" />
  </button>;
}

export function OpenCodexPage({ call }: { call: Call }) {
  const [tab, setTab] = useState<Tab>('research');
  const [data, setData] = useState<OpenCodexResponse>();
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState('');
  const [newJob, setNewJob] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [referenceImage, setReferenceImage] = useState<ReferenceImage>();
  const [referenceName, setReferenceName] = useState('');
  const [readingImage, setReadingImage] = useState(false);
  const [tokens, setTokens] = useState(100_000);
  const [resource, setResource] = useState<{ id: string; content: string }>();
  const lifecycle = useRef<AbortController>();
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await call({ action: 'snapshot' }, signal);
    setData(result);
  }, [call]);
  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(controller.signal); if (!stopped) setConnectionError(''); }
      catch (err) { if (!stopped) setConnectionError(String(err instanceof Error ? err.message : err)); }
      if (!stopped) timer = setTimeout(poll, 4000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [refresh]);
  const run = async (request: OpenCodexRequest, success?: string) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await call(request, lifecycle.current?.signal);
      setData(response);
      if (response.resource) setResource(response.resource);
      if (response.scan) setNotice(`检查完成：${response.scan.baseline} 个基线，${response.scan.changed} 个变化，${response.scan.unchanged} 个未变化。${response.scan.errors.join('；')}`);
      else if (response.validation) setNotice(response.validation.details.join('\n'));
      else if (success) setNotice(success);
      return response;
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const job = data?.state.jobs.find(item => item.id === selected);
  const selectReference = async (file: File) => {
    setError('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) { setError('请选择不超过 2 MB 的 PNG、JPEG 或 WebP 图片'); return; }
    setReadingImage(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('图片读取失败，请重新选择'));
        reader.readAsDataURL(file);
      });
      setReferenceImage({ mimeType: file.type as ReferenceImage['mimeType'], dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) });
      setReferenceName(file.name || '粘贴的截图');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setReadingImage(false); }
  };
  const create = async (candidateId?: string) => {
    const candidate = data?.state.candidates.find(item => item.id === candidateId);
    const result = await run({ action: 'create', ...(!candidate && referenceImage ? { referenceImage } : {}), input: { title: candidate?.title ?? title, description: candidate?.description ?? description, source: candidate ? 'discovery' : 'user', candidateId, budget: { tokenLimit: candidate ? data!.state.settings.defaultJobTokenLimit : tokens } } });
    if (result) { const previous = new Set(data?.state.jobs.map(item => item.id)); setSelected(result.state.jobs.find(item => !previous.has(item.id))?.id); setNewJob(false); setTitle(''); setDescription(''); setReferenceImage(undefined); setReferenceName(''); setTab('research'); }
  };
  const openNew = () => { setReferenceImage(undefined); setReferenceName(''); setTokens(data?.state.settings.defaultJobTokenLimit ?? 100_000); setNewJob(true); setSelected(undefined); setTab('research'); };

  return <div className="oc-page">
    <header className="oc-header"><div><div className="oc-brand">OpenCodex <span>预览版</span></div><p>从功能发现，到本机研究与 DSH 插件。</p></div><button className="oc-primary" onClick={openNew}><Icon name="plus" />主动研究功能</button></header>
    <nav className="oc-tabs" aria-label="OpenCodex"><div>{tabs.map(([id, label]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); setSelected(undefined); setNewJob(false); }}><Icon name={tabIcons[id]} />{label}{id === "discover" && (data?.state.candidates.filter(c => c.status === "new").length ?? 0) > 0 && <span className="oc-count">{data!.state.candidates.filter(c => c.status === "new").length}</span>}</button>)}</div><span className="oc-local"><Icon name="desktop" />本机执行</span></nav>
    {error && <div className="oc-notice oc-error" role="alert">{error}</div>}
    {connectionError && <div className="oc-notice oc-error" role="alert">连接异常：{connectionError}</div>}
    {notice && <div className="oc-notice" role="status">{notice}</div>}
    {!data ? <p className="oc-muted">正在连接 DSH…</p> : <>
      {tab === 'research' && (newJob ? <form className="oc-form" onSubmit={event => { event.preventDefault(); void create(); }}>
        <div className="oc-section-head"><h2>研究一个功能</h2><button type="button" onClick={() => setNewJob(false)}>取消</button></div>
        <label>功能名称<input autoFocus required maxLength={180} placeholder="例如：猜你想问，Tab 接受建议" value={title} onChange={event => setTitle(event.target.value)} /></label>
        <label>希望还原什么<textarea rows={5} maxLength={12000} placeholder="一句话描述想要的功能，也可直接粘贴截图或附链接。" value={description} onChange={event => setDescription(event.target.value)} onPaste={event => { const file = Array.from(event.clipboardData.files).find(file => file.type.startsWith('image/')); if (file) { event.preventDefault(); void selectReference(file); } }} /></label>
        <label>参考截图（可选）<input type="file" accept="image/png,image/jpeg,image/webp" disabled={readingImage || busy} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void selectReference(file); event.currentTarget.value = ''; }} /></label>
        {referenceImage && <div className="oc-reference"><img src={`data:${referenceImage.mimeType};base64,${referenceImage.dataBase64}`} alt="本次研究的参考截图" /><div><span>{referenceName}</span><button type="button" onClick={() => { setReferenceImage(undefined); setReferenceName(''); }}><Icon name="close" />移除截图</button></div></div>}
        {readingImage && <p role="status">正在读取截图…</p>}
        <div className="oc-two-columns"><label>本项 token 上限<input required type="number" min={1000} step={1000} value={tokens} onChange={event => setTokens(Number(event.target.value))} /></label><p className="oc-muted oc-align-bottom">包含全部阶段与重试。默认是短调查额度；可查看进展后续额。</p></div>
        <button className="oc-primary" disabled={busy || readingImage || !title.trim()}><Icon name="plus" />创建研究任务</button>
      </form> : job ? <JobDetail key={job.id} job={job} data={data} busy={busy} run={run} call={call} back={() => setSelected(undefined)} /> : <>
        <div className="oc-section-head"><h2>研究任务 <span className="oc-heading-count">{data.state.jobs.length}</span></h2></div>
        {data.state.jobs.length === 0 ? <div className="oc-empty"><div className="oc-empty-mark"><Icon name="search" /></div><h2>下一项功能，从这里开始</h2><p>描述你想复刻的交互，或从更新中选择候选。<br />研究证据、生成代码和验收结果都保存在本机。</p><button onClick={openNew}><Icon name="plus" />创建第一个任务</button></div> : <div className="oc-list">{[...data.state.jobs].reverse().map(item => <JobRow key={item.id} job={item} confirmed={data.budgets[item.id]?.job.confirmedTokens ?? 0} open={() => setSelected(item.id)} />)}</div>}
      </>)}
      {tab === 'discover' && <><div className="oc-section-head"><div><h2>更新发现</h2><p className="oc-muted">轻量检查公开来源；首次检查保存基线，变化需进一步研究确认。</p></div><button disabled={busy} onClick={() => void run({ action: 'scan' })}><Icon name="refresh" />{busy ? '检查中…' : '检查更新'}</button></div>{data.state.candidates.length ? <div className="oc-list">{data.state.candidates.map(candidate => <article className="oc-candidate" key={candidate.id}><div className="oc-row-title"><strong>{candidate.title}</strong><span className="oc-status">{candidate.status === 'selected' ? '已选择' : '待确认'}</span></div><p>{candidate.description}</p><div className="oc-row-title"><a href={link(candidate.sourceUrl)} target="_blank" rel="noreferrer">查看来源<Icon name="external" /></a><button disabled={busy || candidate.status === 'selected'} onClick={() => { setTokens(data.state.settings.defaultJobTokenLimit); void create(candidate.id); }}><Icon name="search" />选择研究</button></div></article>)}</div> : <div className="oc-empty"><h2>还没有候选变化</h2><p>检查不会启动模型，也不会自动进入深入研究。</p></div>}</>}
      {tab === 'library' && <><div className="oc-section-head"><div><h2>研究资料</h2><p className="oc-muted">按问题加载具体手册，保留证据与未知项。</p></div><button disabled={busy} onClick={() => void run({ action: 'capabilities' })}><Icon name="desktop" />检查环境能力</button></div><Library busy={busy} read={id => void run({ action: 'readResource', id })} />{resource && <details className="oc-resource" open key={resource.id}><summary>{resource.id}</summary><pre>{resource.content}</pre></details>}{data.state.capabilities && <section className="oc-section"><h3>当前环境</h3>{data.state.capabilities.checks.map(check => <div className="oc-capability" key={check.id}><span className={check.available ? 'oc-ok' : 'oc-muted'}><Icon name={check.available ? 'check' : 'circle'} />{check.id}</span><p>{check.detail}</p></div>)}</section>}</>}
      {tab === 'settings' && <SettingsForm settings={data.state.settings} busy={busy} inspect={() => void run({ action: "scanLocalVersion" })} save={patch => void run({ action: 'settings', patch }, '设置已保存')} />}
    </>}
    <footer className="oc-footer"><span>OpenCodex · 独立第三方插件</span><a href="https://github.com/ZiyaZhang/opencodex" target="_blank" rel="noreferrer"><Icon name="code" />源码<Icon name="external" /></a></footer>
  </div>;
}

type Run = (request: OpenCodexRequest, success?: string) => Promise<OpenCodexResponse | undefined>;
function JobDetail({ job, data, busy, run, call, back }: { job: Job; data: OpenCodexResponse; busy: boolean; run: Run; call: Call; back: () => void }) {
  const budget = data.budgets[job.id];
  const evidence = data.state.evidence.filter(item => item.jobId === job.id);
  const specs = data.state.specs.filter(item => item.jobId === job.id);
  const artifacts = data.state.artifacts.filter(item => item.jobId === job.id);
  const checks = data.state.verifications.filter(item => item.jobId === job.id);
  const [resumeNote, setResumeNote] = useState('');
  const [extraTokens, setExtraTokens] = useState(job.budget.tokenLimit + 50_000);
  const [extraMinutes, setExtraMinutes] = useState(job.budget.maxDurationMs / 60_000);
  const [extraRepairs, setExtraRepairs] = useState(job.budget.maxRepairRounds);
  return <section className="oc-detail">
    <button className="oc-back" onClick={back}><Icon name="back" />全部任务</button>
    <div className="oc-section-head"><h2>{job.title}</h2><Status status={job.status} /></div>
    <p className="oc-description">{featureDescription(job.description)}</p>
    <ScreenshotGallery jobId={job.id} artifacts={artifacts} call={call} />
    {['paused', 'blocked', 'failed'].includes(job.status) && job.history.at(-1)?.reason && <div className="oc-notice" role="status">暂停原因：{job.history.at(-1)!.reason}</div>}
    <div className="oc-budget"><div><span>已确认</span><strong>{number(budget?.job.confirmedTokens ?? 0)}</strong></div><div><span>待结算预留</span><strong>{number(budget?.job.reservedTokens ?? 0)}</strong></div><div><span>本项上限</span><strong>{number(job.budget.tokenLimit)}</strong></div><div><span>每日已用 / 上限</span><strong>{number(budget?.daily.confirmedTokens ?? 0)} <small>/ {number(data.state.settings.dailyTokenLimit)}</small></strong></div></div>
    <div className="oc-progress" role="meter" aria-label="任务预算使用" aria-valuemin={0} aria-valuemax={job.budget.tokenLimit} aria-valuenow={Math.min(job.budget.tokenLimit, (budget?.job.confirmedTokens ?? 0) + (budget?.job.reservedTokens ?? 0))}><span style={{ width: `${Math.min(100, 100 * ((budget?.job.confirmedTokens ?? 0) + (budget?.job.reservedTokens ?? 0)) / job.budget.tokenLimit)}%` }} /></div>
    <p className="oc-muted">待结算请求保持预留；实际用量可能超过估算。在途请求结束后才结算。</p>
    {job.sessionId && ['paused', 'blocked', 'failed'].includes(job.status) && <label>继续研究的补充说明（可选）<textarea rows={2} maxLength={4000} value={resumeNote} onChange={event => setResumeNote(event.target.value)} placeholder="例如：已有接口证据足够，先实现最小插件并构建验证。" /></label>}
    <div className="oc-actions">
      {['detected', 'draft', 'paused', 'blocked', 'failed'].includes(job.status) && <button className="oc-primary" disabled={busy} onClick={() => void run({ action: 'start', jobId: job.id, note: resumeNote.trim() || undefined })}><Icon name="play" />{job.sessionId ? '继续研究' : '开始研究'}</button>}
      {active.has(job.status) && <button disabled={busy} onClick={() => void run({ action: 'pause', jobId: job.id })}><Icon name="pause" />暂停</button>}
      {!['cancelled', 'installed', 'ready', 'covered', 'researched'].includes(job.status) && <button disabled={busy} onClick={() => void run({ action: 'cancel', jobId: job.id })}><Icon name="close" />取消任务</button>}
      {artifacts.some(item => item.kind === 'plugin') && <button disabled={busy} onClick={() => void run({ action: 'validateArtifact', jobId: job.id })}><Icon name="package" />检查插件包</button>}
    </div>
    {job.foreground && !job.foreground.completedAt && <div className="oc-notice"><h3>等待前台研究：{job.foreground.target}</h3><p>{job.foreground.scope}</p><ol>{job.foreground.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>{(!job.foreground.approvedAt || job.foreground.releasedAt) ? <button disabled={busy || Boolean(data.state.foregroundLease && data.state.foregroundLease.jobId !== job.id)} onClick={() => void run({ action: 'approveForeground', jobId: job.id, requestId: job.foreground!.id })}><Icon name="desktop" />现在开始前台操作</button> : <p>已获准本次操作。任务仍受当前工具访问限制。</p>}</div>}
    <details className="oc-section"><summary><Icon name="gauge" />预算与执行环境</summary><p>最长 {Math.round(job.budget.maxDurationMs / 60_000)} 分钟 · 最多 {job.budget.maxRepairRounds} 轮修复 · 已运行 {Math.round((budget?.elapsedMs ?? job.elapsedMs) / 60_000)} 分钟</p><p className="oc-path">研究会话：{job.sessionId ?? '尚未创建'}<br />工作目录：{job.workdir ?? '开始研究时创建'}</p><form className="oc-inline-form" onSubmit={event => { event.preventDefault(); void run({ action: 'extendBudget', jobId: job.id, patch: { tokenLimit: extraTokens, maxDurationMs: extraMinutes * 60_000, maxRepairRounds: extraRepairs } }, '预算已更新，点击继续研究恢复任务'); }}><label>新的 token 总上限<input required type="number" min={job.budget.tokenLimit} step={1000} value={extraTokens} onChange={event => setExtraTokens(Number(event.target.value))} /></label><label>最长运行时间（分钟）<input required type="number" min={job.budget.maxDurationMs / 60_000} value={extraMinutes} onChange={event => setExtraMinutes(Number(event.target.value))} /></label><label>最大修复轮数<input required type="number" min={job.budget.maxRepairRounds} value={extraRepairs} onChange={event => setExtraRepairs(Number(event.target.value))} /></label><button disabled={busy}>调整预算</button></form></details>
    <section className="oc-section"><h3><Icon name="file" />研究证据 <span>{evidence.length}</span></h3>{evidence.length === 0 ? <p className="oc-muted">尚未记录。推断与未知项会单独标记。</p> : evidence.map(item => <article className="oc-evidence" key={item.id}><span className={`oc-status oc-evidence-${item.kind}`}>{({ observed: '已观察', inferred: '推断', unknown: '未知' })[item.kind]}</span><p>{item.claim}</p>{link(item.sourceUrl) && <a href={item.sourceUrl} target="_blank" rel="noreferrer">查看来源<Icon name="external" /></a>}{item.localPath && <code className="oc-path">{item.localPath}</code>}</article>)}</section>
    {specs.map(spec => <section className="oc-section" key={spec.id}><h3><Icon name="file" />功能规格：{spec.title}</h3>{([['行为', spec.behavior], ['视觉', spec.visual], ['生命周期', spec.lifecycle], ['已有能力', spec.existingCapabilities], ['缺口', spec.gaps]] as [string, string[]][]).map(([name, rows]) => rows.length > 0 && <div key={name}><h4>{name}</h4><ul>{rows.map((row, i) => <li key={i}>{row}</li>)}</ul></div>)}</section>)}
    <section className="oc-section"><h3><Icon name="package" />产物与验收</h3>{artifacts.length === 0 ? <p className="oc-muted">尚无产物。行为、视觉和生命周期须分别验收。</p> : artifacts.map(item => <article className="oc-artifact" key={item.id}><strong>{item.label}</strong><span className="oc-status">{item.kind}</span><code className="oc-path">{item.path}</code><small>SHA-256 · {item.sha256}</small></article>)}{checks.map(check => <div className="oc-check" key={check.id}><strong>{({ behavior: '行为', visual: '视觉', lifecycle: '生命周期' })[check.scope]} · {({ passed: '通过', failed: '失败', partial: '部分完成' })[check.outcome]}</strong><p>{check.details}</p></div>)}{artifacts.some(item => item.kind === 'plugin') && <p className="oc-muted">包检查只验证结构。隔离环境中的行为、视觉和卸载验收完成后，才可标记就绪；安装由用户在 DSH 插件管理中选择本地产物。</p>}</section>
    {specs.length > 0 && specs.at(-1)!.existingCapabilities.length > 0 && specs.at(-1)!.gaps.length === 0 && ['researching', 'specifying', 'verifying'].includes(job.status) && <div className="oc-notice"><p>规格记录了 DSH 已有能力，且没有待解决缺口。核对证据后，可结束研究而不生成重复插件。</p><button disabled={busy} onClick={() => void run({ action: 'markCovered', jobId: job.id, specId: specs.at(-1)!.id, reason: 'User reviewed the latest specification and observed evidence; existing DSH capabilities cover the requested feature.' }, '已记录为已有能力可用')}>确认已有能力满足需求</button></div>}
    {job.artifactId && <AcceptanceForm job={job} data={data} busy={busy} run={run} />}
    <details className="oc-section"><summary><Icon name="clock" />任务记录</summary><ol className="oc-timeline">{[...job.history].reverse().map((event, i) => <li key={i}><time>{date(event.at)}</time><strong>{labels[event.to]}</strong><p>{event.reason}</p></li>)}</ol></details>
  </section>;
}

export function ScreenshotGallery({ jobId, artifacts, call }: { jobId: string; artifacts: Artifact[]; call: Call }) {
  const shots = artifacts.filter(item => item.kind === 'screenshot');
  const other = shots.filter(item => !item.screenshot || item.screenshot.subject === 'other');
  return <section className="oc-visual-study" aria-label="功能截图对照">
    <div className="oc-screenshot-pair">
      <ScreenshotPanel jobId={jobId} subject="codex" shots={shots.filter(item => item.screenshot?.subject === 'codex')} call={call} />
      <ScreenshotPanel jobId={jobId} subject="dsh" shots={shots.filter(item => item.screenshot?.subject === 'dsh')} call={call} />
    </div>
    {other.length > 0 && <details className="oc-other-screenshots"><summary>其他研究截图 · {other.length}</summary><ScreenshotPanel jobId={jobId} subject="other" shots={other} call={call} /></details>}
  </section>;
}

function ScreenshotPanel({ jobId, subject, shots, call }: { jobId: string; subject: 'codex' | 'dsh' | 'other'; shots: Artifact[]; call: Call }) {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = shots.find(item => item.id === selectedId) ?? shots.at(-1);
  const [picture, setPicture] = useState<ReferenceImage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const title = subject === 'codex' ? 'Codex 参考' : subject === 'dsh' ? 'DSH 实现' : '研究截图';
  useEffect(() => {
    const controller = new AbortController();
    setPicture(undefined); setError(''); setExpanded(false);
    if (!selected && subject !== 'codex') { setLoading(false); return () => controller.abort(); }
    setLoading(true);
    const request: OpenCodexRequest = selected ? { action: 'readScreenshot', jobId, artifactId: selected.id } : { action: 'readReferenceImage', jobId };
    void call(request, controller.signal).then(result => {
      if (!controller.signal.aborted) setPicture(selected ? result.screenshot : result.referenceImage);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [call, jobId, selected?.id, selected?.sha256, subject]);
  const metadata = selected?.screenshot;
  const provenance = metadata ? ({ user: '用户提供', capture: '研究采集', 'public-source': '公开资料' })[metadata.provenance] : selected ? '来源待标注' : '用户提供';
  const caption = metadata?.caption ?? selected?.label;
  return <figure className="oc-screenshot-panel">
    <figcaption><strong><Icon name={subject === 'dsh' ? 'code' : 'image'} />{title}</strong>{picture && <span>{provenance}</span>}</figcaption>
    {shots.length > 1 && <select aria-label={`选择${title}截图`} value={selected?.id} onChange={event => setSelectedId(event.target.value)}>{shots.map(item => <option key={item.id} value={item.id}>{item.screenshot?.caption ?? item.label}</option>)}</select>}
    {loading ? <div className="oc-shot-empty" role="status">正在读取截图…</div> : error ? <div className="oc-shot-empty" role="alert">截图无法读取：{error}</div> : picture ? <>
      <button type="button" className={`oc-shot-image${expanded ? ' oc-shot-expanded' : ''}`} aria-expanded={expanded} aria-label={`${expanded ? '收起' : '放大'}${title}截图`} onClick={() => setExpanded(value => !value)}><img src={`data:${picture.mimeType};base64,${picture.dataBase64}`} alt={caption || `${title}截图`} /></button>
      {caption && <p className="oc-shot-caption">{caption}</p>}
      <div className="oc-shot-meta"><span>{metadata?.version ? `版本 ${metadata.version}` : '版本未记录'}</span>{link(metadata?.sourceUrl) && <a href={metadata!.sourceUrl} target="_blank" rel="noreferrer">原始来源<Icon name="external" /></a>}</div>
    </> : <div className="oc-shot-empty"><Icon name="image" /><strong>{subject === 'codex' ? '尚缺参考截图' : '尚无实现截图'}</strong><p>{subject === 'codex' ? '研究需取得真实截图并说明可见功能；无法取得时记录缺口。' : '生成后在隔离 DSH 中记录相同状态，便于对照。'}</p></div>}
  </figure>;
}

function AcceptanceForm({ job, data, busy, run }: { job: Job; data: OpenCodexResponse; busy: boolean; run: Run }) {
  const [scope, setScope] = useState<VerificationScope>('behavior');
  const [outcome, setOutcome] = useState<Verification['outcome']>('partial');
  const [details, setDetails] = useState('');
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [screenshotIds, setScreenshotIds] = useState<string[]>([]);
  const evidence = data.state.evidence.filter(item => item.jobId === job.id && item.kind === 'observed');
  const screenshots = data.state.artifacts.filter(item => item.jobId === job.id && item.kind === 'screenshot' && item.screenshot);
  const visualPair = ['codex', 'dsh'].every(subject => screenshots.some(item => screenshotIds.includes(item.id) && item.screenshot?.subject === subject));
  return <details className="oc-section"><summary><Icon name="check" />记录隔离验收结果</summary><p className="oc-muted">检查隔离环境中的实际结果，选取相应证据。模型的自述不能替代验收。</p><form className="oc-form" onSubmit={event => { event.preventDefault(); void run({ action: 'recordVerification', jobId: job.id, input: { artifactId: job.artifactId!, scope, outcome, method: 'manual', environment: 'isolated', details, evidenceIds, ...(scope === 'visual' ? { screenshotIds } : {}) } }, '验收结果已记录'); }}><div className="oc-two-columns"><label>验收项目<select value={scope} onChange={event => setScope(event.target.value as VerificationScope)}><option value="behavior">行为</option><option value="visual">视觉</option><option value="lifecycle">生命周期</option></select></label><label>结果<select value={outcome} onChange={event => setOutcome(event.target.value as Verification['outcome'])}><option value="partial">部分完成</option><option value="failed">失败</option><option value="passed">通过</option></select></label></div><label>实际步骤与结果<textarea required minLength={10} rows={3} value={details} onChange={event => setDetails(event.target.value)} /></label><fieldset><legend>关联已观察证据</legend>{evidence.length === 0 && <p className="oc-muted">尚无已观察证据，无法确认验收通过。</p>}{evidence.map(item => <label className="oc-checkbox" key={item.id}><input type="checkbox" checked={evidenceIds.includes(item.id)} onChange={event => setEvidenceIds(event.target.checked ? [...evidenceIds, item.id] : evidenceIds.filter(id => id !== item.id))} />{item.claim}</label>)}</fieldset>{scope === 'visual' && <fieldset><legend>关联对照截图</legend><p className="oc-muted">视觉通过需要 Codex 参考图和 DSH 实现图，并确认两者是可比较的状态。缺图时请选择部分完成。</p>{screenshots.map(item => <label className="oc-checkbox" key={item.id}><input type="checkbox" checked={screenshotIds.includes(item.id)} onChange={event => setScreenshotIds(event.target.checked ? [...screenshotIds, item.id] : screenshotIds.filter(id => id !== item.id))} />{item.screenshot!.subject === 'codex' ? 'Codex' : item.screenshot!.subject === 'dsh' ? 'DSH' : '其他'} · {item.screenshot!.caption}</label>)}</fieldset>}<div className="oc-actions"><button disabled={busy || (outcome === 'passed' && (evidenceIds.length === 0 || (scope === 'visual' && !visualPair)))}><Icon name="check" />保存本项验收</button>{job.status === 'verifying' && <button type="button" disabled={busy} onClick={() => void run({ action: 'markReady', jobId: job.id }, '验收门槛已通过，可在 DSH 插件管理中选择安装该产物')}><Icon name="package" />检查是否可安装</button>}</div></form></details>;
}

function SettingsForm({ settings, busy, save, inspect }: { settings: Settings; busy: boolean; inspect: () => void; save: (patch: Partial<Settings>) => void }) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings.defaultJobTokenLimit, settings.dailyTokenLimit, settings.maxDurationMs, settings.maxRepairRounds, settings.monitorEnabled, settings.monitorIntervalMinutes, settings.localVersionFile, settings.updateResearchMode]);
  return <form className="oc-form" onSubmit={event => { event.preventDefault(); save(draft); }}><h2><Icon name="settings" />预算与发现</h2><div className="oc-two-columns"><label>默认每项 token 上限<input required type="number" min={1000} step={1000} value={draft.defaultJobTokenLimit} onChange={event => setDraft({ ...draft, defaultJobTokenLimit: Number(event.target.value) })} /></label><label>每日 token 总上限<input required type="number" min={1000} step={1000} value={draft.dailyTokenLimit} onChange={event => setDraft({ ...draft, dailyTokenLimit: Number(event.target.value) })} /></label><label>最长运行时间（分钟）<input required type="number" min={1} value={draft.maxDurationMs / 60_000} onChange={event => setDraft({ ...draft, maxDurationMs: Number(event.target.value) * 60_000 })} /></label><label>最大修复轮数<input required type="number" min={0} max={20} value={draft.maxRepairRounds} onChange={event => setDraft({ ...draft, maxRepairRounds: Number(event.target.value) })} /></label></div><label className="oc-checkbox"><input type="checkbox" checked={draft.monitorEnabled} onChange={event => setDraft({ ...draft, monitorEnabled: event.target.checked })} />DSH 运行期间定期检查官方更新来源</label>{draft.monitorEnabled && <label>检查间隔（分钟）<input required type="number" min={15} value={draft.monitorIntervalMinutes} onChange={event => setDraft({ ...draft, monitorIntervalMinutes: Number(event.target.value) })} /></label>}<section className="oc-section"><h3><Icon name="radar" />本机 Codex 更新触发</h3><label>版本文件的绝对路径<input value={draft.localVersionFile} placeholder="选择本机安装的 Info.plist 或 package.json 路径" onChange={event => setDraft({ ...draft, localVersionFile: event.target.value })} /></label><p className="oc-muted">保存路径后监听文件变化，定时补查，重启后补查漏掉的更新。首次只建立基线；留空关闭本机检测。</p><button type="button" disabled={busy || !settings.localVersionFile} onClick={inspect}><Icon name="refresh" />立即检查已保存的版本文件</button><label className="oc-checkbox"><input type="checkbox" checked={draft.updateResearchMode === "investigate"} onChange={event => setDraft({ ...draft, updateResearchMode: event.target.checked ? "investigate" : "notify" })} />本机升级后，在预算内自动调查新增功能</label><p className="oc-muted">默认只生成候选卡。自动调查仅整理变化与证据，具体复刻仍由你选择。</p></section><p className="oc-muted">每日额度按 UTC 结算。新任务使用默认预算；已有任务单独调整。前台操作等待你开始。</p><button className="oc-primary" disabled={busy}><Icon name="check" />保存设置</button></form>;
}

function Library({ busy, read }: { busy: boolean; read: (id: string) => void }) {
  return <div className="oc-library">{catalog.entries.map(({ id, title }) => <button disabled={busy} key={id} onClick={() => read(id)}><Icon name={id === 'source-index' ? 'radar' : 'file'} /><strong>{title}</strong><Icon name="next" className="oc-library-arrow" /></button>)}</div>;
}
