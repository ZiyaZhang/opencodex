import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChangelog } from '../src/host/changelog-parser.ts';

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
  assert.equal(items[0]?.description, 'Draft recovery: Restore an interrupted composer draft without sending it.');
  assert.ok(items.every(item => !/来源范围|尚未在本机验证/.test(item.description)));
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
  assert.equal(items[0]!.description, 'Async compaction: prepare a history summary in the background.');
  assert.equal(items[1]!.description, 'Background compaction: preserve foreground work.');
});

const rss = (title: string, body: string) => `<rss><channel><item><title>${title}</title><pubDate>Thu, 08 Oct 2026 12:30:00 GMT</pubDate><link>${url}#wrapped</link><content:encoded>${body}</content:encoded></item></channel></rss>`;

test('RSS bullets and paragraphs that were hard-wrapped come back as whole sentences, wrapped links included', () => {
  const items = parseChangelog(rss('Codex joins the ChatGPT desktop app', [
    '# Codex joins the ChatGPT desktop app',
    '',
    'Codex is now part of the ChatGPT desktop app on macOS and Windows. Existing',
    'Codex app users can update as usual.',
    '',
    '### New features',
    '',
    '- Edit Markdown and code directly in the app, use inline annotations, and ask',
    '  Codex to revise selected content.',
    '- Use PR Chat to review GitHub pull requests and ask Codex about changes in',
    '  context. Read the [PR Chat',
    '  guide](/codex/pr-chat) first.',
    '- Connect custom domains to published Sites.',
  ].join('\n')), url, { now });
  assert.deepEqual(items.map(item => item.title), [
    'Codex joins the ChatGPT desktop app',
    'Edit Markdown and code directly in the app, use inline annotations, and ask Codex to revise selected content.',
    'Use PR Chat to review GitHub pull requests and ask Codex about changes in context.',
    'Connect custom domains to published Sites.',
  ]);
  assert.equal(items[0]!.description, 'Codex is now part of the ChatGPT desktop app on macOS and Windows. Existing Codex app users can update as usual.');
  assert.equal(items[1]!.description, 'Edit Markdown and code directly in the app, use inline annotations, and ask Codex to revise selected content.');
  assert.equal(items[2]!.description, 'Use PR Chat to review GitHub pull requests and ask Codex about changes in context. Read the PR Chat guide first.');
});

test('a section made of wrapped bullets starts with its first bullet, not with a continuation line', () => {
  const [feature, ...rest] = parseChangelog(rss('Browser extensions, site tools, and cloud sign-in', [
    '# Browser extensions, site tools, and cloud sign-in',
    '',
    '- **More browsers:** Use the [ChatGPT browser extension](/codex/chrome-extension)',
    '  in Microsoft Edge, Brave, Opera, and Vivaldi, as well as Chrome. Set up',
    '  your browser in **Settings &gt; Computer Use** in the ChatGPT desktop app.',
    '',
    '- **Site tools (WebMCP):** In the desktop app&apos;s built-in browser, ChatGPT Work',
    '  and Codex can use [tools provided by a website](/codex/webmcp) to work with',
    '  the page.',
  ].join('\n')), url, { now });
  assert.equal(rest.length, 0);
  assert.equal(feature?.title, 'Browser extensions, site tools, and cloud sign-in');
  assert.equal(feature?.description, "More browsers: Use the ChatGPT browser extension in Microsoft Edge, Brave, Opera, and Vivaldi, as well as Chrome. Set up your browser in Settings > Computer Use in the ChatGPT desktop app. Site tools (WebMCP): In the desktop app's built-in browser, ChatGPT Work and Codex can use tools provided by a website to work with the page.");
});

test('list items, blank lines, code fences and headings end a wrapped line instead of being joined into it', () => {
  const fence = '`'.repeat(3);
  const items = parseChangelog(rss('Codex desktop app 26.1011', [
    '### New features',
    '',
    '- First bullet wraps',
    '  onto a second line.',
    '- Second bullet is short.',
    '',
    'A paragraph after a blank line.',
    '- Third bullet is followed by code',
    `${fence}sh`,
    'codex --help',
    fence,
    '- Fourth bullet is followed by a heading',
    '### Bug fixes',
    '',
    '- Fixed something.',
  ].join('\n')), url, { now });
  assert.deepEqual(items.map(item => item.description), [
    'First bullet wraps onto a second line.',
    'Second bullet is short.',
    'Third bullet is followed by code',
    'Fourth bullet is followed by a heading',
  ]);
});

test('an anchor in the middle of an RSS sentence stays out of the text and out of the way of the heading anchor', () => {
  const html = '<h3 id="preview-attachments">Preview attachments</h3><p>Open image <a name="inline"></a>attachments beside the chat.</p>';
  const [feature] = parseChangelog(rss('Codex desktop tools', html.replace(/</g, '&lt;').replace(/>/g, '&gt;')), url, { now });
  assert.equal(feature?.title, 'Preview attachments');
  assert.equal(feature?.description, 'Open image attachments beside the chat.');
  assert.equal(feature?.sourceUrl, `${url}#preview-attachments`);
});

test('data-id and data-name attributes are not anchors, while a real id still is', () => {
  const page = (attributes: string) => `<main><article ${attributes}><time datetime="2026-10-10">Oct 10</time><h3>Codex desktop app 26.1010</h3><h3>New features</h3><ul><li>Added a keyboard shortcut for drafts.</li></ul></article></main>`;
  assert.equal(parseChangelog(page('data-id="5671996645" data-name="decoy"'), url, { now })[0]?.sourceUrl, url);
  assert.equal(parseChangelog(page('data-id="5671996645" id="actual-release-id"'), url, { now })[0]?.sourceUrl, `${url}#actual-release-id`);
});

test('GitHub release bullets keep their whole sentence: data-id is no anchor and a (#123) tail is stripped whole', () => {
  const pull = (number: number) => `(<a class="issue-link js-issue-link" data-error-text="Failed to load title" data-id="5671996645" data-permission-text="Title is private" data-url="https://github.com/openai/codex/issues/${number}" data-hovercard-type="pull_request" data-hovercard-url="/openai/codex/pull/${number}/hovercard" href="https://github.com/openai/codex/pull/${number}">#${number}</a>)`;
  const html = `<h2>New Features</h2>\n<ul>\n<li>Tune remote compaction for custom providers. ${pull(50148)}</li>\n<li>Add checkpoint listing to the agent Command Center ${pull(51500)}</li>\n</ul>`;
  const escaped = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const items = parseChangelog(rss('Codex CLI Release: 1.2.3', escaped), url, { now });
  assert.deepEqual(items.map(item => [item.title, item.description]), [
    ['Tune remote compaction for custom providers.', 'Tune remote compaction for custom providers.'],
    ['Add checkpoint listing to the agent Command Center', 'Add checkpoint listing to the agent Command Center'],
  ]);
});
