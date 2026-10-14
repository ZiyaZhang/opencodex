import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { JobReferenceThumbnail, ScreenshotGallery } from '../src/client/page.js';
import type { Artifact } from '../src/core/types.js';
import type { OpenCodexRequest, OpenCodexResponse } from '../src/host/remote.js';

const picture = { mimeType: 'image/png' as const, dataBase64: 'image-bytes' };
const response = (extra: Partial<OpenCodexResponse> = {}) => ({ ...extra } as OpenCodexResponse);
function shot(id: string, subject: 'codex' | 'dsh'): Artifact {
  return { id, jobId: 'job', path: `job/${id}.png`, label: id, kind: 'screenshot', sha256: id, bytes: 20, createdAt: '2026-10-14T00:00:00Z', screenshot: { subject, caption: `${subject} visible feature`, provenance: 'capture', version: '1.0' } };
}

test('gallery loads the latest target and implementation by artifact ID and retains source captions', async () => {
  const calls: OpenCodexRequest[] = [];
  const call = async (request: OpenCodexRequest) => { calls.push(request); return response({ screenshot: picture }); };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ScreenshotGallery, { jobId: 'job', artifacts: [shot('old', 'codex'), shot('new', 'codex'), shot('result', 'dsh')], call })); });
  assert.deepEqual(calls, [{ action: 'readScreenshot', jobId: 'job', artifactId: 'new' }, { action: 'readScreenshot', jobId: 'job', artifactId: 'result' }]);
  assert.deepEqual(renderer.root.findAllByType('img').map(image => image.props.alt), ['codex visible feature', 'dsh visible feature']);
  await act(async () => { renderer.root.findByType('select').props.onChange({ target: { value: 'old' } }); });
  assert.deepEqual(calls.at(-1), { action: 'readScreenshot', jobId: 'job', artifactId: 'old' });
  assert.equal(calls.length, 3);
  await act(async () => renderer.unmount());
});

test('old draft uploads remain visible; missing DSH image stays an explicit gap', async () => {
  const calls: OpenCodexRequest[] = [];
  const call = async (request: OpenCodexRequest) => { calls.push(request); return response({ referenceImage: picture }); };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ScreenshotGallery, { jobId: 'draft', artifacts: [], call })); });
  assert.deepEqual(calls, [{ action: 'readReferenceImage', jobId: 'draft' }]);
  assert.equal(renderer.root.findAllByType('img').length, 1);
  assert.match(JSON.stringify(renderer.toJSON()), /尚无实现截图/);
  await act(async () => renderer.unmount());
});

test('changing jobs aborts the old image request and ignores its late response', async () => {
  let resolveOld!: (value: OpenCodexResponse) => void;
  let oldSignal!: AbortSignal;
  const call = async (request: OpenCodexRequest, signal?: AbortSignal) => {
    if ('jobId' in request && request.jobId === 'old') { oldSignal = signal!; return new Promise<OpenCodexResponse>(resolve => { resolveOld = resolve; }); }
    return response();
  };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ScreenshotGallery, { jobId: 'old', artifacts: [], call })); });
  await act(async () => { renderer.update(createElement(ScreenshotGallery, { jobId: 'new', artifacts: [], call })); });
  assert.equal(oldSignal.aborted, true);
  await act(async () => { resolveOld(response({ referenceImage: picture })); });
  assert.equal(renderer.root.findAllByType('img').length, 0);
  assert.match(JSON.stringify(renderer.toJSON()), /尚缺参考截图/);
  await act(async () => renderer.unmount());
});

test('image read failures remain visible instead of becoming a successful reference', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ScreenshotGallery, { jobId: 'job', artifacts: [], call: async () => { throw new Error('Recorded image hash changed'); } })); });
  assert.equal(renderer.root.findAllByType('img').length, 0);
  assert.match(renderer.root.findByProps({ role: 'alert' }).children.join(''), /hash changed/);
  await act(async () => renderer.unmount());
});

test('list thumbnails load real references once across snapshot refreshes and reload changed artifacts', async () => {
  const calls: OpenCodexRequest[] = [];
  const call = async (request: OpenCodexRequest) => { calls.push(request); return response({ screenshot: picture }); };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(JobReferenceThumbnail, { jobId: 'job', artifacts: [shot('reference', 'codex')], call })); });
  await act(async () => { renderer.update(createElement(JobReferenceThumbnail, { jobId: 'job', artifacts: [shot('reference', 'codex')], call })); });
  assert.equal(calls.length, 1);
  assert.equal(renderer.root.findByType('img').props.alt, 'codex visible feature');
  await act(async () => { renderer.update(createElement(JobReferenceThumbnail, { jobId: 'job', artifacts: [{ ...shot('reference', 'codex'), sha256: 'changed' }], call })); });
  assert.equal(calls.length, 2);
  await act(async () => renderer.unmount());
});

test('list thumbnail keeps legacy uploads visible and distinguishes missing references', async () => {
  const calls: OpenCodexRequest[] = [];
  const call = async (request: OpenCodexRequest) => { calls.push(request); return response('jobId' in request && request.jobId === 'legacy' ? { referenceImage: picture } : {}); };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(JobReferenceThumbnail, { jobId: 'legacy', artifacts: [], call })); });
  assert.equal(renderer.root.findAllByType('img').length, 1);
  await act(async () => { renderer.update(createElement(JobReferenceThumbnail, { jobId: 'missing', artifacts: [], call })); });
  assert.equal(renderer.root.findAllByType('img').length, 0);
  assert.match(JSON.stringify(renderer.toJSON()), /缺参考图/);
  assert.deepEqual(calls, [{ action: 'readReferenceImage', jobId: 'legacy' }, { action: 'readReferenceImage', jobId: 'missing' }]);
  await act(async () => renderer.unmount());
});

test('list thumbnail cancels a previous job request and ignores its late picture', async () => {
  let resolveOld!: (value: OpenCodexResponse) => void;
  let signalOld!: AbortSignal;
  const call = async (request: OpenCodexRequest, signal?: AbortSignal) => {
    if ('jobId' in request && request.jobId === 'old') { signalOld = signal!; return new Promise<OpenCodexResponse>(resolve => { resolveOld = resolve; }); }
    return response();
  };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(JobReferenceThumbnail, { jobId: 'old', artifacts: [], call })); });
  await act(async () => { renderer.update(createElement(JobReferenceThumbnail, { jobId: 'new', artifacts: [], call })); });
  assert.equal(signalOld.aborted, true);
  await act(async () => { resolveOld(response({ referenceImage: picture })); });
  assert.equal(renderer.root.findAllByType('img').length, 0);
  await act(async () => renderer.unmount());
});
