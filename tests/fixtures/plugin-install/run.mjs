import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
await mkdir(join(root, '.local'), { recursive: true });
const home = await mkdtemp(join(root, '.local/native-install-'));
const archive = resolve(process.argv[2] ?? join(root, 'examples/async-questions/release/dsh-opencodex-async-questions-0.1.0.tgz'));
await writeFile(join(home, 'native-install-fixture'), 'isolated native installation fixture');
await build({ entryPoints: [join(root, 'tests/fixtures/plugin-install/host.ts')], outfile: join(home, 'host.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22' });
console.log(JSON.stringify({ home, archive }));
for (const phase of ['install', 'disable', 'enable', 'remove', 'removed']) {
  const patch = join(home, 'fixture.patch.yml');
  await writeFile(patch, `- id: session-title-llm\n  disabled: true\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: llm-pi-ai\n  disabled: true\n- insert:\n    - id: native-install-fixture\n      name: ${JSON.stringify(join(home, 'host.mjs'))}\n      config: ${JSON.stringify({ home, archive, phase })}\n`);
  const log = createWriteStream(join(home, `${phase}.log`));
  const env = { ...process.env, DSH_HOME: home };
  // No sessions are created and no model is called in this test.
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete env[key];
  const args = ['node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'native-install-qa', ...(phase === 'install' ? ['--from-default-profile', 'web'] : []), '--patch', patch, '--host', '127.0.0.1', '--port', '53753', '--no-open'];
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    let result;
    for (let i = 0; i < 120; i++) {
      try { result = JSON.parse(await readFile(join(home, `${phase}.json`), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.equal(child.exitCode, null, `DSH exited early; inspect ${phase}.log`);
      await delay(1000);
    }
    assert.ok(result, `Timed out; inspect ${phase}.log`);
    assert.equal(result.passed, true, JSON.stringify(result));
    console.log(JSON.stringify({ phase, passed: result.passed, packageName: result.packageName, application: result.result?.application }));
  } finally {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited; clearTimeout(force); log.end();
  }
}
