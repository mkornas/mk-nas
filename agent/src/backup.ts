/**
 * The box's settings, kept where the data is. Everything the OS disk holds
 * that a pool cannot: the agent's database (policies, shares, copies, SMB
 * users), Samba's password database, the ssh key the copies use, the
 * netplan file, the drive's .env and the drive's own database (its
 * accounts). Written into a dataset of the person's choosing, once a day
 * and on demand, then snapshotted there (`config-<stamp>`, the last 30
 * kept) — so it replicates with everything else, and a dead OS disk is
 * the stick, `pool.import`, and one restore.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConfigBackup } from '../../shared/types.ts';
import type { Db } from './db.ts';
import { BadArgs, datasetName } from './names.ts';
import { stamp } from './policy.ts';
import { must, type Runner } from './run.ts';
import { tokenOf } from './tunnel.ts';
import { confirmed } from './write.ts';
import { listDatasets, listSnapshots } from './zfs.ts';

export interface BackupConfig {
  /** The agent's own database and ssh files. */
  db: string;
  sshKey: string;
  knownHosts: string;
  netplanFile: string;
  /** The drive's .env and database. */
  driveEnv: string;
  driveDb: string;
  /** The runner that finishes a restore once the agent has stepped aside. */
  spawn: (argv: string[]) => void;
}

export const DIR = 'mk-nas-config';
const KEEP = 30;

interface Manifest {
  at: string;
  hostname: string;
  files: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function mountpointOf(run: Runner, datasetArg: string): Promise<string> {
  // the name may come from the database, which a restore replaces: checked again before it reaches zfs
  const dataset = datasetName(datasetArg);
  const [d] = await listDatasets(run, dataset);
  if (!d || d.name !== dataset) throw new BadArgs(`${dataset}: no such dataset`);
  if (!d.mountpoint || !d.mounted) throw new BadArgs(`${dataset} is not mounted`);
  return d.mountpoint;
}

/** A consistent copy of a live SQLite file, WAL and all, without stopping whoever has it open. */
function snapshotSqlite(file: string, to: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;

/**
 * A file of a backup, opened only when it is a regular file reached through real directories and lives on the
 * backup's own filesystem: whoever can write the dataset could otherwise point an entry at the ssh key or /etc/shadow.
 */
async function openSource(dir: string, rel: string): Promise<FileHandle> {
  const root = await lstat(dir);
  if (!root.isDirectory()) throw new BadArgs(`${DIR} is not a directory`);
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++)
    if (!(await lstat(join(dir, ...parts.slice(0, i)))).isDirectory()) throw new BadArgs(`${rel} in the backup: ${parts[i - 1]} is not a directory`);
  const s = await lstat(join(dir, rel));
  if (!s.isFile()) throw new BadArgs(`${rel} in the backup is not a regular file`);
  const h = await open(join(dir, rel), O_RDONLY | O_NOFOLLOW);
  const f = await h.stat();
  if (!f.isFile() || f.dev !== root.dev || f.ino !== s.ino) {
    await h.close();
    throw new BadArgs(`${rel} in the backup changed while it was opened`);
  }
  return h;
}

/**
 * Writes `to` without following a link at that name: a fresh file beside it (O_EXCL|O_NOFOLLOW, so nothing already
 * there is opened), filled, then renamed over — rename replaces a link, it never writes through one.
 */
async function writeNoFollow(to: string, mode: number, fill: (h: FileHandle) => Promise<void>): Promise<void> {
  const tmp = `${to}.mk-nas-${randomBytes(6).toString('hex')}`;
  const h = await open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
  try {
    await h.chmod(mode);
    await fill(h);
  } catch (e) {
    await h.close();
    await rm(tmp, { force: true });
    throw e;
  }
  await h.close();
  await rename(tmp, to);
}

async function copyInto(from: FileHandle, to: FileHandle): Promise<void> {
  const buf = Buffer.allocUnsafe(1 << 20);
  for (let pos = 0; ;) {
    const { bytesRead } = await from.read(buf, 0, buf.length, pos);
    if (!bytesRead) return;
    for (let off = 0; off < bytesRead;) off += (await to.write(buf, off, bytesRead - off)).bytesWritten;
    pos += bytesRead;
  }
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const h = await openSource(dir, 'manifest.json');
    try {
      return JSON.parse(await h.readFile('utf8')) as Manifest;
    } finally {
      await h.close();
    }
  } catch {
    return null;
  }
}

