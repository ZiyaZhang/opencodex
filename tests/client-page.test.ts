import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import createDOMPurify, { type WindowLike } from 'dompurify';
import type { Candidate, Classification, ReportRecord } from '../src/core/candidate.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings.ts';
import type { OpenCodexRequest, OpenCodexResponse } from '../src/host/remote.ts';
import {
  DEFAULT_FILTERS, OpenCodexPage, ReportView, checksSummary, draftOf, mergeLabel, settingsPatch, visibleCandidates,
} from '../src/client/page.tsx';
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
  status: 'new', createdAt: AT(n), updatedAt: AT(n), evidence: [], ...fields,
});
const reportRecord = (n: number, dshRefsTotal = 1, dshRefsResolved = 1): ReportRecord =>
  ({ path: `reports/${ID(n)}/report.md`, generatedAt: AT(3), checks: { requiredSections: true, dshRefsTotal, dshRefsResolved } });
const ids = (list: Candidate[]) => list.map(item => item.id);

/** All text under a rendered node, in document order. */
function textOf(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(textOf).join('');
}
function render(element: ReturnType<typeof createElement>): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  TestRenderer.act(() => { renderer = TestRenderer.create(element); });
  return renderer;
}

test('default filters hide ignored and low-relevance candidates, keep unclassified ones, latest discovered first', () => {
  const list = [
    candidate(1, { classification: classified('cli-core', 'high'), updatedAt: AT(9) }), // classified late: must not move up
    candidate(2, { classification: classified('desktop', 'low') }),
    candidate(3, { status: 'ignored', classification: classified('cli-core', 'high') }),
    candidate(4),
    candidate(5, { status: 'reported', classification: classified('cloud', 'medium'), updatedAt: AT(6) }),
  ];
  assert.deepEqual(ids(visibleCandidates(list, DEFAULT_FILTERS)), [ID(5), ID(4), ID(1)]);
  const all = { source: 'all', category: 'all', relevance: 'all', status: 'all' } as const;
  assert.deepEqual(ids(visibleCandidates(list, all)), [ID(5), ID(4), ID(3), ID(2), ID(1)]);
  assert.deepEqual(ids(list), [ID(1), ID(2), ID(3), ID(4), ID(5)], 'the input list is not reordered');
});

test('each filter narrows to its value; "none" finds the unclassified', () => {
  const list = [
    candidate(1, { source: 'desktop', classification: classified('desktop', 'medium') }),
    candidate(2, { source: 'rss', classification: classified('model', 'low') }),
    candidate(3, { source: 'codex-files', status: 'started', classification: classified('cli-core', 'high') }),
    candidate(4, { status: 'ignored' }),
  ];
  const all = { source: 'all', category: 'all', relevance: 'all', status: 'all' } as const;
  assert.deepEqual(ids(visibleCandidates(list, { ...all, source: 'desktop' })), [ID(1)]);
  assert.deepEqual(ids(visibleCandidates(list, { ...all, category: 'cli-core' })), [ID(3)]);
  assert.deepEqual(ids(visibleCandidates(list, { ...all, category: 'none' })), [ID(4)]);
  assert.deepEqual(ids(visibleCandidates(list, { ...all, relevance: 'low' })), [ID(2)]);
  assert.deepEqual(ids(visibleCandidates(list, { ...all, relevance: 'not-low' })), [ID(4), ID(3), ID(1)]);
  assert.deepEqual(ids(visibleCandidates(list, { ...all, status: 'ignored' })), [ID(4)]);
  assert.deepEqual(ids(visibleCandidates(list, { ...all, status: 'not-ignored' })), [ID(3), ID(2), ID(1)]);
  assert.deepEqual(ids(visibleCandidates(list, { ...all, source: 'rss', relevance: 'high' })), []);
});

test('mergedInto shows one hop: the target title when listed, else its id', () => {
  const target = candidate(2, { title: '目标', classification: classified('cli-core', 'high', { mergedInto: ID(3) }) });
  const third = candidate(3, { title: '第三条' });
  assert.equal(mergeLabel(ID(2), [target, third]), '并入：目标');
  assert.equal(mergeLabel(ID(9), [target, third]), `并入：${ID(9)}`);
});

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
  assert.match(textOf(render(createElement(ReportView, {})).root), /尚未生成报告/);
  const unresolved = textOf(render(createElement(ReportView, { record: reportRecord(1, 5, 3), report: { id: ID(1), markdown: '# 报告' } })).root);
  assert.match(unresolved, /有 2 处引用未在镜像里找到/);
  assert.match(unresolved, /3\/5/);
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

