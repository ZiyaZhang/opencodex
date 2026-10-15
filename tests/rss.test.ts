import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandidateStore, type UpsertInput } from '../src/core/store.ts';
import { RSS_URL, collectRss, rssCandidates } from '../src/host/sources/rss.ts';

const PAGE = 'https://developers.openai.com/codex/changelog';
// The fixture's items are dated Aug-Oct 2026; every call pins the clock so the 120-day window never drifts.
const NOW = new Date('2026-10-15T00:00:00Z');
const readFixture = () => readFile(new URL('./fixtures/changelog-rss-sample.xml', import.meta.url), 'utf8');

interface FetchCall { url: string; init: RequestInit | undefined }
function feed(body: string, calls: FetchCall[] = []): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(input), init }); return new Response(body, { status: 200 }); };
}
/** Counts the upserts it is asked for: a feed that was skipped by its hash shows no new call, a feed that was parsed shows one per item. */
class CountingStore extends CandidateStore {
  upserts = 0;
  override upsert(input: UpsertInput) { this.upserts++; return super.upsert(input); }
}
/** A store whose clock advances one second per read, so any write shows up as a changed `updatedAt`. */
async function withStore(run: (store: CountingStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'oc-rss-'));
  try {
    let seconds = 0;
    await run(new CountingStore(dir, () => new Date(Date.UTC(2026, 9, 15, 0, 0, seconds++))));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('rss keeps product announcements, drops model notices and iOS, lets only runtime bullets through from CLI releases, strips the v1 scope suffix', async () => {
  const xml = await readFixture();
  const items = rssCandidates(xml, PAGE, NOW);
  assert.ok(items.some(i => /Appshots/.test(i.releaseTitle)));
  assert.ok(items.some(i => /Browser extensions/.test(i.releaseTitle)));
  assert.ok(!items.some(i => /GPT-5\.5 retirement|GPT-6\.1 Sol Ultrafast|ChatGPT for iOS/.test(i.releaseTitle)));
  assert.ok(items.every(i => !/来源范围|尚未在本机验证/.test(i.description)));
  assert.ok(items.every(i => i.sourceUrl.startsWith('https://')));
  // CLI features belong to the GitHub source: 0.162.1 and 0.161.0 are dropped whole, 0.162.0 keeps only its compaction bullet.
  const cli = items.filter(i => /^Codex CLI Release:/.test(i.releaseTitle));
  assert.deepEqual(cli.map(i => i.releaseTitle), ['Codex CLI Release: 0.162.0']);
  assert.match(cli[0]!.title, /remote compaction/);
  // Nothing is appended to the source text.
  const appshots = items.find(i => i.title === 'Share an app window on Windows');
  assert.ok(appshots?.description.endsWith('choose which chat receives it in settings.'));
  // Wrapped bullets come back whole, and a GitHub bullet ends at its sentence.
  assert.equal(cli[0]!.description, 'Configure live web access and remote compaction capabilities for custom Responses-compatible model providers.');
  const browser = items.find(i => /Browser extensions/.test(i.releaseTitle));
  assert.ok(browser?.description.includes('More browsers: Use the ChatGPT browser extension in Microsoft Edge, Brave, Opera, and Vivaldi, as well as Chrome.'));
  assert.ok(items.every(i => !/[,(]$/.test(i.title)));
  // Several bullets under the item's own title are one feature each.
  assert.deepEqual(items.filter(i => /Browser extensions/.test(i.releaseTitle)).map(i => i.title), ['More browsers', 'Site tools (WebMCP)', 'Cloud browser sign-in']);
  // Announcements whose only "codex" is a /codex/ link, a section named "Install the ..." and a title that says "availability" are kept.
  for (const title of ['Trigger scheduled tasks from Gmail, Slack, and GitHub events', 'Public plugin catalog CSV export', 'Record & Replay expands to the EU, UK, and Switzerland', 'Install the ChatGPT desktop app on Linux', 'Codex Remote reaches general availability']) {
    assert.ok(items.some(i => i.title === title), title);
  }
});

test('a release that lists nine bullets under its own title gives its intro and then nine features, in the order of the notes', async () => {
  const xml = await readFixture();
  // The release is dated 2026-05-21; the other fixture items lie in the future of this date, or too far in the past, and are skipped.
  const features = rssCandidates(xml, PAGE, new Date('2026-06-01T00:00:00Z')).filter(i => i.releaseTitle === 'Appshots, goal mode, and more');
  assert.equal(features.length, 10);
  assert.equal(features[0]!.title, 'Appshots, goal mode, and more');
  assert.ok(features[0]!.description.startsWith('Appshots are now available in the Codex app on macOS. Press both Command keys'));
  assert.ok(!features[0]!.description.includes('This launch also includes'));
  assert.ok(features[1]!.title.startsWith('Goal mode is no longer an experimental feature'));
  assert.equal(features[6]!.title, 'Codex can now download and extract all image assets from a page much more quickly.');
  assert.ok(features[9]!.title.startsWith('Significantly improved reliability for browser use'));
  assert.ok(features.every(i => i.sourceUrl === 'https://developers.openai.com/codex/changelog/#codex-2026-05-21'));
});

test('option lists stay one feature each: the web search modes and the Team Config layers', async () => {
  const xml = await readFixture();
  const features = rssCandidates(xml, PAGE, new Date('2026-02-01T00:00:00Z'));
  assert.deepEqual(features.map(i => i.title), ['Web search is now enabled by default', 'Team Config for shared configuration']);
  assert.ok(features[0]!.description.startsWith('Codex now enables web search for local tasks in the Codex CLI and IDE Extension.'));
  assert.ok(features[0]!.description.includes('web_search = "cached" (default; serves results from the web search cache)'));
  assert.ok(features[1]!.description.includes('config.toml defaults rules/ for command controls outside the sandbox skills/ for reusable workflows'));
});

test('collectRss stores announcements once, skips an unchanged feed by hash, and only adds new items when the feed changes', async () => {
  const xml = await readFixture();
  await withStore(async store => {
    const signal = new AbortController().signal;
    const calls: FetchCall[] = [];
    const first = await collectRss(store, signal, feed(xml, calls), NOW);
    const stored = await store.list({ source: 'rss' });
    assert.ok(first > 0);
    assert.equal(first, rssCandidates(xml, PAGE, NOW).length);
    assert.equal(stored.length, first);
    assert.equal(store.upserts, first);
    assert.match(await store.checkpoint('rssHash') ?? '', /^[0-9a-f]{64}$/);
    assert.equal(calls[0]?.url, RSS_URL);
    assert.equal(calls[0]?.init?.signal, signal);
    assert.match(new Headers(calls[0]?.init?.headers).get('accept') ?? '', /rss\+xml/);
    assert.match(new Headers(calls[0]?.init?.headers).get('user-agent') ?? '', /^dsh-opencodex\//);
    for (const candidate of stored) {
      assert.equal(candidate.status, 'new');
      assert.equal(candidate.evidence.length, 1);
      assert.equal(candidate.evidence[0]?.kind, 'rss');
      assert.ok(candidate.evidence[0]?.url?.startsWith('https://'));
      assert.ok(!candidate.summary.includes('来源范围'));
    }

    // The same body again: fetched, recognised by its hash, nothing written.
    assert.equal(await collectRss(store, signal, feed(xml, calls), NOW), 0);
    assert.equal(calls.length, 2);
    assert.equal(store.upserts, first, 'an unchanged feed is not parsed again');
    assert.deepEqual(await store.list({ source: 'rss' }), stored);

    // A changed body is processed again; only the unseen item is new.
    const extra = '<item><title>Codex app themes</title><link>https://developers.openai.com/codex/changelog/#codex-2026-10-12-app</link><guid>https://developers.openai.com/codex/changelog/#codex-2026-10-12-app</guid><description>Codex app themes</description><pubDate>Mon, 12 Oct 2026 00:00:00 GMT</pubDate><content:encoded># Codex app themes\n\nPick a theme for the Codex desktop app in **Settings**.</content:encoded></item>';
    const changed = xml.replace('<item>', `${extra}<item>`);
    const hash = await store.checkpoint('rssHash');
    assert.equal(await collectRss(store, signal, feed(changed), NOW), 1);
    assert.equal(store.upserts, first + first + 1);
    assert.equal((await store.list({ source: 'rss' })).length, first + 1);
    assert.notEqual(await store.checkpoint('rssHash'), hash);
    assert.equal(await collectRss(store, signal, feed(changed), NOW), 0);
    assert.equal(store.upserts, first + first + 1);
  });
});

test('collectRss writes oldest first, so list() reads like the feed with the newest on top, and each candidate carries its publication date', async () => {
  const xml = await readFixture();
  await withStore(async store => {
    await collectRss(store, new AbortController().signal, feed(xml), NOW);
    const listed = await store.list({ source: 'rss' });
    assert.deepEqual(listed.map(c => c.title), rssCandidates(xml, PAGE, NOW).map(i => i.title));
    const dates = listed.map(c => c.evidence[0]!.ref.slice(0, 10));
    assert.deepEqual(dates, [...dates].sort().reverse());
    assert.equal(dates[0], '2026-10-08');
    const appshot = listed.find(c => c.title === 'Share an app window on Windows')!;
    assert.equal(appshot.evidence[0]!.ref, '2026-09-11 Quick chats with Pets and Appshots on Windows');
    const [dateLine, firstLine] = appshot.evidence[0]!.excerpt!.split('\n');
    assert.equal(dateLine, '2026-09-11');
    assert.ok(firstLine!.startsWith('Appshots are now available'));
  });
});

test('collectRss reads an unchanged feed again when the saved hash predates the parser version', async () => {
  const xml = await readFixture();
  await withStore(async store => {
    const signal = new AbortController().signal;
    const bodyOnly = createHash('sha256').update(xml).digest('hex');
    await store.setCheckpoint('rssHash', bodyOnly);
    const added = await collectRss(store, signal, feed(xml), NOW);
    assert.ok(added > 0);
    assert.equal(store.upserts, added);
    assert.notEqual(await store.checkpoint('rssHash'), bodyOnly);
    assert.equal(await collectRss(store, signal, feed(xml), NOW), 0);
    assert.equal(store.upserts, added);
  });
});

test('collectRss rejects a non-2xx response and leaves no candidates or checkpoint behind', async () => {
  await withStore(async store => {
    const unavailable: typeof fetch = async () => new Response('busy', { status: 503 });
    await assert.rejects(collectRss(store, new AbortController().signal, unavailable, NOW), /RSS HTTP 503/);
    assert.deepEqual(await store.list({ source: 'rss' }), []);
    assert.equal(await store.checkpoint('rssHash'), undefined);
  });
});

test('collectRss does not remember a 200 body the parser cannot read, so the next good fetch still runs', async () => {
  const xml = await readFixture();
  await withStore(async store => {
    const signal = new AbortController().signal;
    await assert.rejects(collectRss(store, signal, feed('<html>error page</html>'), NOW), /format was not recognized/);
    assert.equal(await store.checkpoint('rssHash'), undefined);
    assert.ok(await collectRss(store, signal, feed(xml), NOW) > 0);
  });
});

test('collectRss stops reading a body larger than 4 MB and writes nothing', async () => {
  await withStore(async store => {
    const megabyte = new Uint8Array(1024 * 1024).fill(0x20);
    let pulled = 0, cancelled = false;
    // Eight megabytes on offer; a reader that honours the cap must quit well before the end.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { if (++pulled > 8) controller.close(); else controller.enqueue(megabyte); },
      cancel() { cancelled = true; },
    });
    const oversized: typeof fetch = async () => new Response(body, { status: 200 });
    await assert.rejects(collectRss(store, new AbortController().signal, oversized, NOW), /RSS body exceeds 4 MB/);
    assert.equal(cancelled, true);
    assert.ok(pulled < 8, `pulled ${pulled} chunks`);
    assert.deepEqual(await store.list({ source: 'rss' }), []);
    assert.equal(await store.checkpoint('rssHash'), undefined);
  });
});
