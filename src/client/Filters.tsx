/** The list's views, 待办 / 相关度低 / 已忽略, each with how many candidates it holds. */
import { VIEWS, VIEW_LABELS, type View } from './labels.js';
import { useUi } from './ui-context.js';

export function Filters({ view, counts, change }: { view: View; counts: Record<View, number>; change: (view: View) => void }) {
  const { Pill } = useUi();
  return <div className="oc-views" role="group" aria-label="视图">
    {VIEWS.map(value => <Pill key={value} active={value === view} aria-pressed={value === view} onClick={() => change(value)}>
      {VIEW_LABELS[value]}<span className="oc-view-count">{counts[value].toLocaleString('zh-CN')}</span>
    </Pill>)}
  </div>;
}
