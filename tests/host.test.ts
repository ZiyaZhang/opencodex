import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FinishReason } from '@deepseek-ai/dsh-llm';
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import { transition, type Candidate, type Evidence } from '../src/core/candidate.ts';
import { ValidationError } from '../src/core/check.ts';
import type { CheckLogEntry } from '../src/core/run-log.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings.ts';
import { CandidateStore } from '../src/core/store.ts';
import { MAX_PAYLOAD, OPEN_CODEX_DESCRIPTOR, parseRequest, type OpenCodexResponse } from '../src/host/remote.ts';
import { FLAGS, GONE_PID, MIRROR, NOW, REPORT, classifyAll, codexGh, fakeLlm, fixture, foreignLock, offlineGh, serve, stalledGh, until, type Answer, type Fixture } from './helpers/host-fixture.ts';

const COUNTER = 'reportsOn-2026-10-15';
const MINUTE = 60_000;
const HOUR = 3_600_000;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

/** A candidate written straight to the store. */
async function seed(store: CandidateStore, key: string, fields: { source?: Candidate['source']; title?: string; evidence?: Evidence[] } = {}): Promise<Candidate> {
  const { candidate } = await store.upsert({
    source: fields.source ?? 'codex-release', key, title: fields.title ?? `Feature ${key}`, summary: `Summary of ${key}`,
    evidence: fields.evidence ?? [{ kind: 'pr', ref: '#50148', url: 'https://github.com/openai/codex/pull/50148', excerpt: 'PR 50148\n\nWhat it changes.' }],
  });
  return candidate;
}
const rssItem = (store: CandidateStore, key = 'rss-item') => seed(store, key, { source: 'rss', title: 'Codex app update', evidence: [{ kind: 'rss', ref: 'Codex app update', excerpt: 'Worktrees in the app.' }] });
/** `candidate` moved to reported with a report file on disk, as a finished report action leaves it. */
async function asReported(f: Fixture, candidate: Candidate): Promise<Candidate> {
  await mkdir(join(f.directory, 'reports', candidate.id), { recursive: true });
  await writeFile(join(f.directory, 'reports', candidate.id, 'report.md'), REPORT);
  const report = { path: `reports/${candidate.id}/report.md`, sessionId: 'analyst-0', generatedAt: NOW.toISOString(), checks: { requiredSections: true, dshRefsTotal: 1, dshRefsResolved: 1 } };
  return f.store.patch(candidate.id, current => ({ ...transition(current, 'reported', NOW.toISOString()), report }));
}
const find = (response: OpenCodexResponse, id: string) => response.candidates.find(candidate => candidate.id === id);
const exists = (path: string) => stat(path).then(() => true, () => false);
/** A matcher for a RemoteError of `code` whose message matches `message`. */
const remoteError = (code: string, message: RegExp) => (error: unknown) => {
  const remote = remoteErrorOf(error);
  assert.equal(remote?.code, code);
  assert.match(remote.message, message);
  return true;
};

test('the Host registers its Remote descriptor and a first snapshot writes the default settings', async () => {
  const f = await fixture({ settings: null });
  try {
    assert.deepEqual(f.descriptors.map(descriptor => descriptor.id), [OPEN_CODEX_DESCRIPTOR.id]);
    await f.store.setCheckpoint('lastStableTag', 'rust-v0.161.0');
    const response = await f.call({ action: 'snapshot' });
    assert.deepEqual(response.settings, DEFAULT_SETTINGS);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'settings.json'), 'utf8')), DEFAULT_SETTINGS);
    assert.deepEqual(response.checkpoints, { lastStableTag: 'rust-v0.161.0' }, 'checkpoints come from the store');
    assert.deepEqual([response.candidates, response.totalCandidates, response.omittedCandidates], [[], 0, 0]);
    assert.deepEqual(response.busy, { check: false, candidates: {} });
    assert.equal(response.hostPid, process.pid);
    for (const key of ['lastCheck', 'lastCheckAt', 'lastCheckLog', 'lock', 'indexSummary', 'notice'] as const) assert.equal(response[key], undefined, key);
  } finally { await f.close(); }
});

test('a damaged settings.json stops the plugin from starting and names the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-host-'));
  try {
    await writeFile(join(directory, 'settings.json'), '{ not json');
    await assert.rejects(fixture({ directory, settings: null }), (error: Error) => error.message.includes(join(directory, 'settings.json')));
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, dailyReportLimit: 0 }));
    await assert.rejects(fixture({ directory, settings: null }), /dailyReportLimit/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a check collects the sources, classifies the new candidates and keeps its result as lastCheck', async () => {
  // The model leaves the first candidate of the batch out: that becomes a classify line among the check errors.
  const f = await fixture({ llm: fakeLlm([ids => classifyAll(ids.slice(1))]) });
  try {
    const response = await f.call({ action: 'check' });
    const check = response.lastCheck!;
    assert.deepEqual([check.releases.added, check.files.added], [6, 1]);
    assert.ok(check.rss > 0);
    const total = 6 + 1 + check.rss;
    assert.equal(response.totalCandidates, total);
    assert.ok(response.candidates.every(candidate => candidate.status === 'new'));
    assert.equal(f.llm.requests.length, Math.ceil(total / 30));
    assert.equal(response.candidates.filter(candidate => candidate.classification).length, total - 1);
    assert.deepEqual(check.errors, [`classify: batch 1 of 1: 1 of ${total} candidates were not in the answer`]);
    assert.equal(response.lastCheckAt, NOW.toISOString());
    assert.deepEqual((await f.call({ action: 'snapshot' })).lastCheck, check, 'lastCheck stays for later snapshots');
  } finally { await f.close(); }
});

