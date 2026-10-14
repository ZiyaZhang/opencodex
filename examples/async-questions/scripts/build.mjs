import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(pkg.name)) {
  throw new Error('Scaffold a valid package name before building.');
}

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist/host', import.meta.url), { recursive: true });
await mkdir(new URL('../release', import.meta.url), { recursive: true });

// Public declarations validate the registration and emit distributable types.
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'),
  '--project', 'tsconfig.json', '--emitDeclarationOnly',
  '--outDir', 'dist/types', '--rootDir', 'src'], { cwd: root, stdio: 'inherit' });

await build({
  absWorkingDir: root,
  entryPoints: ['src/host/index.ts'], outfile: 'dist/host/index.js',
  bundle: true, packages: 'external', platform: 'node', target: 'node22',
  format: 'esm', sourcemap: true,
});
const client = await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.tsx'], bundle: true, write: false,
  platform: 'browser', target: 'es2022', format: 'cjs', jsx: 'automatic',
  // Shared React, Context and DSH service identities come from the host loader.
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/*'],
  define: { 'process.env.NODE_ENV': '"production"' },
});
if (client.outputFiles.length !== 1) throw new Error('Load additional emitted assets explicitly.');
await writeFile(new URL('../dist/client.js', import.meta.url),
  `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);

// These checks cover build/package wiring only, not the feature's behavior.
for (const entry of [pkg.main, pkg.types, pkg.exports['./client'].default,
  pkg.exports['./client'].types, pkg.dsh.bundle.patch]) {
  await readFile(new URL(`../${entry}`, import.meta.url));
}
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
if (!patch.includes(`name: ${pkg.name}\n`)) throw new Error('Patch package name does not match.');
console.log(`Built ${pkg.name}: Host, Client loader, declarations and patch checked.`);
