import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import createDOMPurify, { type WindowLike } from 'dompurify';
import type { Candidate, Classification, ReportRecord } from '../src/core/candidate.ts';
import type { CheckLogEntry } from '../src/core/run-log.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings.ts';
import type { CheckResult } from '../src/host/collector.ts';
import type { OpenCodexRequest, OpenCodexResponse } from '../src/host/remote.ts';
import type { Brief, ModelCatalog } from '../src/client/contract.ts';
import type { Ui } from '../src/client/ui.ts';
import { UiContext } from '../src/client/ui-context.ts';
import { lastCheckOf } from '../src/client/Header.tsx';
import { OpenCodexPage } from '../src/client/page.tsx';
import { ReportView, checksSummary } from '../src/client/ReportPane.tsx';
import { draftOf, modelChoices, routeOf, settingsPatch } from '../src/client/SettingsView.tsx';
import { Markdown, PURIFY_CONFIG, hiddenCharacters, linkDefinitions, renderMarkdown, revealHidden } from '../src/client/markdown.tsx';

// React 18 only flushes effects and state updates inside act() when the environment says it is a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom ships no type declarations; the window is only handed to DOMPurify.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string) => { window: WindowLike } };
/** The real sanitizer, on a jsdom window. */
const purifier = createDOMPurify(new JSDOM('').window);

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = (hour: number) => `2026-10-15T${String(hour).padStart(2, '0')}:00:00.000Z`;
const classified = (category: Classification['category'], relevance: Classification['relevance'], extra: Partial<Classification> = {}): Classification =>
  ({ category, relevance, rationale: 'r', ...extra });
const candidate = (n: number, fields: Partial<Candidate> = {}): Candidate => ({
  id: ID(n), fingerprint: `codex-release:pr:${n}`, source: 'codex-release', title: `候选 ${n}`, summary: '',
  status: 'new', createdAt: AT(n), updatedAt: AT(n), evidence: [], window: { fromTag: 'rust-v0.162.1', toTag: 'rust-v0.163.0' }, ...fields,
});
const reportRecord = (n: number, dshRefsTotal = 1, dshRefsResolved = 1): ReportRecord =>
  ({ path: `reports/${ID(n)}/report.md`, generatedAt: AT(3), checks: { requiredSections: true, dshRefsTotal, dshRefsResolved } });

/** All text under a rendered node, in document order. */
function textOf(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(textOf).join('');
}
/** One part of the page on its own, with the stand-in controls the page would give it. */
function render(element: ReturnType<typeof createElement>): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  TestRenderer.act(() => { renderer = TestRenderer.create(createElement(UiContext.Provider, { value: ui }, element)); });
  return renderer;
}

type Props = Record<string, unknown> & { children?: ReactNode };
/**
 * Stand-ins for the DSH controls: each renders the native element the real one renders, with the props the page chose for its look
 * (variant, size, tone, state, active) as data attributes. The real controls cannot load in Node.
 */
const ui = {
  Button: ({ variant = 'ghost', size = 'md', icon, children, ...rest }: Props) =>
    createElement('button', { type: 'button', 'data-variant': variant, 'data-size': size, ...rest }, icon as ReactNode, children),
  Pill: ({ active = false, children, onClick, ...rest }: Props) => (onClick
    ? createElement('button', { type: 'button', 'data-active': active, onClick, ...rest }, children)
    : createElement('span', { 'data-active': active }, children)),
  Tag: ({ tone = 'outline', children }: Props) => createElement('span', { 'data-tone': tone }, children),
  StateDot: ({ state }: Props) => createElement('span', { 'data-state': state }),
  Input: ({ icon: _icon, className: _className, ...rest }: Props) => createElement('input', rest),
  Switch: ({ checked, onChange, label }: Props) =>
    createElement('button', { type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, onClick: () => (onChange as (next: boolean) => void)(!checked) }),
  SegmentedTabs: ({ items, value, onChange, label }: Props) => createElement('div', { role: 'tablist', 'aria-label': label },
    ...(items as Array<{ value: string; label: ReactNode; id: string; panelId: string }>).map(item => createElement('button', {
      key: item.value, id: item.id, role: 'tab', 'aria-selected': item.value === value, 'aria-controls': item.panelId,
      onClick: () => (onChange as (next: string) => void)(item.value),
    }, item.label))),
  Tooltip: ({ children }: Props) => children,
} as unknown as Ui;

/**
 * A Host stand-in that records the requests: every action answers with the snapshot (`extra` laid over it), `start` with a session id,
 * `candidate` with the record in `whole` (else the listed one), `readReport` with a one-line report, `models` with `host.models`, `brief`
 * with `host.brief`. `failures` makes an action throw.
 */
function fakeHost(candidates: Candidate[], extra: Partial<OpenCodexResponse> = {}, whole: Record<string, Candidate> = {}) {
  const host = {
    requests: [] as OpenCodexRequest[],
    settings: { ...DEFAULT_SETTINGS } as Settings,
    models: undefined as ModelCatalog | undefined,
    brief: {
      instructions: '任务：按报告的建议实现。\n结束时用一句话说明怎么试用。',
      attachments: ['报告 reports/x/report.md', '证据目录 reports/x/evidence/', 'DSH 镜像 /Users/x/deepseek-harness（只读）', '工作目录 work/x/'],
    } as Brief,
    failures: {} as Partial<Record<OpenCodexRequest['action'], string>>,
    call: async (request: OpenCodexRequest): Promise<OpenCodexResponse> => {
      host.requests.push(request);
      const failure = host.failures[request.action];
      if (failure) throw new Error(failure);
      if (request.action === 'settings') host.settings = { ...host.settings, ...request.patch };
      const snapshot: OpenCodexResponse = {
        settings: host.settings, candidates, totalCandidates: candidates.length, omittedCandidates: 0, checkpoints: {},
        busy: { check: false, candidates: {} }, hostPid: 4242, ...extra,
      };
      if (request.action === 'start') return { ...snapshot, startedSessionId: 'session-1' };
      if (request.action === 'candidate') return { ...snapshot, candidate: whole[request.id] ?? candidates.find(item => item.id === request.id) };
      if (request.action === 'readReport') return { ...snapshot, report: { id: request.id, markdown: `报告正文 ${request.id}` } };
      if (request.action === 'models') return { ...snapshot, ...(host.models && { models: host.models }) };
      if (request.action === 'brief') return { ...snapshot, brief: host.brief };
      return snapshot;
    },
  };
  return host;
}
async function mount(props: Omit<Parameters<typeof OpenCodexPage>[0], 'ui'>): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => { renderer = TestRenderer.create(createElement(OpenCodexPage, { ui, ...props })); });
  return renderer;
}
const buttons = (root: ReactTestInstance, label: string) => root.findAll(node => node.type === 'button' && textOf(node) === label);
const labelled = (root: ReactTestInstance, label: string) => root.findAll(node => node.type === 'button' && node.props['aria-label'] === label);
const rows = (root: ReactTestInstance) => root.findAll(node => node.type === 'article');
/** The row whose title is `title`. */
function rowOf(root: ReactTestInstance, title: string): ReactTestInstance {
  const row = rows(root).find(item => textOf(item.findAllByType('h3')[0]!) === title);
  assert.ok(row, `row ${title} not found`);
  return row;
}
/** A row's DSH buttons in order, as `text:variant:size`; the title is a plain button and not among them. */
const looks = (row: ReactTestInstance) => row.findAll(node => node.type === 'button' && node.props['data-variant'] !== undefined)
  .map(node => `${textOf(node)}:${node.props['data-variant']}:${node.props['data-size']}`);
const tagsOf = (root: ReactTestInstance) => root.findAll(node => node.type === 'span' && node.props['data-tone'] !== undefined)
  .map(node => `${textOf(node)}/${node.props['data-tone']}`);