test('classification runs every batch, saves what it got and reports failed batches, missing candidates and unreadable answers', async () => {
  const llm = fakeLlm([
    () => ({ kind: 'error', failure: { code: 'RATE_LIMITED', message: 'slow down' } }),
    classifyAll,
    () => `抱歉，这批我无法归类。${'理由'.repeat(400)}`,
    ids => classifyAll(ids.slice(1)),
  ]);
  const f = await fixture({ llm });
  try {
    for (let n = 0; n < 31; n++) await seed(f.store, `pr:${50000 + n}`);
    const classified = async () => (await f.call({ action: 'snapshot' })).candidates.filter(candidate => candidate.classification).length;
    // Two batches: the first fails, the second (one candidate) is saved, and the call says what went wrong.
    await assert.rejects(f.call({ action: 'classify' }), /batch 1 of 2 failed, so its 30 candidates stay unclassified: classify: model finished with error RATE_LIMITED: slow down/);
    assert.equal(await classified(), 1);
    // The 30 left: an answer without a JSON array saves nothing and is quoted, the line cut to 300 characters.
    await assert.rejects(f.call({ action: 'classify' }), (error: Error) => {
      const line = error.message.replace(/^归类没有全部完成：/, '');
      assert.match(line, /^batch 1 of 1: the answer held no JSON array, so its 30 candidates stay unclassified; it began: 抱歉，这批我无法归类。/);
      assert.equal(Array.from(line).length, 300);
      return true;
    });
    assert.equal(await classified(), 1);
    await assert.rejects(f.call({ action: 'classify' }), /batch 1 of 1: 1 of 30 candidates were not in the answer/);
    assert.equal(await classified(), 30);
    const last = await f.call({ action: 'classify' });
    assert.equal(last.candidates.filter(candidate => candidate.classification).length, 31);
    assert.equal(llm.requests.length, 5);
    assert.deepEqual([...new Set(last.candidates.map(candidate => candidate.status))], ['new'], 'classification never moves a status');
  } finally { await f.close(); }
});

