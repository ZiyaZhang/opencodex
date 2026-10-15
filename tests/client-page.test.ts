import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Candidate, Classification } from '../src/core/candidate.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings.ts';
import type { OpenCodexRequest, OpenCodexResponse } from '../src/host/remote.ts';
import {
  DEFAULT_FILTERS, OpenCodexPage, ReportView, checksSummary, draftOf, mergeLabel, settingsPatch, visibleCandidates,
} from '../src/client/page.tsx';
import { Markdown, PURIFY_CONFIG, hiddenCharacters, renderMarkdown, revealHidden } from '../src/client/markdown.tsx';

// React 18 only flushes effects and state updates inside act() when the environment says it is a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = (hour: number) => `2026-10-15T${String(hour).padStart(2, '0')}:00:00.000Z`;
const classified = (category: Classification['category'], relevance: Classification['relevance'], extra: Partial<Classification> = {}): Classification =>
  ({ category, relevance, rationale: 'r', ...extra });
const candidate = (n: number, fields: Partial<Candidate> = {}): Candidate => ({
  id: ID(n), fingerprint: `codex-release:pr:${n}`, source: 'codex-release', title: `候选 ${n}`, summary: '',
  status: 'new', createdAt: AT(n), updatedAt: AT(n), evidence: [], ...fields,
});
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

test('default filters hide ignored and low-relevance candidates, keep unclassified ones, newest change first', () => {
  const list = [
    candidate(1, { classification: classified('cli-core', 'high') }),
    candidate(2, { classification: classified('desktop', 'low') }),
    candidate(3, { status: 'ignored', classification: classified('cli-core', 'high') }),
    candidate(4),
    candidate(5, { status: 'reported', classification: classified('cloud', 'medium'), updatedAt: AT(0) }),
  ];
  assert.deepEqual(ids(visibleCandidates(list, DEFAULT_FILTERS)), [ID(4), ID(1), ID(5)]);
  const all = { source: 'all', category: 'all', relevance: 'all', status: 'all' } as const;
  assert.deepEqual(ids(visibleCandidates(list, all)), [ID(4), ID(3), ID(2), ID(1), ID(5)]);
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
  const record = (dshRefsTotal: number, dshRefsResolved: number) =>
    ({ path: `reports/${ID(1)}/report.md`, generatedAt: AT(3), checks: { requiredSections: true, dshRefsTotal, dshRefsResolved } });
  const unresolved = textOf(render(createElement(ReportView, { record: record(5, 3), report: { id: ID(1), markdown: '# 报告' } })).root);
  assert.match(unresolved, /有 2 处引用未在镜像里找到/);
  assert.match(unresolved, /3\/5/);
  assert.match(textOf(render(createElement(ReportView, { record: record(0, 0), report: { id: ID(1), markdown: '# 报告' } })).root), /没有引用/);
  assert.match(textOf(render(createElement(ReportView, { record: record(1, 1), report: { id: ID(1), markdown: '', notice: '报告文件不存在，请重新生成' } })).root), /报告文件不存在，请重新生成/);
  assert.match(textOf(render(createElement(ReportView, { record: record(1, 1), error: 'EACCES' })).root), /EACCES/);
});

test('the sanitizer config keeps Markdown elements only and drops attributes that hide text', () => {
  for (const attribute of ['style', 'hidden']) assert.ok(PURIFY_CONFIG.FORBID_ATTR?.includes(attribute), attribute);
  for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input']) assert.ok(PURIFY_CONFIG.FORBID_TAGS?.includes(tag), tag);
  for (const attribute of ['class', 'style', 'hidden', 'title', 'id', 'color']) assert.ok(!PURIFY_CONFIG.ALLOWED_ATTR?.includes(attribute), attribute);
  for (const tag of ['div', 'span', 'details', 'img', 'font', 'select', 'template']) assert.ok(!PURIFY_CONFIG.ALLOWED_TAGS?.includes(tag), tag);
  assert.equal(PURIFY_CONFIG.ALLOW_DATA_ATTR, false);
  assert.equal(PURIFY_CONFIG.ALLOW_ARIA_ATTR, false);
});

