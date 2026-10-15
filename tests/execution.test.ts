import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodexStore } from '../src/core/store.js';
import { executionBrief, executionPreflight, researchAllowance } from '../src/host/execution.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'oc-phase-ledger-'));
  const store = await OpenCodexStore.open({ directory });
  const job = await store.createJob({ title: 'Bounded reconstruction', budget: { tokenLimit: 80_000 } });
  await store.transitionJob(job.id, 'queued'); await store.transitionJob(job.id, 'researching');
  return { store, directory, id: job.id };
}

test('concurrent research admission cannot spend the implementation allowance; restart preserves it', async () => {
  const f = await fixture();
  let store = f.store;
  try {
    const results = await Promise.allSettled(['one', 'two'].map(requestId => store.reserveTokens(f.id, { requestId, reservedTokens: 12_000, enforceResearchAllowance: true })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(store.snapshot().reservations.length, 1);
    assert.equal(store.getJob(f.id).status, 'paused');
    await store.close(); store = await OpenCodexStore.open({ directory: f.directory });
    const allowance = researchAllowance(store.snapshot(), store.getJob(f.id));
    assert.equal(allowance.spentTokens, 12_000);
    assert.equal(allowance.attempts, 1);
    assert.equal(store.snapshot().reservations[0]!.status, 'unknown');
    await store.transitionJob(f.id, 'queued'); await store.transitionJob(f.id, 'researching');
    await assert.rejects(store.reserveTokens(f.id, { requestId: 'three', reservedTokens: 12_000, enforceResearchAllowance: true }), /Research budget/);
  } finally { await store.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('invalid plan fails atomically; complete grounded requirements advance once', async () => {
  const f = await fixture();
  try {
    const evidence = await f.store.addEvidence(f.id, { kind: 'observed', claim: 'Synthetic public specification fixture', sourceUrl: 'https://example.com/spec' });
    const plan = { title: 'One feature', behavior: ['Draft is retained'], visual: ['Question is beside composer'], lifecycle: ['Remove on unload'], existingCapabilities: [], gaps: ['UI comparison pending'], evidenceIds: [evidence.id] };
    await assert.rejects(f.store.submitPlan(f.id, { ...plan, visual: [] }), /Spec needs/);
    assert.equal(f.store.snapshot().specs.length, 0);
    assert.equal(f.store.getJob(f.id).status, 'researching');
    await f.store.submitPlan(f.id, plan);
    assert.equal(f.store.getJob(f.id).status, 'building');
    await f.store.submitPlan(f.id, plan);
    assert.equal(f.store.snapshot().specs.length, 1);
    assert.equal(executionPreflight(f.store.getJob(f.id), false, true).blockers.length, 1);
    const brief = JSON.parse(executionBrief(f.store.snapshot(), f.store.getJob(f.id), executionPreflight(f.store.getJob(f.id), true, true)));
    assert.equal(brief.specification.behavior[0], 'Draft is retained');
    assert.equal(brief.evidence[0].id, evidence.id);
  } finally { await f.store.close(); await rm(f.directory, { recursive: true, force: true }); }
});