/** A model finish that broke off on the connection, as DSH's DeepSeek adapter reports it. */
const transport = (failure: Partial<{ status: number; requestId: string }> = {}): Answer =>
  () => ({ kind: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed', ...failure } }) as FinishReason;

test('a classification batch that broke off on the connection is tried again', async () => {
  const llm = fakeLlm([transport(), transport(), classifyAll]);
  const f = await fixture({ llm });
  try {
    await seed(f.store, 'pr:50148');
    // The action rejects on any problem line, so resolving means none.
    const response = await f.call({ action: 'classify' });
    assert.equal(response.candidates.filter(candidate => candidate.classification).length, 1);
    assert.equal(llm.requests.length, 3);
  } finally { await f.close(); }
});

test('a classification failure off the connection is not tried again, and one that keeps failing shows its cause', async () => {
  const llm = fakeLlm([
    () => ({ kind: 'error', failure: { code: 'RATE_LIMITED', message: 'slow down' } }),
    transport({ status: 502, requestId: 'req-7' }), transport({ status: 502, requestId: 'req-7' }), transport({ status: 502, requestId: 'req-7' }),
  ]);
  const f = await fixture({ llm });
  try {
    await seed(f.store, 'pr:50148');
    await assert.rejects(f.call({ action: 'classify' }), /batch 1 of 1 failed, so its 1 candidates stay unclassified: classify: model finished with error RATE_LIMITED: slow down$/);
    assert.equal(llm.requests.length, 1, 'a refusal is not a dropped connection');
    await assert.rejects(f.call({ action: 'classify' }),
      /batch 1 of 1 failed \(3 tries\), so its 1 candidates stay unclassified: classify: model finished with error TRANSPORT: DeepSeek Messages transport failed ← HTTP 502 ← request req-7$/);
    assert.equal(llm.requests.length, 4);
  } finally { await f.close(); }
});

test('the wait before another classification try ends at an unload', async () => {
  const llm = fakeLlm([transport()]);
  const f = await fixture({ llm, classifyRetryDelaysMs: [60_000] });
  try {
    await seed(f.store, 'pr:50148');
    const classifying = f.call({ action: 'classify' });
    await until(() => llm.requests.length === 1, 'the first try');
    const unloading = Date.now();
    await f.unload();
    await assert.rejects(classifying, { name: 'AbortError' });
    assert.ok(Date.now() - unloading < 5_000, 'the minute-long wait did not hold the unload');
  } finally { await f.close(); }
});

test('a check waiting for a running classification gives up at its own deadline, and a failed check is recorded as lastCheck', async () => {
  const f = await fixture({ llm: fakeLlm([() => 'stall']), gh: offlineGh, feed: serve('gone', 404), timeouts: { check: 100 } });
  try {
    await seed(f.store, 'pr:50148');
    const classifying = f.call({ action: 'classify' });
    await until(() => f.llm.requests.length === 1, 'the classification to start');
    await assert.rejects(f.call({ action: 'check' }), /检查超过 0 分钟还没结束，已停止/);
    const after = await f.call({ action: 'snapshot' });
    assert.match(after.lastCheck!.errors[0]!, /^check: 检查超过 0 分钟还没结束，已停止$/);
    assert.equal(after.lastCheckAt, NOW.toISOString());
    assert.equal(after.busy.check, false);
    await f.unload();
    await assert.rejects(classifying, { name: 'AbortError' });
  } finally { await f.close(); }
});

test('the list carries trimmed records, candidate(id) the whole one, and a damaged record is listed with a notice', async () => {
  const f = await fixture();
  try {
    const seeded = await seed(f.store, 'pr:50148', { evidence: [
      { kind: 'pr', ref: '#50148', url: 'https://github.com/openai/codex/pull/50148', excerpt: 'PR 50148\n\nWhat it changes.' },
      { kind: 'file', ref: 'docs/config.md', excerpt: '+ worktrees = true' },
    ] });
    const long = await f.store.patch(seeded.id, current => ({ ...current, summary: 'word '.repeat(200), classification: { category: 'cli-core', relevance: 'high', rationale: '理'.repeat(200) } }));
    const listed = find(await f.call({ action: 'snapshot' }), seeded.id)!;
    assert.deepEqual(listed.evidence, [{ kind: 'pr', ref: '#50148', url: 'https://github.com/openai/codex/pull/50148' }, { kind: 'file', ref: 'docs/config.md' }]);
    assert.ok(Array.from(listed.summary).length <= 300 && listed.summary.endsWith('…'));
    assert.equal(Array.from(listed.classification!.rationale).length, 120);
    const detail = await f.call({ action: 'candidate', id: seeded.id });
    assert.deepEqual(detail.candidate, long);
    await assert.rejects(f.call({ action: 'candidate', id: UNKNOWN_ID }), remoteError('gateway/bad-request', /Unknown candidate/));

    const broken = await seed(f.store, 'pr:51500');
    await writeFile(join(f.directory, 'candidates', `${broken.id}.json`), JSON.stringify({ ...broken, evidence: 'not a list' }));
    const response = await f.call({ action: 'snapshot' });
    assert.deepEqual(find(response, broken.id)!.evidence, []);
    assert.match(response.notice ?? '', new RegExp(`记录有损坏.*${broken.id}`));
  } finally { await f.close(); }
});

/** A candidate file as the sources write them, for the size test: realistic text in each source's shape. */
function realistic(n: number): Candidate {
  const kinds = ['rss', 'desktop', 'codex-release', 'codex-files'] as const;
  const source = kinds[n % kinds.length]!;
  const prose = (length: number) => '新增功能说明 Codex adds a feature to the TUI and the app server. '.repeat(Math.ceil(length / 60)).slice(0, length);
  const evidence: Evidence[] = source === 'rss' ? [{ kind: 'rss', ref: `Codex changelog ${n}`, url: `https://developers.openai.com/codex/changelog#${n}`, excerpt: prose(1_500) }]
    : source === 'desktop' ? Array.from({ length: 25 }, (_, k) => ({ kind: 'i18n' as const, ref: `codex.feature${n}.section.label${k}`, excerpt: prose(80) }))
    : source === 'codex-release' ? [50148, 51500, 51439].map(pr => ({ kind: 'pr' as const, ref: `#${pr}`, url: `https://github.com/openai/codex/pull/${pr}`, excerpt: prose(1_500) }))
    : [{ kind: 'feature-flag', ref: FLAGS, url: `https://github.com/openai/codex/blob/rust-v0.162.0/${FLAGS}`, excerpt: prose(2_000) }];
  const updatedAt = new Date(NOW.getTime() - n * 60_000).toISOString();
  return {
    id: randomUUID(), fingerprint: `${source}:item-${n}`, source, title: `${source} item ${n}: ${prose(80)}`, summary: prose(source === 'desktop' ? 1_000 : 600),
    status: n % 7 === 0 ? 'ignored' : n % 5 === 0 ? 'reported' : 'new', createdAt: updatedAt, updatedAt, evidence,
    window: { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.0' },
    classification: { category: 'cli-core', relevance: 'medium', rationale: prose(120) },
    ...(n % 5 === 0 && { report: { path: 'reports/x/report.md', sessionId: `analyst-${n}`, generatedAt: updatedAt, checks: { requiredSections: true, dshRefsTotal: 4, dshRefsResolved: 3 } } }),
  };
}

/** Writes candidate files straight into the data directory: thousands of upserts would each read the whole store. */
async function writeCandidates(directory: string, candidates: Candidate[]): Promise<void> {
  await mkdir(join(directory, 'candidates'), { recursive: true });
  await Promise.all(candidates.map(candidate => writeFile(join(directory, 'candidates', `${candidate.id}.json`), JSON.stringify(candidate))));
}

test('2,000 realistic candidates list 800 and the answer stays under 4 MB', async () => {
  const f = await fixture();
  try {
    const all = Array.from({ length: 2_000 }, (_, n) => realistic(n));
    const raw = all.reduce((sum, candidate) => sum + JSON.stringify(candidate).length, 0);
    assert.ok(raw > MAX_PAYLOAD, `the records themselves (${raw} characters) would not fit`);
    await writeCandidates(f.directory, all);
    const response = await f.call({ action: 'snapshot' });
    assert.deepEqual([response.candidates.length, response.totalCandidates, response.omittedCandidates], [800, 2_000, 1_200]);
    const active = all.filter(candidate => candidate.status === 'reported'), fresh = all.filter(candidate => candidate.status === 'new');
    assert.deepEqual(response.candidates.map(candidate => candidate.id), [...active, ...fresh].slice(0, 800).map(candidate => candidate.id),
      'reported first, then the newest new ones; ignored ones only when there is room');
    const { result } = OPEN_CODEX_DESCRIPTOR;
    assert.ok(result.mode === 'strict' && result.encode);
    const size = JSON.stringify(result.encode(response, () => null)).length;
    assert.ok(size < MAX_PAYLOAD, `${size} characters`);
    assert.equal(response.notice, undefined);
  } finally { await f.close(); }
});

test('the list keeps every reported and started candidate, and ignored ones go last', async () => {
  const f = await fixture();
  try {
    // The oldest are active and the newest were just ignored: a list of the newest 800 would lose every active one.
    const all = Array.from({ length: 900 }, (_, n): Candidate => ({ ...realistic(n), status: n < 100 ? 'ignored' : n >= 850 ? (n % 2 === 0 ? 'reported' : 'started') : 'new' }));
    await writeCandidates(f.directory, all);
    const response = await f.call({ action: 'snapshot' });
    const active = all.filter(candidate => candidate.status === 'reported' || candidate.status === 'started');
    const fresh = all.filter(candidate => candidate.status === 'new');
    assert.deepEqual([active.length, fresh.length], [50, 750]);
    assert.deepEqual(response.candidates.map(candidate => candidate.id), [...active, ...fresh].map(candidate => candidate.id));
    assert.deepEqual([response.totalCandidates, response.omittedCandidates], [900, 100]);
    assert.ok(response.candidates.every(candidate => candidate.status !== 'ignored'));
  } finally { await f.close(); }
});

test('a finished action is answered as finished when the list cannot be read or would pass 4 MB', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR } });
  try {
    const target = await seed(f.store, 'pr:50148');
    const reported = await asReported(f, await seed(f.store, 'pr:51500'));
    await writeFile(join(f.directory, 'candidates', `${randomUUID()}.json`), '{ damaged');
    const ignored = await f.call({ action: 'ignore', id: target.id });
    assert.deepEqual([ignored.candidates, ignored.totalCandidates], [[], 0]);
    assert.match(ignored.notice ?? '', /^候选列表没能读出来：Corrupt JSON/);
    assert.equal((await f.store.get(target.id)).status, 'ignored', 'the action itself went through');
    const started = await f.call({ action: 'start', id: reported.id });
    assert.equal(started.startedSessionId, 'cordis-1', 'the opened session is not lost');

    await rm(join(f.directory, 'candidates'), { recursive: true });
    const huge = await seed(f.store, 'huge', { evidence: [{ kind: 'file', ref: 'x'.repeat(MAX_PAYLOAD) }] });
    const read = await f.call({ action: 'readReport', id: huge.id });
    assert.deepEqual(read.report, { id: huge.id, markdown: '', notice: '这条候选还没有报告' });
    assert.deepEqual([read.candidates, read.totalCandidates, read.omittedCandidates], [[], 1, 1]);
    assert.match(read.notice ?? '', /候选列表超过 4 MB，这次没有带上/);
  } finally { await f.close(); }
});

