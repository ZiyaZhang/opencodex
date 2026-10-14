import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SCREENSHOT_BYTES, OpenCodexStore, validateScreenshotBytes, validateState, type ScreenshotMetadata, type VerificationInput } from '../src/core/index.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZQAAAAASUVORK5CYII=', 'base64');
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const metadata = (subject: ScreenshotMetadata['subject']): ScreenshotMetadata => ({ subject, caption: 'Synthetic contract fixture; not product evidence', provenance: 'user' });

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'opencodex-image-'));
  const store = await OpenCodexStore.open({ directory });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const job = await store.createJob({ title: 'Generic visual comparison' });
  await mkdir(join(store.artifactRoot, job.id));
  await store.transitionJob(job.id, 'queued'); await store.transitionJob(job.id, 'researching');
  await writeFile(join(store.artifactRoot, 'probe.txt'), 'Synthetic observation');
  const evidence = await store.addEvidence(job.id, { kind: 'observed', claim: 'Fixture observation', localPath: 'probe.txt' });
  await store.saveSpec(job.id, { title: 'Fixture', behavior: ['Behavior criterion'], visual: ['Compare target and implementation'], lifecycle: ['Unload'], existingCapabilities: [], gaps: [], evidenceIds: [evidence.id] });
  await store.transitionJob(job.id, 'specifying'); await store.transitionJob(job.id, 'building');
  await writeFile(join(store.artifactRoot, 'plugin.tgz'), 'Synthetic package');
  const artifact = await store.registerArtifact(job.id, { path: 'plugin.tgz' });
  await store.transitionJob(job.id, 'verifying');
  async function screenshot(subject: ScreenshotMetadata['subject'], owner = job.id) {
    await mkdir(join(store.artifactRoot, owner), { recursive: true });
    const path = `${owner}/${subject}.png`; await writeFile(join(store.artifactRoot, path), PNG);
    return store.registerArtifact(owner, { kind: 'screenshot', path, screenshot: metadata(subject) });
  }
  const input: VerificationInput = { artifactId: artifact.id, scope: 'visual', outcome: 'passed', method: 'manual', environment: 'isolated', details: 'Synthetic fixture validation', evidenceIds: [evidence.id] };
  return { store, directory, job, artifact, screenshot, input };
}

test('new screenshot artifacts require scoped metadata and bounded image bytes', async t => {
  const f = await fixture(t);
  const path = `${f.job.id}/image.png`;
  await writeFile(join(f.store.artifactRoot, path), PNG);
  await assert.rejects(f.store.registerArtifact(f.job.id, { path, kind: 'screenshot' }), /screenshot metadata/);
  await assert.rejects(f.store.registerArtifact(f.job.id, { path, kind: 'report', screenshot: metadata('codex') }), /requires a screenshot/);
  for (const screenshot of [
    { ...metadata('codex'), subject: 'unknown' },
    { ...metadata('codex'), caption: '' },
    { ...metadata('codex'), provenance: 'assumed' },
    { ...metadata('codex'), provenance: 'public-source' },
    { ...metadata('codex'), sourceUrl: 'file:///private/path' },
  ]) await assert.rejects(f.store.registerArtifact(f.job.id, { path, kind: 'screenshot', screenshot: screenshot as ScreenshotMetadata }));
  for (const bytes of [Buffer.from('not an image'), Buffer.alloc(0), Buffer.alloc(MAX_SCREENSHOT_BYTES + 1), PNG.subarray(0, 35)]) {
    await writeFile(join(f.store.artifactRoot, path), bytes);
    await assert.rejects(f.store.registerArtifact(f.job.id, { path, kind: 'screenshot', screenshot: metadata('codex') }), /Screenshot/);
  }
  assert.equal(f.store.snapshot().artifacts.length, 1, 'rejected registrations do not persist');
  assert.equal(validateScreenshotBytes(PNG), 'image/png');
  assert.equal(validateScreenshotBytes(WEBP), 'image/webp');
  assert.throws(() => validateScreenshotBytes(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('plain text with fake image wrappers'), Buffer.from([0xff, 0xd9])])), /signature/);
});

test('passed visual verification requires an explicitly linked Codex and DSH pair', async t => {
  const f = await fixture(t);
  const codex = await f.screenshot('codex'); const dsh = await f.screenshot('dsh'); const other = await f.screenshot('other');
  for (const screenshotIds of [undefined, [], [codex.id], [dsh.id], [codex.id, other.id]]) {
    await assert.rejects(f.store.recordVerification(f.job.id, { ...f.input, screenshotIds }), /Codex and DSH screenshots/);
  }
  await assert.rejects(f.store.recordVerification(f.job.id, { ...f.input, screenshotIds: [codex.id, codex.id] }), /Duplicate/);
  const partial = await f.store.recordVerification(f.job.id, { ...f.input, outcome: 'partial' });
  assert.equal(partial.outcome, 'partial');
  const passed = await f.store.recordVerification(f.job.id, { ...f.input, screenshotIds: [codex.id, dsh.id] });
  assert.deepEqual(passed.screenshotIds, [codex.id, dsh.id]);
});

