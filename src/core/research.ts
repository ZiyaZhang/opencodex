import type { Job, StoreState } from './types.js';

/** Evidence reads are inputs, not completed deliverables. This allowance never resets on resume. */
export function researchAllowance(state: StoreState, job: Job) {
  const requests = state.reservations.filter(request => {
    if (request.jobId !== job.id) return false;
    const phase = request.phase ?? [...job.history].reverse().find(event => event.at <= request.reservedAt)?.to;
    // Unknown legacy ownership is charged conservatively to research.
    return !phase || ['researching', 'specifying'].includes(phase);
  });
  const spentTokens = requests.reduce((total, request) => total + (request.status === 'settled' ? request.usage!.inputTokens + request.usage!.outputTokens : request.reservedTokens), 0);
  const tokenLimit = job.mode === 'investigate' ? job.budget.tokenLimit : Math.min(100_000, Math.floor(job.budget.tokenLimit / 4));
  const maxAttempts = job.mode === 'investigate' ? 12 : 6;
  return { attempts: requests.length, maxAttempts, spentTokens, tokenLimit, remainingTokens: Math.max(0, tokenLimit - spentTokens),
    nextDeliverable: job.mode === 'investigate' ? 'Grounded inventory or an explicit blocker' : 'Submit a minimal grounded plan with opencodex_submit_plan, then implement; additional SDK reads do not extend this allowance' };
}

export function researchAdmissionError(state: StoreState, job: Job, nextTokens: number): string | undefined {
  if (!['researching', 'specifying'].includes(job.status)) return;
  const limit = researchAllowance(state, job);
  if (limit.attempts >= limit.maxAttempts) return `Research attempt limit reached (${limit.maxAttempts}). Resume and extra evidence do not reset it. Submit a grounded plan or resolve the blocker before further model work.`;
  // Before any provider measurement, UTF-8 bytes deliberately overestimate
  // tokens. Admit one calibration request against the strict total budget;
  // afterwards even unknown usage retains its full reservation in this phase.
  if (limit.attempts === 0) return;
  if (nextTokens > limit.remainingTokens) return `Research budget would be exceeded: ${limit.spentTokens} used/reserved, next request reserves ${nextTokens}, research limit ${limit.tokenLimit}. Implementation budget is preserved; do not resume repeated SDK reading.`;
}