test('ignore and restore move the status, and a restored candidate keeps its old report', async () => {
  const f = await fixture();
  try {
    const candidate = await asReported(f, await seed(f.store, 'pr:50148'));
    const ignored = find(await f.call({ action: 'ignore', id: candidate.id }), candidate.id)!;
    assert.equal(ignored.status, 'ignored');
    await assert.rejects(f.call({ action: 'ignore', id: candidate.id }), /已经忽略/);
    await assert.rejects(f.call({ action: 'report', id: candidate.id }), /已忽略/);
    await assert.rejects(f.call({ action: 'start', id: candidate.id }), /已忽略/);
    const restored = find(await f.call({ action: 'restore', id: candidate.id }), candidate.id)!;
    assert.equal(restored.status, 'new');
    assert.deepEqual(restored.report, candidate.report);
    await assert.rejects(f.call({ action: 'restore', id: candidate.id }), /只有已忽略的候选可以恢复/);
  } finally { await f.close(); }
});

test('settings are saved and read back on the next start; a refused request is a bad-request error with a readable reason', async () => {
  const f = await fixture();
  try {
    const response = await f.call({ action: 'settings', patch: { dailyReportLimit: 3, reportModel: { provider: 'p', model: 'm' } } });
    assert.equal(response.settings.dailyReportLimit, 3);
    assert.deepEqual(response.settings.reportModel, { provider: 'p', model: 'm' });
    assert.deepEqual(response.settings.startModel, DEFAULT_SETTINGS.startModel, 'the start model keeps its default when the report model changes');
    const started = await f.call({ action: 'settings', patch: { startModel: { provider: 'p', model: 'pro' } } });
    assert.deepEqual(started.settings.startModel, { provider: 'p', model: 'pro' });
    await assert.rejects(f.call({ action: 'settings', patch: { startModel: { provider: '', model: 'm' } } }), remoteError('gateway/bad-request', /^startModel needs a provider and a model$/));
    assert.equal((JSON.parse(await readFile(join(f.directory, 'settings.json'), 'utf8')) as Settings).dailyReportLimit, 3);
    await assert.rejects(f.call({ action: 'settings', patch: { dailyReportLimit: '3' } } as never), remoteError('gateway/bad-request', /^设置项 dailyReportLimit 必须是数字$/));
    await assert.rejects(f.call({ action: 'settings', patch: { bogus: 1 } } as never), remoteError('gateway/bad-request', /^没有这个设置项："bogus"$/));
    await assert.rejects(f.call({ action: 'settings', patch: { dailyReportLimit: 0 } }), remoteError('gateway/bad-request', /^dailyReportLimit must be an integer >= 1$/));
    await assert.rejects(f.call({ action: 'report', id: 'abc' }), remoteError('gateway/bad-request', /^report 需要候选 id（小写 UUID）$/));
    await assert.rejects(f.call({ action: 'scan' } as never), remoteError('gateway/bad-request', /^未知的 OpenCodex 操作："scan"$/));
    assert.equal((JSON.parse(await readFile(join(f.directory, 'settings.json'), 'utf8')) as Settings).dailyReportLimit, 3, 'a refused patch writes nothing');
    await f.unload();
    const next = await fixture({ directory: f.directory, settings: null });
    try { assert.equal((await next.call({ action: 'snapshot' })).settings.dailyReportLimit, 3); } finally { await next.close(); }
  } finally { await f.close(); }
});

test('a new mirror path is indexed right away; a mirror that gives no index leaves the settings saved and says so', async () => {
  const f = await fixture();
  const empty = await mkdtemp(join(tmpdir(), 'oc-empty-mirror-'));
  try {
    const indexed = await f.call({ action: 'settings', patch: { dshMirrorPath: MIRROR } });
    assert.ok(indexed.indexSummary && indexed.indexSummary.entries > 0);
    await assert.rejects(f.call({ action: 'settings', patch: { dshMirrorPath: empty } }), /设置已保存，但用新的镜像路径建 DSH 索引失败：DSH index is empty/);
    const after = await f.call({ action: 'snapshot' });
    assert.equal(after.settings.dshMirrorPath, empty);
    assert.deepEqual(after.indexSummary, indexed.indexSummary, 'the previous index stays in use');
  } finally { await f.close(); await rm(empty, { recursive: true, force: true }); }
});

test('a check builds the index from the mirror path in force when its turn comes, not from the one it started with', async () => {
  const other = await mkdtemp(join(tmpdir(), 'oc-other-mirror-'));
  await cp(MIRROR, other, { recursive: true });
  await mkdir(join(other, 'packages', 'core', 'extra'), { recursive: true });
  await writeFile(join(other, 'packages', 'core', 'extra', 'README.md'), '# @deepseek-ai/dsh-extra\n\n## Summary\n\nOne more package.\n');
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[][] = [];
  const served = codexGh();
  const f = await fixture({ settings: { dshMirrorPath: MIRROR }, gh: async (args, signal) => { calls.push(args); await gate; return served(args, signal); } });
  try {
    const first = await f.call({ action: 'rebuildIndex' });
    const running = f.call({ action: 'check' });
    await until(() => calls.length > 0, 'the check to reach GitHub');
    assert.equal((await f.call({ action: 'snapshot' })).busy.check, true);
    // The mirror path changes while the check waits on GitHub: the change builds the other mirror's index at once.
    const moved = await f.call({ action: 'settings', patch: { dshMirrorPath: other } });
    assert.equal(moved.indexSummary!.entries, first.indexSummary!.entries + 1);
    release();
    const checked = await running;
    assert.equal(checked.lastCheck!.index?.entries, first.indexSummary!.entries + 1, 'the check refreshed the index of the mirror now in the settings');
    assert.equal(checked.indexSummary!.entries, first.indexSummary!.entries + 1);
  } finally { await f.close(); await rm(other, { recursive: true, force: true }); }
});

