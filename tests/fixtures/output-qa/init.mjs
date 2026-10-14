import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeFixtureHome } from './home.mjs';

const root = initializeFixtureHome();
const fixtureModule = fileURLToPath(new URL('./index.mjs', import.meta.url));
const template = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8');
const patch = join(root, 'output-qa.patch.yml');
if (existsSync(patch) && (!lstatSync(patch).isFile() || lstatSync(patch).isSymbolicLink())) throw new Error('Refusing a non-file or symlink at the QA patch path');
writeFileSync(patch, template.replace('__FIXTURE_MODULE__', JSON.stringify(fixtureModule)), { mode: 0o600 });
console.log(JSON.stringify({ home: root, patch }, null, 2));
