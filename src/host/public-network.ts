import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

/** Read the configured macOS HTTPS proxy; never discover or change proxy settings. */
export function macOSHttpsProxy(settings: string): string | undefined {
  const value = (key: string) => settings.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)\\s*$`, 'm'))?.[1];
  if (value('HTTPSEnable') !== '1') return undefined;
  const host = value('HTTPSProxy'), port = Number(value('HTTPSPort'));
  if (!host || !/^[\w.:[\]-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid system HTTPS proxy configuration');
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}

/** Scoped to public-source requests. It does not alter global fetch or the DSH transport. */
export async function publicNetwork(signal: AbortSignal): Promise<{ fetch: typeof globalThis.fetch; route: string; close(): Promise<void> }> {
  signal.throwIfAborted();
  let dispatcher: Dispatcher | undefined, route = 'direct';
  if (['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'].some(key => process.env[key])) {
    dispatcher = new EnvHttpProxyAgent(); route = 'environment-proxy';
  } else if (process.platform === 'darwin') {
    const { stdout } = await promisify(execFile)('/usr/sbin/scutil', ['--proxy'], { signal, timeout: 2000, maxBuffer: 64 * 1024 });
    const proxy = macOSHttpsProxy(stdout);
    if (proxy) { dispatcher = new ProxyAgent(proxy); route = 'system-proxy'; }
  }
  // Keep fetch and its dispatcher on the same undici version; Node's bundled ABI can differ.
  const request: typeof globalThis.fetch = (url, init) => undiciFetch(url as string, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
  return { fetch: request, route, close: async () => { await dispatcher?.destroy(); } };
}