test('Markdown output reaches the sanitizer with that config, and code blocks and task boxes need no attribute', () => {
  const seen: { html: string; config: unknown }[] = [];
  const purifier = {
    removed: [] as unknown[],
    sanitize(html: string, config: unknown) { seen.push({ html, config }); this.removed = [{}, {}]; return '<p>clean</p>'; },
  };
  const text = ['```ts', 'const a = 1;', '```', '', '- [x] 做完', '- [ ] 没做', '', '<span hidden>藏起来</span>'].join('\n');
  assert.deepEqual(renderMarkdown(text, purifier), { html: '<p>clean</p>', removed: 2 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.config, PURIFY_CONFIG);
  assert.match(seen[0]!.html, /<pre><code>const a = 1;\n<\/code><\/pre>/);
  assert.doesNotMatch(seen[0]!.html, /class=|<input/);
  assert.match(seen[0]!.html, /☑ 做完/);
  assert.match(seen[0]!.html, /☐ 没做/);
  assert.match(seen[0]!.html, /<span hidden>藏起来<\/span>/, 'raw HTML is left to the sanitizer');
});

test('without a DOM the report shows as plain text, never as unsanitized HTML', () => {
  assert.equal(renderMarkdown('<b hidden>x</b>'), undefined);
  const renderer = render(createElement(Markdown, { text: '<b hidden>藏</b><script>alert(1)</script>' }));
  assert.equal(renderer.root.findAll(node => node.props.dangerouslySetInnerHTML !== undefined).length, 0);
  const [pre] = renderer.root.findAllByType('pre');
  assert.ok(pre);
  assert.equal(textOf(pre), '<b hidden>藏</b><script>alert(1)</script>');
});

test('invisible characters are counted and spelled out in the raw view', () => {
  const zwsp = String.fromCodePoint(0x200b), tag = String.fromCodePoint(0xe0041), rlo = String.fromCodePoint(0x202e);
  const text = `看${zwsp}得见${tag}${rlo}`;
  assert.equal(hiddenCharacters(text), 3);
  assert.equal(revealHidden(text), '看⟦U+200B⟧得见⟦U+E0041⟧⟦U+202E⟧');
  assert.equal(hiddenCharacters('普通文字 plain text'), 0);
});

test('the settings patch holds only the changed keys, a model route whole, numbers as numbers', () => {
  const current: Settings = { ...DEFAULT_SETTINGS, classifyModel: { ...DEFAULT_SETTINGS.classifyModel }, reportModel: { ...DEFAULT_SETTINGS.reportModel } };
  assert.deepEqual(settingsPatch(current, draftOf(current)), {});
  const draft = { ...draftOf(current), dshMirrorPath: ' /Users/x/deepseek-harness ', classifyModel: 'deepseek-pro', dailyReportLimit: '3' };
  assert.deepEqual(settingsPatch(current, draft), {
    dshMirrorPath: '/Users/x/deepseek-harness',
    classifyModel: { provider: current.classifyModel.provider, model: 'deepseek-pro' },
    dailyReportLimit: 3,
  });
});

/**
 * A Host stand-in: answers every action with the snapshot it holds plus `extra`, `start` with a session id, `candidate` with the record in
 * `whole` (else the listed one), and records the requests.
 */
function fakeHost(candidates: Candidate[], extra: Record<string, unknown> = {}, whole: Record<string, Candidate> = {}) {
  const requests: OpenCodexRequest[] = [];
  const snapshot = () => ({ settings: DEFAULT_SETTINGS, candidates, checkpoints: {}, ...extra }) as OpenCodexResponse;
  const call = async (request: OpenCodexRequest): Promise<OpenCodexResponse> => {
    requests.push(request);
    if (request.action === 'start') return { ...snapshot(), startedSessionId: 'session-1' };
    if (request.action === 'candidate') return { ...snapshot(), candidate: whole[request.id] ?? candidates.find(item => item.id === request.id) };
    return snapshot();
  };
  return { requests, call };
}
async function mount(props: Parameters<typeof OpenCodexPage>[0]): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => { renderer = TestRenderer.create(createElement(OpenCodexPage, props)); });
  return renderer;
}
const buttons = (root: ReactTestInstance, label: string) => root.findAll(node => node.type === 'button' && textOf(node) === label);
async function click(button: ReactTestInstance | undefined): Promise<void> {
  assert.ok(button, 'button not found');
  await TestRenderer.act(async () => { await button.props.onClick(); });
}

test('row buttons follow the allowed status moves', async () => {
  const host = fakeHost([candidate(1), candidate(2, { status: 'reported', report: { path: `reports/${ID(2)}/report.md`, generatedAt: AT(2), checks: { requiredSections: true, dshRefsTotal: 1, dshRefsResolved: 1 } } })]);
  const renderer = await mount({ call: host.call });
  try {
    const rows = renderer.root.findAll(node => node.type === 'article');
    assert.equal(rows.length, 2);
    const [reported, fresh] = rows as [ReactTestInstance, ReactTestInstance];
    assert.equal(buttons(fresh, '生成报告')[0]?.props.disabled, false);
    assert.equal(buttons(fresh, '开工')[0]?.props.disabled, true);
    assert.equal(buttons(fresh, '忽略')[0]?.props.disabled, false);
    assert.equal(buttons(reported, '查看报告')[0]?.props.disabled, false);
    assert.equal(buttons(reported, '开工')[0]?.props.disabled, false);
    await click(buttons(fresh, '忽略')[0]);
    assert.deepEqual(host.requests.at(-1), { action: 'ignore', id: ID(1) });
  } finally { renderer.unmount(); }
});

