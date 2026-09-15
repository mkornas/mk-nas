/**
 * The way in from outside: a Cloudflare Tunnel to the drive, run as the
 * mk-drive-tunnel container of the drive's stack (install/stack-up.sh starts
 * it when /opt/mk-drive/.env has CLOUDFLARE_TUNNEL_TOKEN). These verbs write
 * or remove that one line and bring the stack up again, which starts or stops
 * only the tunnel: the drive itself is not recreated, so the page that asked
 * keeps its connection. The status is read, never stored: the container's
 * state, cloudflared's readiness on 127.0.0.1, and its log (the hostnames
 * Cloudflare configured, the last connection, the last error). Hostnames stay
 * managed in Cloudflare's dashboard. The token is never returned.
 */
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { Tunnel } from '../../shared/types.ts';
import { BadArgs } from './names.ts';
import { must, type Runner } from './run.ts';

export interface TunnelConfig {
  /** The drive stack's .env, root-only. */
  envFile: string;
  /** Brings the stack up with or without the tunnel profile. */
  stackUp: string;
  container: string;
  /** cloudflared's readiness endpoint, bound to localhost by the compose file. */
  readyUrl: string;
}

export type Fetch = typeof fetch;

const LINE = /^\s*CLOUDFLARE_TUNNEL_TOKEN\s*=/;

/** A tunnel token as Cloudflare's dashboard shows it: base64 of {"a": account, "t": tunnel id, "s": secret}. Returns the tunnel id. */
export function tokenOf(v: unknown): { token: string; tunnelId: string } {
  if (typeof v !== 'string') throw new BadArgs('token: paste the tunnel token');
  const token = v.trim().replace(/^.*--token\s+/, '');
  if (!/^[A-Za-z0-9+/_-]{40,4000}={0,2}$/.test(token)) throw new BadArgs('token: that is not a tunnel token (copy the long string after --token)');
  let j: { a?: unknown; t?: unknown; s?: unknown };
  try {
    j = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    throw new BadArgs('token: that is not a tunnel token (copy the long string after --token)');
  }
  if (typeof j.a !== 'string' || typeof j.s !== 'string' || typeof j.t !== 'string' || !/^[0-9a-f-]{36}$/i.test(j.t))
    throw new BadArgs('token: that is not a tunnel token (copy the long string after --token)');
  return { token, tunnelId: j.t.toLowerCase() };
}

