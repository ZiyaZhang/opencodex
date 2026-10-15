import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectTarball } from './artifact.js';

export interface NativeVerificationInput { archive: string; sha256: string; directory: string; signal: AbortSignal }
export interface NativeVerificationReport { passed: boolean; packageName: string; version: string; phases: unknown[]; limitations: string[] }
export class VerificationUnavailableError extends Error {}
export function dshCliPath(): string {
  const require = createRequire(import.meta.url);
  try { return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js'); }
  catch {
    // A profile-local plugin may not resolve the globally installed CLI as its dependency.
    const entry = process.argv[1];
    if (entry) {
      try {
        const manifest = JSON.parse(readFileSync(join(dirname(entry), '../package.json'), 'utf8'));
        if (manifest.name === '@deepseek-ai/dsh' && entry.endsWith('/lib/bin.js')) return resolve(entry);
      } catch { /* Report the unavailable runtime; never launch a guessed executable. */ }
    }
    throw new VerificationUnavailableError('Cannot resolve the installed DSH CLI for isolated verification');
  }
}
async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(error => error ? reject(error) : resolve((address as { port: number }).port)); });
  });
}
export async function runNativeVerification(input: NativeVerificationInput): Promise<NativeVerificationReport> {
  input.signal.throwIfAborted();
  const cli = dshCliPath(), probe = fileURLToPath(new URL('./acceptance-probe.js', import.meta.url));
  const bytes = await readFile(input.archive);
  if (createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new Error('Verification package digest changed');
  const manifest = inspectTarball(bytes);
  const home = resolve(input.directory), nonce = randomUUID();
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(home, 'opencodex-verification'), nonce, { flag: 'wx', mode: 0o600 });
  const archive = join(home, 'candidate.tgz');
  await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
  const result: NativeVerificationReport = { passed: false, packageName: manifest.packageName, version: manifest.version, phases: [], limitations: ['Native package lifecycle only. Client rendering, feature behavior, feature-specific persistence and visual equivalence require separate verification.'] };
  for (const phase of ['install', 'disable', 'enable', 'remove', 'removed']) {
    input.signal.throwIfAborted();
    const config = { home: await realpath(home), archive, phase, nonce, packageName: manifest.packageName, version: manifest.version };
    const patch = join(home, `${phase}.patch.yml`);
    await writeFile(patch, `- id: session-title-llm\n  disabled: true\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: llm-pi-ai\n  disabled: true\n- insert:\n    - id: opencodex-acceptance-probe\n      name: ${JSON.stringify(probe)}\n      config: ${JSON.stringify(config)}\n`, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR, HOME: home, DSH_HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data') };
    if (process.platform === 'win32') { env.SystemRoot = process.env.SystemRoot; env.USERPROFILE = home; }
    const args = [cli, '--profile', 'verification', ...(phase === 'install' ? ['--from-default-profile', 'web'] : []), '--patch', patch, '--host', '127.0.0.1', '--port', String(await freePort()), '--no-open'];
    const child = spawn(process.execPath, args, { cwd: home, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', exited = false;
    const completion = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => { exited = true; resolve(); }); });
    void completion.catch(() => undefined);
    const terminate = (signal: NodeJS.Signals) => {
      if (!child.pid || (process.platform === 'win32' && exited)) return;
      try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    const onAbort = () => terminate('SIGTERM');
    input.signal.addEventListener('abort', onAbort, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output += chunk.toString(); if (output.length > 2_000_000) { output = output.slice(0, 2_000_000); terminate('SIGTERM'); } });
    try {
      let observed: Record<string, unknown> | undefined;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        input.signal.throwIfAborted();
        try { observed = JSON.parse(await readFile(join(home, `${phase}.json`), 'utf8')); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (exited) throw new Error(`Isolated DSH exited during ${phase}; inspect its retained log`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!observed || observed.nonce !== nonce || observed.phase !== phase) throw new Error(`No matching isolated ${phase} receipt`);
      result.phases.push(observed);
      if (observed.passed !== true) throw new Error(`Isolated ${phase} failed: ${String(observed.error ?? 'No passing receipt')}`);
    } finally {
      input.signal.removeEventListener('abort', onAbort); terminate('SIGTERM');
      const force = setTimeout(() => terminate('SIGKILL'), 3000);
      try { await completion; } finally { terminate('SIGKILL'); clearTimeout(force); await writeFile(join(home, `${phase}.log`), output, { mode: 0o600 }); }
    }
  }
  result.passed = true;
  return result;
}