test('visual links reject unknown, non-screenshot and other-job artifacts', async t => {
  const f = await fixture(t); const codex = await f.screenshot('codex');
  const otherJob = await f.store.createJob({ title: 'Another research job' });
  const otherDsh = await f.screenshot('dsh', otherJob.id);
  for (const badId of ['missing', f.artifact.id, otherDsh.id]) {
    await assert.rejects(f.store.recordVerification(f.job.id, { ...f.input, screenshotIds: [codex.id, badId] }), /same-job screenshot/);
  }
});

test('screenshot registration rejects sibling paths, directory and file symlinks, and hard links', async t => {
  const f = await fixture(t);
  const otherJob = await f.store.createJob({ title: 'Another screenshot owner' });
  const other = await f.screenshot('dsh', otherJob.id);
  const root = f.store.artifactRoot;
  const source = join(root, other.path);
  const register = (path: string) => f.store.registerArtifact(f.job.id, { path, kind: 'screenshot', screenshot: metadata('codex') });
  await assert.rejects(register(other.path), /inside its own job/);
  await writeFile(join(root, 'shared.png'), PNG);
  await assert.rejects(register('shared.png'), /inside its own job/);
  await symlink(source, join(root, f.job.id, 'linked.png'));
  await assert.rejects(register(`${f.job.id}/linked.png`), /symlinks/);
  await symlink(join(root, otherJob.id), join(root, f.job.id, 'linked-directory'));
  await assert.rejects(register(`${f.job.id}/linked-directory/dsh.png`), /symlinks/);
  await link(source, join(root, f.job.id, 'hard-linked.png'));
  await assert.rejects(register(`${f.job.id}/hard-linked.png`), /hard links/);
  assert.equal(f.store.snapshot().artifacts.filter(a => a.jobId === f.job.id).length, 1);
});

test('verification, ready and install recheck links even when screenshot bytes are unchanged', async t => {
  const f = await fixture(t); const codex = await f.screenshot('codex'); const dsh = await f.screenshot('dsh');
  const screenshotIds = [codex.id, dsh.id]; const root = f.store.artifactRoot;
  const siblingJob = await f.store.createJob({ title: 'Sibling screenshot owner' });
  const sibling = await f.screenshot('codex', siblingJob.id);
  await unlink(join(root, codex.path)); await symlink(join(root, sibling.path), join(root, codex.path));
  await assert.rejects(f.store.recordVerification(f.job.id, { ...f.input, screenshotIds }), /symlinks/);
  await unlink(join(root, codex.path)); await writeFile(join(root, codex.path), PNG);
  for (const scope of ['visual', 'behavior', 'lifecycle'] as const) await f.store.recordVerification(f.job.id, { ...f.input, scope, ...(scope === 'visual' ? { screenshotIds } : {}) });
  const own = join(root, f.job.id); const moved = join(root, `${f.job.id}-moved`);
  await rename(own, moved); await symlink(moved, own);
  await assert.rejects(f.store.transitionJob(f.job.id, 'ready'), /symlinks/);
  await unlink(own); await rename(moved, own);
  const duplicate = join(own, 'duplicate.png'); await link(join(root, dsh.path), duplicate);
  await assert.rejects(f.store.transitionJob(f.job.id, 'ready'), /hard links/);
  await unlink(duplicate);
  await f.store.transitionJob(f.job.id, 'ready');
  await unlink(join(root, dsh.path)); await symlink(join(root, sibling.path), join(root, dsh.path));
  await assert.rejects(f.store.markInstalled(f.job.id, { userConfirmed: true, artifactId: f.artifact.id, receipt: 'Fixture receipt' }), /symlinks/);
  assert.equal(f.store.getJob(f.job.id).status, 'ready');
});

