/** Fakes that need no Host: a clock and timers the test moves by hand, a wait for a condition, and another DSH process's lock file. */
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import type { LockRecord } from '../../src/core/lock.ts';
import type { Timers } from '../../src/core/timers.ts';

// The RSS fixture's items are dated Aug-Oct 2026; the clock is pinned so the parser's 120-day window never drifts.
export const NOW = new Date('2026-10-15T08:00:00.000Z');

/** Waits until `condition` holds, and fails the test after `ms`. */
export async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

/** A timer table the test fires by hand. */
export function fakeTimers() {
  const armed = new Map<number, { run: () => void; ms: number }>();
  const log: Array<{ handle: number; ms: number }> = [];
  const cleared: number[] = [];
  let last = 0;
  const timers: Timers = {
    set(run, ms) { const handle = ++last; armed.set(handle, { run, ms }); log.push({ handle, ms }); return handle; },
    clear(handle) { cleared.push(handle as number); armed.delete(handle as number); },
  };
  return {
    timers, armed, log, cleared,
    /** Runs the one armed timer. */
    fire() {
      assert.equal(armed.size, 1, 'exactly one timer is armed');
      const [[handle, entry]] = [...armed];
      armed.delete(handle);
      entry.run();
    },
  };
}

/** A clock that stands still at `start` until the test moves it. */
export function fakeClock(start: Date = NOW) {
  let at = start.getTime();
  return {
    now: () => new Date(at),
    /** Moves the clock by `ms`. */
    advance(ms: number) { at += ms; },
  };
}

/** No process has this pid: Linux and macOS both keep pids below 2^22. */
export const GONE_PID = 2 ** 22 + 1;
/** `lock.json` as another DSH process leaves it: by default the parent of this test process, which is alive, checking since NOW and beating at NOW. */
export const foreignLock = (fields: Partial<LockRecord> = {}): LockRecord =>
  ({ pid: process.ppid, kind: 'check', startedAt: NOW.toISOString(), heartbeatAt: NOW.toISOString(), hostname: hostname(), ...fields });
