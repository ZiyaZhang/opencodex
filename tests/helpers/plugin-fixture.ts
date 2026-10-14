import { gzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenCodexStore } from '../../src/core/store.js';

export function fixtureTarball(manifest: Record<string, unknown> = {}): Buffer {
  const files = {
    'package/package.json': JSON.stringify({ name: 'dsh-install-fixture', version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } }, ...manifest }),
    'package/cordis.patch.yml': '- insert:\n    - id: opencodex-install-fixture\n      name: dsh-install-fixture\n',
    'package/index.js': 'export function apply(ctx) { ctx.on("dispose", () => {}); }\n',
  };
  const chunks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content), header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write('0000644\0', 100, 8);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12); header[156] = 48;
    header.fill(32, 148, 156);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

/** Synthetic records test orchestration, never claim acceptance of a product feature. */
export async function verifyingPlugin(store: OpenCodexStore, bytes = fixtureTarball()) {
  const job = await store.createJob({ title: 'Synthetic installation contract fixture' });
  await store.transitionJob(job.id, 'queued'); await store.transitionJob(job.id, 'researching');
  await mkdir(join(store.artifactRoot, job.id), { recursive: true });
  await writeFile(join(store.artifactRoot, job.id, 'fixture.log'), 'Synthetic evidence for testing installation state transitions only.');
  const evidence = await store.addEvidence(job.id, { kind: 'observed', claim: 'Synthetic unit-test fixture', localPath: `${job.id}/fixture.log` });
  await store.transitionJob(job.id, 'specifying');
  await store.saveSpec(job.id, { title: 'Synthetic plugin', behavior: ['Fixture'], visual: ['Fixture'], lifecycle: ['Fixture'], existingCapabilities: [], gaps: [], evidenceIds: [evidence.id] });
  await store.transitionJob(job.id, 'building');
  await writeFile(join(store.artifactRoot, job.id, 'feature.tgz'), bytes);
  const artifact = await store.registerArtifact(job.id, { kind: 'plugin', path: `${job.id}/feature.tgz` });
  const screenshotIds: string[] = [];
  for (const subject of ['codex', 'dsh'] as const) {
    const path = `${job.id}/${subject}.png`;
    await writeFile(join(store.artifactRoot, path), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZQAAAAASUVORK5CYII=', 'base64'));
    screenshotIds.push((await store.registerArtifact(job.id, { kind: 'screenshot', path, screenshot: { subject, caption: 'Synthetic unit-test image; no product fidelity evidence', provenance: 'user' } })).id);
  }
  await store.transitionJob(job.id, 'verifying');
  const verification = (scope: 'behavior' | 'visual' | 'lifecycle') => ({ artifactId: artifact.id, scope, outcome: 'passed' as const, method: 'manual' as const, environment: 'isolated' as const, details: 'Synthetic orchestration acceptance fixture', evidenceIds: [evidence.id], ...(scope === 'visual' ? { screenshotIds } : {}) });
  return { jobId: job.id, artifact, bytes, verification };
}