test('a check that stalls gives up at its deadline, is recorded, and does not hold the next one', async () => {
  let calls = 0;
  const f = await fixture({ gh: (args, signal) => { calls++; return stalledGh(args, signal); }, timeouts: { check: 20 } });
  try {
    await assert.rejects(f.call({ action: 'check' }), /检查超过 0 分钟还没结束，已停止/);
    const first = calls;
    await assert.rejects(f.call({ action: 'check' }), /已停止/);
    assert.ok(calls > first, 'the second check ran on its own instead of joining the stalled one');
    assert.match((await f.call({ action: 'snapshot' })).lastCheck!.errors[0]!, /^check: 检查超过/);
    assert.equal(f.timers.log.at(-1)!.ms, 24 * HOUR, 'a check that gave up still re-arms the timer');
  } finally { await f.close(); }
});

const lockFile = (f: Fixture) => join(f.directory, 'lock.json');
const logLines = async (f: Fixture) => (await readFile(join(f.directory, 'checks.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as CheckLogEntry);

test('checks one after the other each take the lock, let it go and append a line, which snapshots and a restarted Host read back', async () => {
  const f = await fixture();
  try {
    const first = await f.call({ action: 'check' });
    f.clock.advance(HOUR);
    const second = await f.call({ action: 'check' });
    assert.equal(await exists(lockFile(f)), false, 'no lock is left behind');
    const { releases, files, rss } = first.lastCheck!;
    const later = new Date(NOW.getTime() + HOUR).toISOString();
    assert.deepEqual(await logLines(f), [
      { at: NOW.toISOString(), startedAt: NOW.toISOString(), trigger: 'manual', pid: process.pid, window: { fromTag: 'rust-v0.161.0', toTag: 'rust-v0.162.0' },
        added: { releases: releases.added, files: files.added, desktop: 0, rss }, errors: [] },
      { at: later, startedAt: later, trigger: 'manual', pid: process.pid, window: null, added: { releases: 0, files: 0, desktop: 0, rss: 0 }, errors: [] },
    ]);
    assert.deepEqual([first.lastCheckAt, second.lastCheckAt], [NOW.toISOString(), later], 'a line ends when lastCheckAt says');
    const [, last] = await logLines(f);
    assert.deepEqual(second.lastCheckLog, last);
    assert.equal(second.hostPid, process.pid);
    await f.unload();
    const next = await fixture({ directory: f.directory, settings: null });
    try {
      const restarted = await next.call({ action: 'snapshot' });
      assert.equal(restarted.lastCheck, undefined, 'the restarted Host has run no check');
      assert.deepEqual(restarted.lastCheckLog, last);
    } finally { await next.close(); }
  } finally { await f.close(); }
});

test('a check refused by another process\'s lock is a bad request, writes no line, keeps lastCheck and is tried again in 10 minutes', async () => {
  const f = await fixture();
  try {
    const before = await f.call({ action: 'check' });
    const holder = foreignLock();
    await writeFile(lockFile(f), JSON.stringify(holder));
    await assert.rejects(f.call({ action: 'check' }), remoteError('gateway/bad-request', new RegExp(`^另一个 DSH 进程正在检查（pid ${process.ppid}，开始于 .+）$`)));
    assert.equal(f.timers.log.at(-1)!.ms, 10 * MINUTE);
    const refused = await f.call({ action: 'snapshot' });
    assert.deepEqual([refused.lastCheck, refused.lastCheckAt, refused.lastCheckLog], [before.lastCheck, before.lastCheckAt, before.lastCheckLog]);
    assert.deepEqual(refused.lock, { pid: process.ppid, kind: 'check', startedAt: holder.startedAt });
    // The timer's try is refused the same way; the one after the other process lets go runs.
    f.timers.fire();
    await until(() => f.timers.log.length === 4, 'the timer check to be refused');
    assert.equal(f.timers.log.at(-1)!.ms, 10 * MINUTE);
    assert.equal((await logLines(f)).length, 1, 'no line for a check that did not run');
    assert.deepEqual(JSON.parse(await readFile(lockFile(f), 'utf8')), holder, 'the other process keeps its lock');
    await rm(lockFile(f));
    f.timers.fire();
    await until(() => f.timers.log.length === 5, 'the timer check to run');
    assert.deepEqual((await logLines(f)).map(line => line.trigger), ['manual', 'timer']);
    assert.equal(f.timers.log.at(-1)!.ms, 24 * HOUR);
  } finally { await f.close(); }
});

test('the snapshot names its own process, and another process\'s lock only while that process is alive and beating', async () => {
  const f = await fixture();
  try {
    const plain = await f.call({ action: 'snapshot' });
    assert.equal(plain.hostPid, process.pid);
    assert.equal(plain.lock, undefined);
    const holder = foreignLock({ kind: 'research' });
    await writeFile(lockFile(f), JSON.stringify(holder));
    assert.deepEqual((await f.call({ action: 'snapshot' })).lock, { pid: process.ppid, kind: 'research', startedAt: holder.startedAt });
    f.clock.advance(6 * MINUTE);
    assert.equal((await f.call({ action: 'snapshot' })).lock, undefined, 'a heartbeat over 5 minutes old');
    await writeFile(lockFile(f), JSON.stringify(foreignLock({ pid: GONE_PID, heartbeatAt: f.clock.now().toISOString() })));
    assert.equal((await f.call({ action: 'snapshot' })).lock, undefined, 'a process that is gone');
    assert.equal(JSON.parse(await readFile(lockFile(f), 'utf8')).pid, GONE_PID, 'a snapshot takes nothing over');
  } finally { await f.close(); }
});

test('unloading during a check lets go of the lock and writes no line', async () => {
  let calls = 0;
  const f = await fixture({ gh: (args, signal) => { calls++; return stalledGh(args, signal); } });
  try {
    const running = f.call({ action: 'check' });
    await until(() => calls > 0, 'the check to reach GitHub');
    const held = JSON.parse(await readFile(lockFile(f), 'utf8'));
    assert.deepEqual([held.pid, held.kind], [process.pid, 'check']);
    assert.equal((await f.call({ action: 'snapshot' })).lock, undefined, 'the lock of this process is not shown as another\'s');
    await f.unload();
    await assert.rejects(running, { name: 'AbortError' });
    assert.equal(await exists(lockFile(f)), false);
    assert.equal(await exists(join(f.directory, 'checks.jsonl')), false);
  } finally { await f.close(); }
});

test('a check whose lock another process takes over stops, and is recorded as failed', async () => {
  let calls = 0;
  const f = await fixture({ gh: (args, signal) => { calls++; return stalledGh(args, signal); } });
  try {
    const running = f.call({ action: 'check' });
    await until(() => calls > 0, 'the check to reach GitHub');
    // This process stood still past the stale limit, and another one took the lock over: the next heartbeat finds out.
    const successor = foreignLock();
    await writeFile(lockFile(f), JSON.stringify(successor));
    f.lockTimers.fire();
    await assert.rejects(running, /数据目录锁被另一个 DSH 进程接管/);
    const after = await f.call({ action: 'snapshot' });
    assert.match(after.lastCheck!.errors[0]!, /^check: 数据目录锁被另一个 DSH 进程接管/);
    assert.deepEqual(after.lastCheckLog?.errors, after.lastCheck!.errors);
    assert.deepEqual(JSON.parse(await readFile(lockFile(f), 'utf8')), successor, 'the other process keeps its lock');
  } finally { await f.close(); }
});

test('a check log that cannot be written becomes a log line of the check, and one that cannot be read a notice', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.directory, 'checks.jsonl'));
    const response = await f.call({ action: 'check' });
    assert.match(response.lastCheck!.errors.at(-1)!, /^log: EISDIR/);
    assert.equal(response.lastCheckLog, undefined);
    assert.match(response.notice ?? '', /^检查日志 .*checks\.jsonl 没能读出来：EISDIR/);
  } finally { await f.close(); }
});

