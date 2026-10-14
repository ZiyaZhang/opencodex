import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export const MARKER = '.opencodex-output-qa.json';
const KIND = 'opencodex-output-qa';

function within(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function selectedHome(value) {
  if (!value || !isAbsolute(value)) throw new Error('Set OPENCODEX_QA_HOME to an absolute, dedicated acceptance directory');
  const selected = resolve(value);
  const userHome = realpathSync(homedir());
  const dailyHome = join(userHome, '.dsh');
  const canonical = existsSync(selected) ? realpathSync(selected) : selected;
  if (canonical === parse(canonical).root || canonical === userHome || within(dailyHome, canonical)
    || (existsSync(dailyHome) && within(realpathSync(dailyHome), canonical))) {
    throw new Error('Refusing the daily ~/.dsh directory, a subdirectory of it, or a filesystem/home root');
  }
  if (existsSync(selected) && (!lstatSync(selected).isDirectory() || lstatSync(selected).isSymbolicLink())) {
    throw new Error('The QA home must be a real directory, not a symlink');
  }
  return selected;
}

function readMarker(root) {
  const path = join(root, MARKER);
  if (!existsSync(path)) throw new Error('Missing dedicated QA marker; run init.mjs first');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid QA marker file');
  const marker = JSON.parse(readFileSync(path, 'utf8'));
  if (marker.kind !== KIND || marker.version !== 1 || marker.home !== realpathSync(root)) throw new Error('Invalid QA marker contents');
}

/** Only initialize an empty directory, or reuse a previously marked fixture home. */
export function initializeFixtureHome(value = process.env.OPENCODEX_QA_HOME) {
  const selected = selectedHome(value);
  mkdirSync(selected, { recursive: true, mode: 0o700 });
  const root = realpathSync(selected);
  // Recheck after creation: an existing ancestor may itself be a symlink.
  selectedHome(root);
  if (existsSync(join(root, MARKER))) readMarker(root);
  else {
    if (readdirSync(root).length) throw new Error('Refusing an unmarked, nonempty directory; choose a new dedicated QA home');
    writeFileSync(join(root, MARKER), `${JSON.stringify({ kind: KIND, version: 1, home: root }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  return root;
}

export function assertFixtureHome(env = process.env) {
  const selected = selectedHome(env.OPENCODEX_QA_HOME);
  if (!existsSync(selected)) throw new Error('QA home does not exist; run init.mjs first');
  const root = realpathSync(selected);
  readMarker(root);
  if (!env.DSH_HOME || !isAbsolute(env.DSH_HOME) || !existsSync(env.DSH_HOME) || realpathSync(env.DSH_HOME) !== root) {
    throw new Error('DSH_HOME must explicitly match the marked OPENCODEX_QA_HOME');
  }
  return root;
}

export function controlPort(value = process.env.OPENCODEX_QA_CONTROL_PORT ?? '53752') {
  if (!/^\d+$/.test(String(value))) throw new Error('Invalid fixture control port');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture control port');
  return port;
}