/** The view switches, as `text:pressed`. */
const views = (root: ReactTestInstance) => root.findAll(node => node.type === 'button' && node.props['data-active'] !== undefined)
  .map(node => `${textOf(node)}:${node.props['aria-pressed']}`);
/** The detail's tabs, as `text:selected`, and one of them by its text. */
const tabs = (root: ReactTestInstance) => root.findAll(node => node.type === 'button' && node.props.role === 'tab')
  .map(node => `${textOf(node)}:${node.props['aria-selected']}`);
const tab = (root: ReactTestInstance, label: string) => root.findAll(node => node.type === 'button' && node.props.role === 'tab' && textOf(node) === label)[0];
/** The open part of the detail. */
function panel(root: ReactTestInstance): ReactTestInstance {
  const [found] = root.findAll(node => node.type === 'div' && node.props.role === 'tabpanel');
  assert.ok(found, 'no part of the detail is open');
  return found;
}
/** The detail's head: the title, its tag, the third line and the buttons. */
function head(root: ReactTestInstance): ReactTestInstance {
  const [found] = root.findAll(node => node.type === 'header' && node.props.className === 'oc-detail-head');
  assert.ok(found, 'no detail is open');
  return found;
}
async function click(button: ReactTestInstance | undefined): Promise<void> {
  assert.ok(button, 'button not found');
  await TestRenderer.act(async () => { await button.props.onClick(); });
}
const isField = (node: ReactTestInstance) => node.type === 'input' || node.type === 'select' || node.type === 'textarea';
async function type(root: ReactTestInstance, name: string, value: string): Promise<void> {
  const [field] = root.findAll(node => isField(node) && node.props.name === name);
  assert.ok(field, `field ${name} not found`);
  await TestRenderer.act(async () => { field.props.onChange({ target: { value } }); });
}
const valueOf = (root: ReactTestInstance, name: string) => root.findAll(node => isField(node) && node.props.name === name)[0]?.props.value;
async function submit(root: ReactTestInstance): Promise<void> {
  const [form] = root.findAllByType('form');
  assert.ok(form);
  await TestRenderer.act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
}

test('checks summary: warnings for unresolved references and for none at all, neither passes', () => {
  assert.deepEqual(checksSummary({ requiredSections: true, dshRefsTotal: 4, dshRefsResolved: 4 }).warnings, []);
  assert.equal(checksSummary({ requiredSections: true, dshRefsTotal: 4, dshRefsResolved: 4 }).passed, true);
  const partial = checksSummary({ requiredSections: true, dshRefsTotal: 5, dshRefsResolved: 3 });
  assert.deepEqual(partial.warnings, ['有 2 处引用未在镜像里找到']);
  assert.equal(partial.passed, false);
  const none = checksSummary({ requiredSections: true, dshRefsTotal: 0, dshRefsResolved: 0 });
  assert.deepEqual(none.warnings, ['没有引用']);
  assert.equal(none.passed, false);
  assert.equal(checksSummary({ requiredSections: false, dshRefsTotal: 2, dshRefsResolved: 2 }).passed, false);
});

test('report area: empty state, check warnings, notice and read error', () => {
  assert.match(textOf(render(createElement(ReportView, {})).root), /还没有报告/);
  const unresolved = textOf(render(createElement(ReportView, { record: reportRecord(1, 5, 3), report: { id: ID(1), markdown: '# 报告' } })).root);
  assert.match(unresolved, /有 2 处引用未在镜像里找到/);
  assert.match(unresolved, /3\/5 处引用在镜像里找到/);
  assert.match(textOf(render(createElement(ReportView, { record: reportRecord(1, 0, 0), report: { id: ID(1), markdown: '# 报告' } })).root), /没有引用/);
  assert.match(textOf(render(createElement(ReportView, { record: reportRecord(1), report: { id: ID(1), markdown: '', notice: '报告文件不存在，请重新生成' } })).root), /报告文件不存在，请重新生成/);
  assert.match(textOf(render(createElement(ReportView, { record: reportRecord(1), error: 'EACCES' })).root), /EACCES/);
});

test('the sanitizer config keeps Markdown elements only and drops attributes that hide text', () => {
  for (const attribute of ['style', 'hidden']) assert.ok(PURIFY_CONFIG.FORBID_ATTR?.includes(attribute), attribute);
  for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input']) assert.ok(PURIFY_CONFIG.FORBID_TAGS?.includes(tag), tag);
  for (const attribute of ['class', 'style', 'hidden', 'title', 'id', 'color']) assert.ok(!PURIFY_CONFIG.ALLOWED_ATTR?.includes(attribute), attribute);
  for (const tag of ['div', 'span', 'details', 'img', 'font', 'select', 'template']) assert.ok(!PURIFY_CONFIG.ALLOWED_TAGS?.includes(tag), tag);
  assert.equal(PURIFY_CONFIG.ALLOW_DATA_ATTR, false);
  assert.equal(PURIFY_CONFIG.ALLOW_ARIA_ATTR, false);
  assert.equal(PURIFY_CONFIG.FORCE_BODY, true);
});

test('real sanitizer: a clean report counts nothing removed', () => {
  const clean = [
    '# 标题', '', '正文 **粗** *斜* ~~删~~ `code` [链接](https://example.com/a?b=1)', '',
    '| 左 | 右 |', '|:--|--:|', '| 1 | 2 |', '', '```ts', 'const a = 1;', '```', '',
    '- [x] 做完', '- [ ] 没做', '', '3. 三', '4. 四', '', '> 引用', '', '---', '',
  ].join('\n');
  const rendered = renderMarkdown(clean, purifier);
  assert.equal(rendered?.removed, 0);
  assert.match(rendered!.html, /<a href="https:\/\/example.com\/a\?b=1">链接<\/a>/);
  assert.match(rendered!.html, /<ol start="3">/);
  assert.match(rendered!.html, /<th align="left">/);
  assert.deepEqual(renderMarkdown('', purifier), { html: '', removed: 0 });
});

test('real sanitizer: scripts, handlers, javascript: links, svg and iframes go; hidden text shows', () => {
  const links = renderMarkdown('[点我](javascript:alert(1)) <a href="javascript:alert(2)">再点</a>', purifier)!;
  assert.doesNotMatch(links.html, /javascript:/i);
  assert.match(links.html, /点我/);
  assert.match(links.html, /再点/);
  const active = renderMarkdown('<img src=x onerror="alert(1)">\n\n<svg><script>alert(2)</script><text>svg</text></svg>\n\n<iframe srcdoc="<script>alert(3)</script>"></iframe>', purifier)!;
  assert.doesNotMatch(active.html, /<img|onerror|<svg|<script|<iframe|srcdoc|alert/i);
  assert.ok(active.removed >= 3);
  const hidden = renderMarkdown('<p hidden>甲</p><p style="display:none">乙</p><p class="hidden">丙</p>', purifier)!;
  assert.doesNotMatch(hidden.html, /hidden|style|class/);
  for (const word of ['甲', '乙', '丙']) assert.match(hidden.html, new RegExp(word));
  assert.equal(hidden.removed, 3);
});

test('real sanitizer: raw HTML that would land in <head> is counted', () => {
  const titled = renderMarkdown('<title>藏起来的标题</title>\n\n# 报告', purifier)!;
  assert.equal(titled.removed, 1);
  assert.doesNotMatch(titled.html, /藏起来的标题/);
  assert.match(titled.html, /<h1>报告<\/h1>/);
  assert.equal(renderMarkdown('<style>.oc-page{display:none}</style><meta name="x"><link rel="x" href="y">\n\n正文', purifier)?.removed, 3);
});

test('link definitions are counted by line, repeated labels too, outside fenced code', () => {
  assert.equal(linkDefinitions('[//]: # (藏起来的话)\n\n正文'), 1);
  assert.equal(linkDefinitions('[a]: https://x\n[a]: https://y\n> [b]: https://z\n- [c]: <https://w> "t"'), 4);
  assert.equal(linkDefinitions('```md\n[a]: https://x\n```\n~~~\n[b]: y\n~~~'), 0);
  assert.equal(linkDefinitions('- [x] 做完\n- [ ] 没做\n[链接](https://x)\n[]: x\n    代码'), 0);
});