test('parseRequest accepts the listed actions only, with candidate UUIDs and settings of the right shape; the wire codec only wants an object', () => {
  const id = '9b2f3c1e-5d4a-4b6c-8e7f-0a1b2c3d4e5f';
  assert.deepEqual(parseRequest({ action: 'snapshot' }), { action: 'snapshot' });
  assert.deepEqual(parseRequest({ action: 'report', id }), { action: 'report', id });
  assert.deepEqual(parseRequest({ action: 'settings', patch: { checkIntervalHours: 6, classifyModel: { provider: 'p', model: 'm' } } }),
    { action: 'settings', patch: { checkIntervalHours: 6, classifyModel: { provider: 'p', model: 'm' } } });
  const refused: unknown[] = [
    null, [], 'snapshot', {}, { action: 'scan' }, { action: 'toString' }, { action: 'snapshot', id },
    { action: 'report' }, { action: 'report', id: 'abc' }, { action: 'report', id: id.toUpperCase() }, { action: 'report', id: 7 },
    { action: 'start', id: `${id}/../x` }, { action: 'readReport', id, path: '/etc/passwd' },
    { action: 'settings' }, { action: 'settings', patch: [] }, { action: 'settings', patch: { bogus: 1 } }, { action: 'settings', patch: { __proto__: { x: 1 } } },
    { action: 'settings', patch: JSON.parse('{"__proto__":{"dailyReportLimit":1}}') },
    { action: 'settings', patch: { dailyReportLimit: '3' } }, { action: 'settings', patch: { dshMirrorPath: 7 } }, { action: 'settings', patch: { checkIntervalHours: Number.NaN } },
    { action: 'settings', patch: { reportModel: { provider: 'p' } } }, { action: 'settings', patch: { reportModel: { provider: 'p', model: 'm', key: 'x' } } },
    { action: 'settings', patch: { reportModel: 'p/m' } }, { action: 'settings', patch: {}, extra: 1 },
  ];
  for (const value of refused) assert.throws(() => parseRequest(value), ValidationError, JSON.stringify(value));
  const [parameter] = OPEN_CODEX_DESCRIPTOR.parameters;
  assert.ok(parameter?.codec.mode === 'strict');
  const wire = parameter.codec.create();
  assert.deepEqual(wire.parse({ action: 'scan' }), { action: 'scan' }, 'content errors are left to call, whose messages reach the page');
  assert.throws(() => wire.parse('snapshot'), ValidationError);
});

test('the result codec sends plain JSON and refuses more than 4 MB', () => {
  const { result } = OPEN_CODEX_DESCRIPTOR;
  assert.ok(result.mode === 'strict' && result.encode, 'the gateway calls encode on the Host; it never calls the result parse');
  const writeBytes = () => null;
  assert.deepEqual(result.encode({ at: new Date(0), gone: undefined }, writeBytes), { at: '1970-01-01T00:00:00.000Z' });
  assert.throws(() => result.encode!({ text: 'x'.repeat(MAX_PAYLOAD) }, writeBytes), /4 MB/);
});

test('report: refused while one runs and past the daily limit; otherwise it writes the evidence pack and records the report', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR, dailyReportLimit: 2 } });
  try {
    // A pull request reference without a URL is what a failed lookup leaves behind; the report repairs it first.
    const bare = await seed(f.store, 'pr:50148', { title: 'Create a Git worktree for a task', evidence: [{ kind: 'pr', ref: '#50148' }] });
    const rss = await rssItem(f.store);
    const index = await f.call({ action: 'rebuildIndex' });
    assert.ok(index.indexSummary && index.indexSummary.entries > 0);

    f.dsh.hold();
    const running = f.call({ action: 'report', id: bare.id });
    await until(() => f.dsh.prompts.length === 1, 'the analyst prompt');
    await assert.rejects(f.call({ action: 'report', id: bare.id }), /正在生成报告/);
    await assert.rejects(f.call({ action: 'start', id: bare.id }), /正在生成报告/);
    await assert.rejects(f.call({ action: 'ignore', id: bare.id }), /正在生成报告/);
    f.dsh.open();
    const done = find(await running, bare.id)!;

    assert.equal(done.status, 'reported');
    assert.equal(done.report?.path, `reports/${bare.id}/report.md`);
    assert.equal(done.report?.sessionId, 'analyst-1');
    assert.deepEqual(done.report?.checks, { requiredSections: true, dshRefsTotal: 1, dshRefsResolved: 1 });
    const reportDir = join(f.directory, 'reports', bare.id);
    assert.deepEqual(f.dsh.created[0], { cwd: reportDir });
    assert.deepEqual(f.dsh.selected.map(({ provider, model }) => ({ provider, model })), [DEFAULT_SETTINGS.reportModel]);
    assert.deepEqual(f.dsh.defaults, [{ provider: 'deepseek-official', model: 'deepseek-flash' }], 'the user default model is put back');
    assert.deepEqual(f.dsh.policies, ['never'], 'no approval waits for a person');
    assert.equal(await readFile(join(reportDir, 'report.md'), 'utf8'), REPORT);
    const indexMd = await readFile(join(reportDir, 'evidence', 'INDEX.md'), 'utf8');
    assert.ok(indexMd.includes(`DSH 镜像根目录：${MIRROR}`));
    assert.ok((await readdir(join(reportDir, 'evidence', 'sources'))).some(name => name.endsWith('.diff')), 'the pull request diff is in the pack');
    assert.ok((await readdir(join(reportDir, 'evidence', 'dsh'))).length > 0, 'the index hits are in the pack');
    assert.equal(await exists(join(reportDir, 'evidence.prev')), false);
    // The bare reference was repaired on the candidate itself.
    const repaired = (await f.call({ action: 'candidate', id: bare.id })).candidate!;
    assert.deepEqual(repaired.evidence.map(({ kind, ref, url }) => ({ kind, ref, url })), [{ kind: 'pr', ref: '#50148', url: 'https://github.com/openai/codex/pull/50148' }]);
    assert.match(repaired.evidence[0]!.excerpt ?? '', /^PR 50148\n\nWhat 50148 changes\./);
    assert.equal((await f.call({ action: 'snapshot' })).checkpoints[COUNTER], '1');
    assert.deepEqual((await f.call({ action: 'readReport', id: bare.id })).report, { id: bare.id, markdown: REPORT });

    // The second analyst session of the day reaches the limit of two; a third report, even a rerun, is refused before anything is made.
    assert.equal(find(await f.call({ action: 'report', id: rss.id }), rss.id)!.status, 'reported');
    assert.equal((await f.call({ action: 'snapshot' })).checkpoints[COUNTER], '2');
    const sessions = f.dsh.created.length;
    await assert.rejects(f.call({ action: 'report', id: bare.id }), /达到每日上限 2 份/);
    assert.equal(f.dsh.created.length, sessions);
  } finally { await f.close(); }
});

