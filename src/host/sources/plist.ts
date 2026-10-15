import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface BundleVersion { version: string; build: string }
/** Runs a process and resolves with its stdout; the default is `execFile`, tests pass a stand-in where /usr/bin/plutil does not exist. */
export type PlutilRunner = (file: string, args: string[], options: { maxBuffer: number; timeout: number }) => Promise<{ stdout: string }>;

/** plutil converts binary plists; the fields are read from its XML output without a full XML parser. `-o -` writes to stdout, the input file is never modified. */
export async function readBundleVersion(plistPath: string, run: PlutilRunner = promisify(execFile)): Promise<BundleVersion> {
  const { stdout } = await run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', plistPath], { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 });
  const field = (key: string) => stdout.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]{1,64})</string>`))?.[1];
  const version = field('CFBundleShortVersionString'), build = field('CFBundleVersion');
  if (!version || !build) throw new Error(`No version fields in ${plistPath}`);
  return { version, build };
}
