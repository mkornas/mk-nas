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
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConfigBackup } from '../../shared/types.ts';
import type { Db } from './db.ts';
import { BadArgs, datasetName } from './names.ts';
import { stamp } from './policy.ts';
import { must, type Runner } from './run.ts';
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

async function mountpointOf(run: Runner, dataset: string): Promise<string> {
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

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    return null;
  }
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
    await mountpointOf(run, name);
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
    const dir = join(mp, DIR);
    const fresh = `${dir}.new`;
    await rm(fresh, { recursive: true, force: true });
    await mkdir(join(fresh, 'ssh'), { recursive: true, mode: 0o700 });
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
    if (await exists(cfg.driveDb)) {
      snapshotSqlite(cfg.driveDb, join(fresh, 'mk-drive.db'));
      files.push('mk-drive.db');
    }
    const manifest: Manifest = { at: now.toISOString(), hostname: hostname(), files };
    await writeFile(join(fresh, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    const old = `${dir}.old`;
    await rm(old, { recursive: true, force: true });
    if (await exists(dir)) await rename(dir, old);
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
  await mkdir(dirname(cfg.sshKey), { recursive: true, mode: 0o700 });
  for (const [f, to, mode] of [
    ['ssh/id_ed25519', cfg.sshKey, 0o600],
    ['ssh/id_ed25519.pub', `${cfg.sshKey}.pub`, 0o644],
    ['ssh/known_hosts', cfg.knownHosts, 0o600],
    ['90-mk-nas.yaml', cfg.netplanFile, 0o600],
    ['mk-drive.env', cfg.driveEnv, 0o600],
  ] as [string, string, number][]) {
    if (!has(f)) continue;
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(dir, f), to);
    await chmod(to, mode);
  }
  await copyFile(join(dir, 'mk-nas.db'), `${cfg.db}.restore`);
  if (has('mk-drive.db')) await copyFile(join(dir, 'mk-drive.db'), `${cfg.driveDb}.restore`);
  cfg.spawn([process.execPath, new URL('./restore-finish.ts', import.meta.url).pathname, has('passdb.tdb') ? join(dir, 'passdb.tdb') : '']);
  return { restoring: true, files: m.files, takenAt: m.at };
}
