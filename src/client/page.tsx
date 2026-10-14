import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Artifact, Job, JobStatus, Settings, VerificationScope, Verification } from '../core/types.js';
import type { OpenCodexRequest, OpenCodexResponse } from '../host/remote.js';
import catalog from '../../resources/catalog.json';
import { Icon, type IconName } from './icons.js';
import { fetchPluginArtifact } from './plugin-download.js';

type Call = (request: OpenCodexRequest, signal?: AbortSignal) => Promise<OpenCodexResponse>;
type OpenPlugin = (packageName: string) => void;
type ReferenceImage = { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; dataBase64: string };
type Tab = 'research' | 'discover' | 'library' | 'settings';
const tabs: [Tab, string][] = [['research', '研究'], ['discover', '发现'], ['library', '资料'], ['settings', '设置']];
const tabIcons: Record<Tab, IconName> = { research: 'search', discover: 'radar', library: 'books', settings: 'settings' };
const labels: Record<JobStatus, string> = { detected: '发现候选', draft: '待开始', queued: '排队中', researching: '调查中', specifying: '编写规格', researched: '调查完成', building: '开发中', verifying: '待验收', ready: '验收通过', covered: '已有能力可用', paused: '已暂停', blocked: '需要处理', failed: '失败', installed: '已安装', cancelled: '已取消' };
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

function JobRow({ job, artifacts, confirmed, call, open }: { job: Job; artifacts: Artifact[]; confirmed: number; call: Call; open: () => void }) {
  const plugin = artifacts.find(item => item.kind === 'plugin');
  return <button className="oc-job-row" onClick={open}>
    <JobReferenceThumbnail jobId={job.id} artifacts={artifacts} call={call} />
    <span className="oc-job-content">
      <span className="oc-row-title"><strong>{job.title}</strong><Status status={job.status} /></span>
      <span className="oc-job-description">{featureDescription(job.description) || '尚无补充描述'}</span>
      <span className="oc-row-meta"><span><Icon name="package" />{plugin ? (['ready', 'installed'].includes(job.status) ? '已有插件包 · 已验收' : '已有实验包 · 待验收') : '尚未产出插件包'}</span><span><Icon name="clock" />{date(job.updatedAt)}</span><span><Icon name="gauge" /><span className="oc-numeric">{number(confirmed)} <span className="oc-separator">/</span> {number(job.budget.tokenLimit)}</span><span className="oc-unit">tokens</span></span></span>
    </span>
    <Icon name="next" className="oc-row-arrow" />
  </button>;
}

/** Image reads begin near the viewport and depend on identity/hash, never snapshot object identity. */
export function JobReferenceThumbnail({ jobId, artifacts, call }: { jobId: string; artifacts: Artifact[]; call: Call }) {
  const selected = artifacts.filter(item => item.jobId === jobId && item.kind === 'screenshot' && item.screenshot?.subject === 'codex').at(-1);
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [picture, setPicture] = useState<ReferenceImage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || !container.current) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '160px' });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setPicture(undefined); setError('');
    if (!visible) return () => controller.abort();
    setLoading(true);
    const request: OpenCodexRequest = selected ? { action: 'readScreenshot', jobId, artifactId: selected.id } : { action: 'readReferenceImage', jobId };
    void call(request, controller.signal).then(result => {
      if (!controller.signal.aborted) setPicture(selected ? result.screenshot : result.referenceImage);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [call, visible, jobId, selected?.id, selected?.sha256]);
  const caption = selected?.screenshot?.caption ?? '用户提供的 Codex 参考截图';
  return <span ref={container} className="oc-job-thumbnail" title={error || (picture ? caption : undefined)}>
    {picture ? <><img src={`data:${picture.mimeType};base64,${picture.dataBase64}`} alt={caption} loading="lazy" /><span>Codex 参考</span></>
      : <span className="oc-thumb-empty">{loading || !visible ? '读取参考图…' : error ? '参考图不可读' : '缺参考图'}</span>}
  </span>;
}

