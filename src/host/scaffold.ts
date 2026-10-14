/** Copy a fixed, feature-free packaged skeleton into a fresh job-local directory. */
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Job } from '../core/types.js';

export const SCAFFOLD_FILES = [
  'package.json', 'package-lock.json', 'cordis.patch.yml', 'src/host/index.ts',
  'src/client/index.tsx', 'scripts/build.mjs', 'tsconfig.json', 'README.md',
] as const;
const MAX_FILE_BYTES = 128_000;
const MAX_TOTAL_BYTES = 512_000;

async function directoryWithoutSymlinks(root: string, parts: string[]): Promise<string> {
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Scaffold paths must be directories without symlinks');
  }
  return path;
}

async function templateText(root: string, name: string): Promise<string> {
  const parts = name.split('/');
  await directoryWithoutSymlinks(root, parts.slice(0, -1));
  const file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Scaffold template is not a bounded regular file');
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await file.read(bytes, length, bytes.length - length, null);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw new Error('Scaffold template exceeds the read limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await file.close(); }
}

export async function scaffoldPlugin(packageRoot: string, artifactRoot: string, job: Job, packageName: string) {
  if (job.mode !== 'reconstruct') throw new Error('Scaffolding is available only for reconstruction jobs');
  if (!['researching', 'specifying', 'building'].includes(job.status)) throw new Error('Scaffolding requires an active reconstruction job');
  if (typeof packageName !== 'string' || packageName.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(packageName) || ['node_modules', 'favicon.ico'].includes(packageName)) throw new Error('packageName must be an unscoped lowercase npm name using letters, digits and single hyphens, at most 80 characters');
  if (!job.workdir || !job.sessionId) throw new Error('Scaffolding requires the dedicated research workspace');
  if (!/^[A-Za-z0-9_-]+$/.test(job.id)) throw new Error('Scaffold job identity must be one path segment');
  const artifacts = await realpath(artifactRoot);
  const workdir = await directoryWithoutSymlinks(artifacts, [job.id]);
  if (await realpath(workdir) !== resolve(job.workdir)) throw new Error('Scaffold workspace does not match the bound job');
  const destination = join(workdir, 'plugin');
  const checkDestination = async () => {
    try {
      const stat = await lstat(destination);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Scaffold destination must be an empty directory without symlinks');
      if ((await readdir(destination)).length) throw new Error('Scaffold destination must be empty; existing files will not be overwritten');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  await checkDestination();
  const source = await directoryWithoutSymlinks(await realpath(packageRoot), ['templates', 'dsh-plugin']);
  const contents = new Map<string, string>();
  let total = 0;
  for (const name of SCAFFOLD_FILES) {
    const content = (await templateText(source, name)).replaceAll('__PLUGIN_NAME__', packageName);
    total += Buffer.byteLength(content);
    if (total > MAX_TOTAL_BYTES) throw new Error('Scaffold templates exceed the total read limit');
    contents.set(name, content);
  }
  const manifest = JSON.parse(contents.get('package.json')!) as { version: string; devDependencies: Record<string, string> };
  const quickstart = {
    templateDependencies: Object.fromEntries(Object.entries(manifest.devDependencies).filter(([name]) => name.startsWith('@deepseek-ai/'))),
    clientEntry: 'src/client/index.tsx',
    clientSource: contents.get('src/client/index.tsx')!,
    hostEntry: 'src/host/index.ts',
    commands: ['npm ci', 'npm run build', 'npm test', 'npm run package'],
    commandDirectory: 'plugin',
    output: `plugin/release/${packageName}-${manifest.version}.tgz`,
    files: [...contents].map(([path, content]) => ({ path, sha256: createHash('sha256').update(content).digest('hex') })),
    note: 'These are the shipped template targets, not a probe of the running host. No dependencies were installed and no build was run. Implement the feature in clientEntry using the supplied exact source; inspect other files only for a concrete change or failure. Keep shared React and DSH modules external as configured in scripts/build.mjs. The starter is empty, not an implemented feature.',
  };
  const temporary = await mkdtemp(join(workdir, '.opencodex-scaffold-'));
  try {
    for (const [name, content] of contents) {
      const path = join(temporary, name);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, content, { flag: 'wx', mode: 0o600 });
    }
    await checkDestination();
    // rename refuses a nonempty destination, so a concurrent file is never replaced.
    await rename(temporary, destination);
    return { path: 'plugin' as const, packageName, files: [...SCAFFOLD_FILES], quickstart };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
