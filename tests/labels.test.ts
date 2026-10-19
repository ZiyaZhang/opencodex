import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate, Classification, Evidence } from '../src/core/candidate.ts';
import {
  PHASE_TAGS, clipLine, countViews, gistOf, groupCandidates, headlineOf, mergeLabel, phaseOf, referenceOf, tagOf, versionOf, viewOf,
} from '../src/client/labels.ts';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = (hour: number) => `2026-10-15T${String(hour).padStart(2, '0')}:00:00.000Z`;
const classified = (relevance: Classification['relevance'], extra: Partial<Classification> = {}): Classification =>
  ({ category: 'cli-core', relevance, rationale: 'r', ...extra });
const candidate = (n: number, fields: Partial<Candidate> = {}): Candidate => ({
  id: ID(n), fingerprint: `codex-release:pr:${n}`, source: 'codex-release', title: `候选 ${n}`, summary: '',
  status: 'new', createdAt: AT(n), updatedAt: AT(n), evidence: [], ...fields,
});
const release = (n: number, toTag: string, fields: Partial<Candidate> = {}) => candidate(n, { window: { fromTag: 'rust-v0.160.0', toTag }, ...fields });
const ids = (list: readonly Candidate[]) => list.map(item => item.id);
const pr = (ref: string): Evidence => ({ kind: 'pr', ref });

test('release and file candidates of one minor version form one group, titled with its highest version', () => {
  const groups = groupCandidates([
    release(1, 'rust-v0.162.0'),
    release(2, 'rust-v0.162.1', { source: 'codex-files' }),
    release(3, 'rust-v0.163.0'),
    candidate(4, { source: 'desktop', window: { version: '26.415.1' } }),
    candidate(5, { source: 'rss' }),
    candidate(6, { source: 'rss' }),
  ]);
  assert.deepEqual(groups.map(group => group.title), ['官方公告', 'Codex 桌面端 26.415.1', 'Codex 0.163.0', 'Codex 0.162.1']);
  assert.deepEqual(groups.map(group => ids(group.items)), [[ID(6), ID(5)], [ID(4)], [ID(3)], [ID(2), ID(1)]]);
  assert.equal(groups[0]!.latest, AT(6), 'a group carries its latest discovery');
});

test('groups are ordered by their latest discovery, versions compared as numbers', () => {
  const groups = groupCandidates([
    release(1, 'rust-v0.9.3'), release(2, 'rust-v0.10.0'), release(3, 'v0.162.9'), release(4, 'rust-v0.162.10'),
    candidate(5, { source: 'desktop', window: { version: '26.415.1' } }), candidate(6, { source: 'desktop', window: { version: '26.416.2' } }),
  ]);
  assert.deepEqual(groups.map(group => group.title), ['Codex 桌面端 26.416.2', 'Codex 桌面端 26.415.1', 'Codex 0.162.10', 'Codex 0.10.0', 'Codex 0.9.3']);
  const tied = groupCandidates([release(1, 'rust-v0.162.0', { createdAt: AT(5) }), release(2, 'rust-v0.163.0', { createdAt: AT(5) })]);
  assert.deepEqual(tied.map(group => group.title), ['Codex 0.163.0', 'Codex 0.162.0'], 'a tie puts the later version first');
});

test('a candidate without a version still gets a group', () => {
  const groups = groupCandidates([candidate(1), candidate(2, { source: 'desktop' }), release(3, 'nightly')]);
  assert.deepEqual(groups.map(group => group.title), ['Codex（版本不明）', 'Codex 桌面端']);
  assert.deepEqual(ids(groups[0]!.items), [ID(3), ID(1)]);
});

test('within a group: status (new, reported, started), then relevance (high, medium, low, unclassified), then the latest change', () => {
  const [group] = groupCandidates([
    release(1, 'rust-v0.163.0', { status: 'started', classification: classified('high') }),
    release(2, 'rust-v0.163.0', { status: 'reported', classification: classified('low') }),
    release(3, 'rust-v0.163.0', { status: 'reported', classification: classified('high') }),
    release(4, 'rust-v0.163.0', { classification: classified('low') }),
    release(5, 'rust-v0.163.0'),
    release(6, 'rust-v0.163.0', { classification: classified('medium') }),
    release(7, 'rust-v0.163.0', { classification: classified('high'), updatedAt: AT(1) }),
    release(8, 'rust-v0.163.0', { classification: classified('high'), updatedAt: AT(2) }),
  ]);
  assert.deepEqual(ids(group!.items), [ID(8), ID(7), ID(6), ID(4), ID(5), ID(3), ID(2), ID(1)]);
});

test('views: 待办 holds new candidates that are not low and every reported and started one', () => {
  const list = [
    candidate(1, { classification: classified('high') }),
    candidate(2, { classification: classified('low') }),
    candidate(3),
    candidate(4, { status: 'reported', classification: classified('low') }),
    candidate(5, { status: 'started' }),
    candidate(6, { status: 'ignored', classification: classified('low') }),
  ];
  assert.deepEqual(list.map(viewOf), ['todo', 'low', 'todo', 'todo', 'todo', 'ignored']);
  assert.deepEqual(countViews(list), { todo: 4, low: 1, ignored: 1 });
});