test('the settings patch holds only the changed keys, a model route whole, numbers as numbers', () => {
  const current: Settings = {
    ...DEFAULT_SETTINGS, classifyModel: { ...DEFAULT_SETTINGS.classifyModel }, reportModel: { ...DEFAULT_SETTINGS.reportModel },
    startModel: { ...DEFAULT_SETTINGS.startModel },
  };
  assert.deepEqual(settingsPatch(current, draftOf(current)), {});
  const draft = { ...draftOf(current), dshMirrorPath: ' /Users/x/deepseek-harness ', classifyModel: 'deepseek-pro', dailyReportLimit: '3' };
  assert.deepEqual(settingsPatch(current, draft), {
    dshMirrorPath: '/Users/x/deepseek-harness',
    classifyModel: { provider: current.classifyModel.provider, model: 'deepseek-pro' },
    dailyReportLimit: 3,
  });
  assert.deepEqual(settingsPatch(current, { ...draftOf(current), startModel: ' deepseek-flash ' }),
    { startModel: { provider: current.startModel.provider, model: 'deepseek-flash' } });
});

/**
 * A Host stand-in that records the requests: every action answers with the snapshot (`extra` laid over it), `start` with a session id,
 * `candidate` with the record in `whole` (else the listed one), `readReport` with a one-line report. `failures` makes an action throw.
 */
function fakeHost(candidates: Candidate[], extra: Partial<OpenCodexResponse> = {}, whole: Record<string, Candidate> = {}) {
  const host = {
    requests: [] as OpenCodexRequest[],
    settings: { ...DEFAULT_SETTINGS } as Settings,
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
      return snapshot;
    },
  };
  return host;
}
async function mount(props: Parameters<typeof OpenCodexPage>[0]): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => { renderer = TestRenderer.create(createElement(OpenCodexPage, props)); });
  return renderer;
}
const buttons = (root: ReactTestInstance, label: string) => root.findAll(node => node.type === 'button' && textOf(node) === label);
const rows = (root: ReactTestInstance) => root.findAll(node => node.type === 'article');
async function click(button: ReactTestInstance | undefined): Promise<void> {
  assert.ok(button, 'button not found');
  await TestRenderer.act(async () => { await button.props.onClick(); });
}
async function type(root: ReactTestInstance, name: string, value: string): Promise<void> {
  const [input] = root.findAll(node => node.type === 'input' && node.props.name === name);
  assert.ok(input, `input ${name} not found`);
  await TestRenderer.act(async () => { input.props.onChange({ target: { value } }); });
}
const valueOf = (root: ReactTestInstance, name: string) => root.findAll(node => node.type === 'input' && node.props.name === name)[0]?.props.value;
async function submit(root: ReactTestInstance): Promise<void> {
  const [form] = root.findAllByType('form');
  assert.ok(form);
  await TestRenderer.act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
}

test('row buttons follow the allowed status moves; the row shows when the candidate was discovered', async () => {
  const host = fakeHost([candidate(1), candidate(2, { status: 'reported', report: reportRecord(2) }), candidate(3, { status: 'new', report: reportRecord(3) })]);
  const renderer = await mount({ call: host.call });
  try {
    const [restored, reported, fresh] = rows(renderer.root) as [ReactTestInstance, ReactTestInstance, ReactTestInstance];
    assert.equal(buttons(fresh, '生成报告')[0]?.props.disabled, false);
    assert.equal(buttons(fresh, '开工')[0]?.props.disabled, true);
    assert.equal(buttons(fresh, '开工')[0]?.props.title, '先生成报告再开工');
    assert.equal(buttons(fresh, '忽略')[0]?.props.disabled, false);
    assert.match(textOf(fresh), /发现 /);
    assert.equal(buttons(reported, '查看报告')[0]?.props.disabled, false);
    assert.equal(buttons(reported, '开工')[0]?.props.disabled, false);
    assert.equal(buttons(restored, '开工')[0]?.props.title, '恢复的候选要先重新生成报告');
    await click(buttons(fresh, '忽略')[0]);
    assert.deepEqual(host.requests.at(-1), { action: 'ignore', id: ID(1) });
  } finally { renderer.unmount(); }
});

test('开工 switches to the session the Host opened; a switch that fails says the session exists', async () => {
  const host = fakeHost([candidate(1, { status: 'reported', report: reportRecord(1) })]);
  const opened: string[] = [];
  const renderer = await mount({ call: host.call, openSession: id => { opened.push(id); } });
  try {
    await click(buttons(renderer.root, '开工')[0]);
    assert.deepEqual(host.requests.at(-1), { action: 'start', id: ID(1) });
    assert.deepEqual(opened, ['session-1']);
  } finally { renderer.unmount(); }
  const failing = await mount({ call: host.call, openSession: () => { throw new Error('no workspace'); } });
  try {
    await click(buttons(failing.root, '开工')[0]);
    const [row] = rows(failing.root);
    assert.match(textOf(row!), /开工会话已创建（session-1），但没能自动打开/);
    assert.equal(row!.findAll(node => node.props.className === 'oc-error').length, 0);
  } finally { failing.unmount(); }
});

