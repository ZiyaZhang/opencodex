/**
 * The detail's 概览: what Codex does, why the classification put it where it is, what the source called it, and the evidence. It reads the
 * whole record once the detail has it: the list carries the summary and the reason cut short, and no evidence excerpts.
 */
import type { Candidate, Evidence } from '../core/candidate.js';
import { Icon } from './icons.js';
import { CATEGORY_LABELS, EVIDENCE_LABELS, RELEVANCE_LABELS, given, labelOf, mergeLabel } from './labels.js';
import { revealHidden } from './markdown.js';
import { useUi } from './ui-context.js';

const httpUrl = (url: string | undefined) => (url && /^https?:\/\//i.test(url) ? url : undefined);

/** The evidence of a candidate: its kind, its reference and link, and the excerpt behind a click, invisible characters spelled out. */
export function EvidenceList({ evidence }: { evidence: readonly Evidence[] }) {
  const { Tag } = useUi();
  if (evidence.length === 0) return <p className="oc-muted">没有证据条目。</p>;
  return <ul className="oc-evidence">{evidence.map((item, index) => {
    const url = httpUrl(item.url);
    return <li key={index}>
      <div className="oc-evidence-head">
        <Tag tone="neutral">{labelOf(EVIDENCE_LABELS, item.kind)}</Tag><code>{item.ref}</code>
        {url && <a href={url} target="_blank" rel="noreferrer">打开<Icon name="external" /></a>}
      </div>
      {item.excerpt && <details><summary>摘录</summary><pre className="oc-raw">{revealHidden(item.excerpt)}</pre></details>}
    </li>;
  })}</ul>;
}

export interface OverviewPaneProps {
  /** The candidate as listed. */
  candidate: Candidate;
  /** Its whole record, once read. */
  whole?: Candidate;
  /** Why the whole record could not be read. */
  error?: string;
  /** Every listed candidate, to name the one a merged candidate went into. */
  candidates: readonly Candidate[];
}

export function OverviewPane({ candidate, whole, error, candidates }: OverviewPaneProps) {
  const record = whole ?? candidate;
  const { classification, window: range } = record;
  const gist = given(classification?.gist), summary = given(record.summary);
  // Without the classification's sentence the summary says what Codex does, and the source part below names only the title.
  const does = gist ?? summary;
  return <>
    <section className="oc-pane-section">
      <h3>Codex 做了什么</h3>
      {does ? <p className="oc-text">{does}</p> : <p className="oc-muted">来源没有给出说明。</p>}
    </section>
    <section className="oc-pane-section">
      <h3>归类理由</h3>
      {classification ? <>
        <p className="oc-pane-facts">
          <span>{labelOf(CATEGORY_LABELS, classification.category)}</span>
          <span>相关度{labelOf(RELEVANCE_LABELS, classification.relevance)}</span>
          {classification.mergedInto && <span>{mergeLabel(classification.mergedInto, candidates)}</span>}
        </p>
        <p className="oc-text">{classification.rationale}</p>
      </> : <p className="oc-muted">还没有归类，检查更新后会自动归类。</p>}
    </section>
    <section className="oc-pane-section">
      <h3>{gist && summary ? '原始标题和摘要' : '原始标题'}</h3>
      <p className="oc-text oc-pane-title">{record.title}</p>
      {(range?.toTag || range?.version) && <p className="oc-pane-facts">
        {range.toTag && <span>{range.fromTag ? `${range.fromTag} → ` : ''}{range.toTag}</span>}
        {range.version && <span>版本 {range.version}</span>}
      </p>}
      {gist && summary && <p className="oc-text">{summary}</p>}
    </section>
    <section className="oc-pane-section">
      <h3>证据 <span>{record.evidence.length.toLocaleString('zh-CN')}</span></h3>
      {error && <p className="oc-error" role="alert">摘录读取失败：{error}</p>}
      <EvidenceList evidence={record.evidence} />
    </section>
  </>;
}
