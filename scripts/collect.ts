// Phase 1 acceptance: one collection run without DSH, printing the check result and the stored candidates.
// Usage: npx tsx scripts/collect.ts --home <data dir> [--mirror <DSH mirror>] [--plist <Info.plist>] [--locale zh-CN]
// An empty --mirror (the default) skips the index, an empty --plist the desktop source. Exit code 1 when the check reports errors.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SOURCES } from '../src/core/candidate.ts';
import { ValidationError } from '../src/core/check.ts';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/core/settings.ts';
import { CandidateStore } from '../src/core/store.ts';
import { runCheck } from '../src/host/collector.ts';

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    mirror: { type: 'string', default: '' },
    plist: { type: 'string', default: DEFAULT_SETTINGS.desktopPlistPath },
    locale: { type: 'string', default: DEFAULT_SETTINGS.desktopLocale },
  },
});
if (!values.home) { console.error('--home is required'); process.exit(2); }
/** Settings hold absolute paths; '' stays '' and switches that part off. */
const absolute = (path: string | undefined) => (path ? resolve(path) : '');
const settings = (() => {
  try { return mergeSettings(DEFAULT_SETTINGS, { dshMirrorPath: absolute(values.mirror), desktopPlistPath: absolute(values.plist), desktopLocale: values.locale }); }
  catch (error) { if (error instanceof ValidationError) { console.error(error.message); process.exit(2); } throw error; }
})();
const home = resolve(values.home);
const store = new CandidateStore(home);
const result = await runCheck({ directory: home, store, settings, signal: new AbortController().signal });
console.log(JSON.stringify(result, null, 2));
const { desktop } = result;
console.log(`desktop: version ${desktop.version || '(none)'}, changed ${desktop.changed}, added ${desktop.added}, keys ${desktop.keys}, localeBundle ${desktop.localeBundle ?? '(none)'}, keysReset ${desktop.keysReset ?? false}`);
// Grouped by source in source order (newest first within one), so the first 30 lines are not all from whichever source ran last.
const all = (await store.list()).sort((a, b) => SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source));
console.log(`candidates: ${all.length} (${SOURCES.map(source => `${source} ${all.filter(c => c.source === source).length}`).join(', ')})`);
for (const c of all.slice(0, 30)) console.log(`- [${c.source}] ${c.title} (${c.evidence.length} evidence)`);
process.exitCode = result.errors.length > 0 ? 1 : 0;
