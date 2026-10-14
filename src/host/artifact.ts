/** Structural package inspection; never executes generated code or install scripts. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

export function inspectTarball(bytes: Buffer): { passed: boolean; details: string[]; packageName: string; version: string } {
  if (bytes.byteLength > 16_000_000) throw new Error('Generated package exceeds the 16 MB inspection limit');
  const tar = gunzipSync(bytes, { maxOutputLength: 32_000_000 });
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const recordedChecksum = Number.parseInt(header.subarray(148, 156).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    const calculatedChecksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (recordedChecksum !== calculatedChecksum) throw new Error('Invalid tar header checksum');
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    const type = String.fromCharCode(header[156] ?? 0);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid tar entry size');
    if (!path.startsWith('package/') || path.split('/').includes('..') || path.includes('\\')) throw new Error('Unsafe archive path');
    if (type !== '\0' && type !== '0' && type !== '5') throw new Error('Package inspection does not accept links or extended tar entries');
    if (type !== '5') {
      if (files.has(path)) throw new Error('Duplicate archive entry');
      files.set(path, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const manifestBytes = files.get('package/package.json');
  if (!manifestBytes) throw new Error('Package tarball has no package.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  const dsh = manifest.dsh as { bundle?: { patch?: string } } | undefined;
  const patch = dsh?.bundle?.patch;
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Error('Package requires a name and version');
  if (manifest.name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.name)) throw new Error('Invalid plugin package name');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error('Plugin requires a concrete package version');
  if (manifest.name === 'dsh-opencodex' || manifest.name.startsWith('@deepseek-ai/')) throw new Error('Generated features require their own package name, not OpenCodex or a DSH host package');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) throw new Error(`Invalid ${field}`);
    for (const [name, spec] of Object.entries(dependencies)) {
      if (name === 'dsh-opencodex') throw new Error('Feature plugins must run independently of OpenCodex');
      if (typeof spec !== 'string' || /^(?:file:|link:|workspace:|\/|\.\.?[\\/]|[a-zA-Z]:[\\/])/.test(spec)) throw new Error('Feature runtime dependencies must not reference a local research workspace');
    }
  }
  if (typeof patch !== 'string' || !files.has(`package/${patch.replace(/^\.\//, '')}`)) throw new Error('Package requires a shipped dsh.bundle.patch');
  if (![...files.keys()].some(path => /\.(?:js|mjs|cjs)$/.test(path))) throw new Error('Package has no compiled JavaScript entry');
  const scripts = manifest.scripts as Record<string, unknown> | undefined;
  if (scripts && ['preinstall', 'install', 'postinstall'].some(key => key in scripts)) throw new Error('Generated bundles must not execute lifecycle install scripts');
  return { passed: true, packageName: manifest.name, version: manifest.version, details: [`Inspected ${manifest.name}@${manifest.version}: ${files.size} files; bundle patch and compiled JavaScript present.`, 'No code was executed. Behavior, visuals and lifecycle still require independent isolated acceptance.'] };
}

export async function inspectArtifact(path: string, expectedHash: string): Promise<{ passed: boolean; details: string[] }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16_000_000) throw new Error('Generated package exceeds the 16 MB inspection limit or is not a regular file');
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65_536, 16_000_001 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > 16_000_000) throw new Error('Generated package exceeds the 16 MB inspection limit');
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  const bytes = Buffer.concat(chunks, total);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('Artifact bytes changed after registration');
  return inspectTarball(bytes);
}