test('reports still running count against the daily limit, and reading a report being generated says so', async () => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[][] = [];
  const served = codexGh();
  const f = await fixture({ settings: { dshMirrorPath: MIRROR, dailyReportLimit: 1 }, gh: async (args, signal) => { calls.push(args); await gate; return served(args, signal); } });
  try {
    const first = await seed(f.store, 'pr:50148', { evidence: [{ kind: 'pr', ref: '#50148' }] });
    const second = await rssItem(f.store);
    f.dsh.hold();
    const running = f.call({ action: 'report', id: first.id });
    // Still at GitHub: admitted, no session yet.
    await until(() => calls.length > 0, 'the GitHub part of the report');
    await assert.rejects(f.call({ action: 'report', id: second.id }), /已有 1 份（含正在生成的），达到每日上限 1 份/);
    release();
    // At its analyst session: counted.
    await until(() => f.dsh.prompts.length === 1, 'the analyst prompt');
    await assert.rejects(f.call({ action: 'report', id: second.id }), /达到每日上限 1 份/);
    const busy = await f.call({ action: 'readReport', id: first.id });
    assert.deepEqual(busy.report, { id: first.id, markdown: '', notice: '报告正在生成，生成完再看' });
    assert.deepEqual(busy.busy, { check: false, candidates: { [first.id]: 'report' } });
    f.dsh.open();
    assert.equal(find(await running, first.id)!.status, 'reported');
    assert.equal(await f.store.checkpoint(COUNTER), '1');
  } finally { await f.close(); }
});

test('a failed report session is named in the error, counts toward the day, and leaves the earlier report and evidence in place', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR } });
  try {
    const candidate = await rssItem(f.store);
    const reportDir = join(f.directory, 'reports', candidate.id);
    await f.call({ action: 'report', id: candidate.id });
    await writeFile(join(reportDir, 'evidence', 'marker.txt'), 'the first pack');
    f.dsh.hooks.activationError = new Error('no agent for the session');
    await assert.rejects(f.call({ action: 'report', id: candidate.id }), /no agent for the session.*analyst-2/);
    assert.equal(await f.store.checkpoint(COUNTER), '2', 'the failed session counts: it may have cost tokens');
    assert.equal(await readFile(join(reportDir, 'evidence', 'marker.txt'), 'utf8'), 'the first pack', 'the earlier evidence is back');
    assert.equal(await exists(join(reportDir, 'evidence.prev')), false);
    assert.equal(await readFile(join(reportDir, 'report.md'), 'utf8'), REPORT);
    const after = await f.store.get(candidate.id);
    assert.deepEqual([after.status, after.report?.sessionId], ['reported', 'analyst-1']);
    // A rerun that succeeds replaces the evidence and drops the backup.
    f.dsh.hooks.activationError = undefined;
    assert.equal(find(await f.call({ action: 'report', id: candidate.id }), candidate.id)!.report?.sessionId, 'analyst-3');
    assert.equal(await exists(join(reportDir, 'evidence', 'marker.txt')), false);
    assert.equal(await exists(join(reportDir, 'evidence.prev')), false);
  } finally { await f.close(); }
});

test('a report whose session was never created gives its daily place back, and a lone evidence backup is left alone', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR, dailyReportLimit: 1 } });
  try {
    const candidate = await rssItem(f.store);
    // A backup without an evidence/ beside it is the only copy left of that pack.
    const backup = join(f.directory, 'reports', candidate.id, 'evidence.prev');
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'marker.txt'), 'the only copy');
    f.dsh.hooks.createError = new Error('unknown agent preset');
    await assert.rejects(f.call({ action: 'report', id: candidate.id }), { name: 'ReportSessionError', message: '报告会话准备失败：unknown agent preset' });
    assert.equal(await f.store.checkpoint(COUNTER), '0', 'the place is given back');
    assert.equal(await readFile(join(backup, 'marker.txt'), 'utf8'), 'the only copy', 'with no evidence/ to set aside, the backup stays');
    f.dsh.hooks.createError = undefined;
    assert.equal(find(await f.call({ action: 'report', id: candidate.id }), candidate.id)!.status, 'reported', 'the one place of the day was free');
    assert.equal(await f.store.checkpoint(COUNTER), '1');
  } finally { await f.close(); }
});

