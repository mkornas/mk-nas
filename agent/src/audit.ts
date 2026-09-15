/** One JSON line per request. The file is append-only; '-' means stderr. */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditLine {
  ts: string;
  verb: string;
  args: unknown;
  ok: boolean;
  ms: number;
  error?: string;
  argv?: string[][];
}

export type Audit = (line: AuditLine) => Promise<void>;

export function createAudit(target: string): Audit {
  if (target === '-') return async (line) => void process.stderr.write(JSON.stringify(line) + '\n');
  let ready: Promise<void> | null = null;
  return async (line) => {
    ready ??= mkdir(dirname(target), { recursive: true }).then(() => undefined);
    await ready;
    await appendFile(target, JSON.stringify(line) + '\n', { mode: 0o600 });
  };
}
