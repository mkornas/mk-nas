/**
 * The data itself, off the box. Replication copies a dataset to another ZFS host; this is for when there is none:
 * the chosen datasets go to a restic repository in object storage (S3 or anything that speaks it, Backblaze B2) or
 * on a path (a USB disk), encrypted before they leave, deduplicated, with a history.
 *
 * Each run takes one snapshot per dataset under a fixed name, `@mk-nas-offsite`, and backs up from
 * `<mountpoint>/.zfs/snapshot/mk-nas-offsite`: what is copied is one moment of the dataset, and the path is the same
 * every time, so restic compares against the last run instead of reading every file again. The snapshot is gone
 * when the run ends. A restore never writes over anything: it lands in a new `restored-<stamp>` directory.
 *
 * The secrets — the storage's keys and the repository's password — live in one root-only file, reach restic only
 * through its environment and are never returned by any verb, except the password once, when the agent made it:
 * without it the repository cannot be read, and the box that knows it is the thing the backup is for losing.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Job, Offsite, OffsiteSchedule, OffsiteSetArgs, OffsiteSnapshot } from '../../shared/types.ts';
import type { Db } from './db.ts';
import { BadArgs, datasetName } from './names.ts';
import { stamp } from './policy.ts';
import { must, type Runner } from './run.ts';
import { listDatasets, listSnapshots } from './zfs.ts';

export interface OffsiteConfig {
  /** The root-only file with the storage keys and the repository password. */
  secrets: string;
  /** restic's cache, so a run does not download the repository's index again. */
  cache: string;
  hostname: string;
}

export const SNAPSHOT = 'mk-nas-offsite';
export const SCHEDULES: OffsiteSchedule[] = ['manual', 'daily', 'weekly'];
const PERIOD: Record<Exclude<OffsiteSchedule, 'manual'>, number> = { daily: 86_400_000, weekly: 7 * 86_400_000 };
const SLACK = 10 * 60_000;
/** What `forget` keeps of each dataset's history. */
const KEEP = ['--keep-daily', '7', '--keep-weekly', '4', '--keep-monthly', '12'];
const TAG = 'mk-nas';

type Kind = 's3' | 'b2' | 'path';

/** Which credentials each kind of repository takes; nothing else is ever put into restic's environment from a caller. */
const CREDENTIALS: Record<Kind, string[]> = {
  s3: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  b2: ['B2_ACCOUNT_ID', 'B2_ACCOUNT_KEY'],
  path: [],
};

/**
 * A repository as restic names it, of the three kinds this takes: `s3:https://host/bucket[/prefix]`,
 * `b2:bucket[:prefix]`, or an absolute path. Never anything that could be read as an option, and no credentials in it.
 */
export function repositoryOf(v: unknown): { repository: string; kind: Kind } {
  if (typeof v !== 'string' || v.length > 400) throw new BadArgs('repository: s3:https://host/bucket, b2:bucket or a path');
  if (/^s3:https?:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(v)) return { repository: v, kind: 's3' };
  if (/^b2:[A-Za-z0-9-]{6,63}(:[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)?$/.test(v)) return { repository: v, kind: 'b2' };
  if (/^(\/[A-Za-z0-9._-]+)+$/.test(v) && !v.split('/').includes('..')) return { repository: v, kind: 'path' };
  throw new BadArgs('repository: s3:https://host/bucket, b2:bucket or a path');
}

const secretValue = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(v)) throw new BadArgs(`${what}: printable characters without spaces`);
  return v;
};

export function passwordOf(v: unknown): string {
  if (typeof v !== 'string' || !/^[\x21-\x7e]{12,256}$/.test(v)) throw new BadArgs('password: 12 to 256 printable characters without spaces');
  return v;
}

export function scheduleOf(v: unknown): OffsiteSchedule {
  if (v === undefined) return 'daily';
  if (typeof v !== 'string' || !SCHEDULES.includes(v as OffsiteSchedule)) throw new BadArgs(`schedule: one of ${SCHEDULES.join(', ')}`);
  return v as OffsiteSchedule;
}

