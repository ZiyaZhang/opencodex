/** Arms and clears one timer: the Host's check timer, the lock's heartbeat. Tests pass a table they fire by hand. */
export interface Timers { set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
/** Node's timers, unref'd, so that an armed one never keeps DSH from exiting. */
export const NODE_TIMERS: Timers = { set: (run, ms) => setTimeout(run, ms).unref(), clear: handle => clearTimeout(handle as NodeJS.Timeout) };