export function OpenCodexPage({ call, openPlugin }: { call: Call; openPlugin?: OpenPlugin }) {
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
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([]);
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
      if (response.scan) {
        const scan = response.scan;
        if (scan.errors.length) {
          const partial = scan.baseline + scan.changed + scan.unchanged > 0 || (scan.discovered ?? 0) > 0;
          setError(`${partial ? '部分来源检查失败' : '检查失败'}：${scan.errors.join('；')}`);
          if ((scan.discovered ?? 0) > 0) setNotice(`已保存 ${scan.discovered} 项功能候选，其余来源可稍后重试。`);
        } else setNotice(`检查完成：${scan.discovered ?? 0} 项新功能候选，${scan.changed} 个来源变化。`);
      }
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
  const createSelectedCandidates = async () => {
    if (busy || !data) return;
    const candidates = data.state.candidates.filter(item => selectedCandidates.includes(item.id) && item.status === 'new' && item.sourceType !== 'local-version');
    if (!candidates.length) return;
    setBusy(true); setError(''); setNotice('');
    const created: string[] = [];
    try {
      for (const candidate of candidates) {
        const result = await call({ action: 'create', input: { title: candidate.title, description: candidate.description, source: 'discovery', candidateId: candidate.id, budget: { tokenLimit: data.state.settings.defaultJobTokenLimit } } }, lifecycle.current?.signal);
        setData(result); created.push(candidate.id);
      }
      setSelected(undefined); setNewJob(false); setTab('research');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally {
      setSelectedCandidates(previous => previous.filter(id => !created.includes(id)));
      if (created.length) setNotice(`已创建 ${created.length} 项研究任务。`);
      setBusy(false);
    }
  };

  return <div className="oc-page">
    <header className="oc-header"><div><div className="oc-brand">OpenCodex <span>预览版</span></div></div><button className="oc-primary" onClick={openNew}><Icon name="plus" />主动研究功能</button></header>
    <nav className="oc-tabs" aria-label="OpenCodex"><div>{tabs.map(([id, label]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); setSelected(undefined); setNewJob(false); }}><Icon name={tabIcons[id]} />{label}{id === "discover" && (data?.state.candidates.filter(c => c.status === "new" && c.sourceType !== "local-version").length ?? 0) > 0 && <span className="oc-count">{data!.state.candidates.filter(c => c.status === "new" && c.sourceType !== "local-version").length}</span>}</button>)}</div><span className="oc-local"><Icon name="desktop" />本机执行</span></nav>
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
        <div className="oc-two-columns"><label>本项 token 上限<input required type="number" min={1000} step={1000} value={tokens} onChange={event => setTokens(Number(event.target.value))} /></label><p className="oc-muted oc-align-bottom">包含研究、开发、验收与重试。</p></div>
        <button className="oc-primary" disabled={busy || readingImage || !title.trim()}><Icon name="plus" />创建研究任务</button>
      </form> : job ? <JobDetail key={job.id} job={job} data={data} busy={busy} run={run} call={call} openPlugin={openPlugin} back={() => setSelected(undefined)} /> : <>
        <div className="oc-section-head"><h2>研究任务 <span className="oc-heading-count">{data.state.jobs.length}</span></h2></div>
        {data.state.jobs.length === 0 ? <div className="oc-empty"><div className="oc-empty-mark"><Icon name="search" /></div><h2>还没有研究任务</h2><button onClick={openNew}><Icon name="plus" />新建研究</button></div> : <div className="oc-list">{[...data.state.jobs].reverse().map(item => <JobRow key={item.id} job={item} artifacts={data.state.artifacts.filter(artifact => artifact.jobId === item.id)} confirmed={data.budgets[item.id]?.job.confirmedTokens ?? 0} call={call} open={() => setSelected(item.id)} />)}</div>}
      </>)}
      {tab === 'discover' && <>
        <div className="oc-section-head"><h2>更新发现</h2><button disabled={busy} onClick={() => void run({ action: 'scan' })}><Icon name="refresh" />{busy ? '检查中…' : '检查更新'}</button></div>
        {data.state.candidates.some(item => item.sourceType !== 'local-version') ? <>
          <div className="oc-discovery-actions"><label className="oc-checkbox"><input type="checkbox" disabled={busy || !data.state.candidates.some(item => item.status === 'new' && item.sourceType !== 'local-version')} checked={data.state.candidates.filter(item => item.status === 'new' && item.sourceType !== 'local-version').length > 0 && data.state.candidates.filter(item => item.status === 'new' && item.sourceType !== 'local-version').every(item => selectedCandidates.includes(item.id))} onChange={event => setSelectedCandidates(event.target.checked ? data.state.candidates.filter(item => item.status === 'new' && item.sourceType !== 'local-version').map(item => item.id) : [])} />选择未研究功能</label><button className="oc-primary" disabled={busy || !data.state.candidates.some(item => selectedCandidates.includes(item.id) && item.status === 'new' && item.sourceType !== 'local-version')} onClick={() => void createSelectedCandidates()}><Icon name="search" />研究所选 ({data.state.candidates.filter(item => selectedCandidates.includes(item.id) && item.status === 'new' && item.sourceType !== 'local-version').length})</button></div>
          <div className="oc-list">{data.state.candidates.filter(item => item.sourceType !== 'local-version').map(candidate => <article className="oc-candidate" key={candidate.id}><div className="oc-row-title"><label className="oc-checkbox"><input type="checkbox" disabled={busy || candidate.status !== 'new'} checked={candidate.status === 'selected' || selectedCandidates.includes(candidate.id)} onChange={event => setSelectedCandidates(previous => event.target.checked ? [...new Set([...previous, candidate.id])] : previous.filter(id => id !== candidate.id))} /><strong>{candidate.title}</strong></label>{candidate.status !== 'new' && <span className="oc-status">{candidate.status === 'selected' ? '已创建研究' : '已忽略'}</span>}</div><p>{candidate.description}</p>{(candidate.publishedAt || candidate.releaseTitle) && <p className="oc-release-meta">{[candidate.publishedAt?.slice(0, 10), candidate.releaseTitle].filter(Boolean).join(' · ')}</p>}{link(candidate.sourceUrl) && <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">查看更新来源<Icon name="external" /></a>}</article>)}</div>
        </> : <div className="oc-empty"><h2>还没有功能候选</h2></div>}
        {data.state.candidates.some(item => item.sourceType === 'local-version') && <details className="oc-section"><summary><Icon name="desktop" />本机版本信号</summary><p className="oc-muted">版本变化用于触发检查，具体功能以更新日志与研究证据为准。</p>{data.state.candidates.filter(item => item.sourceType === 'local-version').map(candidate => <article className="oc-candidate" key={candidate.id}><strong>{candidate.title}</strong><p>{candidate.description}</p></article>)}</details>}
      </>}
      {tab === 'library' && <><div className="oc-section-head"><h2>研究资料</h2><button disabled={busy} onClick={() => void run({ action: 'capabilities' })}><Icon name="desktop" />检查环境能力</button></div><Library busy={busy} read={id => void run({ action: 'readResource', id })} />{resource && <details className="oc-resource" open key={resource.id}><summary>{resource.id}</summary><pre>{resource.content}</pre></details>}{data.state.capabilities && <section className="oc-section"><h3>当前环境</h3>{data.state.capabilities.checks.map(check => <div className="oc-capability" key={check.id}><span className={check.available ? 'oc-ok' : 'oc-muted'}><Icon name={check.available ? 'check' : 'circle'} />{check.id}</span><p>{check.detail}</p></div>)}</section>}</>}
      {tab === 'settings' && <SettingsForm settings={data.state.settings} busy={busy} inspect={() => void run({ action: "scanLocalVersion" })} save={patch => void run({ action: 'settings', patch }, '设置已保存')} />}
    </>}
    <footer className="oc-footer"><span>OpenCodex · 独立第三方插件</span><a href="https://github.com/ZiyaZhang/opencodex" target="_blank" rel="noreferrer"><Icon name="code" />源码<Icon name="external" /></a></footer>
  </div>;
}

type Run = (request: OpenCodexRequest, success?: string) => Promise<OpenCodexResponse | undefined>;
function JobDetail({ job, data, busy, run, call, back, openPlugin }: { job: Job; data: OpenCodexResponse; busy: boolean; run: Run; call: Call; back: () => void; openPlugin?: OpenPlugin }) {
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
    <ScreenshotGallery jobId={job.id} artifacts={artifacts} call={call} upload={<ScreenshotUpload job={job} busy={busy} run={run} />} />
    <PluginResultSummary job={job} artifacts={artifacts} checks={checks} latestSpecId={specs.at(-1)?.id} call={call} openPlugin={openPlugin} />
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
    <section className="oc-section"><h3><Icon name="file" />研究证据 <span>{evidence.length}</span></h3>{evidence.length === 0 ? <p className="oc-muted">暂无研究证据。</p> : evidence.map(item => <article className="oc-evidence" key={item.id}><span className={`oc-status oc-evidence-${item.kind}`}>{({ observed: '已观察', inferred: '推断', unknown: '未知' })[item.kind]}</span><p>{item.claim}</p>{link(item.sourceUrl) && <a href={item.sourceUrl} target="_blank" rel="noreferrer">查看来源<Icon name="external" /></a>}{item.localPath && <code className="oc-path">{item.localPath}</code>}</article>)}</section>
    {specs.map(spec => <section className="oc-section" key={spec.id}><h3><Icon name="file" />功能规格：{spec.title}</h3>{([['行为', spec.behavior], ['视觉', spec.visual], ['生命周期', spec.lifecycle], ['已有能力', spec.existingCapabilities], ['缺口', spec.gaps]] as [string, string[]][]).map(([name, rows]) => rows.length > 0 && <div key={name}><h4>{name}</h4><ul>{rows.map((row, i) => <li key={i}>{row}</li>)}</ul></div>)}</section>)}
    <details className="oc-section"><summary><Icon name="file" />产物文件与验收记录 · {artifacts.length} 个文件</summary>{artifacts.length === 0 ? <p className="oc-muted">尚无登记文件。</p> : artifacts.map(item => <article className="oc-artifact" key={item.id}><strong>{item.label}</strong><span className="oc-status">{item.kind}</span><code className="oc-path">{item.path}</code><small>SHA-256 · {item.sha256}</small></article>)}{checks.map(check => <div className="oc-check" key={check.id}><strong>{({ behavior: '行为', visual: '视觉', lifecycle: '生命周期' })[check.scope]} · {({ passed: '通过', failed: '失败', partial: '部分完成' })[check.outcome]}</strong><p>{check.details}</p></div>)}</details>
    {specs.length > 0 && specs.at(-1)!.existingCapabilities.length > 0 && specs.at(-1)!.gaps.length === 0 && ['researching', 'specifying', 'verifying'].includes(job.status) && <div className="oc-notice"><p>规格记录了 DSH 已有能力，且没有待解决缺口。核对证据后，可结束研究而不生成重复插件。</p><button disabled={busy} onClick={() => void run({ action: 'markCovered', jobId: job.id, specId: specs.at(-1)!.id, reason: 'User reviewed the latest specification and observed evidence; existing DSH capabilities cover the requested feature.' }, '已记录为已有能力可用')}>确认已有能力满足需求</button></div>}
    {job.artifactId && job.status === 'verifying' && <AcceptanceForm job={job} data={data} busy={busy} run={run} />}
    <details className="oc-section"><summary><Icon name="clock" />任务记录</summary><ol className="oc-timeline">{[...job.history].reverse().map((event, i) => <li key={i}><time>{date(event.at)}</time><strong>{labels[event.to]}</strong><p>{event.reason}</p></li>)}</ol></details>
  </section>;
}

export function PluginResultSummary({ job, artifacts, checks, latestSpecId, call, openPlugin }: { job: Job; artifacts: Artifact[]; checks: Verification[]; latestSpecId?: string; call: Call; openPlugin?: OpenPlugin }) {
  const plugins = artifacts.filter(item => item.jobId === job.id && item.kind === 'plugin');
  return <section className="oc-plugin-results" aria-label="插件产出">
    <h3><Icon name="package" />插件产出{plugins.length > 0 && <span>{plugins.length} 个包</span>}</h3>
    {plugins.length === 0 ? <p className="oc-muted">尚未产出插件包。</p>
      : <>{[...plugins].reverse().map(artifact => <PluginDownload key={`${job.id}:${artifact.id}:${artifact.sha256}`} job={job} artifact={artifact} checks={checks} latestSpecId={latestSpecId} call={call} openPlugin={openPlugin} />)}<p className="oc-result-note">验收通过后自动安装到当前 DSH 并启用。</p></>}
  </section>;
}

function PluginDownload({ job, artifact, checks, latestSpecId, call, openPlugin }: { job: Job; artifact: Artifact; checks: Verification[]; latestSpecId?: string; call: Call; openPlugin?: OpenPlugin }) {
  const [downloading, setDownloading] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);
  const ready = ['ready', 'installed'].includes(job.status) && job.artifactId === artifact.id;
  const currentChecks = checks.filter(item => item.jobId === job.id && item.artifactId === artifact.id && item.artifactSha256 === artifact.sha256 && item.specId === latestSpecId);
  const filename = artifact.path.split('/').at(-1);
  const download = async () => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    setDownloading(true); setError(''); setSaved(false); setPercent(0);
    try {
      const result = await fetchPluginArtifact(call, job.id, artifact, controller.signal, (received, total) => {
        if (!controller.signal.aborted) setPercent(Math.round(received * 100 / total));
      });
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/gzip' }));
      const anchor = document.createElement('a');
      try {
        anchor.href = url; anchor.download = result.filename; anchor.hidden = true;
        document.body.append(anchor); anchor.click(); setSaved(true);
      } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); }
    finally { request.current = undefined; if (!controller.signal.aborted) setDownloading(false); }
  };
  return <article className="oc-plugin-result">
    {job.artifactId === artifact.id && <InstallationStatus job={job} call={call} openPlugin={openPlugin} />}
    <div className="oc-plugin-result-head"><div><strong>{filename}</strong><p>{artifact.label}</p><span className="oc-result-size">{artifact.bytes >= 1_000_000 ? `${(artifact.bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(artifact.bytes / 1000))} KB`} · {date(artifact.createdAt)}</span></div><button className="oc-primary" disabled={downloading} onClick={() => void download()}><Icon name="package" />{downloading ? `下载并校验 ${percent}%` : ready ? '下载插件包' : '下载实验包'}</button></div>
    {artifact.provenance?.kind === 'operator-assisted' && <p className="oc-result-provenance"><strong>人工协助产物</strong> · {artifact.provenance.details}</p>}
    <div className="oc-result-checks" aria-label="插件验收状态">{(['behavior', 'visual', 'lifecycle'] as const).map(scope => {
      const check = currentChecks.filter(item => item.scope === scope).at(-1);
      return <span key={scope} className={check?.outcome === 'passed' ? 'oc-ok' : ''}><Icon name={check?.outcome === 'passed' ? 'check' : check?.outcome === 'failed' ? 'warning' : 'circle'} />{({ behavior: '行为', visual: '视觉', lifecycle: '生命周期' })[scope]} · {check ? ({ passed: '通过', partial: '部分完成', failed: '失败' })[check.outcome] : '待验收'}</span>;
    })}</div>
    {!ready && <p className="oc-result-note">{job.status === 'verifying' ? '实验产物，等待完成全部隔离验收。' : '实验产物，当前未处于验收阶段；可先下载到隔离环境检查。'}</p>}
    {error && <p className="oc-error" role="alert">{error}</p>}
    {saved && <p className="oc-result-note" role="status">SHA-256 校验通过，已发起文件保存。</p>}
  </article>;
}