test('link definitions the line count misses are still counted, through marked\'s own lexer', () => {
  assert.equal(linkDefinitions('[//\n]: # (SECRET)\n\n正文'), 1, 'a label split over two lines');
  assert.equal(linkDefinitions('```x`\n\n[a]: https://secret\n\n正文'), 1, 'after a line that only looks like a fence');
  assert.equal(linkDefinitions('<div>\n```\n</div>\n\n[b]: https://secret\n\n正文'), 1, 'after a fence-like line inside raw HTML');
  const renderer = render(createElement(Markdown, { text: '[//\n]: # (SECRET)\n\n正文', sanitizer: purifier }));
  assert.match(textOf(renderer.root), /有 1 行链接定义没有显示/);
});

test('a report that sanitizes to no text at all is shown raw, with a note', () => {
  const text = '<frameset><frame src="https://x"></frameset>\n\n藏起来的正文';
  const renderer = render(createElement(Markdown, { text, sanitizer: purifier }));
  assert.equal(renderer.root.findAll(node => node.props.dangerouslySetInnerHTML !== undefined).length, 0);
  assert.equal(textOf(renderer.root.findAllByType('pre')[0]!), text);
  assert.match(textOf(renderer.root), /排版后没有一个字能显示，下面是原文。/);
  assert.equal(renderer.root.findAll(node => node.type === 'button').length, 0, 'no formatted view to switch to');
  const definitionsOnly = render(createElement(Markdown, { text: '[a]: https://x\n[b]: https://y', sanitizer: purifier }));
  assert.equal(textOf(definitionsOnly.root.findAllByType('pre')[0]!), '[a]: https://x\n[b]: https://y');
});

test('invisible characters written as HTML character references are counted', () => {
  assert.equal(hiddenCharacters('a&#x200B;b&#X202e;c&#8203;d&#8238e&ZeroWidthSpace;f&zwj;g'), 6);
  assert.equal(hiddenCharacters('&amp; &#x41; &#65; &copy; https://x?a=1&it=2 &#x110000; &nbsp;'), 0);
});

test('the report notice counts what is not shown, and 看原文 shows the raw text', () => {
  const text = '<title>藏</title>\n\n[//]: # (藏起来的话)\n\n正文';
  const renderer = render(createElement(Markdown, { text, sanitizer: purifier }));
  assert.match(textOf(renderer.root), /有 1 处 HTML 标签或属性没有显示；有 1 行链接定义没有显示，原文里能看到。/);
  assert.equal(renderer.root.findAllByType('pre').length, 0);
  const [formatted] = renderer.root.findAll(node => node.props.dangerouslySetInnerHTML !== undefined);
  assert.match(formatted!.props.dangerouslySetInnerHTML.__html as string, /正文/);
  const [toggle] = renderer.root.findAll(node => node.type === 'button' && textOf(node) === '看原文');
  TestRenderer.act(() => { toggle!.props.onClick(); });
  const [pre] = renderer.root.findAllByType('pre');
  assert.equal(textOf(pre!), text);
  assert.equal(renderer.root.findAll(node => node.type === 'button' && textOf(node) === '看排版').length, 1);
});

test('Markdown output reaches the sanitizer with that config, and code blocks and task boxes need no attribute', () => {
  const seen: { html: string; config: unknown }[] = [];
  const stand = {
    removed: [] as unknown[],
    sanitize(html: string, config: unknown) { seen.push({ html, config }); this.removed = [{}, {}]; return '<p>clean</p>'; },
  };
  const text = ['```ts', 'const a = 1;', '```', '', '- [x] 做完', '- [ ] 没做', '', '<span hidden>藏起来</span>'].join('\n');
  assert.deepEqual(renderMarkdown(text, stand), { html: '<p>clean</p>', removed: 2 });
  assert.equal(seen[0]!.config, PURIFY_CONFIG);
  assert.match(seen[0]!.html, /<pre><code>const a = 1;\n<\/code><\/pre>/);
  assert.doesNotMatch(seen[0]!.html, /class=|<input/);
  assert.match(seen[0]!.html, /☑ 做完/);
  assert.match(seen[0]!.html, /☐ 没做/);
});

test('without a DOM the report shows as plain text, never as unsanitized HTML', () => {
  assert.equal(renderMarkdown('<b hidden>x</b>'), undefined);
  const renderer = render(createElement(Markdown, { text: '<b hidden>藏</b><script>alert(1)</script>' }));
  assert.equal(renderer.root.findAll(node => node.props.dangerouslySetInnerHTML !== undefined).length, 0);
  const [pre] = renderer.root.findAllByType('pre');
  assert.equal(textOf(pre!), '<b hidden>藏</b><script>alert(1)</script>');
});

test('invisible characters are counted and spelled out in the raw view', () => {
  const zwsp = String.fromCodePoint(0x200b), tag = String.fromCodePoint(0xe0041), rlo = String.fromCodePoint(0x202e);
  const text = `看${zwsp}得见${tag}${rlo}`;
  assert.equal(hiddenCharacters(text), 3);
  assert.equal(revealHidden(text), '看⟦U+200B⟧得见⟦U+E0041⟧⟦U+202E⟧');
  assert.equal(hiddenCharacters('普通文字 plain text'), 0);
});


test('each phase gets its tag and its buttons, the primary one last; queued and running rows show progress instead', async () => {
  const host = fakeHost([
    candidate(1, { classification: classified('cli-core', 'high') }),
    candidate(2, { status: 'reported', report: reportRecord(2) }),
    candidate(3, { status: 'started', report: reportRecord(3), started: { sessionId: 'session-3', at: AT(4) } }),
    candidate(4),
    candidate(5),
    candidate(6, { status: 'ignored' }),
  ], { researchQueue: [ID(4)], busy: { check: false, candidates: { [ID(5)]: 'report' } } });
  const renderer = await mount({ call: host.call, openSession: () => {} });
  try {
    const { root } = renderer;
    assert.deepEqual(looks(rowOf(root, '候选 1')), ['忽略:ghost:sm', '开始调研:primary:sm']);
    assert.deepEqual(looks(rowOf(root, '候选 2')), ['忽略:ghost:sm', '开始执行:outline:sm', '阅读报告:primary:sm']);
    assert.deepEqual(looks(rowOf(root, '候选 3')), ['打开会话:primary:sm']);
    assert.deepEqual(looks(rowOf(root, '候选 4')), []);
    assert.match(textOf(rowOf(root, '候选 4')), /排在第 1 个/);
    assert.deepEqual(looks(rowOf(root, '候选 5')), []);
    assert.match(textOf(rowOf(root, '候选 5')), /正在写报告/);
    assert.deepEqual([1, 2, 3, 4, 5].map(n => tagsOf(rowOf(root, `候选 ${n}`))),
      [['新发现/outline'], ['已调研/success'], ['执行中/warning'], ['排队中/quiet'], ['调研中/info']]);
    assert.deepEqual(rowOf(root, '候选 5').findAll(node => node.props['data-state'] !== undefined).map(node => node.props['data-state']), ['ongoing']);
    await click(buttons(root, '已忽略1')[0]);
    assert.deepEqual(looks(rowOf(root, '候选 6')), ['恢复:primary:sm']);
    assert.deepEqual(tagsOf(rowOf(root, '候选 6')), ['已忽略/quiet']);
  } finally { renderer.unmount(); }
});