test('an action error shows next to its row as plain text', async () => {
  const host = fakeHost([candidate(1)]);
  host.failures.report = '<b>今天已达上限</b>';
  const renderer = await mount({ call: host.call });
  try {
    await click(buttons(renderer.root, '生成报告')[0]);
    assert.match(textOf(rows(renderer.root)[0]!), /<b>今天已达上限<\/b>/);
  } finally { renderer.unmount(); }
});

test('opening a reported candidate reads its whole record and its report', async () => {
  const listed = candidate(1, { status: 'reported', report: reportRecord(1), summary: '摘要前 300 字', classification: classified('cli-core', 'high', { rationale: '理由前 120 字' }) });
  const whole = { ...listed, summary: '摘要前 300 字，后面还有', classification: { ...listed.classification!, rationale: '理由前 120 字，后面还有' } };
  const host = fakeHost([listed], {}, { [ID(1)]: whole });
  const renderer = await mount({ call: host.call });
  try {
    await click(buttons(renderer.root, '候选 1')[0]);
    assert.deepEqual(host.requests.slice(-2), [{ action: 'candidate', id: ID(1) }, { action: 'readReport', id: ID(1) }]);
    const page = textOf(renderer.root);
    assert.match(page, /摘要前 300 字，后面还有/);
    assert.match(page, /理由前 120 字，后面还有/);
    assert.match(page, new RegExp(`报告正文 ${ID(1)}`));
  } finally { renderer.unmount(); }
});

test('saving settings sends only what changed; a Host error shows inline until the next edit', async () => {
  const host = fakeHost([]);
  const renderer = await mount({ call: host.call });
  try {
    await click(buttons(renderer.root, '设置')[0]);
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

test('the start model goes to the Host only when it changes', async () => {
  const host = fakeHost([]);
  const renderer = await mount({ call: host.call });
  try {
    await click(buttons(renderer.root, '设置')[0]);
    assert.equal(valueOf(renderer.root, 'startProvider'), DEFAULT_SETTINGS.startModel.provider);
    assert.equal(valueOf(renderer.root, 'startModel'), DEFAULT_SETTINGS.startModel.model);
    await type(renderer.root, 'dshMirrorPath', '/Users/x/deepseek-harness');
    await submit(renderer.root);
    assert.deepEqual(host.requests.at(-1), { action: 'settings', patch: { dshMirrorPath: '/Users/x/deepseek-harness' } });
    await type(renderer.root, 'startModel', 'deepseek-flash');
    await submit(renderer.root);
    assert.deepEqual(host.requests.at(-1), { action: 'settings', patch: { startModel: { provider: DEFAULT_SETTINGS.startModel.provider, model: 'deepseek-flash' } } });
  } finally { renderer.unmount(); }
});

test('a refresh brings in settings changed elsewhere without wiping a field being edited', async () => {
  const host = fakeHost([]);
  const renderer = await mount({ call: host.call });
  try {
    await click(buttons(renderer.root, '设置')[0]);
    await type(renderer.root, 'dshMirrorPath', '/Users/x/typing');
    host.settings = { ...host.settings, dailyReportLimit: 3 };
    await click(buttons(renderer.root, '重建索引')[0]);
    assert.equal(valueOf(renderer.root, 'dshMirrorPath'), '/Users/x/typing');
    assert.equal(valueOf(renderer.root, 'dailyReportLimit'), '3');
  } finally { renderer.unmount(); }
});

test('the Host busy state holds the check button and the busy rows; notice, counts and omitted candidates show', async () => {
  const host = fakeHost([candidate(1), candidate(2), candidate(3, { classification: classified('fix', 'low') })], {
    busy: { check: true, candidates: { [ID(2)]: 'report' } }, notice: '设置文件读不了，用的是默认设置', totalCandidates: 808, omittedCandidates: 5,
  });
  const renderer = await mount({ call: host.call });
  try {
    assert.equal(buttons(renderer.root, '检查中…')[0]?.props.disabled, true);
    const [busyRow, idleRow] = rows(renderer.root) as [ReactTestInstance, ReactTestInstance];
    assert.match(textOf(busyRow), /生成中/);
    assert.ok(busyRow.findAll(node => node.type === 'button' && textOf(node) !== '候选 2').every(node => node.props.disabled === true));
    assert.equal(buttons(idleRow, '生成报告')[0]?.props.disabled, false);
    const page = textOf(renderer.root);
    assert.match(page, /设置文件读不了，用的是默认设置/);
    assert.match(page, /显示 2 条，共 808 条/);
    assert.match(page, /另有 5 条较旧的候选未列出/);
    const [badge] = renderer.root.findAll(node => node.props.className === 'oc-count');
    assert.equal(textOf(badge!), '2', 'the low-relevance candidate is hidden and not counted');
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
