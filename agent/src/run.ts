/**
 * The only way a command runs: an argv array through execFile. No shell,
 * ever. Every caller-supplied value has been through names.ts before it
 * gets here, and no value may begin with '-' unless the verb wrote it.
 */
import { execFile } from 'node:child_process';

export interface RunResult {
  argv: string[];
  /** null when the tool could not be started (missing, killed, timed out). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeout?: number;
  /** Written to the tool's stdin, then closed. The only way a secret reaches a tool. */
  input?: string;
}

export type Runner = (argv: string[], opts?: RunOptions) => Promise<RunResult>;

export class CommandError extends Error {
  readonly result: RunResult;
  constructor(result: RunResult) {
    super(`${result.argv[0]} exited ${result.exitCode}: ${result.stderr.trim() || '(no stderr)'}`);
    this.result = result;
  }
}

/** Resolves on any exit code; the verb decides what a non-zero means. */
export const run: Runner = (argv, opts = {}) =>
  new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' };
    const child = execFile(cmd, args, { timeout: opts.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (!err) return resolve({ argv, exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
      const e = err as Error & { code?: number | string };
      const exitCode = typeof e.code === 'number' ? e.code : null;
      resolve({ argv, exitCode, stdout: String(stdout), stderr: exitCode === null ? `${String(stderr)}${e.message}` : String(stderr) });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });

/** Runs and throws CommandError on a non-zero exit. */
export async function must(runner: Runner, argv: string[], opts?: RunOptions): Promise<string> {
  const r = await runner(argv, opts);
  if (r.exitCode !== 0) throw new CommandError(r);
  return r.stdout;
}