/** The token in the .env text, the way stack-up.sh reads it (the last line wins, quotes and spaces dropped). */
export function readToken(env: string): string | null {
  const lines = env.split('\n').filter((l) => LINE.test(l));
  const last = lines.at(-1);
  if (!last) return null;
  const value = last.replace(LINE, '').replace(/["'\s\r]/g, '');
  return value || null;
}

/** The .env text with the token line replaced, or removed for null; every other line stays as it was. */
export function withToken(env: string, token: string | null): string {
  const kept = env.split('\n').filter((l) => !LINE.test(l));
  while (kept.length && kept.at(-1) === '') kept.pop();
  if (token) kept.push(`CLOUDFLARE_TUNNEL_TOKEN=${token}`);
  return kept.length ? kept.join('\n') + '\n' : '';
}

export interface TunnelLog {
  hostnames: string[];
  lastConnectedAt: string | null;
  lastError: string | null;
}

/** What cloudflared's log says: the ingress hostnames of the newest configuration, the last registered connection, the last error. */
export function parseTunnelLog(text: string, token: string | null): TunnelLog {
  const out: TunnelLog = { hostnames: [], lastConnectedAt: null, lastError: null };
  for (const line of text.split('\n')) {
    if (token && line.includes(token)) continue; // never let the secret out through a log line
    const at = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+(\w{3})\s+(.*)$/.exec(line.trim());
    if (!at) continue;
    const [, time, level, rest] = at;
    if (/^Updated to new configuration/.test(rest)) out.hostnames = [...new Set([...rest.matchAll(/hostname\\?"\s*:\s*\\?"([^"\\]+)/g)].map((m) => m[1]))];
    else if (/^Registered tunnel connection/.test(rest)) out.lastConnectedAt = time;
    else if (level === 'ERR') out.lastError = `${time.replace('T', ' ').slice(0, 16)} ${rest.replace(/\s+(connIndex|event|ip)=\S+/g, '')}`.slice(0, 300);
  }
  return out;
}

export async function readTunnel(run: Runner, fetchFn: Fetch, cfg: TunnelConfig, now = Date.now()): Promise<Tunnel> {
  const env = await readFile(cfg.envFile, 'utf8').catch(() => '');
  const token = readToken(env);
  let tunnelId: string | null = null;
  try {
    tunnelId = token ? tokenOf(token).tunnelId : null;
  } catch {
    /* a line someone edited by hand into something else: shown as configured, id unknown */
  }
  const base: Tunnel = {
    configured: !!token,
    tunnelId,
    state: 'off',
    container: null,
    since: null,
    restarts: 0,
    connections: null,
    hostnames: [],
    lastConnectedAt: null,
    lastError: null,
  };
  const inspect = await run(['docker', 'inspect', '--format', '{{json .State}}|{{.RestartCount}}', cfg.container]);
  if (inspect.exitCode !== 0) return { ...base, state: token ? 'starting' : 'off' };
  const [stateJson, restarts] = inspect.stdout.trim().split('|');
  const st = JSON.parse(stateJson || '{}') as { Status?: string; Running?: boolean; StartedAt?: string };
  const logs = await run(['docker', 'logs', '--since', '72h', '--tail', '400', cfg.container]);
  const log = parseTunnelLog(`${logs.stdout}\n${logs.stderr}`, token);
  let connections: number | null = null;
  if (st.Running) {
    try {
      const res = await fetchFn(cfg.readyUrl, { signal: AbortSignal.timeout(2000) });
      const j = (await res.json()) as { readyConnections?: unknown };
      connections = typeof j.readyConnections === 'number' ? j.readyConnections : null;
    } catch {
      /* not listening yet */
    }
  }
  const since = st.StartedAt && !st.StartedAt.startsWith('0001') ? new Date(st.StartedAt).toISOString() : null;
  const young = since !== null && now - Date.parse(since) < 30_000;
  const state: Tunnel['state'] = !token
    ? 'off'
    : !st.Running
      ? 'failing'
      : connections && connections > 0
        ? 'connected'
        : young && !log.lastError
          ? 'starting'
          : 'disconnected';
  return { ...base, state, container: st.Status ?? null, since, restarts: Number(restarts) || 0, connections, ...log };
}

async function writeEnv(file: string, text: string): Promise<void> {
  // the file holds secrets: root-only, replaced whole, never half-written
  const mode = await stat(file).then(
    (s) => s.mode & 0o777 & 0o600,
    () => 0o600,
  );
  const tmp = `${file}.mk-nas-tmp`;
  await writeFile(tmp, text, { mode: mode || 0o600 });
  await rename(tmp, file);
}

export async function setTunnel(run: Runner, fetchFn: Fetch, cfg: TunnelConfig, tokenArg: unknown): Promise<Tunnel> {
  const { token } = tokenOf(tokenArg);
  const env = await readFile(cfg.envFile, 'utf8').catch(() => '');
  await writeEnv(cfg.envFile, withToken(env, token));
  await must(run, [cfg.stackUp], { timeout: 5 * 60_000 });
  return readTunnel(run, fetchFn, cfg);
}

export async function removeTunnel(run: Runner, fetchFn: Fetch, cfg: TunnelConfig): Promise<Tunnel> {
  const env = await readFile(cfg.envFile, 'utf8').catch(() => '');
  if (!readToken(env)) throw new BadArgs('no tunnel is set up');
  await writeEnv(cfg.envFile, withToken(env, null));
  await must(run, [cfg.stackUp], { timeout: 5 * 60_000 });
  return readTunnel(run, fetchFn, cfg);
}