test('the phase tags: a running report, then a queued new candidate, then the status', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(PHASE_TAGS).map(([phase, tag]) => [phase, `${tag.label}/${tag.tone}`])), {
    new: '新发现/outline', queued: '排队中/quiet', researching: '调研中/info', reported: '已调研/success', started: '执行中/warning', ignored: '已忽略/quiet',
  });
  assert.equal(phaseOf('new', { queued: true, researching: false }), 'queued');
  assert.equal(phaseOf('new', { queued: true, researching: true }), 'researching');
  assert.equal(phaseOf('reported', { queued: false, researching: true }), 'researching', 'a report written again');
  assert.equal(phaseOf('reported', { queued: true, researching: false }), 'reported', 'the queue skips what is no longer new');
  assert.equal(phaseOf('ignored', { queued: false, researching: false }), 'ignored');
  assert.deepEqual(tagOf('archived'), { label: 'archived', tone: 'neutral' }, 'a status this page does not know is shown as it is');
});

test('the title is the feature the classification names, the second line what Codex does', () => {
  const named = candidate(1, { title: 'Add JS helpers', summary: 'Add JS helpers', classification: classified('high', { headline: '流式 JS 助手', gist: '提供流式 JS 辅助函数' }) });
  assert.equal(headlineOf(named), '流式 JS 助手');
  assert.equal(gistOf(named), '提供流式 JS 辅助函数');
  const blank = candidate(2, { title: 'Pin tasks', summary: '在命令中心\n固定任务', classification: classified('low', { headline: ' ', gist: '' }) });
  assert.equal(headlineOf(blank), 'Pin tasks', 'an empty headline counts as none');
  assert.equal(gistOf(blank), '在命令中心 固定任务', 'the summary, on one line');
  assert.equal(gistOf(candidate(3, { title: 'Same  text', summary: 'Same text' })), '', 'a summary that only repeats the title is left out');
  const long = gistOf(candidate(4, { summary: '字'.repeat(130) }));
  assert.equal(Array.from(long).length, 120);
  assert.ok(long.endsWith('…'));
  assert.equal(clipLine('a\nb  c', 60), 'a b c');
  assert.equal(clipLine(`${'错'.repeat(70)}`, 60), `${'错'.repeat(59)}…`);
});

test('the reference: pull requests, file names, desktop chunk and key counts, 公告', () => {
  assert.equal(referenceOf(candidate(1, { evidence: [pr('#12'), pr('#15'), { kind: 'file', ref: 'a.rs' }, pr('#12')] })), '#12、#15');
  assert.equal(referenceOf(candidate(2, { evidence: [pr('#1'), pr('#2'), pr('#3'), pr('#4'), pr('#5')] })), '#1、#2、#3 等 5 个 PR');
  assert.equal(referenceOf(candidate(3, { source: 'codex-files', evidence: [
    { kind: 'feature-flag', ref: 'codex-rs/features/src/lib.rs' }, { kind: 'feature-flag', ref: 'codex-rs/features/src/feature_configs.rs' },
  ] })), 'lib.rs、feature_configs.rs');
  assert.equal(referenceOf(candidate(4, { source: 'codex-files', evidence: ['a/mod.rs', 'b/mod.rs', 'c.rs', 'd.rs', 'e.rs'].map(ref => ({ kind: 'schema' as const, ref })) })),
    'mod.rs、c.rs、d.rs 等 5 个文件');
  assert.equal(referenceOf(candidate(5, { source: 'codex-files', evidence: [{ kind: 'schema', ref: 'a/mod.rs' }, { kind: 'schema', ref: 'b/mod.rs' }] })), 'mod.rs 等 2 个文件');
  assert.equal(referenceOf(candidate(6, { source: 'desktop', evidence: [{ kind: 'chunk', ref: 'assets/x' }] })), 'chunk 1');
  assert.equal(referenceOf(candidate(7, { source: 'desktop', evidence: ['a', 'b', 'c'].map(ref => ({ kind: 'i18n' as const, ref })) })), 'key 3');
  assert.equal(referenceOf(candidate(8, { source: 'desktop', evidence: [{ kind: 'chunk', ref: 'x' }, { kind: 'i18n', ref: 'k' }, { kind: 'i18n', ref: 'l' }] })), 'chunk 1、key 2');
  assert.equal(referenceOf(candidate(9, { source: 'rss', evidence: [{ kind: 'rss', ref: '2026-10-15 Codex' }] })), '公告');
  assert.equal(referenceOf(candidate(10)), '', 'no evidence, no reference');
});

test('versions are read from release tags', () => {
  assert.deepEqual(versionOf('rust-v0.163.0'), { parts: [0, 163, 0], text: '0.163.0' });
  assert.deepEqual(versionOf('v0.162.1'), { parts: [0, 162, 1], text: '0.162.1' });
  assert.equal(versionOf('nightly'), undefined);
  assert.equal(versionOf(undefined), undefined);
});

test('mergedInto shows one hop: the target feature name, else its title, else its id', () => {
  const target = candidate(2, { title: '目标', classification: classified('high', { mergedInto: ID(3) }) });
  const named = candidate(3, { title: 'Third', classification: classified('high', { headline: '第三条' }) });
  assert.equal(mergeLabel(ID(2), [target, named]), '并入：目标');
  assert.equal(mergeLabel(ID(3), [target, named]), '并入：第三条');
  assert.equal(mergeLabel(ID(9), [target, named]), `并入：${ID(9)}`);
});