test('the GitHub part of a report gives up at its deadline before any session is made, and does not count', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR }, gh: stalledGh, timeouts: { github: 20 } });
  try {
    const candidate = await seed(f.store, 'pr:50148', { evidence: [{ kind: 'pr', ref: '#50148' }] });
    await assert.rejects(f.call({ action: 'report', id: candidate.id }), /从 GitHub 取证据超过 0 分钟还没结束，已停止/);
    assert.equal(f.dsh.created.length, 0);
    assert.equal(await f.store.checkpoint(COUNTER), undefined);
    assert.equal((await f.store.get(candidate.id)).status, 'new');
    assert.deepEqual((await f.call({ action: 'snapshot' })).busy.candidates, {}, 'the candidate is free again');
  } finally { await f.close(); }
});

test('report and start need the mirror path, and readReport says why a report is missing', async () => {
  const f = await fixture();
  try {
    const candidate = await seed(f.store, 'pr:50148');
    await assert.rejects(f.call({ action: 'report', id: candidate.id }), /dshMirrorPath/);
    assert.deepEqual((await f.call({ action: 'readReport', id: candidate.id })).report, { id: candidate.id, markdown: '', notice: '这条候选还没有报告' });
    await asReported(f, candidate);
    await assert.rejects(f.call({ action: 'start', id: candidate.id }), /dshMirrorPath/);
    assert.equal((await f.call({ action: 'readReport', id: candidate.id })).report?.markdown, REPORT);
    await unlink(join(f.directory, 'reports', candidate.id, 'report.md'));
    assert.deepEqual((await f.call({ action: 'readReport', id: candidate.id })).report, { id: candidate.id, markdown: '', notice: '报告文件不存在，请重新生成' });
    assert.equal(f.dsh.created.length, 0);
  } finally { await f.close(); }
});

test('start opens a creator session for a reported candidate, records it, and refuses while the last one runs', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR } });
  try {
    const fresh = await seed(f.store, 'pr:51500');
    await assert.rejects(f.call({ action: 'start', id: fresh.id }), /先生成报告再开工/);
    const candidate = await asReported(f, await seed(f.store, 'pr:50148'));
    const response = await f.call({ action: 'start', id: candidate.id });
    assert.equal(response.startedSessionId, 'cordis-1');
    const started = find(response, candidate.id)!;
    assert.equal(started.status, 'started');
    assert.deepEqual(started.started, { sessionId: 'cordis-1', at: NOW.toISOString() });
    assert.deepEqual(f.dsh.created, [{ cwd: join(f.directory, 'work', candidate.id), agentPreset: 'cordis' }]);
    assert.deepEqual(f.dsh.selected, [{ sessionId: 'cordis-1', ...DEFAULT_SETTINGS.startModel }], 'the creator session runs on the start model');
    assert.deepEqual(f.dsh.defaults, [{ provider: 'deepseek-official', model: 'deepseek-flash' }], 'the user default model is put back');
    const prompt = f.dsh.prompts[0]!.content[0]!;
    assert.ok(prompt.type === 'text' && prompt.text.includes(REPORT), 'the report is the task');

    f.dsh.statuses.set('cordis-1', 'running');
    await assert.rejects(f.call({ action: 'start', id: candidate.id }), /上一个开工会话还在运行（会话 cordis-1）/);
    f.dsh.statuses.set('cordis-1', 'idle');
    const again = await f.call({ action: 'start', id: candidate.id });
    assert.equal(again.startedSessionId, 'cordis-2', 'started -> started opens another session');
    assert.equal(find(again, candidate.id)!.started?.sessionId, 'cordis-2');
    // A report rerun moves the candidate back to reported; its creator session may still be working.
    await f.store.patch(candidate.id, current => transition(current, 'reported', NOW.toISOString()));
    f.dsh.statuses.set('cordis-2', 'running');
    await assert.rejects(f.call({ action: 'start', id: candidate.id }), /上一个开工会话还在运行（会话 cordis-2）/);
  } finally { await f.close(); }
});

test('a start whose record cannot be saved names the session it opened', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR } });
  try {
    const candidate = await asReported(f, await seed(f.store, 'pr:50148'));
    // The candidate file breaks while the creator session takes its task, so the patch that records the session fails.
    f.dsh.hooks.creatorPrompted = () => writeFile(join(f.directory, 'candidates', `${candidate.id}.json`), '{ damaged');
    await assert.rejects(f.call({ action: 'start', id: candidate.id }), /开工会话 cordis-1 已经开始工作，但没能记到候选上：Corrupt JSON/);
  } finally { await f.close(); }
});

test('the timer runs the first check after a short delay, re-arms after each check and after a settings change, and is cleared on unload', async () => {
  const feed = { count: 0 };
  const f = await fixture({ gh: offlineGh, feed: serve('gone', 404, feed) });
  try {
    await f.call({ action: 'snapshot' });
    assert.deepEqual(f.timers.log.map(entry => entry.ms), [60_000], 'no check at construction, one after a minute');
    f.timers.fire();
    const checked = await f.call({ action: 'check' });
    assert.equal(feed.count, 1, 'the requested check joined the one the timer started');
    assert.equal(checked.lastCheckLog?.trigger, 'startup');
    assert.ok(checked.lastCheck && checked.lastCheck.errors.length > 0);
    assert.deepEqual([...new Set(f.timers.log.slice(1).map(entry => entry.ms))], [24 * HOUR]);
    assert.equal(f.timers.armed.size, 1);
    await f.call({ action: 'settings', patch: { checkIntervalHours: 6 } });
    assert.equal(f.timers.log.at(-1)!.ms, 6 * HOUR, 'the next check is due one new interval after the last one');
    assert.equal(f.timers.armed.size, 1);
    const armed = [...f.timers.armed.keys()];
    await f.unload();
    assert.equal(f.timers.armed.size, 0);
    assert.ok(armed.every(handle => f.timers.cleared.includes(handle)));
    await assert.rejects(f.call({ action: 'snapshot' }), /已卸载/);
  } finally { await f.close(); }
});

test('unloading aborts a running report and leaves the candidate as it was', async () => {
  const f = await fixture({ settings: { dshMirrorPath: MIRROR } });
  try {
    const candidate = await rssItem(f.store);
    f.dsh.hold();
    const running = f.call({ action: 'report', id: candidate.id });
    await until(() => f.dsh.prompts.length === 1, 'the analyst prompt');
    await f.unload();
    await assert.rejects(running, /报告会话已中止（会话 analyst-1）/);
    const after = await f.store.get(candidate.id);
    assert.deepEqual([after.status, after.report], ['new', undefined]);
    assert.equal(await exists(join(f.directory, 'reports', candidate.id, 'report.md')), false);
  } finally { await f.close(); }
});
