import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChangelog } from '../src/host/changelog-parser.js';

const url = 'https://learn.chatgpt.com/docs/changelog';
const now = new Date('2026-10-14T12:00:00.000Z');
const markdown = `# Synthetic changelog
- 2026-10-13
### Codex CLI 1.2.3
## New Features
- Added Rust transport state.
- 2026-10-12
### GPT-6 model announcement
A new model is available in Codex.
- 2026-10-11
### Codex desktop app 26.1011 {#desktop-release}
### New features
- **Draft recovery:** Restore an interrupted composer draft without sending it.
- **Question cards:** Keep normal input available while a question waits.
### Bug fixes
- Fixed a sidebar crash.
- 2026-10-10
### ChatGPT consumer update
ChatGPT shopping has a new layout.
- 2026-10-09
### Codex desktop tools {#tools-release}
### Preview attachments {#preview-attachments}
Open image attachments beside the chat.
### Performance improvements
Various bug fixes.
`;

test('dated product releases become separate actionable features with source dates and actual anchors', () => {
  const items = parseChangelog(markdown, url, { now });
  assert.deepEqual(items.map(item => item.title), ['Draft recovery', 'Question cards', 'Preview attachments']);
  assert.equal(items[0]?.publishedAt, '2026-10-11T00:00:00.000Z');
  assert.equal(items[0]?.releaseTitle, 'Codex desktop app 26.1011');
  assert.equal(items[0]?.sourceUrl, `${url}#desktop-release`);
  assert.equal(items[2]?.sourceUrl, `${url}#preview-attachments`);
  assert.ok(items.every(item => item.description.includes('尚未在本机验证')));
});

test('HTML parser preserves real release IDs and ignores scripts/navigation instead of promoting page chrome', () => {
  const html = `<html><nav><time datetime="2026-10-12">date</time><h3>Codex junk</h3><p>Navigation</p></nav><main>
    <article id="actual-release-id"><time datetime="2026-10-10T12:34:56Z">Oct 10</time><h3>Codex desktop app 26.1010</h3>
    <h3>New features</h3><ul><li><strong>Image preview:</strong> Show files &amp; captions inline.</li><li>Added a keyboard shortcut for drafts.</li></ul>
    <script>document.write('not a feature')</script><h3>Bug fixes</h3><ul><li>Fixed an error.</li></ul></article>
  </main></html>`;
  const items = parseChangelog(html, url, { now });
  assert.deepEqual(items.map(item => item.title), ['Image preview', 'Added a keyboard shortcut for drafts.']);
  assert.equal(items[0]?.sourceUrl, `${url}#actual-release-id`);
  assert.match(items[0]!.description, /files & captions/);
});

test('RSS respects publication dates and original release links with bounded product scope', () => {
  const xml = `<rss version="2.0"><channel>
    <item><title>Codex desktop app 26.1008</title><pubDate>Thu, 08 Oct 2026 12:30:00 GMT</pubDate><link>${url}#official-1008</link><description><![CDATA[<h3>New features</h3><ul><li>Added a compact task preview.</li><li>Added image captions.</li></ul>]]></description></item>
    <item><title>Codex Mobile 26.1008</title><pubDate>Thu, 08 Oct 2026 12:30:00 GMT</pubDate><link>${url}#mobile</link><description>Codex can now show mobile tasks.</description></item>
  </channel></rss>`;
  const items = parseChangelog(xml, url, { now });
  assert.equal(items.length, 2);
  assert.equal(items[0]?.sourceUrl, `${url}#official-1008`);
  assert.equal(items[0]?.publishedAt, '2026-10-08T00:00:00.000Z');
});

test('RSS paragraph and list fragments without headings still produce individual features', () => {
  const xml = `<rss><channel><item><title>Codex desktop app 26.1008</title><pubDate>Thu, 08 Oct 2026 12:30:00 GMT</pubDate><link>${url}#official-1008</link><description><![CDATA[<p>New in the desktop app:</p><ul><li><strong>Thread chips:</strong> Reference another conversation.</li><li><strong>Draft restore:</strong> Keep the current draft after a restart.</li></ul>]]></description></item></channel></rss>`;
  const items = parseChangelog(xml, url, { now });
  assert.deepEqual(items.map(item => item.title), ['Thread chips', 'Draft restore']);
  assert.equal(items[0]?.sourceUrl, `${url}#official-1008`);
});

test('feature identity is insensitive to list order, whitespace and release text edits', () => {
  const first = parseChangelog(markdown, url, { now });
  const second = parseChangelog(markdown.replace('Restore an interrupted composer draft without sending it.', 'Restore a saved composer draft after restart.').replace('### New features', '### New features\n\n'), url, { now });
  assert.deepEqual(first.map(item => item.fingerprint), second.map(item => item.fingerprint));
  assert.notEqual(first[0]?.description, second[0]?.description);
});

test('recent release and feature bounds apply after excluding irrelevant entries; malformed content cannot become a generic notice', () => {
  assert.equal(parseChangelog(markdown, url, { now, maxReleases: 1 }).length, 2);
  assert.equal(parseChangelog(markdown, url, { now, maxFeatures: 1 }).length, 1);
  assert.equal(parseChangelog(markdown, url, { now, maxAgeDays: 1 }).length, 0);
  assert.throws(() => parseChangelog('<html>error page</html>', url, { now }), /format was not recognized/);
});

test('untrusted RSS links never become script or remote site links, and undated content is not assigned today', () => {
  const xml = `<rss><channel><item><title>Codex desktop app</title><pubDate>Thu, 08 Oct 2026 12:30:00 GMT</pubDate><link>javascript:alert(1)</link><description><![CDATA[<h3>Draft history</h3><p>Codex preserves older drafts.</p>]]></description></item><item><title>Codex invented date</title><description>Codex feature with no date.</description></item></channel></rss>`;
  const items = parseChangelog(xml, url, { now });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.sourceUrl, url);
});

test('runtime capabilities in CLI and performance notes remain candidates without claiming desktop availability', () => {
  const source = `2026-10-12\n# Codex CLI 1.2\n### Performance\n- Async compaction: prepare a history summary in the background.\n- Fixed compaction crash.\n- Reduced startup latency.\n### Features\n- Added a shell completion shortcut.\n2026-10-11\n# Codex desktop app 26.1011\n### Performance\n- Background compaction: preserve foreground work.\n- Faster startup.\n`;
  const items = parseChangelog(source, url, { now });
  assert.deepEqual(items.map(item => item.title), ['Async compaction', 'Background compaction']);
  assert.match(items[0]!.description, /桌面可用性未确认/);
  assert.match(items[1]!.description, /桌面应用/);
});
