/**
 * Replication: a dataset pushed to another ZFS host over ssh. The plan is
 * pure — which send to do, given the snapshots on both sides and a resume
 * token — and `replicate` runs it: snapshot, look, send | ssh receive,
 * prune, record. The send and the receive are two processes joined by a
 * pipe in Node; no shell on this side. The remote side runs what ssh is
 * given, argument by argument, all of them validated names.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Job, Replication, ReplicationSchedule, ReplicationSetArgs, ReplicationTest } from '../../shared/types.ts';
import type { Db, StoredReplication } from './db.ts';
import { BadArgs, datasetName } from './names.ts';
import { stamp } from './policy.ts';
import { must, type Runner } from './run.ts';
import { listDatasets } from './zfs.ts';

export interface ReplConfig {
  keyFile: string;
  knownHosts: string;
}

export interface Target {
  host: string;
  user: string;
  port: number;
}

export const SCHEDULES: ReplicationSchedule[] = ['manual', 'hourly', 'daily', 'weekly'];
const PERIOD: Record<Exclude<ReplicationSchedule, 'manual'>, number> = { hourly: 3_600_000, daily: 86_400_000, weekly: 7 * 86_400_000 };
const SLACK = 10 * 60_000;

export function hostName(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/.test(v)) throw new BadArgs('host: not a host name or address');
  return v;
}
export function userName(v: unknown): string {
  if (v === undefined) return 'root';
  if (typeof v !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(v)) throw new BadArgs('user: not a user name');
  return v;
}
export function portNumber(v: unknown): number {
  if (v === undefined) return 22;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) throw new BadArgs('port: 1 to 65535');
  return v;
}
export function scheduleOf(v: unknown): ReplicationSchedule {
  if (v === undefined) return 'daily';
  if (typeof v !== 'string' || !SCHEDULES.includes(v as ReplicationSchedule)) throw new BadArgs(`schedule: one of ${SCHEDULES.join(', ')}`);
  return v as ReplicationSchedule;
}

export function sshArgv(cfg: ReplConfig, t: Target, remote: string[]): string[] {
  return [
    'ssh',
    '-i',
    cfg.keyFile,
    '-o',
    'BatchMode=yes',
    '-o',
    `UserKnownHostsFile=${cfg.knownHosts}`,
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-p',
    String(t.port),
    `${t.user}@${t.host}`,
    ...remote,
  ];
}

export type SendPlan = { kind: 'none' } | { kind: 'resume'; token: string } | { kind: 'full'; to: string } | { kind: 'incremental'; from: string; to: string };

/**
 * `local` are the dataset's snapshot names oldest → newest, `remote` the names
 * on the target, `latest` the one just taken. Resume beats everything; then
 * the newest snapshot both sides have is the base; no common one with a
 * non-empty target means the two diverged, and that is a refusal, not -F.
 */
export function plan(local: string[], remote: string[], token: string | null, latest: string): SendPlan {
  if (token) return { kind: 'resume', token };
  if (remote.length === 0) return { kind: 'full', to: latest };
  const common = [...local].reverse().find((s) => remote.includes(s));
  if (!common)
    throw new BadArgs("the target has snapshots of this dataset but none in common with ours; pick another target dataset or delete the target's copy");
  if (common === latest) return { kind: 'none' };
  return { kind: 'incremental', from: common, to: latest };
}

export function due(r: StoredReplication, now = Date.now()): boolean {
  if (r.schedule === 'manual') return false;
  if (!r.lastRunAt) return true;
  return now - Date.parse(r.lastRunAt) >= PERIOD[r.schedule] - SLACK;
}

/** Two processes joined by a pipe: `send` writes, `recv` reads; `onProgress` gets the bytes zfs send -Pv reports. */
export type Pipe = (send: string[], recv: string[], onProgress: (bytes: number) => void) => Promise<{ exitCode: number; stderr: string }>;

export const pipe: Pipe = (send, recv, onProgress) =>
  new Promise((resolve) => {
    const env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' };
    const a = spawn(send[0], send.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env });
    const b = spawn(recv[0], recv.slice(1), { stdio: ['pipe', 'ignore', 'pipe'], env });
    a.stdout.pipe(b.stdin);
    let aErr = '';
    let bErr = '';
    let tail = '';
    a.stderr.setEncoding('utf8');
    b.stderr.setEncoding('utf8');
    a.stderr.on('data', (d: string) => {
      tail += d;
      const lines = tail.split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) {
        const m = /^\d\d:\d\d:\d\d\t(\d+)\t/.exec(line);
        if (m) onProgress(Number(m[1]));
        else aErr += line + '\n';
      }
    });
    b.stderr.on('data', (d: string) => (bErr += d));
    let aCode: number | null | undefined;
    let bCode: number | null | undefined;
    const finish = () => {
      if (aCode === undefined || bCode === undefined) return;
      const exitCode = bCode !== 0 ? (bCode ?? 1) : (aCode ?? 1);
      resolve({ exitCode, stderr: (bCode !== 0 ? bErr + aErr : aErr + bErr).trim() });
    };
    a.on('error', (e) => (aErr += e.message));
    b.on('error', (e) => (bErr += e.message));
    a.on('close', (c) => ((aCode = c), finish()));
    b.on('close', (c) => ((bCode = c), finish()));
    b.stdin.on('error', () => {}); // EPIPE when the receiver dies first: the exit codes tell the story
  });