/**
 * The backup is written by path: when anyone but root can write the dataset's top directory (a location is the
 * container's), a link could be swapped in under the agent mid-write, and the key and Samba's passwords do not belong there.
 */
async function rootOnly(mp: string, dataset: string): Promise<void> {
  const s = await lstat(mp);
  if (!s.isDirectory() || s.uid !== (process.getuid?.() ?? 0) || s.mode & 0o022)
    throw new BadArgs(`${dataset}: others can write to it; the settings backup needs a dataset only root writes to (not a location)`);
}

/** What a value from the backup's mk-drive.env must look like, per key; a key not here is never restored. */
const plain = (v: string) => /^[^\x00-\x1f\x7f"'`\\$]{0,1024}$/.test(v);
const ENV_KEYS: Record<string, (v: string) => boolean> = {
  DRIVE_UID: (v) => /^\d{1,10}$/.test(v),
  DRIVE_GID: (v) => /^\d{1,10}$/.test(v),
  TZ: (v) => /^[A-Za-z0-9_+-]{1,32}(\/[A-Za-z0-9_+-]{1,32}){0,3}$/.test(v),
  DRIVE_PASSWORD_LOGIN: (v) => ['on', 'lan', 'off'].includes(v),
  DRIVE_OIDC_ISSUER: (v) => {
    try {
      return plain(v) && !/\s/.test(v) && ['http:', 'https:'].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  },
  DRIVE_OIDC_CLIENT_ID: plain,
  DRIVE_OIDC_CLIENT_SECRET: plain,
  DRIVE_OIDC_NAME: plain,
  // the drive's read-only monitor route for a dashboard elsewhere: 32 to 256 token characters, as the drive requires
  DRIVE_NAS_MONITOR_TOKEN: (v) => /^[A-Za-z0-9._~+/=-]{32,256}$/.test(v),
  CLOUDFLARE_TUNNEL_TOKEN: (v) => {
    try {
      return tokenOf(v).token === v;
    } catch {
      return false;
    }
  },
};
const keyOf = (line: string) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];

/**
 * The drive's .env after a restore: the file on this box, line for line, with the allow-listed keys the backup has
 * set to the backup's values. Everything else in the backup is left behind — DRIVE_IMAGE too, since it chooses the
 * image the drive runs, and MK_NAS_GID, which is this box's group. A key whose value fails its check keeps this box's
 * value and gets a comment saying so (the value itself is never written), so one odd line does not stop a restore.
 */
export function mergeDriveEnv(current: string, backup: string): string {
  const taken = new Map<string, string | null>();
  for (const line of backup.split(/\r?\n/)) {
    const key = keyOf(line);
    if (!key || !Object.hasOwn(ENV_KEYS, key)) continue;
    // the last line wins, as in docker compose; only KEY=value, optionally quoted as a whole
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    const value = m?.[2].replace(/^(["'])(.*)\1$/, '$2');
    taken.set(key, m && value !== undefined && (value === '' || ENV_KEYS[key](value)) ? line : null);
  }
  const out = current.split('\n');
  while (out.length && out.at(-1) === '') out.pop();
  for (const [key, line] of taken) {
    if (line === null) {
      const note = `# ${key} from the settings backup was not restored: its value did not pass the check`;
      if (!out.includes(note)) out.push(note);
      continue;
    }
    // in place of this box's first line for the key, the others dropped
    const at = out.findIndex((l) => keyOf(l) === key);
    if (at === -1) out.push(line);
    else {
      out[at] = line;
      for (let i = out.length - 1; i > at; i--) if (keyOf(out[i]) === key) out.splice(i, 1);
    }
  }
  return out.length ? out.join('\n') + '\n' : '';
}

export async function readBackup(run: Runner, db: Db, cfg: BackupConfig): Promise<ConfigBackup> {
  const row = db.configBackup();
  const out: ConfigBackup = {
    dataset: row?.dataset ?? null,
    lastAt: row?.lastAt ?? null,
    lastResult: row?.lastResult ?? null,
    lastMessage: row?.lastMessage ?? null,
    snapshots: 0,
    files: [],
    takenAt: null,
  };
  if (!out.dataset) return out;
  try {
    const mp = await mountpointOf(run, out.dataset);
    const m = await readManifest(join(mp, DIR));
    if (m) {
      out.files = m.files;
      out.takenAt = m.at;
    }
    out.snapshots = (await listSnapshots(run, out.dataset)).filter((s) => s.snapshot.startsWith('config-')).length;
  } catch {
    /* the dataset is gone or not mounted: the row says so by itself */
  }
  return out;
}

export async function setBackup(run: Runner, db: Db, cfg: BackupConfig, dataset: unknown): Promise<ConfigBackup> {
  if (dataset === null || dataset === undefined || dataset === '') db.setConfigBackup(null);
  else {
    const name = datasetName(dataset);
    if (!name.includes('/')) throw new BadArgs('pick a dataset, not a pool');
    await rootOnly(await mountpointOf(run, name), name);
    db.setConfigBackup(name);
  }
  return readBackup(run, db, cfg);
}

/** One backup: a fresh directory built next to the old one, swapped in whole, then a snapshot. */
export async function runBackup(run: Runner, db: Db, cfg: BackupConfig, now = new Date()): Promise<ConfigBackup> {
  const row = db.configBackup();
  if (!row) throw new BadArgs('no dataset was chosen for the settings backup');
  try {
    const mp = await mountpointOf(run, row.dataset);
    await rootOnly(mp, row.dataset);
    const dir = join(mp, DIR);
    const fresh = `${dir}.new`;
    // rm unlinks a link instead of following it; mkdir without recursive refuses whatever is still in the way
    await rm(fresh, { recursive: true, force: true });
    await mkdir(fresh, { mode: 0o700 });
    await mkdir(join(fresh, 'ssh'), { mode: 0o700 });
    const files: string[] = [];
    snapshotSqlite(cfg.db, join(fresh, 'mk-nas.db'));
    files.push('mk-nas.db');
    // Samba's password database, exported the way pdbedit imports it back
    const pdb = await run(['pdbedit', '-e', `tdbsam:${join(fresh, 'passdb.tdb')}`]);
    if (pdb.exitCode === 0) files.push('passdb.tdb');
    for (const [from, to] of [
      [cfg.sshKey, 'ssh/id_ed25519'],
      [`${cfg.sshKey}.pub`, 'ssh/id_ed25519.pub'],
      [cfg.knownHosts, 'ssh/known_hosts'],
      [cfg.netplanFile, '90-mk-nas.yaml'],
      [cfg.driveEnv, 'mk-drive.env'],
    ]) {
      if (!(await exists(from))) continue;
      await copyFile(from, join(fresh, to));
      files.push(to);
    }
    // the drive's data directory is the container's: its database must be a file, not a link to one of root's
    const driveDb = await lstat(cfg.driveDb).catch(() => null);
    if (driveDb && !driveDb.isFile()) throw new Error(`${cfg.driveDb} is not a regular file`);
    if (driveDb) {
      snapshotSqlite(cfg.driveDb, join(fresh, 'mk-drive.db'));
      files.push('mk-drive.db');
    }
    const manifest: Manifest = { at: now.toISOString(), hostname: hostname(), files };
    await writeFile(join(fresh, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    const old = `${dir}.old`;
    await rm(old, { recursive: true, force: true });
    if (await lstat(dir).catch(() => null)) await rename(dir, old);
    await rename(fresh, dir);
    await rm(old, { recursive: true, force: true });
    // the history is ZFS's: one snapshot per backup, the newest 30 kept
    await must(run, ['zfs', 'snapshot', `${row.dataset}@config-${stamp(now)}`]);
    const mine = (await listSnapshots(run, row.dataset))
      .filter((s) => s.snapshot.startsWith('config-'))
      .sort((a, b) => Date.parse(a.creation) - Date.parse(b.creation));
    for (const s of mine.slice(0, Math.max(0, mine.length - KEEP))) await must(run, ['zfs', 'destroy', s.name]);
    db.recordConfigBackup('ok', `${files.length} files`, now.getTime());
  } catch (e) {
    db.recordConfigBackup('failed', (e as Error).message, now.getTime());
    throw e;
  }
  return readBackup(run, db, cfg);
}

/** Due once a day, and only when a dataset was chosen. */
export function backupDue(db: Db, now = Date.now()): boolean {
  const row = db.configBackup();
  return !!row && (!row.lastAt || now - Date.parse(row.lastAt) >= 20 * 3_600_000);
}

/**
 * Puts the files back. What the running agent and drive hold open (their
 * databases) goes next to the live file as `.restore`; the detached finisher
 * stops both services, moves the files into place, imports the Samba
 * passwords, regenerates smb.conf and the exports, and starts everything
 * again — so the answer to this verb still arrives.
 */
export async function restoreBackup(
  run: Runner,
  cfg: BackupConfig,
  dataset: unknown,
  confirm: unknown,
): Promise<{ restoring: true; files: string[]; takenAt: string }> {
  const name = datasetName(dataset);
  confirmed(confirm, name);
  const mp = await mountpointOf(run, name);
  const dir = join(mp, DIR);
  const m = await readManifest(dir);
  if (!m) throw new BadArgs(`${name} holds no settings backup`);
  const has = (f: string) => m.files.includes(f);
  if (!has('mk-nas.db')) throw new BadArgs('the backup has no agent database');
  // Samba's passwords wait in root's own directory for the finisher, not in the dataset where they could change meanwhile
  const passdb = join(dirname(cfg.db), 'passdb.tdb.restore');
  const copies = (
    [
      ['ssh/id_ed25519', cfg.sshKey, 0o600],
      ['ssh/id_ed25519.pub', `${cfg.sshKey}.pub`, 0o644],
      ['ssh/known_hosts', cfg.knownHosts, 0o600],
      ['90-mk-nas.yaml', cfg.netplanFile, 0o600],
      ['mk-nas.db', `${cfg.db}.restore`, 0o600],
      ['mk-drive.db', `${cfg.driveDb}.restore`, 0o600],
      ['passdb.tdb', passdb, 0o600],
    ] as [string, string, number][]
  ).filter(([f]) => has(f));
  // every source is opened before anything is written: a backup with a link in it restores nothing
  const sources = new Map<string, FileHandle>();
  try {
    for (const f of [...copies.map(([f]) => f), ...(has('mk-drive.env') ? ['mk-drive.env'] : [])]) sources.set(f, await openSource(dir, f));
    const env = sources.get('mk-drive.env');
    if (env && (await env.stat()).size > 1 << 20) throw new BadArgs('mk-drive.env in the backup is too large to be an .env');
    await mkdir(dirname(cfg.sshKey), { recursive: true, mode: 0o700 });
    for (const [f, to, mode] of copies) {
      await mkdir(dirname(to), { recursive: true });
      // the drive's data directory is the container's: whatever it left at the .restore name goes, unfollowed
      if (to.endsWith('.restore')) await rm(to, { force: true });
      await writeNoFollow(to, mode, (h) => copyInto(sources.get(f)!, h));
    }
    if (env) {
      const backup = await env.readFile('utf8');
      const current = await readFile(cfg.driveEnv, 'utf8').catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return '';
        throw e;
      });
      await writeNoFollow(cfg.driveEnv, 0o600, (h) => h.writeFile(mergeDriveEnv(current, backup)));
    }
  } finally {
    for (const h of sources.values()) await h.close();
  }
  cfg.spawn([process.execPath, new URL('./restore-finish.ts', import.meta.url).pathname, has('passdb.tdb') ? passdb : '']);
  return { restoring: true, files: m.files, takenAt: m.at };
}