test('开工 switches to the session the Host opened', async () => {
  const opened: string[] = [];
  const host = fakeHost([candidate(1, { status: 'reported', report: { path: `reports/${ID(1)}/report.md`, generatedAt: AT(2), checks: { requiredSections: true, dshRefsTotal: 1, dshRefsResolved: 1 } } })]);
  const renderer = await mount({ call: host.call, openSession: id => { opened.push(id); } });
  try {
    await click(buttons(renderer.root, '开工')[0]);
    assert.deepEqual(host.requests.at(-1), { action: 'start', id: ID(1) });
    assert.deepEqual(opened, ['session-1']);
  } finally { renderer.unmount(); }
});

test('an action error shows next to its row as plain text', async () => {
  const host = fakeHost([candidate(1)]);
  const failing = async (request: OpenCodexRequest) => {
    if (request.action === 'report') throw new Error('<b>今天已达上限</b>');
    return host.call(request);
  };
  const renderer = await mount({ call: failing });
  try {
    await click(buttons(renderer.root, '生成报告')[0]);
    const [row] = renderer.root.findAll(node => node.type === 'article');
    assert.ok(row);
    assert.match(textOf(row), /<b>今天已达上限<\/b>/);
  } finally { renderer.unmount(); }
});

test('saving settings sends only what changed', async () => {
  const host = fakeHost([]);
  const renderer = await mount({ call: host.call });
  try {
    await click(buttons(renderer.root, '设置')[0]);
    const [input] = renderer.root.findAll(node => node.type === 'input' && node.props.name === 'dshMirrorPath');
    assert.ok(input);
    await TestRenderer.act(async () => { input.props.onChange({ target: { value: '/Users/x/deepseek-harness' } }); });
    const [form] = renderer.root.findAllByType('form');
    assert.ok(form);
    await TestRenderer.act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
    assert.deepEqual(host.requests.at(-1), { action: 'settings', patch: { dshMirrorPath: '/Users/x/deepseek-harness' } });
  } finally { renderer.unmount(); }
});

test('the Host busy state holds the check button and the busy rows, notice and omitted candidates show', async () => {
  const host = fakeHost([candidate(1), candidate(2)], {
    busy: { check: true, candidates: { [ID(2)]: 'report' } }, notice: '设置文件读不了，用的是默认设置', totalCandidates: 805, omittedCandidates: 5,
  });
  const renderer = await mount({ call: host.call });
  try {
    const [check] = buttons(renderer.root, '检查中…');
    assert.equal(check?.props.disabled, true);
    const [busyRow, idleRow] = renderer.root.findAll(node => node.type === 'article') as [ReactTestInstance, ReactTestInstance];
    assert.match(textOf(busyRow), /生成中/);
    assert.ok(busyRow.findAll(node => node.type === 'button' && textOf(node) !== '候选 2').every(node => node.props.disabled === true));
    assert.equal(buttons(idleRow, '生成报告')[0]?.props.disabled, false);
    const page = textOf(renderer.root);
    assert.match(page, /设置文件读不了，用的是默认设置/);
    assert.match(page, /另有 5 条较旧的候选未列出/);
  } finally { renderer.unmount(); }
});

test('the detail shows the whole summary and rationale the list clips', async () => {
  const listed = candidate(1, { summary: '摘要前 300 字', classification: classified('cli-core', 'high', { rationale: '理由前 120 字' }) });
  const whole = { ...listed, summary: '摘要前 300 字，后面还有', classification: { ...listed.classification!, rationale: '理由前 120 字，后面还有' } };
  const host = fakeHost([listed], {}, { [ID(1)]: whole });
  const renderer = await mount({ call: host.call });
  try {
    await click(buttons(renderer.root, '候选 1')[0]);
    assert.deepEqual(host.requests.at(-1), { action: 'candidate', id: ID(1) });
    const page = textOf(renderer.root);
    assert.match(page, /摘要前 300 字，后面还有/);
    assert.match(page, /理由前 120 字，后面还有/);
  } finally { renderer.unmount(); }
});