const target = (r: Target) => ({ host: r.host, user: r.user, port: r.port });
const shortName = (full: string) => full.slice(full.indexOf('@') + 1);

async function remoteSnapshots(run: Runner, cfg: ReplConfig, t: Target, dataset: string): Promise<{ snapshots: string[]; exists: boolean; error?: string }> {
  const r = await run(sshArgv(cfg, t, ['zfs', 'list', '-H', '-o', 'name', '-t', 'snapshot', '-d', '1', dataset]), { timeout: 60_000 });
  if (r.exitCode === 0)
    return {
      exists: true,
      snapshots: r.stdout
        .split('\n')
        .filter((l) => l.startsWith(dataset + '@'))
        .map(shortName),
    };
  if (/dataset does not exist/i.test(r.stderr)) return { exists: false, snapshots: [] };
  return { exists: false, snapshots: [], error: r.stderr.trim().split('\n').pop() || `ssh exited ${r.exitCode}` };
}

export async function testTarget(run: Runner, cfg: ReplConfig, t: Target, dataset: string): Promise<ReplicationTest> {
  await ensureKey(run, cfg);
  const r = await remoteSnapshots(run, cfg, t, dataset);
  if (r.error) {
    const why = /permission denied/i.test(r.error)
      ? `${t.user}@${t.host} refused the key — is the public key in that user's authorized keys?`
      : /could not resolve|connection refused|timed out|no route/i.test(r.error)
        ? `cannot reach ${t.host}:${t.port} — ${r.error}`
        : r.error;
    return { ok: false, message: why, snapshots: [] };
  }
  return {
    ok: true,
    message: r.exists
      ? `${dataset} exists on ${t.host} with ${r.snapshots.length} snapshot${r.snapshots.length === 1 ? '' : 's'}`
      : `${t.host} answers; ${dataset} does not exist yet and will be created by the first send`,
    snapshots: r.snapshots,
  };
}

export async function ensureKey(run: Runner, cfg: ReplConfig): Promise<string> {
  try {
    return (await readFile(`${cfg.keyFile}.pub`, 'utf8')).trim();
  } catch {
    await mkdir(dirname(cfg.keyFile), { recursive: true, mode: 0o700 });
    await must(run, ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'mk-nas replication', '-f', cfg.keyFile]);
    return (await readFile(`${cfg.keyFile}.pub`, 'utf8')).trim();
  }
}

export async function setReplication(run: Runner, db: Db, a: ReplicationSetArgs): Promise<StoredReplication> {
  const dataset = datasetName(a.dataset);
  const [d] = await listDatasets(run, dataset);
  if (!d || d.name !== dataset) throw new BadArgs(`${dataset}: no such dataset`);
  const keep = a.keep === undefined ? 3 : a.keep;
  if (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 1 || keep > 100) throw new BadArgs('keep: 1 to 100');
  if (a.recursive !== undefined && typeof a.recursive !== 'boolean') throw new BadArgs('recursive must be true or false');
  if (a.id !== undefined && (typeof a.id !== 'number' || !db.replication(a.id))) throw new BadArgs('id: no such replication');
  return db.setReplication({
    id: a.id,
    dataset,
    host: hostName(a.host),
    user: userName(a.user),
    port: portNumber(a.port),
    targetDataset: datasetName(a.targetDataset, 'targetDataset'),
    recursive: a.recursive ?? false,
    schedule: scheduleOf(a.schedule),
    keep,
  });
}

export function withRunning(db: Db, r: StoredReplication): Replication {
  return { ...r, running: db.runningJob(r.id) };
}

export interface ReplicateDeps {
  run: Runner;
  pipe: Pipe;
  db: Db;
  cfg: ReplConfig;
  pid: number;
  now?: () => Date;
  log?: (line: string) => void;
}

