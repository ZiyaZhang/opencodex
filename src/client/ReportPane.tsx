/**
 * The detail's 报告: the report with its checks and 重新调研, or, without one, what research writes and 开始调研 (or how far the queue is).
 */
import type { ReactNode } from 'react';
import { canTransition, type Candidate, type ReportChecks, type ReportRecord } from '../core/candidate.js';
import type { CandidateAction } from './CandidateRow.js';
import type { ReportText } from './contract.js';
import { time } from './labels.js';
import { Markdown } from './markdown.js';
import { useUi } from './ui-context.js';

/** The report checks as the report's head shows them. A report without any DSH reference does not pass. */
export function checksSummary({ requiredSections, dshRefsTotal: total, dshRefsResolved: resolved }: ReportChecks) {
  const refsOk = total > 0 && resolved >= total;
  const warnings = total === 0 ? ['没有引用'] : resolved < total ? [`有 ${total - resolved} 处引用未在镜像里找到`] : [];
  return {
    passed: requiredSections && refsOk,
    items: [
      { label: `${resolved}/${total} 处引用在镜像里找到`, ok: refsOk },
      { label: requiredSections ? '模板要求的节齐全' : '缺少模板要求的节', ok: requiredSections },
    ],
    warnings,
  };
}

/** A report: its checks with `action` at the right of them, then the text, or why there is none to show. */
export function ReportView({ record, report, error, loading, action }: {
  record?: ReportRecord; report?: ReportText; error?: string; loading?: boolean; action?: ReactNode;
}) {
  if (!record) return <p className="oc-muted">还没有报告</p>;
  const { passed, items, warnings } = checksSummary(record.checks);
  return <div className="oc-report">
    <div className="oc-report-bar">
      <p className="oc-report-head">
        <strong className={passed ? 'oc-ok' : 'oc-warn'}>{passed ? '校验通过' : '校验未通过'}</strong>
        {items.map(item => <span key={item.label} className={item.ok ? '' : 'oc-warn'}>{item.ok ? '✓' : '✗'} {item.label}</span>)}
        <span className="oc-muted">生成于 <time dateTime={record.generatedAt}>{time(record.generatedAt)}</time></span>
      </p>
      {action}
    </div>
    {warnings.map(warning => <p key={warning} className="oc-warning" role="note">{warning}</p>)}
    {error ? <p className="oc-error" role="alert">报告读取失败：{error}</p>
      : report?.notice ? <p className="oc-notice" role="status">{report.notice}</p>
      : report ? <Markdown text={report.markdown} />
      : loading ? <p className="oc-muted" role="status">正在读取报告…</p> : null}
  </div>;
}

export interface ReportPaneProps {
  candidate: Candidate;
  /** The report's text as the detail read it, why that failed, or that it is still reading. */
  report?: ReportText; error?: string; loading: boolean;
  busy?: CandidateAction;
  /** Its place in the automatic research queue, from 1. */
  queued?: number;
  run: (action: 'report') => unknown;
}

export function ReportPane({ candidate, report, error, loading, busy, queued, run }: ReportPaneProps) {
  const { Button } = useUi();
  const { status } = candidate;
  const researching = busy === 'report';
  // A report can be asked for again from any status but ignored; while any request on the candidate is out, the button waits. It is a
  // secondary button: the head's 开始调研 is the primary one.
  const research = (idle: string) =>
    <Button variant="outline" size="sm" disabled={busy !== undefined || !canTransition(status, 'reported')} onClick={() => run('report')}>{researching ? '调研中…' : idle}</Button>;
  if (!candidate.report) {
    return <div className="oc-report-empty">
      <p>还没有报告。开始调研后，分析会话会对照证据和 DSH 镜像写一份报告，大约 3 分钟。</p>
      {researching ? <p role="status">分析会话正在写报告。</p>
        : queued !== undefined ? <p role="status">排在自动调研的第 {queued} 个，轮到时自动开始。</p>
        : status === 'ignored' ? <p>已忽略的动态要先恢复，才能开始调研。</p>
        : research('开始调研')}
    </div>;
  }
  return <ReportView record={candidate.report} report={report} error={error} loading={loading} action={research('重新调研')} />;
}