interface Secrets {
  password: string;
  credentials: Record<string, string>;
}

/** The secrets file, read strictly: a value that would not pass `offsite.set` (a restored or edited file) is not used. */
export async function readSecrets(file: string): Promise<Secrets | null> {
  let j: { password?: unknown; credentials?: unknown };
  try {
    j = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  try {
    const credentials: Record<string, string> = {};
    const all = Object.values(CREDENTIALS).flat();
    for (const [k, v] of Object.entries((j.credentials ?? {}) as Record<string, unknown>)) if (all.includes(k)) credentials[k] = secretValue(v, k);
    return { password: passwordOf(j.password), credentials };
  } catch {
    return null;
  }
}

async function writeSecrets(file: string, s: Secrets): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(s) + '\n', { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

/** What restic is started with: the repository and the secrets in its environment, never on its command line. */
function resticEnv(cfg: OffsiteConfig, repository: string, s: Secrets): Record<string, string> {
  return { RESTIC_REPOSITORY: repository, RESTIC_PASSWORD: s.password, RESTIC_CACHE_DIR: cfg.cache, HOME: dirname(cfg.cache), ...s.credentials };
}

/** restic's own words for what went wrong, shortened to the line that says it. */
function why(stderr: string, exitCode: number | null): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const fatal = lines.find((l) => l.startsWith('Fatal:'));
  return (fatal ?? lines.at(-1) ?? `restic exited ${exitCode}`).replace(/^Fatal:\s*/, '');
}

export async function resticVersion(run: Runner): Promise<string | null> {
  const r = await run(['restic', 'version']);
  return r.exitCode === 0 ? (/^restic (\S+)/.exec(r.stdout)?.[1] ?? null) : null;
}

export async function readOffsite(run: Runner, db: Db, cfg: OffsiteConfig): Promise<Offsite> {
  const row = db.offsite();
  const secrets = row ? await readSecrets(cfg.secrets) : null;
  return {
    available: (await resticVersion(run)) !== null,
    repository: row?.repository ?? null,
    datasets: row?.datasets ?? [],
    schedule: row?.schedule ?? 'daily',
    credentials: Object.keys(secrets?.credentials ?? {}).sort(),
    hasPassword: !!secrets,
    lastRunAt: row?.lastRunAt ?? null,
    lastResult: row?.lastResult ?? null,
    lastMessage: row?.lastMessage ?? null,
    running: db.runningOffsite(),
  };
}

/**
 * Chooses the repository, what goes into it and how often. The repository is opened with what was given before
 * anything is stored: one that does not exist yet is made, one that exists must take the password. Credentials and
 * the password are kept when left out, as long as the repository stays the same.
 */
export async function setOffsite(run: Runner, db: Db, cfg: OffsiteConfig, a: OffsiteSetArgs): Promise<Offsite & { password?: string }> {
  const { repository, kind } = repositoryOf(a.repository);
  if (!Array.isArray(a.datasets) || a.datasets.length === 0 || a.datasets.length > 64) throw new BadArgs('datasets: at least one dataset');
  const datasets = [...new Set(a.datasets.map((d) => datasetName(d)))].sort();
  const known = await listDatasets(run);
  for (const d of datasets) {
    const found = known.find((k) => k.name === d);
    if (!found) throw new BadArgs(`${d}: no such dataset`);
    if (found.type !== 'filesystem') throw new BadArgs(`${d} is a volume; only filesystems are backed up`);
  }
  const schedule = scheduleOf(a.schedule);
  if ((await resticVersion(run)) === null) throw new BadArgs('restic is not installed on the box: sudo apt install restic');

  const row = db.offsite();
  const stored = row?.repository === repository ? await readSecrets(cfg.secrets) : null;
  const credentials: Record<string, string> = {};
  if (a.credentials !== undefined && (a.credentials === null || typeof a.credentials !== 'object' || Array.isArray(a.credentials)))
    throw new BadArgs('credentials must be an object');
  for (const [k, v] of Object.entries(a.credentials ?? {})) {
    if (!CREDENTIALS[kind].includes(k)) throw new BadArgs(`credentials: ${k} is not one this kind of repository takes (${CREDENTIALS[kind].join(', ') || 'none'})`);
    credentials[k] = secretValue(v, k);
  }
  for (const k of CREDENTIALS[kind]) {
    if (credentials[k] === undefined && stored?.credentials[k] !== undefined) credentials[k] = stored.credentials[k];
    if (credentials[k] === undefined) throw new BadArgs(`credentials: ${k} is needed`);
  }
  const given = a.password === undefined || a.password === '' ? null : passwordOf(a.password);
  const made = given || stored ? null : randomBytes(24).toString('base64url');
  const secrets: Secrets = { password: given ?? stored?.password ?? made!, credentials };

  const env = resticEnv(cfg, repository, secrets);
  await mkdir(cfg.cache, { recursive: true, mode: 0o700 });
  const open = await run(['restic', 'cat', 'config', '--no-lock'], { env, timeout: 120_000 });
  if (open.exitCode !== 0) {
    if (/wrong password|no key found/i.test(open.stderr))
      throw new BadArgs(given ? 'the repository exists and that is not its password' : 'the repository exists already: give its password to use it');
    if (!/does not exist|Is there a repository|unable to open config file/i.test(open.stderr)) throw new BadArgs(`the repository cannot be reached: ${why(open.stderr, open.exitCode)}`);
    const init = await run(['restic', 'init'], { env, timeout: 120_000 });
    if (init.exitCode !== 0) throw new BadArgs(`the repository could not be made: ${why(init.stderr, init.exitCode)}`);
  }
  await writeSecrets(cfg.secrets, secrets);
  db.setOffsite({ repository, datasets, schedule });
  const out: Offsite & { password?: string } = await readOffsite(run, db, cfg);
  // the one time it is said: the box that knows it is what this backup is for losing
  if (made) out.password = made;
  return out;
}

/** Forgets the repository and its secrets on this box. What is stored in the repository stays there. */
export async function removeOffsite(run: Runner, db: Db, cfg: OffsiteConfig): Promise<Offsite> {
  if (db.runningOffsite()) throw new BadArgs('a backup or a restore is running; wait for it to finish');
  db.setOffsite(null);
  await rm(cfg.secrets, { force: true });
  return readOffsite(run, db, cfg);
}

export function due(o: { schedule: OffsiteSchedule; lastRunAt: string | null }, now = Date.now()): boolean {
  if (o.schedule === 'manual') return false;
  if (!o.lastRunAt) return true;
  return now - Date.parse(o.lastRunAt) >= PERIOD[o.schedule] - SLACK;
}

/** A command whose stdout is read line by line while it runs. */
export type Stream = (argv: string[], env: Record<string, string>, onLine: (line: string) => void) => Promise<{ exitCode: number | null; stderr: string }>;

export const stream: Stream = (argv, env, onLine) =>
  new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C', ...env } });
    let tail = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      tail += d;
      const lines = tail.split('\n');
      tail = lines.pop() ?? '';
      lines.forEach(onLine);
    });
    child.stderr.on('data', (d: string) => (stderr = (stderr + d).slice(-8192)));
    child.on('error', (e) => resolve({ exitCode: null, stderr: e.message }));
    child.on('close', (code) => {
      if (tail) onLine(tail);
      resolve({ exitCode: code, stderr });
    });
  });