export function InstallationStatus({ job, call, openPlugin }: { job: Job; call: Call; openPlugin?: OpenPlugin }) {
  const receipt = job.installation;
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!receipt && !['ready', 'installed'].includes(job.status)) return null;
  const title = !receipt ? (job.status === 'ready' ? '验收通过，正在安排安装…' : '已有安装记录')
    : receipt.status === 'installing' ? '正在安装到当前 DSH…'
      : receipt.status === 'installed' ? (receipt.application === 'restart-required' ? '已安装并启用 · 重启 DSH 后生效' : '安装完成 · DSH 已应用')
        : receipt.status === 'interrupted' ? '安装中断，结果待核对' : '安装未完成';
  const retry = async () => {
    setBusy(true); setError('');
    try { await call({ action: 'installPlugin', jobId: job.id }); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return <div className="oc-installation" aria-label="DSH 安装结果">
    <strong role="status"><Icon name={receipt?.status === 'installed' ? 'check' : receipt?.status === 'failed' || receipt?.status === 'interrupted' ? 'warning' : 'clock'} />{title}</strong>
    {receipt?.packageName && <p>{receipt.packageName} <span className="oc-numeric">{receipt.version}</span></p>}
    {receipt?.error && <p className="oc-error">{receipt.error}</p>}
    {receipt?.warnings?.map((warning, i) => <p key={i}>{warning}</p>)}
    {receipt?.logPath && <details><summary>安装日志</summary><code className="oc-path">{receipt.logPath}</code></details>}
    <div className="oc-actions">
      {receipt && ['failed', 'interrupted'].includes(receipt.status) && <button disabled={busy} onClick={() => void retry()}><Icon name="refresh" />{busy ? '提交重试…' : '重试安装'}</button>}
      {receipt?.packageName && openPlugin && <button onClick={() => { try { openPlugin(receipt.packageName!); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } }}><Icon name="package" />在插件管理中查看</button>}
    </div>
    {error && <p className="oc-error" role="alert">{error}</p>}
  </div>;
}

export function ScreenshotGallery({ jobId, artifacts, call, upload }: { jobId: string; artifacts: Artifact[]; call: Call; upload?: ReactNode }) {
  const shots = artifacts.filter(item => item.kind === 'screenshot');
  const other = shots.filter(item => !item.screenshot || item.screenshot.subject === 'other');
  return <section className="oc-visual-study" aria-label="功能截图对照">
    {upload}
    <div className="oc-screenshot-pair">
      <ScreenshotPanel jobId={jobId} subject="codex" shots={shots.filter(item => item.screenshot?.subject === 'codex')} call={call} />
      <ScreenshotPanel jobId={jobId} subject="dsh" shots={shots.filter(item => item.screenshot?.subject === 'dsh')} call={call} />
    </div>
    {other.length > 0 && <details className="oc-other-screenshots"><summary>其他研究截图 · {other.length}</summary><ScreenshotPanel jobId={jobId} subject="other" shots={other} call={call} /></details>}
  </section>;
}

export function ScreenshotUpload({ job, busy, run }: { job: Job; busy: boolean; run: Run }) {
  const [subject, setSubject] = useState<'codex' | 'dsh'>('codex');
  const [caption, setCaption] = useState('');
  const [version, setVersion] = useState('');
  const [image, setImage] = useState<ReferenceImage>();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const disclosure = useRef<HTMLDetailsElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const choose = async (file: File) => {
    setError(''); setImage(undefined);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) { setError('请选择不超过 2 MB 的 PNG、JPEG 或 WebP 图片'); return; }
    setReading(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file);
      });
      setImage({ mimeType: file.type as ReferenceImage['mimeType'], dataBase64: data.slice(data.indexOf(',') + 1) });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setReading(false); }
  };
  return <details className="oc-shot-upload" ref={disclosure}><summary><Icon name="plus" />添加截图</summary><form className="oc-form" onSubmit={event => {
    event.preventDefault(); if (!image || busy || reading) return;
    void run({ action: 'addScreenshot', jobId: job.id, image, metadata: { subject, caption: caption.trim(), provenance: 'user', ...(version.trim() ? { version: version.trim() } : {}) } }, '截图已添加').then(result => {
      if (result) { setImage(undefined); setCaption(''); setVersion(''); if (input.current) input.current.value = ''; if (disclosure.current) disclosure.current.open = false; }
    });
  }}><div className="oc-two-columns"><label>截图内容<select value={subject} onChange={event => setSubject(event.target.value as 'codex' | 'dsh')}><option value="codex">Codex 参考</option><option value="dsh">DSH 实现</option></select></label><label>应用版本（可选）<input value={version} maxLength={120} onChange={event => setVersion(event.target.value)} /></label></div><label>图中展示了什么<input required maxLength={1000} placeholder="例如：回复结束后，输入框显示可用 Tab 接受的建议" value={caption} onChange={event => setCaption(event.target.value)} /></label><label>选择截图<input ref={input} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || reading} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void choose(file); }} /></label>{image && <div className="oc-reference"><img src={`data:${image.mimeType};base64,${image.dataBase64}`} alt="待添加的截图预览" /></div>}{error && <p className="oc-error" role="alert">{error}</p>}<div className="oc-upload-actions"><button className="oc-primary" disabled={busy || reading || !image || !caption.trim()}><Icon name="plus" />{reading ? '读取中…' : '添加到研究'}</button></div></form></details>;
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
    </> : <div className="oc-shot-empty"><Icon name="image" /><strong>{subject === 'codex' ? '尚缺参考截图' : '尚无实现截图'}</strong></div>}
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
  return <details className="oc-section"><summary><Icon name="check" />记录隔离验收结果</summary><p className="oc-muted">验收全部通过后，自动安装到当前 DSH 并启用。</p><form className="oc-form" onSubmit={event => { event.preventDefault(); void run({ action: 'recordVerification', jobId: job.id, input: { artifactId: job.artifactId!, scope, outcome, method: 'manual', environment: 'isolated', details, evidenceIds, ...(scope === 'visual' ? { screenshotIds } : {}) } }, '验收结果已记录'); }}><div className="oc-two-columns"><label>验收项目<select value={scope} onChange={event => setScope(event.target.value as VerificationScope)}><option value="behavior">行为</option><option value="visual">视觉</option><option value="lifecycle">生命周期</option></select></label><label>结果<select value={outcome} onChange={event => setOutcome(event.target.value as Verification['outcome'])}><option value="partial">部分完成</option><option value="failed">失败</option><option value="passed">通过</option></select></label></div><label>实际步骤与结果<textarea required minLength={10} rows={3} value={details} onChange={event => setDetails(event.target.value)} /></label><fieldset><legend>关联已观察证据</legend>{evidence.length === 0 && <p className="oc-muted">尚无已观察证据，无法确认验收通过。</p>}{evidence.map(item => <label className="oc-checkbox" key={item.id}><input type="checkbox" checked={evidenceIds.includes(item.id)} onChange={event => setEvidenceIds(event.target.checked ? [...evidenceIds, item.id] : evidenceIds.filter(id => id !== item.id))} />{item.claim}</label>)}</fieldset>{scope === 'visual' && <fieldset><legend>关联对照截图</legend><p className="oc-muted">视觉通过需要 Codex 参考图和 DSH 实现图，并确认两者是可比较的状态。缺图时请选择部分完成。</p>{screenshots.map(item => <label className="oc-checkbox" key={item.id}><input type="checkbox" checked={screenshotIds.includes(item.id)} onChange={event => setScreenshotIds(event.target.checked ? [...screenshotIds, item.id] : screenshotIds.filter(id => id !== item.id))} />{item.screenshot!.subject === 'codex' ? 'Codex' : item.screenshot!.subject === 'dsh' ? 'DSH' : '其他'} · {item.screenshot!.caption}</label>)}</fieldset>}<div className="oc-actions"><button disabled={busy || (outcome === 'passed' && (evidenceIds.length === 0 || (scope === 'visual' && !visualPair)))}><Icon name="check" />保存本项验收</button>{job.status === 'verifying' && <button type="button" disabled={busy} onClick={() => void run({ action: 'markReady', jobId: job.id }, '验收通过，已安排自动安装')}><Icon name="package" />检查验收并安装</button>}</div></form></details>;
}