/** One run of one replication, start to finish; the job row is the progress report. */
export async function replicate(deps: ReplicateDeps, id: number): Promise<Job> {
  const { run, db, cfg } = deps;
  const log = deps.log ?? (() => {});
  const r = db.replication(id);
  if (!r) throw new BadArgs(`no replication ${id}`);
  if (db.runningJob(id)) throw new BadArgs(`replication ${id} is already running`);
  const t = target(r);
  const job = db.startJob('replication', id, `${r.dataset} → ${r.user}@${r.host}:${r.targetDataset}`, deps.pid);
  const fail = (message: string): Job => {
    log(`failed: ${message}`);
    db.finishReplication(id, 'failed', message);
    return db.finishJob(job.id, 'failed', message);
  };
  try {
    // the row may come from a restored database rather than replication.set: its names are checked again before any argv
    try {
      datasetName(r.dataset);
      datasetName(r.targetDataset, 'targetDataset');
      hostName(r.host);
      userName(r.user);
      portNumber(r.port);
      if (!Number.isInteger(r.keep) || r.keep < 1 || r.keep > 100) throw new BadArgs('keep: 1 to 100');
    } catch (e) {
      return fail(`replication ${id} is not valid (${(e as Error).message}); set it again`);
    }
    await ensureKey(run, cfg);
    const latest = `repl-${stamp(deps.now?.() ?? new Date())}`;
    await must(run, ['zfs', 'snapshot', ...(r.recursive ? ['-r'] : []), `${r.dataset}@${latest}`]);
    const localOut = await must(run, ['zfs', 'list', '-H', '-o', 'name', '-t', 'snapshot', '-s', 'creation', '-d', '1', r.dataset]);
    const local = localOut.split('\n').filter(Boolean).map(shortName);
    const remote = await remoteSnapshots(run, cfg, t, r.targetDataset);
    if (remote.error) return fail(remote.error);
    let token: string | null = null;
    if (remote.exists) {
      const tok = await run(sshArgv(cfg, t, ['zfs', 'get', '-H', '-o', 'value', 'receive_resume_token', r.targetDataset]), { timeout: 60_000 });
      if (tok.exitCode === 0 && tok.stdout.trim() && tok.stdout.trim() !== '-') token = tok.stdout.trim();
    }
    const p = plan(local, remote.snapshots, token, latest);
    if (p.kind === 'none') {
      db.finishReplication(id, 'ok', 'nothing new to send');
      return db.finishJob(job.id, 'done', 'nothing new to send');
    }
    const flags = r.recursive ? ['-R'] : ['-p'];
    const sendArgv =
      p.kind === 'resume'
        ? ['zfs', 'send', '-P', '-v', '-t', p.token]
        : p.kind === 'full'
          ? ['zfs', 'send', '-P', '-v', ...flags, `${r.dataset}@${p.to}`]
          : ['zfs', 'send', '-P', '-v', ...flags, '-I', `${r.dataset}@${p.from}`, `${r.dataset}@${p.to}`];
    // the size first, so the job can say how far it is
    let total: number | null = null;
    const est = await run([...sendArgv.slice(0, 2), '-n', ...sendArgv.slice(2)]);
    const size = /^size\t(\d+)$/m.exec(est.stdout + est.stderr);
    if (size) total = Number(size[1]);
    const what = p.kind === 'resume' ? 'resumed the interrupted send' : p.kind === 'full' ? `full send of ${p.to}` : `incremental from ${p.from} to ${p.to}`;
    db.progressJob(job.id, 0, total, what);
    log(`${r.dataset}: ${what}${total ? ` (${total} bytes)` : ''}`);
    // -u: not mounted now; -x mountpoint: the copy inherits its place from the target's parent instead of carrying the
    // source's (a copy on the same box would otherwise sit over the original at the next mount -a); readonly: a copy is not for writing
    const recvArgv = sshArgv(cfg, t, ['zfs', 'receive', '-u', '-s', '-x', 'mountpoint', '-o', 'readonly=on', r.targetDataset]);
    let last = 0;
    const result = await deps.pipe(sendArgv, recvArgv, (bytes) => {
      if (bytes - last >= 8 * 1024 * 1024 || bytes === total) {
        last = bytes;
        db.progressJob(job.id, bytes, total);
      }
    });
    if (result.exitCode !== 0) return fail(`${what}: ${result.stderr.split('\n').pop() || `exit ${result.exitCode}`}`);
    db.progressJob(job.id, total ?? last, total);
    // our own repl-* snapshots beyond `keep`, on both sides, oldest first; nothing else is ever destroyed
    const mine = local.filter((s) => s.startsWith('repl-'));
    if (!mine.includes(latest)) mine.push(latest);
    for (const old of mine.slice(0, Math.max(0, mine.length - r.keep))) {
      await run(['zfs', 'destroy', ...(r.recursive ? ['-r'] : []), `${r.dataset}@${old}`]);
      await run(sshArgv(cfg, t, ['zfs', 'destroy', ...(r.recursive ? ['-r'] : []), `${r.targetDataset}@${old}`]), { timeout: 60_000 });
    }
    const message = `${what}${total ? `, ${Math.round(total / 1048576)} MB` : ''}`;
    db.finishReplication(id, 'ok', message);
    log(`done: ${message}`);
    return db.finishJob(job.id, 'done', message);
  } catch (e) {
    return fail((e as Error).message);
  }
}