export interface OffsiteDeps {
  run: Runner;
  stream: Stream;
  db: Db;
  cfg: OffsiteConfig;
  pid: number;
  now?: () => Date;
  log?: (line: string) => void;
}

const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

/** What a job cannot start without: the stored choice, valid as `offsite.set` would have it, and the secrets. */
async function ready(deps: OffsiteDeps): Promise<{ repository: string; datasets: string[]; env: Record<string, string> }> {
  const row = deps.db.offsite();
  if (!row) throw new BadArgs('no off-site backup is set up');
  // the row may come from a restored database: its names are checked again before any argv
  const { repository } = repositoryOf(row.repository);
  const datasets = row.datasets.map((d) => datasetName(d));
  const secrets = await readSecrets(deps.cfg.secrets);
  if (!secrets) throw new BadArgs('the repository password is missing on this box; set the off-site backup up again with it');
  await mkdir(deps.cfg.cache, { recursive: true, mode: 0o700 });
  return { repository, datasets, env: resticEnv(deps.cfg, repository, secrets) };
}

/** One backup of every chosen dataset, start to finish; the job row is the progress report. */
export async function backup(deps: OffsiteDeps): Promise<Job> {
  const { run, db } = deps;
  const log = deps.log ?? (() => {});
  if (db.runningOffsite()) throw new BadArgs('a backup or a restore is already running');
  const row = db.offsite();
  const job = db.startJob('offsite', null, `${row?.datasets.length ?? 0} dataset${row?.datasets.length === 1 ? '' : 's'} → ${row?.repository ?? '?'}`, deps.pid);
  const fail = (message: string): Job => {
    log(`failed: ${message}`);
    db.finishOffsite('failed', message);
    return db.finishJob(job.id, 'failed', message);
  };
  try {
    const { datasets, env } = await ready(deps);
    const mounted = await listDatasets(run);
    const failed: string[] = [];
    let added = 0;
    let files = 0;
    for (const [i, dataset] of datasets.entries()) {
      const label = `${dataset} (${i + 1} of ${datasets.length})`;
      const d = mounted.find((m) => m.name === dataset);
      if (!d || d.type !== 'filesystem' || !d.mounted || !d.mountpoint) {
        failed.push(`${dataset}: not there or not mounted`);
        continue;
      }
      const snap = `${dataset}@${SNAPSHOT}`;
      try {
        // one left by a run that was cut short
        if ((await listSnapshots(run, dataset)).some((s) => s.name === snap)) await must(run, ['zfs', 'destroy', snap]);
        await must(run, ['zfs', 'snapshot', snap]);
        db.progressJob(job.id, 0, null, label);
        let last = 0;
        let error = '';
        const r = await deps.stream(
          ['restic', 'backup', '--json', '--host', deps.cfg.hostname, '--tag', TAG, '--tag', dataset, join(d.mountpoint, '.zfs', 'snapshot', SNAPSHOT)],
          env,
          (line) => {
            let m: { message_type?: string; bytes_done?: number; total_bytes?: number; data_added?: number; total_files_processed?: number; error?: { message?: string }; item?: string };
            try {
              m = JSON.parse(line);
            } catch {
              return;
            }
            if (m.message_type === 'status' && typeof m.bytes_done === 'number' && Date.now() - last >= 2000) {
              last = Date.now();
              db.progressJob(job.id, m.bytes_done, m.total_bytes ?? null);
            } else if (m.message_type === 'summary') {
              added += m.data_added ?? 0;
              files += m.total_files_processed ?? 0;
            } else if (m.message_type === 'error') error = `${m.item ?? ''} ${m.error?.message ?? ''}`.trim();
          },
        );
        if (r.exitCode !== 0) failed.push(`${dataset}: ${error || why(r.stderr, r.exitCode)}`);
        else log(`${dataset}: backed up`);
      } catch (e) {
        failed.push(`${dataset}: ${(e as Error).message}`);
      } finally {
        await run(['zfs', 'destroy', snap]);
      }
    }
    if (failed.length) return fail(failed.join('; '));
    // the history thins out only after a run where everything arrived
    db.progressJob(job.id, 0, null, 'thinning out the history');
    const forget = await run(['restic', 'forget', '--tag', TAG, '--group-by', 'host,tags', ...KEEP, '--prune'], { env, timeout: 6 * 3_600_000 });
    if (forget.exitCode !== 0) return fail(`backed up, but the old history could not be thinned out: ${why(forget.stderr, forget.exitCode)}`);
    const message = `${files} files in ${datasets.length} dataset${datasets.length === 1 ? '' : 's'}, ${mb(added)} new`;
    db.finishOffsite('ok', message);
    log(`done: ${message}`);
    return db.finishJob(job.id, 'done', message);
  } catch (e) {
    return fail((e as Error).message);
  }
}

