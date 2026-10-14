import type { Artifact } from '../core/types.js';
import type { OpenCodexRequest, OpenCodexResponse } from '../host/remote.js';

type Call = (request: OpenCodexRequest, signal?: AbortSignal) => Promise<OpenCodexResponse>;
const MAX_PACKAGE_BYTES = 16_000_000;
const MAX_CHUNK_BYTES = 512 * 1024;

/** Fetch only registered packages, rejecting changed or incomplete transfers before saving. */
export async function fetchPluginArtifact(call: Call, jobId: string, artifact: Artifact, signal: AbortSignal, progress?: (received: number, total: number) => void) {
  if (artifact.kind !== 'plugin' || artifact.jobId !== jobId || !/^[a-f0-9]{64}$/.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > MAX_PACKAGE_BYTES) throw new Error('插件包登记信息无效');
  const bytes = new Uint8Array(artifact.bytes);
  let offset = 0, filename = '', requests = 0;
  while (offset < bytes.byteLength) {
    signal.throwIfAborted();
    if (++requests > 1024) throw new Error('插件包分片数量异常');
    const result = await call({ action: 'readPluginArtifact', jobId, artifactId: artifact.id, offset }, signal);
    signal.throwIfAborted();
    const part = result.pluginArtifact;
    if (!part || part.offset !== offset || part.totalBytes !== artifact.bytes || part.sha256 !== artifact.sha256) throw new Error('插件包在下载期间发生变化，请重新检查产物');
    if (typeof part.filename !== 'string' || !/^[^/\\\x00-\x1f\x7f]{1,180}\.(?:tgz|tar\.gz)$/.test(part.filename)
        || (filename && part.filename !== filename)) throw new Error('插件包文件名无效或已变化');
    if (typeof part.dataBase64 !== 'string' || part.dataBase64.length > 4 * Math.ceil(MAX_CHUNK_BYTES / 3)
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.dataBase64)) throw new Error('插件包分片编码无效');
    filename = part.filename;
    const decoded = atob(part.dataBase64);
    if (!decoded.length || decoded.length > MAX_CHUNK_BYTES || offset + decoded.length > bytes.byteLength) throw new Error('插件包分片长度无效');
    for (let i = 0; i < decoded.length; i++) bytes[offset + i] = decoded.charCodeAt(i);
    offset += decoded.length;
    if (offset < bytes.byteLength ? part.nextOffset !== offset : part.nextOffset !== undefined) throw new Error('插件包传输不完整或分片顺序错误');
    progress?.(offset, bytes.byteLength);
  }
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器无法校验文件，请在受支持的本机浏览器中下载');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  signal.throwIfAborted();
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== artifact.sha256) throw new Error('插件包 SHA-256 校验失败，未保存文件');
  return { filename, bytes };
}
