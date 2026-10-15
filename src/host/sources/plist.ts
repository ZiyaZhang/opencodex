import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface BundleVersion { version: string; build: string }
/** Runs a process and resolves with its stdout; the default is `execFile`, tests pass a stand-in where /usr/bin/plutil does not exist. */
export type PlutilRunner = (file: string, args: string[], options: { maxBuffer: number; timeout: number; signal?: AbortSignal }) => Promise<{ stdout: string }>;

/** The characters the checkpoint store refuses in a value. A version label becomes a checkpoint value, so it must not contain them. */
const UNSAFE = /[\p{Cc}\u{2028}\u{2029}]/u;

/** plutil converts binary plists; the fields are read from its XML output without a full XML parser. `-o -` writes to stdout, the input file is never modified. */
export async function readBundleVersion(plistPath: string, run: PlutilRunner = promisify(execFile), signal?: AbortSignal): Promise<BundleVersion> {
  const { stdout } = await run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', plistPath], { maxBuffer: 4 * 1024 * 1024, timeout: 10_000, ...(signal && { signal }) });
  // One line of at most 64 characters without control characters: the label is also a candidate key and a directory name.
  const field = (key: string): string | undefined => {
    const raw = stdout.match(new RegExp(`<key>${key}</key>\\s*<string>([^<\\n\\r]{1,64})</string>`))?.[1];
    if (raw === undefined) return undefined;
    if (UNSAFE.test(raw)) throw new Error(`Invalid ${key} in ${plistPath}: it holds a control character`);
    return raw.trim() || undefined;
  };
  const version = field('CFBundleShortVersionString'), build = field('CFBundleVersion');
  if (!version || !build) throw new Error(`No version fields in ${plistPath}`);
  return { version, build };
}