interface ResticSnapshot {
  id?: string;
  short_id?: string;
  time?: string;
  tags?: string[];
  paths?: string[];
}

function ours(list: ResticSnapshot[]): (OffsiteSnapshot & { path: string })[] {
  const out: (OffsiteSnapshot & { path: string })[] = [];
  for (const s of list) {
    const dataset = s.tags?.find((t) => t !== TAG);
    if (typeof s.id !== 'string' || !/^[0-9a-f]{64}$/.test(s.id) || !s.tags?.includes(TAG) || !dataset || typeof s.paths?.[0] !== 'string') continue;
    const time = Date.parse(s.time ?? '');
    if (Number.isNaN(time)) continue;
    out.push({ id: s.id.slice(0, 12), time: new Date(time).toISOString(), dataset, path: s.paths[0] });
  }
  return out.sort((a, b) => b.time.localeCompare(a.time));
}

/** What the repository holds, newest first. Asks the repository, so it takes as long as the network does. */
export async function listOffsiteSnapshots(deps: Pick<OffsiteDeps, 'run' | 'db' | 'cfg'>): Promise<OffsiteSnapshot[]> {
  const { env } = await ready(deps as OffsiteDeps);
  const r = await deps.run(['restic', 'snapshots', '--json', '--tag', TAG, '--no-lock'], { env, timeout: 120_000 });
  if (r.exitCode !== 0) throw new BadArgs(`the repository cannot be read: ${why(r.stderr, r.exitCode)}`);
  return ours(JSON.parse(r.stdout || '[]') as ResticSnapshot[]).map(({ path: _path, ...s }) => s);
}