test('开始调研, 忽略 and 恢复 ask the Host; 打开会话 opens the session; 阅读报告 opens the detail with the report', async () => {
  const host = fakeHost([
    candidate(1), candidate(2, { status: 'reported', report: reportRecord(2) }),
    candidate(3, { status: 'started', started: { sessionId: 'session-3', at: AT(4) } }), candidate(4, { status: 'ignored' }),
  ]);
  const opened: string[] = [];
  const renderer = await mount({ call: host.call, openSession: id => { opened.push(id); } });
  try {
    const { root } = renderer;
    await click(buttons(rowOf(root, '候选 1'), '开始调研')[0]);
    assert.deepEqual(host.requests.at(-1), { action: 'report', id: ID(1) });
    await click(buttons(rowOf(root, '候选 1'), '忽略')[0]);
    assert.deepEqual(host.requests.at(-1), { action: 'ignore', id: ID(1) });
    await click(buttons(rowOf(root, '候选 3'), '打开会话')[0]);
    assert.deepEqual(opened, ['session-3']);
    await click(buttons(root, '已忽略1')[0]);
    await click(buttons(rowOf(root, '候选 4'), '恢复')[0]);
    assert.deepEqual(host.requests.at(-1), { action: 'restore', id: ID(4) });
    await click(buttons(root, '待办3')[0]);
    await click(buttons(rowOf(root, '候选 2'), '阅读报告')[0]);
    assert.deepEqual(host.requests.slice(-2), [{ action: 'candidate', id: ID(2) }, { action: 'readReport', id: ID(2) }]);
    assert.match(textOf(root), new RegExp(`报告正文 ${ID(2)}`));
  } finally { renderer.unmount(); }
});

test('开始执行 on the list opens 执行 and sends nothing; 发送并打开会话 starts the session and switches to it', async () => {
  const host = fakeHost([candidate(1, { status: 'reported', report: reportRecord(1) })]);
  const opened: string[] = [];
  const renderer = await mount({ call: host.call, openSession: id => { opened.push(id); } });
  try {
    await click(buttons(renderer.root, '开始执行')[0]);
    assert.ok(host.requests.every(request => request.action !== 'start'));
    assert.equal(rows(renderer.root).length, 0, 'the detail replaced the list');
    assert.deepEqual(tabs(renderer.root), ['概览:false', '报告:false', '执行:true']);
    await click(buttons(renderer.root, '发送并打开会话')[0]);
    assert.deepEqual(host.requests.at(-1), {
      action: 'start', id: ID(1), instructions: host.brief.instructions, model: { ...DEFAULT_SETTINGS.startModel }, preset: DEFAULT_SETTINGS.startPreset,
    });
    assert.deepEqual(opened, ['session-1']);
  } finally { renderer.unmount(); }
  const failing = await mount({ call: host.call, openSession: () => { throw new Error('no workspace'); } });
  try {
    await click(buttons(failing.root, '开始执行')[0]);
    await click(buttons(failing.root, '发送并打开会话')[0]);
    assert.match(textOf(panel(failing.root)), /执行会话已创建（session-1），但没能自动打开/);
    assert.equal(failing.root.findAll(node => node.props.role === 'alert').length, 0);
  } finally { failing.unmount(); }
});

test('打开会话 that cannot switch says which session it was; without a workspace it is off', async () => {
  const listed = [candidate(1, { status: 'started', started: { sessionId: 'session-9', at: AT(4) } })];
  const renderer = await mount({ call: fakeHost(listed).call, openSession: () => { throw new Error('no workspace'); } });
  try {
    await click(buttons(renderer.root, '打开会话')[0]);
    assert.match(textOf(rowOf(renderer.root, '候选 1')), /会话 session-9 没能自动打开/);
  } finally { renderer.unmount(); }
  const bare = await mount({ call: fakeHost(listed).call });
  try { assert.equal(buttons(bare.root, '打开会话')[0]?.props.disabled, true); } finally { bare.unmount(); }
});

test('while a row\'s request is out its buttons wait, the one pressed saying so', async () => {
  const host = fakeHost([candidate(1)]);
  let finish!: () => void;
  const call = async (request: OpenCodexRequest) => {
    if (request.action === 'ignore') await new Promise<void>(resolve => { finish = resolve; });
    return host.call(request);
  };
  const renderer = await mount({ call });
  try {
    TestRenderer.act(() => { void buttons(rowOf(renderer.root, '候选 1'), '忽略')[0]!.props.onClick(); });
    const row = rowOf(renderer.root, '候选 1');
    assert.deepEqual(looks(row), ['忽略中…:ghost:sm', '开始调研:primary:sm']);
    assert.ok(row.findAll(node => node.props['data-variant'] !== undefined && node.type === 'button').every(node => node.props.disabled === true));
    await TestRenderer.act(async () => { finish(); });
    assert.deepEqual(looks(rowOf(renderer.root, '候选 1')), ['忽略:ghost:sm', '开始调研:primary:sm']);
  } finally { renderer.unmount(); }
});

test('an action error shows on its row as plain text', async () => {
  const host = fakeHost([candidate(1)]);
  host.failures.report = '<b>今天已达上限</b>';
  const renderer = await mount({ call: host.call });
  try {
    await click(buttons(renderer.root, '开始调研')[0]);
    assert.match(textOf(rowOf(renderer.root, '候选 1')), /<b>今天已达上限<\/b>/);
  } finally { renderer.unmount(); }
});

test('opening a candidate from its title reads its whole record and its report, and 概览 shows the whole record', async () => {
  const listed = candidate(1, { status: 'reported', report: reportRecord(1), summary: '摘要前 300 字', classification: classified('cli-core', 'high', { rationale: '理由前 120 字' }) });
  const whole = { ...listed, summary: '摘要前 300 字，后面还有', classification: { ...listed.classification!, rationale: '理由前 120 字，后面还有' } };
  const host = fakeHost([listed], {}, { [ID(1)]: whole });
  const renderer = await mount({ call: host.call });
  try {
    await click(buttons(renderer.root, '候选 1')[0]);
    assert.deepEqual(host.requests.slice(-2), [{ action: 'candidate', id: ID(1) }, { action: 'readReport', id: ID(1) }]);
    assert.match(textOf(panel(renderer.root)), new RegExp(`报告正文 ${ID(1)}`));
    await click(tab(renderer.root, '概览'));
    const overview = textOf(panel(renderer.root));
    assert.match(overview, /摘要前 300 字，后面还有/);
    assert.match(overview, /理由前 120 字，后面还有/);
  } finally { renderer.unmount(); }
});

test('the detail opens at 报告 when there is a report, else at 概览; 阅读报告 and 开始执行 open their part; each part is labelled by its tab', async () => {
  const host = fakeHost([candidate(1, { status: 'reported', report: reportRecord(1) }), candidate(2, { classification: classified('cli-core', 'high') })]);
  const renderer = await mount({ call: host.call });
  try {
    const { root } = renderer;
    await click(buttons(root, '候选 1')[0]);
    assert.deepEqual(tabs(root), ['概览:false', '报告:true', '执行:false']);
    const [selected] = root.findAll(node => node.props.role === 'tab' && node.props['aria-selected'] === true);
    assert.equal(panel(root).props['aria-labelledby'], selected!.props.id);
    assert.equal(panel(root).props.id, selected!.props['aria-controls']);
    // The head has the row's tag, third line and buttons; its 开始执行 and 阅读报告 switch parts.
    assert.deepEqual(tagsOf(head(root)), ['已调研/success']);
    assert.match(textOf(head(root)), /Codex 发布说明/);
    assert.deepEqual(looks(head(root)), ['忽略:ghost:sm', '开始执行:outline:sm', '阅读报告:primary:sm']);
    await click(buttons(head(root), '开始执行')[0]);
    assert.deepEqual(tabs(root), ['概览:false', '报告:false', '执行:true']);
    await click(buttons(head(root), '阅读报告')[0]);
    assert.deepEqual(tabs(root), ['概览:false', '报告:true', '执行:false']);
    await click(tab(root, '概览'));
    assert.deepEqual(tabs(root), ['概览:true', '报告:false', '执行:false']);
    await click(buttons(root, '返回列表')[0]);
    await click(buttons(root, '候选 2')[0]);
    assert.deepEqual(tabs(root), ['概览:true', '报告:false', '执行:false']);
    assert.deepEqual(looks(head(root)), ['忽略:ghost:sm', '开始调研:primary:sm']);
    await click(buttons(root, '返回列表')[0]);
    await click(buttons(rowOf(root, '候选 1'), '阅读报告')[0]);
    assert.deepEqual(tabs(root), ['概览:false', '报告:true', '执行:false']);
    await click(buttons(root, '返回列表')[0]);
    await click(buttons(rowOf(root, '候选 1'), '开始执行')[0]);
    assert.deepEqual(tabs(root), ['概览:false', '报告:false', '执行:true']);
  } finally { renderer.unmount(); }
});

