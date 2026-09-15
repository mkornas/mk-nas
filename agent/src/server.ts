/**
 * Newline-delimited JSON over a Unix socket. One request per line, one
 * response per line, answered in completion order and matched by id.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, chownSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import type { NasError, Request, Response } from '../../shared/types.ts';
import type { Audit } from './audit.ts';
import { BadArgs } from './names.ts';
import { CommandError, type Runner } from './run.ts';
import { isVerb, verbs, type Deps } from './verbs.ts';

export interface ServerOptions {
  socket: string;
  group?: string;
  audit: Audit;
  deps: Deps;
}

const MAX_LINE = 64 * 1024;

export function toError(err: unknown): NasError {
  if (err instanceof BadArgs) return { code: 'bad-args', message: err.message };
  if (err instanceof CommandError) {
    const r = err.result;
    if (r.exitCode === null)
      return { code: 'unavailable', message: `${r.argv[0]} could not run`, detail: { argv: r.argv, exitCode: null, stderr: r.stderr.slice(0, 4000) } };
    const notFound = /(no such pool|dataset does not exist|cannot open)/i.test(r.stderr);
    return {
      code: notFound ? 'not-found' : 'command-failed',
      message: r.stderr.trim().split('\n')[0] || err.message,
      detail: { argv: r.argv, exitCode: r.exitCode, stderr: r.stderr.slice(0, 4000) },
    };
  }
  return { code: 'internal', message: err instanceof Error ? err.message : String(err) };
}

/** What the audit line shows as args: everything but secrets. */
function redacted(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args || !('password' in args)) return args;
  return { ...args, password: '[redacted]' };
}

export async function handle(req: Request, deps: Deps, audit: Audit): Promise<Response> {
  const t0 = performance.now();
  const shown = redacted(req.args);
  if (!isVerb(req.verb)) {
    await audit({ ts: new Date().toISOString(), verb: String(req.verb), args: shown, ok: false, ms: 0, error: 'unknown-verb' });
    return { id: req.id, ok: false, error: { code: 'unknown-verb', message: `no such verb: ${String(req.verb)}` } };
  }
  const argv: string[][] = [];
  const run: Runner = (a, o) => {
    argv.push(a);
    return deps.run(a, o);
  };
  try {
    const result = await verbs[req.verb](req.args, { ...deps, run });
    await audit({ ts: new Date().toISOString(), verb: req.verb, args: shown, ok: true, ms: Math.round(performance.now() - t0), argv });
    return { id: req.id, ok: true, result };
  } catch (err) {
    const error = toError(err);
    await audit({
      ts: new Date().toISOString(),
      verb: req.verb,
      args: shown,
      ok: false,
      ms: Math.round(performance.now() - t0),
      error: `${error.code}: ${error.message}`,
      argv,
    });
    return { id: req.id, ok: false, error };
  }
}

function parseLine(line: string): Request | NasError {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { code: 'bad-request', message: 'not JSON' };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { code: 'bad-request', message: 'request must be an object' };
  const r = v as Record<string, unknown>;
  if (!(typeof r.id === 'string' || typeof r.id === 'number')) return { code: 'bad-request', message: 'id must be a string or number' };
  if (typeof r.verb !== 'string') return { code: 'bad-request', message: 'verb must be a string' };
  if (r.args !== undefined && (typeof r.args !== 'object' || r.args === null || Array.isArray(r.args)))
    return { code: 'bad-request', message: 'args must be an object' };
  return r as unknown as Request;
}

function serve(sock: Socket, opts: ServerOptions): void {
  let buf = '';
  const send = (res: Response) => {
    if (!sock.destroyed) sock.write(JSON.stringify(res) + '\n');
  };
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_LINE) {
      send({ id: null, ok: false, error: { code: 'bad-request', message: 'line too long' } });
      sock.destroy();
      return;
    }
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const req = parseLine(line);
      if ('code' in req) {
        send({ id: null, ok: false, error: req });
        continue;
      }
      void handle(req, opts.deps, opts.audit).then(send);
    }
  });
  sock.on('error', () => sock.destroy());
}

function gidOf(group: string): number | null {
  try {
    const line = readFileSync('/etc/group', 'utf8')
      .split('\n')
      .find((l) => l.startsWith(group + ':'));
    return line ? Number(line.split(':')[2]) : null;
  } catch {
    return null;
  }
}

export function listen(opts: ServerOptions): Promise<Server> {
  const server = createServer((sock) => serve(sock, opts));
  if (existsSync(opts.socket)) unlinkSync(opts.socket);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socket, () => {
      server.off('error', reject);
      chmodSync(opts.socket, 0o660);
      const gid = opts.group ? gidOf(opts.group) : null;
      if (gid !== null && process.getuid?.() === 0) chownSync(opts.socket, 0, gid);
      resolve(server);
    });
  });
}