export function snapshotId(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{8,64}$/.test(v)) throw new BadArgs('snapshot: an id from the list');
  return v;
}

/**
 * Brings one snapshot back into a new directory, `restored-<stamp>`, at the top of `into` (any mounted dataset).
 * Nothing that exists is written over; the person moves what they need from there.
 */
export async function restore(deps: OffsiteDeps, snapshot: string, into: string): Promise<Job> {
  const { run, db } = deps;
  const log = deps.log ?? (() => {});
  if (db.runningOffsite()) throw new BadArgs('a backup or a restore is already running');
  const id = snapshotId(snapshot);
  const dataset = datasetName(into);
  const job = db.startJob('offsite', null, `restore ${id} → ${dataset}`, deps.pid);
  const fail = (message: string): Job => {
    log(`failed: ${message}`);
    return db.finishJob(job.id, 'failed', message);
  };
  try {
    const { env } = await ready(deps);
    const [d] = (await listDatasets(run, dataset)).filter((x) => x.name === dataset);
    if (!d || d.type !== 'filesystem' || !d.mounted || !d.mountpoint) return fail(`${dataset} is not a mounted dataset`);
    const list = await run(['restic', 'snapshots', '--json', '--tag', TAG, '--no-lock'], { env, timeout: 120_000 });
    if (list.exitCode !== 0) return fail(`the repository cannot be read: ${why(list.stderr, list.exitCode)}`);
    const found = ours(JSON.parse(list.stdout || '[]') as ResticSnapshot[]).filter((s) => s.id.startsWith(id.slice(0, 12)));
    if (found.length !== 1) return fail(`no snapshot ${id} in the repository`);
    const target = join(d.mountpoint, `restored-${stamp(deps.now?.() ?? new Date())}`);
    // without recursive: a directory of that name already there is a refusal, never a merge
    await mkdir(target, { mode: 0o700 });
    db.progressJob(job.id, 0, null, `${found[0].dataset} as of ${found[0].time} → ${target}`);
    // <id>:<path>: the dataset's own files land in the target, not under the path they were read from
    const r = await deps.stream(['restic', 'restore', `${found[0].id}:${found[0].path}`, '--target', target], env, () => {});
    if (r.exitCode !== 0) return fail(why(r.stderr, r.exitCode));
    const message = `${found[0].dataset} as of ${found[0].time} is in ${target}`;
    log(`done: ${message}`);
    return db.finishJob(job.id, 'done', message);
  } catch (e) {
    return fail((e as Error).message);
  }
}