function SettingsForm({ settings, busy, save, inspect }: { settings: Settings; busy: boolean; inspect: () => void; save: (patch: Partial<Settings>) => void }) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings.defaultJobTokenLimit, settings.dailyTokenLimit, settings.maxDurationMs, settings.maxRepairRounds, settings.monitorEnabled, settings.monitorIntervalMinutes, settings.localVersionFile, settings.updateResearchMode]);
  return <form className="oc-form" onSubmit={event => { event.preventDefault(); save(draft); }}><h2><Icon name="settings" />预算与发现</h2><div className="oc-two-columns"><label>默认每项 token 上限<input required type="number" min={1000} step={1000} value={draft.defaultJobTokenLimit} onChange={event => setDraft({ ...draft, defaultJobTokenLimit: Number(event.target.value) })} /></label><label>每日 token 总上限<input required type="number" min={1000} step={1000} value={draft.dailyTokenLimit} onChange={event => setDraft({ ...draft, dailyTokenLimit: Number(event.target.value) })} /></label><label>最长运行时间（分钟）<input required type="number" min={1} value={draft.maxDurationMs / 60_000} onChange={event => setDraft({ ...draft, maxDurationMs: Number(event.target.value) * 60_000 })} /></label><label>最大修复轮数<input required type="number" min={0} max={20} value={draft.maxRepairRounds} onChange={event => setDraft({ ...draft, maxRepairRounds: Number(event.target.value) })} /></label></div><label className="oc-checkbox"><input type="checkbox" checked={draft.monitorEnabled} onChange={event => setDraft({ ...draft, monitorEnabled: event.target.checked })} />DSH 运行期间定期检查官方更新来源</label>{draft.monitorEnabled && <label>检查间隔（分钟）<input required type="number" min={15} value={draft.monitorIntervalMinutes} onChange={event => setDraft({ ...draft, monitorIntervalMinutes: Number(event.target.value) })} /></label>}<section className="oc-section"><h3><Icon name="radar" />本机 Codex 更新触发</h3><label>版本文件的绝对路径<input value={draft.localVersionFile} placeholder="选择本机安装的 Info.plist 或 package.json 路径" onChange={event => setDraft({ ...draft, localVersionFile: event.target.value })} /></label><p className="oc-muted">保存路径后监听文件变化，定时补查，重启后补查漏掉的更新。首次只建立基线；留空关闭本机检测。</p><button type="button" disabled={busy || !settings.localVersionFile} onClick={inspect}><Icon name="refresh" />立即检查已保存的版本文件</button><label className="oc-checkbox"><input type="checkbox" checked={draft.updateResearchMode === "investigate"} onChange={event => setDraft({ ...draft, updateResearchMode: event.target.checked ? "investigate" : "notify" })} />本机升级后，在预算内自动调查新增功能</label><p className="oc-muted">默认只生成候选卡。自动调查仅整理变化与证据，具体复刻仍由你选择。</p></section><p className="oc-muted">每日额度按 UTC 结算。新任务使用默认预算；已有任务单独调整。前台操作等待你开始。</p><button className="oc-primary" disabled={busy}><Icon name="check" />保存设置</button></form>;
}

function Library({ busy, read }: { busy: boolean; read: (id: string) => void }) {
  return <div className="oc-library">{catalog.entries.map(({ id, title }) => <button disabled={busy} key={id} onClick={() => read(id)}><Icon name={id === 'source-index' ? 'radar' : 'file'} /><strong>{title}</strong><Icon name="next" className="oc-library-arrow" /></button>)}</div>;
}
