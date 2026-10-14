import assert from 'node:assert/strict';
import test from 'node:test';
import { researchPrompt } from '../src/host/prompt.js';
import type { Job } from '../src/core/types.js';

const job = {
  id: 'prompt-fixture', title: 'Preserve the composer', description: 'Tab must not send the draft.',
  status: 'building', mode: 'reconstruct', workdir: '/fixture/job',
  budget: { tokenLimit: 120_000, maxDurationMs: 600_000, maxRepairRounds: 2 },
} as Job;

test('resume omits the repeated entry skill while retaining feature, phase and execution constraints', () => {
  const entry = 'UNIQUE_ENTRY_BODY '.repeat(1000);
  const first = researchPrompt(job, [], ['opencodex_read_resource'], false, entry);
  const resumed = researchPrompt(job, [], ['opencodex_read_resource'], true, entry);
  assert.ok(first.includes(entry));
  assert.ok(!resumed.includes('UNIQUE_ENTRY_BODY'));
  assert.ok(resumed.length < first.length - entry.length + 600);
  for (const text of ['Current stage: building', job.description, '120000 total tokens', 'workspace-write', 'cannot mark a job ready', 'existing implementation']) {
    assert.ok(resumed.includes(text), text);
  }
  assert.match(resumed, /section index/);
  assert.match(resumed, /at most 6000 characters/);
});

test('investigation-only resumes still prohibit implementation and finish at researched', () => {
  const prompt = researchPrompt({ ...job, mode: 'investigate', status: 'specifying' }, [], [], true, 'ENTRY');
  assert.match(prompt, /Do not implement, package or install/);
  assert.match(prompt, /stage researched and stop/);
  assert.doesNotMatch(prompt, /<opencodex-entry-skill>/);
});