test('概览 says what Codex does, why it was classified so, what the source called it, and lists the evidence', async () => {
  const listed = candidate(1, {
    summary: '摘要前 300 字', evidence: [{ kind: 'pr', ref: '#12', url: 'https://github.com/openai/codex/pull/12' }],
    classification: classified('cli-core', 'high', { headline: '重启后台服务', gist: '可以从界面重启托管的后台服务', rationale: '理由' }),
  });
  const whole = { ...listed, summary: '摘要前 300 字，后面还有', evidence: [{ ...listed.evidence[0]!, excerpt: '摘录正文' }] };
  const host = fakeHost([listed, candidate(2, { summary: '只有摘要' })], {}, { [ID(1)]: whole });
  const renderer = await mount({ call: host.call });
  try {
    const { root } = renderer;
    await click(buttons(root, '重启后台服务')[0]);
    const overview = panel(root);
    const sections = overview.findAll(node => node.type === 'section').map(section => textOf(section));
    assert.equal(sections.length, 4);
    assert.match(sections[0]!, /^Codex 做了什么可以从界面重启托管的后台服务$/);
    assert.match(sections[1]!, /^归类理由CLI 核心相关度高理由$/);
    assert.match(sections[2]!, /^原始标题和摘要候选 1rust-v0\.162\.1 → rust-v0\.163\.0摘要前 300 字，后面还有$/);
    assert.match(sections[3]!, /^证据 1PR#12打开摘录摘录正文$/);
    assert.equal(overview.findAll(node => node.type === 'a' && node.props.href === 'https://github.com/openai/codex/pull/12').length, 1);
    await click(buttons(root, '返回列表')[0]);
    // Without the classification's sentence the summary says what Codex does, once.
    await click(buttons(root, '候选 2')[0]);
    const bare = panel(root).findAll(node => node.type === 'section').map(section => textOf(section));
    assert.equal(bare[0], 'Codex 做了什么只有摘要');
    assert.match(bare[1]!, /还没有归类/);
    assert.equal(bare[2], '原始标题候选 2rust-v0.162.1 → rust-v0.163.0');
  } finally { renderer.unmount(); }
});

test('报告 without a report says what research writes and starts it, or how far the queue is; with one it gives the checks and 重新调研', async () => {
  const host = fakeHost([
    candidate(1), candidate(2, { status: 'reported', report: reportRecord(2, 4, 3) }), candidate(3), candidate(4), candidate(5, { status: 'ignored' }),
  ], { researchQueue: [ID(3)], busy: { check: false, candidates: { [ID(4)]: 'report' } } });
  const renderer = await mount({ call: host.call });
  /** The 报告 of the candidate titled `title`, opened from the list's view `view`. */
  const report = async (title: string, view = '待办4') => {
    const [back] = buttons(renderer.root, '返回列表');
    if (back) await click(back);
    await click(buttons(renderer.root, view)[0]);
    await click(buttons(renderer.root, title)[0]);
    await click(tab(renderer.root, '报告'));
    return panel(renderer.root);
  };
  try {
    const empty = await report('候选 1');
    assert.match(textOf(empty), /还没有报告。开始调研后，分析会话会对照证据和 DSH 镜像写一份报告，大约 3 分钟。/);
    assert.deepEqual(looks(empty), ['开始调研:outline:sm']);
    await click(buttons(empty, '开始调研')[0]);
    assert.deepEqual(host.requests.at(-1), { action: 'report', id: ID(1) });
    const queued = await report('候选 3');
    assert.match(textOf(queued), /排在自动调研的第 1 个，轮到时自动开始。/);
    assert.deepEqual(looks(queued), []);
    assert.match(textOf(await report('候选 4')), /分析会话正在写报告。/);
    const ignored = await report('候选 5', '已忽略1');
    assert.match(textOf(ignored), /已忽略的动态要先恢复，才能开始调研。/);
    assert.deepEqual(looks(ignored), []);
    const written = await report('候选 2');
    assert.match(textOf(written), /3\/4 处引用在镜像里找到/);
    assert.match(textOf(written), new RegExp(`报告正文 ${ID(2)}`));
    assert.deepEqual(looks(written).filter(look => look.startsWith('重新调研')), ['重新调研:outline:sm']);
    await click(buttons(written, '重新调研')[0]);
    assert.deepEqual(host.requests.at(-1), { action: 'report', id: ID(2) });
  } finally { renderer.unmount(); }
});

test('执行 reads the brief: the instructions can be edited, what goes with them is listed, and the model and preset are for this start only', async () => {
  const host = fakeHost([candidate(1, { status: 'reported', report: reportRecord(1) })]);
  host.models = catalog;
  const opened: string[] = [];
  const renderer = await mount({ call: host.call, openSession: id => { opened.push(id); } });
  try {
    const { root } = renderer;
    await click(buttons(root, '开始执行')[0]);
    assert.deepEqual(host.requests.filter(request => request.action === 'brief'), [{ action: 'brief', id: ID(1) }]);
    assert.ok(host.requests.some(request => request.action === 'models'), 'the model list as the settings read it');
    const text = textOf(panel(root));
    for (const line of host.brief.attachments) assert.ok(text.includes(line), line);
    assert.match(text, /会话在 workspace-write 沙箱里运行，能写自己的工作目录；安装 bundle 时 DSH 会弹一次审批。/);
    assert.equal(valueOf(root, 'instructions'), host.brief.instructions);
    assert.equal(valueOf(root, 'startModel'), 'deepseek-official/deepseek-v4-pro');
    assert.deepEqual(root.findAll(node => node.type === 'select' && node.props.name === 'startModel')[0]!.findAllByType('optgroup').map(group => group.props.label),
      ['DeepSeek', 'OpenRouter']);
    assert.equal(valueOf(root, 'startPreset'), 'cordis');
    const send = () => buttons(root, '发送并打开会话')[0]!;
    assert.deepEqual([send().props['data-variant'], send().props['data-size'], send().props.disabled], ['primary', 'sm', false]);
    await type(root, 'instructions', '   ');
    assert.equal(send().props.disabled, true, 'blank instructions are not sent');
    await type(root, 'instructions', '任务：只做第一级。');
    await type(root, 'startModel', 'openrouter/anthropic/claude-x');
    await type(root, 'startPreset', ' agent-x ');
    await click(send());
    assert.deepEqual(host.requests.at(-1), {
      action: 'start', id: ID(1), instructions: '任务：只做第一级。', model: { provider: 'openrouter', model: 'anthropic/claude-x' }, preset: 'agent-x',
    });
    assert.deepEqual(opened, ['session-1']);
    assert.ok(host.requests.every(request => request.action !== 'settings'), 'nothing is saved');
    assert.deepEqual(host.settings.startModel, DEFAULT_SETTINGS.startModel);
    assert.equal(host.requests.filter(request => request.action === 'brief').length, 1, 'the brief is read once');
    assert.equal(valueOf(root, 'instructions'), '任务：只做第一级。', 'the edit stays');
  } finally { renderer.unmount(); }
});

test('执行 shows why the Host refuses a brief, and no form; it asks again once the candidate has moved on', async () => {
  const list = [candidate(1)];
  const host = fakeHost(list);
  host.failures.brief = '先在设置里填 DSH 镜像路径';
  const renderer = await mount({ call: host.call });
  try {
    const { root } = renderer;
    await click(buttons(root, '候选 1')[0]);
    await click(tab(root, '执行'));
    assert.match(textOf(panel(root)), /先在设置里填 DSH 镜像路径/);
    assert.equal(root.findAllByType('textarea').length, 0);
    assert.equal(buttons(root, '发送并打开会话').length, 0);
    delete host.failures.brief;
    list[0] = { ...list[0]!, status: 'reported', report: reportRecord(1), updatedAt: AT(9) };
    await click(buttons(root, '重建索引')[0]);
    assert.equal(host.requests.filter(request => request.action === 'brief').length, 2);
    assert.equal(valueOf(root, 'instructions'), host.brief.instructions);
  } finally { renderer.unmount(); }
});

test('执行 of a candidate already sent shows its session and when it went, and 再开一个会话 sends the form again', async () => {
  const host = fakeHost([candidate(1, { status: 'started', report: reportRecord(1), started: { sessionId: 'session-3', at: AT(4) } })]);
  const opened: string[] = [];
  const renderer = await mount({ call: host.call, openSession: id => { opened.push(id); } });
  try {
    const { root } = renderer;
    await click(buttons(root, '候选 1')[0]);
    assert.deepEqual(looks(head(root)), ['打开会话:primary:sm']);
    await click(tab(root, '执行'));
    const pane = panel(root);
    assert.match(textOf(pane), /会话 session-3发送于 /);
    await click(buttons(pane, 'session-3')[0]);
    assert.deepEqual(opened, ['session-3']);
    assert.equal(buttons(root, '发送并打开会话').length, 0);
    assert.deepEqual(looks(pane).filter(look => look.startsWith('再开一个会话')), ['再开一个会话:outline:sm']);
    await type(root, 'instructions', '任务：再做一遍。');
    await click(buttons(pane, '再开一个会话')[0]);
    assert.deepEqual(host.requests.at(-1), {
      action: 'start', id: ID(1), instructions: '任务：再做一遍。', model: { ...DEFAULT_SETTINGS.startModel }, preset: DEFAULT_SETTINGS.startPreset,
    });
    assert.deepEqual(opened, ['session-3', 'session-1']);
    assert.equal(valueOf(root, 'instructions'), '任务：再做一遍。');
  } finally { renderer.unmount(); }
});

test('a start the Host refuses shows its reason in 执行 beside the button, not under the head', async () => {
  const host = fakeHost([candidate(1, { status: 'reported', report: reportRecord(1) })]);
  host.failures.start = '上一个会话还在运行（会话 session-0）';
  const renderer = await mount({ call: host.call });
  try {
    const { root } = renderer;
    await click(buttons(root, '开始执行')[0]);
    await click(buttons(root, '发送并打开会话')[0]);
    assert.match(textOf(panel(root)), /上一个会话还在运行（会话 session-0）/);
    assert.doesNotMatch(textOf(head(root)), /上一个会话还在运行/);
    // Any other action's error is under the head, where its buttons are.
    host.failures.ignore = '记录写不进去';
    await click(buttons(head(root), '忽略')[0]);
    assert.match(textOf(head(root)), /记录写不进去/);
  } finally { renderer.unmount(); }
});

test('the views split the list, 待办 first and pressed, each with its count; an empty view says so', async () => {
  const host = fakeHost([
    candidate(1, { classification: classified('cli-core', 'high') }), candidate(2, { classification: classified('fix', 'low') }), candidate(3),
    candidate(4, { status: 'reported', report: reportRecord(4), classification: classified('fix', 'low') }), candidate(5, { status: 'ignored' }),
  ]);
  const renderer = await mount({ call: host.call });
  try {
    const { root } = renderer;
    const titles = () => rows(root).map(row => textOf(row.findAllByType('h3')[0]!));
    assert.deepEqual(views(root), ['待办3:true', '相关度低1:false', '已忽略1:false']);
    assert.deepEqual(titles(), ['候选 1', '候选 3', '候选 4']);
    await click(buttons(root, '相关度低1')[0]);
    assert.deepEqual(views(root), ['待办3:false', '相关度低1:true', '已忽略1:false']);
    assert.deepEqual(titles(), ['候选 2']);
    await click(buttons(root, '已忽略1')[0]);
    assert.deepEqual(titles(), ['候选 5']);
  } finally { renderer.unmount(); }
  const empty = await mount({ call: fakeHost([candidate(1)]).call });
  try {
    await click(buttons(empty.root, '已忽略0')[0]);
    assert.match(textOf(empty.root), /没有已忽略的动态/);
  } finally { empty.unmount(); }
  const none = await mount({ call: fakeHost([]).call });
  try { assert.match(textOf(none.root), /还没有 Codex 动态/); } finally { none.unmount(); }
});

test('rows come in version groups that give their latest discovery and size; the third line names source, category, relevance and time', async () => {
  const host = fakeHost([
    candidate(1, {
      evidence: [{ kind: 'pr', ref: '#12' }], window: { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.0' },
      classification: classified('cli-core', 'high', { headline: '重启后台服务', gist: '可以从界面重启托管的后台服务' }),
    }),
    candidate(2, { source: 'codex-files', evidence: [{ kind: 'feature-flag', ref: 'codex-rs/features/src/lib.rs' }], window: { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.1' } }),
    candidate(3, {
      source: 'rss', window: undefined, evidence: [{ kind: 'rss', ref: '2026-10-15 x' }], status: 'reported', report: reportRecord(3),
      classification: classified('cloud', 'medium'), research: { lastError: '早先的失败' },
    }),
    candidate(4, { status: 'started', started: { sessionId: 'session-4', at: AT(5) } }),
    candidate(5, { research: { autoAttemptedAt: AT(6), lastError: `模型超时 ${'x'.repeat(80)}` } }),
  ]);
  const renderer = await mount({ call: host.call });
  try {
    const { root } = renderer;
    const groups = root.findAll(node => node.type === 'section' && node.props.className === 'oc-group');
    assert.deepEqual(groups.map(group => textOf(group.findAllByType('h2')[0]!)), ['Codex 0.163.0', '官方公告', 'Codex 0.162.1']);
    assert.match(textOf(groups[2]!), /发现 · 2 条/);
    const named = rowOf(root, '重启后台服务');
    for (const part of [/可以从界面重启托管的后台服务/, /Codex 发布说明 #12/, /CLI 核心/, /相关度高/, /发现 /]) assert.match(textOf(named), part);
    assert.match(textOf(rowOf(root, '候选 2')), /Codex 仓库文件 lib\.rs/);
    assert.match(textOf(rowOf(root, '候选 2')), /未归类/);
    const announced = textOf(rowOf(root, '候选 3'));
    assert.match(announced, /官方 RSS 公告/);
    assert.match(announced, /报告 /);
    assert.doesNotMatch(announced, /自动调研失败/, 'a candidate with a report no longer needs the failure');
    assert.match(textOf(rowOf(root, '候选 4')), /发送 /);
    const failed = rowOf(root, '候选 5');
    assert.match(textOf(failed), new RegExp(`自动调研失败：模型超时 ${'x'.repeat(54)}…`));
    assert.equal(failed.findAll(node => node.props.title === `模型超时 ${'x'.repeat(80)}`).length, 1, 'the whole error is in its tooltip');
  } finally { renderer.unmount(); }
});

const logEntry = (fields: Partial<CheckLogEntry> = {}): CheckLogEntry => ({
  at: AT(9), startedAt: AT(8), trigger: 'timer', pid: 4242, window: { fromTag: 'rust-v0.162.1', toTag: 'rust-v0.163.0' },
  added: { releases: 3, files: 2, desktop: 0, rss: 1 }, errors: [], ...fields,
});
const checkResult = (fields: Partial<CheckResult> = {}): CheckResult => ({
  releases: { window: { from: 'rust-v0.161.0', to: 'rust-v0.162.0', releases: [] }, added: 4, gap: false, prLookupFailures: 0, unreleased: [], unrecognized: [], rateLimited: false },
  files: { added: 1, merged: 0, gap: false, unread: { overBudget: 0, rateLimited: 0, failed: 0 } },
  desktop: { version: '', changed: false, added: 0, keys: 0 }, rss: 0, errors: ['rss: HTTP 500'], ...fields,
});

test('上次检查 reads the check log first, this process\'s last check without it, and tells another process\'s check', () => {
  assert.equal(lastCheckOf({ hostPid: 4242 }), undefined);
  assert.deepEqual(lastCheckOf({ hostPid: 4242, lastCheckLog: logEntry() }), {
    at: AT(9), window: { from: 'rust-v0.162.1', to: 'rust-v0.163.0' }, added: { releases: 3, files: 2, desktop: 0, rss: 1 }, errors: [], elsewhere: false,
  });
  assert.equal(lastCheckOf({ hostPid: 4242, lastCheckLog: logEntry({ pid: 777 }) })?.elsewhere, true);
  assert.equal(lastCheckOf({ hostPid: 4242, lastCheckLog: logEntry({ window: null }) })?.window, null);
  assert.deepEqual(lastCheckOf({ hostPid: 4242, lastCheck: checkResult(), lastCheckAt: AT(7) }), {
    at: AT(7), window: { from: 'rust-v0.161.0', to: 'rust-v0.162.0' }, added: { releases: 4, files: 1, desktop: 0, rss: 0 }, errors: ['rss: HTTP 500'], elsewhere: false,
  });
  assert.equal(lastCheckOf({ hostPid: 4242, lastCheckLog: logEntry({ at: AT(9) }), lastCheck: checkResult(), lastCheckAt: AT(7) })?.at, AT(9));
  // A check of this process that ended after the log's last line is one whose line could not be written; its `log:` error says why.
  assert.equal(lastCheckOf({ hostPid: 4242, lastCheckLog: logEntry({ at: AT(5) }), lastCheck: checkResult(), lastCheckAt: AT(7) })?.at, AT(7));
});

test('the header shows the last check, another process that ran it, a lock that holds 检查更新, and the research notice', async () => {
  const header = async (extra: Partial<OpenCodexResponse>) => {
    const renderer = await mount({ call: fakeHost([], extra).call });
    try { return { text: textOf(renderer.root), check: buttons(renderer.root, '检查更新')[0]?.props.disabled }; } finally { renderer.unmount(); }
  };
  const never = await header({});
  assert.match(never.text, /DSH 启动后还没有检查过。/);
  assert.equal(never.check, false);
  const logged = (await header({ lastCheckLog: logEntry() })).text;
  for (const part of [/rust-v0\.162\.1 → rust-v0\.163\.0/, /发布说明 \+3/, /仓库文件 \+2/, /桌面端 \+0/, /RSS \+1/, /没有错误/]) assert.match(logged, part);
  assert.doesNotMatch(logged, /由另一个 DSH 进程执行/);
  const elsewhere = (await header({ lastCheckLog: logEntry({ pid: 777, errors: ['rss: HTTP 500'] }) })).text;
  assert.match(elsewhere, /由另一个 DSH 进程执行/);
  assert.match(elsewhere, /1 条错误/);
  assert.match((await header({ lastCheck: checkResult(), lastCheckAt: AT(7) })).text, /rust-v0\.161\.0 → rust-v0\.162\.0/);
  assert.match((await header({ lastCheckLog: logEntry({ window: null }) })).text, /没有新的正式版/);
  const locked = await header({ lock: { pid: 777, kind: 'check', startedAt: AT(8) } });
  assert.match(locked.text, /另一个 DSH 进程正在检查（pid 777）/);
  assert.equal(locked.check, true);
  assert.match((await header({ lock: { pid: 778, kind: 'research', startedAt: AT(8) } })).text, /另一个 DSH 进程正在调研（pid 778）/);
  assert.match((await header({ researchNotice: '今天的报告额度用完，还有 2 条明天继续' })).text, /今天的报告额度用完，还有 2 条明天继续/);
});

test('the Host busy state holds the check button and the busy rows; notice, counts and omitted candidates show', async () => {
  const host = fakeHost([candidate(1), candidate(2), candidate(3, { classification: classified('fix', 'low') })], {
    busy: { check: true, candidates: { [ID(2)]: 'report' } }, notice: '设置文件读不了，用的是默认设置', totalCandidates: 808, omittedCandidates: 5,
  });
  const renderer = await mount({ call: host.call });
  try {
    const { root } = renderer;
    assert.equal(buttons(root, '检查中…')[0]?.props.disabled, true);
    assert.deepEqual(looks(rowOf(root, '候选 2')), []);
    assert.match(textOf(rowOf(root, '候选 2')), /正在写报告/);
    assert.equal(buttons(rowOf(root, '候选 1'), '开始调研')[0]?.props.disabled, false);
    const page = textOf(root);
    assert.match(page, /设置文件读不了，用的是默认设置/);
    assert.match(page, /另有 5 条较旧的动态未列出/);
    assert.deepEqual(views(root), ['待办2:true', '相关度低1:false', '已忽略0:false']);
  } finally { renderer.unmount(); }
});

test('the index line tells what to do next', async () => {
  const unset = await mount({ call: fakeHost([]).call });
  try { assert.match(textOf(unset.root), /还没有建，先在设置里填 DSH 镜像路径/); } finally { unset.unmount(); }
  const host = fakeHost([]);
  host.settings = { ...host.settings, dshMirrorPath: '/Users/x/deepseek-harness' };
  const set = await mount({ call: host.call });
  try {
    assert.match(textOf(set.root), /还没有建，点「重建索引」/);
    assert.doesNotMatch(textOf(set.root), /先在设置里填/);
  } finally { set.unmount(); }
});

const catalog: ModelCatalog = [
  { provider: 'deepseek-official', providerName: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] },
  { provider: 'openrouter', providerName: 'OpenRouter', models: [{ id: 'anthropic/claude-x', name: '' }] },
  { provider: 'broken', providerName: 'Broken', models: [] },
];

test('model choices: a group per provider that lists models, values provider/model, a route that is not listed added at the end', () => {
  const choices = modelChoices(catalog, ['deepseek-official/deepseek-flash']);
  assert.deepEqual(choices.groups.map(group => [group.label, group.options.map(option => `${option.value}=${option.label}`)]), [
    ['DeepSeek', ['deepseek-official/deepseek-flash=DeepSeek Flash', 'deepseek-official/deepseek-v4-pro=DeepSeek V4 Pro']],
    ['OpenRouter', ['openrouter/anthropic/claude-x=anthropic/claude-x']],
  ]);
  assert.deepEqual(choices.missing, []);
  assert.deepEqual(modelChoices(catalog, ['deepseek-official/deepseek-old', 'deepseek-official/deepseek-old']).missing,
    [{ value: 'deepseek-official/deepseek-old', label: 'deepseek-official/deepseek-old（不在列表里）' }]);
  assert.deepEqual(routeOf('openrouter/anthropic/claude-x'), { provider: 'openrouter', model: 'anthropic/claude-x' }, 'split at the first /');
  assert.deepEqual(routeOf(' deepseek-official / deepseek-flash '), { provider: 'deepseek-official', model: 'deepseek-flash' });
  assert.deepEqual(routeOf('no-slash'), { provider: 'no-slash', model: '' });
});

test('the settings patch holds only the changed keys, a model route whole, numbers as numbers, 自动调研 only when it changed', () => {
  const current: Settings = {
    ...DEFAULT_SETTINGS, classifyModel: { ...DEFAULT_SETTINGS.classifyModel }, reportModel: { ...DEFAULT_SETTINGS.reportModel },
    startModel: { ...DEFAULT_SETTINGS.startModel },
  };
  assert.deepEqual(settingsPatch(current, draftOf(current)), {});
  assert.equal(draftOf(current).classifyModel, 'deepseek-official/deepseek-flash');
  const draft = { ...draftOf(current), dshMirrorPath: ' /Users/x/deepseek-harness ', classifyModel: 'deepseek-official/deepseek-pro', dailyReportLimit: '3' };
  assert.deepEqual(settingsPatch(current, draft), {
    dshMirrorPath: '/Users/x/deepseek-harness', classifyModel: { provider: 'deepseek-official', model: 'deepseek-pro' }, dailyReportLimit: 3,
  });
  assert.deepEqual(settingsPatch(current, { ...draftOf(current), startModel: 'openrouter/anthropic/claude-x' }),
    { startModel: { provider: 'openrouter', model: 'anthropic/claude-x' } });
  assert.deepEqual(settingsPatch(current, { ...draftOf(current), autoResearch: 'off' }), { autoResearch: 'off' });
  const medium = { ...current, autoResearch: 'medium' as const };
  assert.deepEqual(settingsPatch(medium, draftOf(medium)), {});
  // The previous Host, which the page can still be talking to right after a reinstall, has no such setting.
  const { autoResearch: _none, ...older } = current;
  assert.equal(draftOf(older as Settings).autoResearch, DEFAULT_SETTINGS.autoResearch, 'a Host without the setting shows its default');
  assert.deepEqual(settingsPatch(older as Settings, draftOf(older as Settings)), {}, 'and is not sent the field it does not know');
});

test('the settings open from the header icon and read the model list; a model is picked by provider and saved as a route; 返回 goes back', async () => {
  const host = fakeHost([candidate(1)]);
  host.models = catalog;
  host.settings = { ...host.settings, reportModel: { provider: 'deepseek-official', model: 'deepseek-old' } };
  const renderer = await mount({ call: host.call });
  try {
    const { root } = renderer;
    assert.equal(labelled(root, '设置')[0]?.props['aria-pressed'], false);
    await click(labelled(root, '设置')[0]);
    assert.deepEqual(host.requests.at(-1), { action: 'models' });
    assert.equal(labelled(root, '设置')[0]?.props['aria-pressed'], true);
    const select = (name: string) => root.findAll(node => node.type === 'select' && node.props.name === name)[0]!;
    assert.deepEqual(select('classifyModel').findAllByType('optgroup').map(group => group.props.label), ['DeepSeek', 'OpenRouter']);
    assert.equal(select('classifyModel').props.value, 'deepseek-official/deepseek-flash');
    assert.equal(select('reportModel').props.value, 'deepseek-official/deepseek-old');
    assert.equal(select('reportModel').findAllByType('option').map(option => `${option.props.value}=${textOf(option)}`).at(-1),
      'deepseek-official/deepseek-old=deepseek-official/deepseek-old（不在列表里）');
    await type(root, 'reportModel', 'openrouter/anthropic/claude-x');
    await submit(root);
    assert.deepEqual(host.requests.at(-1), { action: 'settings', patch: { reportModel: { provider: 'openrouter', model: 'anthropic/claude-x' } } });
    const [save] = buttons(root, '保存');
    assert.deepEqual([save?.props['data-variant'], save?.props['data-size'], save?.props.type], ['outline', 'sm', 'submit']);
    await click(buttons(root, '返回')[0]);
    assert.equal(rows(root).length, 1);
  } finally { renderer.unmount(); }
});

test('without a model list the model fields are provider/model text boxes, and the page says why', async () => {
  const host = fakeHost([]);
  host.failures.models = '未知的 OpenCodex 操作："models"';
  const renderer = await mount({ call: host.call });
  try {
    await click(labelled(renderer.root, '设置')[0]);
    assert.equal(renderer.root.findAll(node => node.type === 'select' && node.props.name === 'startModel').length, 0);
    assert.equal(valueOf(renderer.root, 'startModel'), 'deepseek-official/deepseek-v4-pro');
    assert.match(textOf(renderer.root), /模型列表没取到：未知的 OpenCodex 操作："models"/);
    await type(renderer.root, 'startModel', 'deepseek-official/deepseek-flash');
    await submit(renderer.root);
    assert.deepEqual(host.requests.at(-1), { action: 'settings', patch: { startModel: { provider: 'deepseek-official', model: 'deepseek-flash' } } });
  } finally { renderer.unmount(); }
  const empty = fakeHost([], { notice: 'Broken 的模型列表没取到：NO_ADAPTER' });
  empty.models = [{ provider: 'broken', providerName: 'Broken', models: [] }];
  const blank = await mount({ call: empty.call });
  try {
    await click(labelled(blank.root, '设置')[0]);
    assert.equal(blank.root.findAll(node => node.type === 'select' && node.props.name === 'startModel').length, 0);
    assert.match(textOf(blank.root), /DSH 没有列出可选的模型/);
    assert.match(textOf(blank.root), /Broken 的模型列表没取到：NO_ADAPTER/);
  } finally { blank.unmount(); }
});

test('自动调研 offers 关, 相关度高 and 相关度中及以上, and goes to the Host only when it changes', async () => {
  const host = fakeHost([]);
  host.models = catalog;
  const renderer = await mount({ call: host.call });
  try {
    await click(labelled(renderer.root, '设置')[0]);
    const [select] = renderer.root.findAll(node => node.type === 'select' && node.props.name === 'autoResearch');
    assert.deepEqual(select!.findAllByType('option').map(option => `${option.props.value}=${textOf(option)}`), ['off=关', 'high=相关度高', 'medium=相关度中及以上']);
    assert.equal(select!.props.value, 'high');
    await type(renderer.root, 'dshMirrorPath', '/Users/x/deepseek-harness');
    await submit(renderer.root);
    assert.deepEqual(host.requests.at(-1), { action: 'settings', patch: { dshMirrorPath: '/Users/x/deepseek-harness' } });
    await type(renderer.root, 'autoResearch', 'medium');
    await submit(renderer.root);
    assert.deepEqual(host.requests.at(-1), { action: 'settings', patch: { autoResearch: 'medium' } });
  } finally { renderer.unmount(); }
});

test('saving settings sends only what changed; a Host error shows inline until the next edit', async () => {
  const host = fakeHost([]);
  const renderer = await mount({ call: host.call });
  try {
    await click(labelled(renderer.root, '设置')[0]);
    host.failures.settings = 'DSH 镜像路径要写绝对路径';
    await type(renderer.root, 'dshMirrorPath', 'relative/path');
    await submit(renderer.root);
    assert.deepEqual(host.requests.find(request => request.action === 'settings'), { action: 'settings', patch: { dshMirrorPath: 'relative/path' } });
    assert.match(textOf(renderer.root.findAllByType('form')[0]!), /DSH 镜像路径要写绝对路径/);
    delete host.failures.settings;
    await type(renderer.root, 'dshMirrorPath', '/Users/x/deepseek-harness');
    assert.doesNotMatch(textOf(renderer.root.findAllByType('form')[0]!), /DSH 镜像路径要写绝对路径/);
    await submit(renderer.root);
    assert.deepEqual(host.requests.at(-1), { action: 'settings', patch: { dshMirrorPath: '/Users/x/deepseek-harness' } });
  } finally { renderer.unmount(); }
});

test('a refresh brings in settings changed elsewhere without wiping a field being edited', async () => {
  const host = fakeHost([]);
  host.models = catalog;
  const renderer = await mount({ call: host.call });
  try {
    await click(labelled(renderer.root, '设置')[0]);
    await type(renderer.root, 'dshMirrorPath', '/Users/x/typing');
    host.settings = { ...host.settings, dailyReportLimit: 3, classifyModel: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } };
    await click(buttons(renderer.root, '重建索引')[0]);
    assert.equal(valueOf(renderer.root, 'dshMirrorPath'), '/Users/x/typing');
    assert.equal(valueOf(renderer.root, 'dailyReportLimit'), '3');
    assert.equal(valueOf(renderer.root, 'classifyModel'), 'deepseek-official/deepseek-v4-pro');
  } finally { renderer.unmount(); }
});