test('public-source screenshots require a credential-free HTTP source URL', async t => {
  const f = await fixture(t); const path = `${f.job.id}/public.png`;
  await writeFile(join(f.store.artifactRoot, path), PNG);
  const screenshot: ScreenshotMetadata = { ...metadata('codex'), provenance: 'public-source' };
  await assert.rejects(f.store.registerArtifact(f.job.id, { path, kind: 'screenshot', screenshot }), /requires sourceUrl/);
  for (const sourceUrl of ['https://user:secret@example.org/screen.png', 'file:///screen.png', 'not-a-url']) {
    await assert.rejects(f.store.registerArtifact(f.job.id, { path, kind: 'screenshot', screenshot: { ...screenshot, sourceUrl } }), /URL/);
  }
  const registered = await f.store.registerArtifact(f.job.id, { path, kind: 'screenshot', screenshot: { ...screenshot, sourceUrl: 'https://example.org/codex/screen.png' } });
  assert.equal(registered.screenshot?.sourceUrl, 'https://example.org/codex/screen.png');
  const invalid = f.store.snapshot();
  delete invalid.artifacts.find(a => a.id === registered.id)!.screenshot!.sourceUrl;
  assert.throws(() => validateState(invalid), /requires sourceUrl/);
});

test('recording and readiness recheck linked screenshot bytes and missing files', async t => {
  const f = await fixture(t); const codex = await f.screenshot('codex'); const dsh = await f.screenshot('dsh');
  const screenshotIds = [codex.id, dsh.id];
  const changed = Buffer.from(PNG); changed[45] ^= 1;
  await writeFile(join(f.store.artifactRoot, codex.path), changed);
  await assert.rejects(f.store.recordVerification(f.job.id, { ...f.input, screenshotIds }), /screenshot no longer matches/);
  await writeFile(join(f.store.artifactRoot, codex.path), PNG);
  for (const scope of ['visual', 'behavior', 'lifecycle'] as const) await f.store.recordVerification(f.job.id, { ...f.input, scope, ...(scope === 'visual' ? { screenshotIds } : {}) });
  await writeFile(join(f.store.artifactRoot, dsh.path), changed);
  await assert.rejects(f.store.transitionJob(f.job.id, 'ready'), /screenshot no longer matches/);
  await unlink(join(f.store.artifactRoot, dsh.path));
  await assert.rejects(f.store.transitionJob(f.job.id, 'ready'), /ENOENT/);
  await writeFile(join(f.store.artifactRoot, dsh.path), PNG);
  assert.equal((await f.store.transitionJob(f.job.id, 'ready')).status, 'ready');
  await writeFile(join(f.store.artifactRoot, dsh.path), changed);
  await assert.rejects(f.store.markInstalled(f.job.id, { userConfirmed: true, artifactId: f.artifact.id, receipt: 'Fixture receipt' }), /screenshot no longer matches/);
});

test('legacy ready state stays readable but missing screenshot links cannot authorize installation', async t => {
  const f = await fixture(t); const codex = await f.screenshot('codex'); const dsh = await f.screenshot('dsh');
  for (const scope of ['visual', 'behavior', 'lifecycle'] as const) await f.store.recordVerification(f.job.id, { ...f.input, scope, ...(scope === 'visual' ? { screenshotIds: [codex.id, dsh.id] } : {}) });
  await f.store.transitionJob(f.job.id, 'ready');
  const path = f.store.filePath; await f.store.close();
  const legacy = JSON.parse(await readFile(path, 'utf8'));
  for (const artifact of legacy.artifacts) delete artifact.screenshot;
  for (const verification of legacy.verifications) delete verification.screenshotIds;
  validateState(legacy);
  await writeFile(path, JSON.stringify(legacy));
  const reopened = await OpenCodexStore.open({ directory: f.directory });
  try {
    assert.equal(reopened.getJob(f.job.id).status, 'ready');
    await assert.rejects(reopened.markInstalled(f.job.id, { userConfirmed: true, artifactId: f.artifact.id, receipt: 'Fixture receipt' }), /Codex and DSH screenshots/);
  } finally { await reopened.close(); }
});

test('legacy metadata-free screenshots cannot serve as a new visual pass', async t => {
  const f = await fixture(t); const codex = await f.screenshot('codex'); const dsh = await f.screenshot('dsh');
  const path = f.store.filePath; await f.store.close();
  const legacy = JSON.parse(await readFile(path, 'utf8'));
  for (const artifact of legacy.artifacts) delete artifact.screenshot;
  await writeFile(path, JSON.stringify(legacy));
  const reopened = await OpenCodexStore.open({ directory: f.directory });
  try {
    for (const status of ['queued', 'researching', 'specifying', 'building', 'verifying'] as const) await reopened.transitionJob(f.job.id, status);
    await assert.rejects(reopened.recordVerification(f.job.id, { ...f.input, screenshotIds: [codex.id, dsh.id] }), /screenshot metadata/);
    const partial = await reopened.recordVerification(f.job.id, { ...f.input, outcome: 'partial', screenshotIds: [codex.id, dsh.id] });
    assert.equal(partial.outcome, 'partial');
  } finally { await reopened.close(); }
});
