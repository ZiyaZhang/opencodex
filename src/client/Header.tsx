/** The top of the page: the title with 检查更新 and the settings button, then what the last check found and what holds up the next one. */
import type { ClientResponse } from './contract.js';
import { Icon } from './icons.js';
import { time } from './labels.js';
import { useUi } from './ui-context.js';

/** The last check as the header shows it, from whichever record has it. */
export interface CheckSummary {
  /** When it ended. */
  at?: string;
  /** The release window it covered; null when there was no new stable release. */
  window: { from?: string; to?: string } | null;
  added: { releases: number; files: number; desktop: number; rss: number };
  errors: string[];
  /** Another DSH process ran it: a scheduled run beside the desktop app, or DSH before its last restart. */
  elsewhere: boolean;
}

/**
 * The last check on this data directory. The check log's last line comes first: every process writes one, so it is there after a restart
 * and for a check another process ran. This process's own last check is used without a log line, and also when it ended after the log's
 * last line, which happens only when its own line could not be written (its `log:` error says why).
 */
export function lastCheckOf({ lastCheckLog: log, lastCheck, lastCheckAt, hostPid }: Pick<ClientResponse, 'lastCheckLog' | 'lastCheck' | 'lastCheckAt' | 'hostPid'>): CheckSummary | undefined {
  const ownIsLater = lastCheck !== undefined && lastCheckAt !== undefined && log !== undefined && lastCheckAt > log.at;
  if (log && !ownIsLater) {
    const { releases, files, desktop, rss } = log.added;
    return {
      at: log.at, window: log.window && { from: log.window.fromTag, to: log.window.toTag }, added: { releases, files, desktop, rss },
      errors: log.errors, elsewhere: log.pid !== hostPid,
    };
  }
  if (!lastCheck) return undefined;
  const range = lastCheck.releases.window ?? lastCheck.files.window;
  return {
    ...(lastCheckAt && { at: lastCheckAt }), window: range ? { from: range.from, to: range.to } : null,
    added: { releases: lastCheck.releases.added, files: lastCheck.files.added, desktop: lastCheck.desktop.added, rss: lastCheck.rss },
    errors: lastCheck.errors, elsewhere: false,
  };
}

const windowText = (window: CheckSummary['window']) => (!window?.to ? '没有新的正式版' : window.from ? `${window.from} → ${window.to}` : window.to);

function LastCheckLine({ summary }: { summary?: CheckSummary }) {
  if (!summary) return <p className="oc-line">DSH 启动后还没有检查过。</p>;
  const { at, window, added, errors, elsewhere } = summary;
  return <div className="oc-line">
    <strong>上次检查</strong>
    {at && <time dateTime={at}>{time(at)}</time>}
    {elsewhere && <span>由另一个 DSH 进程执行</span>}
    <span>{windowText(window)}</span>
    <span>发布说明 +{added.releases}</span>
    <span>仓库文件 +{added.files}</span>
    <span>桌面端 +{added.desktop}</span>
    <span>RSS +{added.rss}</span>
    {errors.length === 0 ? <span>没有错误</span>
      : <details className="oc-errors"><summary className="oc-warn">{errors.length} 条错误</summary><ul>{errors.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}
  </div>;
}

type IndexSummary = NonNullable<ClientResponse['indexSummary']>;
function IndexLine({ summary, mirrorSet, busy, rebuild }: { summary?: IndexSummary; mirrorSet: boolean; busy: boolean; rebuild: () => unknown }) {
  const { Button } = useUi();
  return <div className="oc-line">
    <strong>DSH 索引</strong>
    {summary
      ? <><span>{summary.entries.toLocaleString('zh-CN')} 条</span><span>提交 <code>{summary.commit.slice(0, 12)}</code></span><span>建于 {time(summary.builtAt)}</span></>
      : <span>{mirrorSet ? '还没有建，点「重建索引」' : '还没有建，先在设置里填 DSH 镜像路径'}</span>}
    <Button variant="outline" size="sm" disabled={busy} onClick={rebuild}>{busy ? '重建中…' : '重建索引'}</Button>
  </div>;
}

export interface HeaderProps {
  /** The last answer; absent until the first one arrives. */
  data?: ClientResponse;
  /** A check is running, asked for by this page or started by the Host's timer. */
  checking: boolean;
  indexBusy: boolean;
  settingsOpen: boolean;
  /** The last failure of each control, and of the last refresh. */
  errors: { check?: string; index?: string; refresh?: string };
  check: () => unknown;
  rebuildIndex: () => unknown;
  toggleSettings: () => unknown;
}

export function Header({ data, checking, indexBusy, settingsOpen, errors, check, rebuildIndex, toggleSettings }: HeaderProps) {
  const { Button, Tooltip } = useUi();
  // Another live process holding the data directory refuses a check, whatever it is doing there.
  const lock = data?.lock;
  return <>
    <header className="oc-header">
      <h1 className="oc-title">Codex 动态</h1>
      <div className="oc-header-actions">
        <Button variant="outline" size="sm" icon={<Icon name="refresh" />} disabled={!data || checking || lock !== undefined} onClick={check}>
          {checking ? '检查中…' : '检查更新'}
        </Button>
        <Tooltip label="设置" side="bottom" align="end" delayMs={500}>
          <Button variant="ghost" size="sm" className="oc-icon-button" icon={<Icon name="settings" />} aria-label="设置" aria-pressed={settingsOpen} onClick={toggleSettings} />
        </Tooltip>
      </div>
    </header>
    {data && <section className="oc-overview" aria-label="检查与索引">
      <LastCheckLine summary={lastCheckOf(data)} />
      {lock && <p className="oc-line oc-attention" role="status">另一个 DSH 进程正在{lock.kind === 'research' ? '调研' : '检查'}（pid {lock.pid}）</p>}
      {data.researchNotice && <p className="oc-line oc-attention" role="status">{data.researchNotice}</p>}
      {errors.check && <p className="oc-error" role="alert">{errors.check}</p>}
      <IndexLine summary={data.indexSummary} mirrorSet={data.settings.dshMirrorPath !== ''} busy={indexBusy} rebuild={rebuildIndex} />
      {errors.index && <p className="oc-error" role="alert">{errors.index}</p>}
      {data.notice && <p className="oc-notice" role="status">{data.notice}</p>}
      {errors.refresh && <p className="oc-error" role="alert">刷新失败：{errors.refresh}</p>}
    </section>}
  </>;
}
