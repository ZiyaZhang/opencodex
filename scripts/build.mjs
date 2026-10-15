import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

await mkdir('dist/host', { recursive: true });
await build({
  entryPoints: ['src/host/index.ts'], outfile: 'dist/host/index.js',
  bundle: true, packages: 'external', platform: 'node', target: 'node22',
  format: 'esm', sourcemap: true,
});
const client = await build({
  entryPoints: ['src/client/index.tsx'], bundle: true, write: false,
  platform: 'browser', target: 'es2022', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots'],
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text' }, minify: true,
});
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:"dsh-opencodex",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
execFileSync('node', ['node_modules/typescript/bin/tsc', '--declaration', '--emitDeclarationOnly', '--outDir', 'dist/types', '--rootDir', 'src', '--project', 'tsconfig.build.json'], { stdio: 'inherit' });
