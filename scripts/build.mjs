import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Anchor every relative path below to the repository root, so the script behaves the same from any directory.
// esbuild captures process.cwd() when it is imported, before this runs, so its builds also get absWorkingDir.
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);

await rm('dist', { recursive: true, force: true });
await mkdir('dist/host', { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ['src/host/index.ts'], outfile: 'dist/host/index.js',
  bundle: true, packages: 'external', platform: 'node', target: 'node22',
  format: 'esm', sourcemap: true,
});
const client = await build({
  absWorkingDir: root, entryPoints: ['src/client/index.tsx'], bundle: true, write: false,
  platform: 'browser', target: 'es2022', format: 'cjs', jsx: 'automatic',
  // DSH resolves these from its own module table at load time, the DSH controls (`dsh-client-ui-primitives`) by their bare package name.
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'],
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text' }, minify: true,
});
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:"dsh-opencodex",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
execFileSync('node', ['node_modules/typescript/bin/tsc', '--declaration', '--emitDeclarationOnly', '--outDir', 'dist/types', '--rootDir', 'src', '--project', 'tsconfig.build.json'], { stdio: 'inherit' });
