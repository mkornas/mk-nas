/**
 * What the system cannot hold: snapshot policies (later shares, job history,
 * SMB users). node:sqlite, one file, WAL. ZFS itself is never mirrored here.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Job, Policy, PolicySetArgs, Replication, ReplicationSchedule, ScrubInterval, ScrubPolicy, Share, SmbUser } from '../../shared/types.ts';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS policies (
    dataset TEXT PRIMARY KEY,
    hourly INTEGER NOT NULL DEFAULT 0,
    daily INTEGER NOT NULL DEFAULT 0,
    weekly INTEGER NOT NULL DEFAULT 0,
    monthly INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS config_backup (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    dataset TEXT NOT NULL,
    last_at INTEGER,
    last_result TEXT,
    last_message TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS scrub_policies (
    pool TEXT PRIMARY KEY,
    interval TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS shares (
    dataset TEXT PRIMARY KEY,
    smb INTEGER NOT NULL DEFAULT 0,
    time_machine INTEGER NOT NULL DEFAULT 0,
    nfs INTEGER NOT NULL DEFAULT 0,
    nfs_clients TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS replications (
    id INTEGER PRIMARY KEY,
    dataset TEXT NOT NULL,
    host TEXT NOT NULL,
    user TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    target_dataset TEXT NOT NULL,
    recursive INTEGER NOT NULL DEFAULT 0,
    schedule TEXT NOT NULL DEFAULT 'daily',
    keep INTEGER NOT NULL DEFAULT 3,
    last_run_at INTEGER,
    last_result TEXT,
    last_message TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    replication_id INTEGER,
    target TEXT NOT NULL,
    state TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    progress REAL,
    bytes INTEGER NOT NULL DEFAULT 0,
    total INTEGER,
    message TEXT,
    pid INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS jobs_repl ON jobs(replication_id, started_at)`,
  `CREATE TABLE IF NOT EXISTS smb_users (
    name TEXT PRIMARY KEY,
    has_password INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
];

interface ShareRow {
  dataset: string;
  smb: number;
  time_machine: number;
  nfs: number;
  nfs_clients: string;
  updated_at: number;
}

interface SmbUserRow {
  name: string;
  has_password: number;
  created_at: number;
}

interface ReplicationRow {
  id: number;
  dataset: string;
  host: string;
  user: string;
  port: number;
  target_dataset: string;
  recursive: number;
  schedule: string;
  keep: number;
  last_run_at: number | null;
  last_result: string | null;
  last_message: string | null;
  created_at: number;
}

interface JobRow {
  id: number;
  kind: string;
  replication_id: number | null;
  pool: string | null;
  target: string;
  state: string;
  started_at: number;
  finished_at: number | null;
  progress: number | null;
  bytes: number;
  total: number | null;
  message: string | null;
  pid: number | null;
}

/** A replication as stored (the running job is joined in by the verb). */
export type StoredReplication = Omit<Replication, 'running'>;

/** A share as stored: everything but the mountpoint, which ZFS knows. */
export type StoredShare = Omit<Share, 'mountpoint'>;

interface PolicyRow {
  dataset: string;
  hourly: number;
  daily: number;
  weekly: number;
  monthly: number;
  updated_at: number;
}

export class Db {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o750 });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    for (const s of SCHEMA) this.db.exec(s);
    // added after 0.2.0: the schema only ever gains columns, so an older agent ignores it
    const cols = (this.db.prepare('PRAGMA table_info(jobs)').all() as unknown as { name: string }[]).map((c) => c.name);
    if (!cols.includes('pool')) this.db.exec('ALTER TABLE jobs ADD COLUMN pool TEXT');
  }

  policies(): Policy[] {
    return (this.db.prepare('SELECT * FROM policies ORDER BY dataset').all() as unknown as PolicyRow[]).map(toPolicy);
  }

  policy(dataset: string): Policy | null {
    const row = this.db.prepare('SELECT * FROM policies WHERE dataset = ?').get(dataset) as unknown as PolicyRow | undefined;
    return row ? toPolicy(row) : null;
  }

  /** All counts zero removes the policy. */
  setPolicy(p: PolicySetArgs, now = Date.now()): Policy | null {
    if (p.hourly + p.daily + p.weekly + p.monthly === 0) {
      this.db.prepare('DELETE FROM policies WHERE dataset = ?').run(p.dataset);
      return null;
    }
    this.db
      .prepare(
        `INSERT INTO policies (dataset, hourly, daily, weekly, monthly, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(dataset) DO UPDATE SET hourly = excluded.hourly, daily = excluded.daily, weekly = excluded.weekly, monthly = excluded.monthly, updated_at = excluded.updated_at`,
      )
      .run(p.dataset, p.hourly, p.daily, p.weekly, p.monthly, now);
    return this.policy(p.dataset);
  }

  configBackup(): { dataset: string; lastAt: string | null; lastResult: 'ok' | 'failed' | null; lastMessage: string | null } | null {
    const row = this.db.prepare('SELECT * FROM config_backup WHERE id = 1').get() as
      { dataset: string; last_at: number | null; last_result: 'ok' | 'failed' | null; last_message: string | null } | undefined;
    return row
      ? { dataset: row.dataset, lastAt: row.last_at ? new Date(row.last_at).toISOString() : null, lastResult: row.last_result, lastMessage: row.last_message }
      : null;
  }

  /** null switches the backup off; a new dataset starts with no history. */
  setConfigBackup(dataset: string | null): void {
    if (dataset === null) this.db.prepare('DELETE FROM config_backup WHERE id = 1').run();
    else
      this.db
        .prepare(
          `INSERT INTO config_backup (id, dataset) VALUES (1, ?)
           ON CONFLICT(id) DO UPDATE SET dataset = excluded.dataset, last_at = CASE WHEN config_backup.dataset = excluded.dataset THEN last_at ELSE NULL END, last_result = CASE WHEN config_backup.dataset = excluded.dataset THEN last_result ELSE NULL END, last_message = CASE WHEN config_backup.dataset = excluded.dataset THEN last_message ELSE NULL END`,
        )
        .run(dataset);
  }

  recordConfigBackup(result: 'ok' | 'failed', message: string, now = Date.now()): void {
    this.db.prepare('UPDATE config_backup SET last_at = ?, last_result = ?, last_message = ? WHERE id = 1').run(now, result, message);
  }

  scrubPolicy(pool: string): ScrubPolicy | null {
    const row = this.db.prepare('SELECT * FROM scrub_policies WHERE pool = ?').get(pool) as unknown as
      { pool: string; interval: ScrubInterval; updated_at: number } | undefined;
    return row ? { pool: row.pool, interval: row.interval, updatedAt: new Date(row.updated_at).toISOString() } : null;
  }

  setScrubPolicy(pool: string, interval: ScrubInterval, now = Date.now()): ScrubPolicy {
    this.db
      .prepare(
        'INSERT INTO scrub_policies (pool, interval, updated_at) VALUES (?, ?, ?) ON CONFLICT(pool) DO UPDATE SET interval = excluded.interval, updated_at = excluded.updated_at',
      )
      .run(pool, interval, now);
    return this.scrubPolicy(pool)!;
  }

  shares(): StoredShare[] {
    return (this.db.prepare('SELECT * FROM shares ORDER BY dataset').all() as unknown as ShareRow[]).map(toShare);
  }

  share(dataset: string): StoredShare | null {
    const row = this.db.prepare('SELECT * FROM shares WHERE dataset = ?').get(dataset) as unknown as ShareRow | undefined;
    return row ? toShare(row) : null;
  }

  setShare(s: Omit<StoredShare, 'name' | 'updatedAt'>, now = Date.now()): StoredShare {
    this.db
      .prepare(
        `INSERT INTO shares (dataset, smb, time_machine, nfs, nfs_clients, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(dataset) DO UPDATE SET smb = excluded.smb, time_machine = excluded.time_machine, nfs = excluded.nfs, nfs_clients = excluded.nfs_clients, updated_at = excluded.updated_at`,
      )
      .run(s.dataset, s.smb ? 1 : 0, s.timeMachine ? 1 : 0, s.nfs ? 1 : 0, s.nfsClients.join(' '), now);
    return this.share(s.dataset)!;
  }

  removeShare(dataset: string): boolean {
    return this.db.prepare('DELETE FROM shares WHERE dataset = ?').run(dataset).changes > 0;
  }

  replications(): StoredReplication[] {
    return (this.db.prepare('SELECT * FROM replications ORDER BY id').all() as unknown as ReplicationRow[]).map(toReplication);
  }

  replication(id: number): StoredReplication | null {
    const row = this.db.prepare('SELECT * FROM replications WHERE id = ?').get(id) as unknown as ReplicationRow | undefined;
    return row ? toReplication(row) : null;
  }

  setReplication(
    r: Omit<StoredReplication, 'id' | 'lastRunAt' | 'lastResult' | 'lastMessage' | 'createdAt'> & { id?: number },
    now = Date.now(),
  ): StoredReplication {
    if (r.id) {
      this.db
        .prepare('UPDATE replications SET dataset = ?, host = ?, user = ?, port = ?, target_dataset = ?, recursive = ?, schedule = ?, keep = ? WHERE id = ?')
        .run(r.dataset, r.host, r.user, r.port, r.targetDataset, r.recursive ? 1 : 0, r.schedule, r.keep, r.id);
      return this.replication(r.id)!;
    }
    const res = this.db
      .prepare('INSERT INTO replications (dataset, host, user, port, target_dataset, recursive, schedule, keep, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.dataset, r.host, r.user, r.port, r.targetDataset, r.recursive ? 1 : 0, r.schedule, r.keep, now);
    return this.replication(Number(res.lastInsertRowid))!;
  }

  finishReplication(id: number, result: 'ok' | 'failed', message: string, now = Date.now()): void {
    this.db.prepare('UPDATE replications SET last_run_at = ?, last_result = ?, last_message = ? WHERE id = ?').run(now, result, message, id);
  }

  removeReplication(id: number): boolean {
    return this.db.prepare('DELETE FROM replications WHERE id = ?').run(id).changes > 0;
  }

  /** Running first, then newest; a replication id narrows it. */
  jobs(replicationId?: number, limit = 50): Job[] {
    const rows = (replicationId === undefined
      ? this.db.prepare(`SELECT * FROM jobs ORDER BY (state = 'running') DESC, started_at DESC, id DESC LIMIT ?`).all(limit)
      : this.db
          .prepare(`SELECT * FROM jobs WHERE replication_id = ? ORDER BY (state = 'running') DESC, started_at DESC, id DESC LIMIT ?`)
          .all(replicationId, limit)) as unknown as JobRow[];
    return rows.map(toJob);
  }

  /** Scrubs and resilvers, running first, then newest; a pool narrows it. */
  scanJobs(pool?: string, limit = 50): Job[] {
    const rows = (pool === undefined
      ? this.db.prepare(`SELECT * FROM jobs WHERE kind IN ('scrub', 'resilver') ORDER BY (state = 'running') DESC, started_at DESC, id DESC LIMIT ?`).all(limit)
      : this.db
          .prepare(`SELECT * FROM jobs WHERE kind IN ('scrub', 'resilver') AND pool = ? ORDER BY (state = 'running') DESC, started_at DESC, id DESC LIMIT ?`)
          .all(pool, limit)) as unknown as JobRow[];
    return rows.map(toJob);
  }

  runningScans(): Job[] {
    return (
      this.db.prepare(`SELECT * FROM jobs WHERE kind IN ('scrub', 'resilver') AND state = 'running' ORDER BY started_at`).all() as unknown as JobRow[]
    ).map(toJob);
  }

  runningScan(pool: string): Job | null {
    return this.runningScans().find((j) => j.pool === pool) ?? null;
  }

  startScan(kind: 'scrub' | 'resilver', pool: string, now = Date.now()): Job {
    const res = this.db.prepare(`INSERT INTO jobs (kind, pool, target, state, started_at) VALUES (?, ?, ?, 'running', ?)`).run(kind, pool, pool, now);
    return this.job(Number(res.lastInsertRowid))!;
  }

  progressScan(id: number, percent: number | null): void {
    this.db.prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(percent, id);
  }

  job(id: number): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  runningJob(replicationId: number): Job | null {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE replication_id = ? AND state = 'running' ORDER BY started_at DESC LIMIT 1`)
      .get(replicationId) as unknown as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  startJob(kind: Job['kind'], replicationId: number | null, target: string, pid: number, now = Date.now()): Job {
    const res = this.db
      .prepare(`INSERT INTO jobs (kind, replication_id, target, state, started_at, pid) VALUES (?, ?, ?, 'running', ?, ?)`)
      .run(kind, replicationId, target, now, pid);
    return this.job(Number(res.lastInsertRowid))!;
  }

  /** Running replications whose process is gone (a reboot or a crash mid-send) are failed, so the next run is not blocked. Scans live in ZFS, not in a process. */
  failDeadJobs(alive: (pid: number) => boolean, message: string, now = Date.now()): number {
    let n = 0;
    for (const row of this.db.prepare(`SELECT id, pid FROM jobs WHERE state = 'running' AND kind = 'replication'`).all() as unknown as {
      id: number;
      pid: number | null;
    }[]) {
      if (row.pid !== null && alive(row.pid)) continue;
      this.db.prepare(`UPDATE jobs SET state = 'failed', finished_at = ?, message = ? WHERE id = ?`).run(now, message, row.id);
      n++;
    }
    return n;
  }

  progressJob(id: number, bytes: number, total: number | null, message?: string): void {
    const progress = total ? Math.min(100, Math.round((bytes / total) * 1000) / 10) : null;
    if (message !== undefined)
      this.db.prepare('UPDATE jobs SET bytes = ?, total = ?, progress = ?, message = ? WHERE id = ?').run(bytes, total, progress, message, id);
    else this.db.prepare('UPDATE jobs SET bytes = ?, total = ?, progress = ? WHERE id = ?').run(bytes, total, progress, id);
  }

  finishJob(id: number, state: 'done' | 'failed', message: string, now = Date.now()): Job {
    this.db
      .prepare(`UPDATE jobs SET state = ?, finished_at = ?, message = ?, progress = CASE WHEN ? = 'done' THEN 100 ELSE progress END WHERE id = ?`)
      .run(state, now, message, state, id);
    return this.job(id)!;
  }

  smbUsers(): SmbUser[] {
    return (this.db.prepare('SELECT * FROM smb_users ORDER BY name').all() as unknown as SmbUserRow[]).map(toSmbUser);
  }

  smbUser(name: string): SmbUser | null {
    const row = this.db.prepare('SELECT * FROM smb_users WHERE name = ?').get(name) as unknown as SmbUserRow | undefined;
    return row ? toSmbUser(row) : null;
  }

  setSmbUser(name: string, hasPassword: boolean, now = Date.now()): SmbUser {
    this.db
      .prepare(
        `INSERT INTO smb_users (name, has_password, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET has_password = max(smb_users.has_password, excluded.has_password)`,
      )
      .run(name, hasPassword ? 1 : 0, now);
    return this.smbUser(name)!;
  }

  removeSmbUser(name: string): boolean {
    return this.db.prepare('DELETE FROM smb_users WHERE name = ?').run(name).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

const toShare = (r: ShareRow): StoredShare => ({
  dataset: r.dataset,
  name: r.dataset.split('/').pop() ?? r.dataset,
  smb: !!r.smb,
  timeMachine: !!r.time_machine,
  nfs: !!r.nfs,
  nfsClients: r.nfs_clients ? r.nfs_clients.split(' ') : [],
  updatedAt: new Date(r.updated_at).toISOString(),
});
const toReplication = (r: ReplicationRow): StoredReplication => ({
  id: r.id,
  dataset: r.dataset,
  host: r.host,
  user: r.user,
  port: r.port,
  targetDataset: r.target_dataset,
  recursive: !!r.recursive,
  schedule: r.schedule as ReplicationSchedule,
  keep: r.keep,
  lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
  lastResult: (r.last_result as 'ok' | 'failed' | null) ?? null,
  lastMessage: r.last_message,
  createdAt: new Date(r.created_at).toISOString(),
});
const toJob = (r: JobRow): Job => ({
  id: r.id,
  kind: r.kind as Job['kind'],
  replicationId: r.replication_id,
  pool: r.pool,
  target: r.target,
  state: r.state as Job['state'],
  startedAt: new Date(r.started_at).toISOString(),
  finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  progress: r.progress,
  bytes: r.bytes,
  total: r.total,
  message: r.message,
});
const toSmbUser = (r: SmbUserRow): SmbUser => ({ name: r.name, hasPassword: !!r.has_password, createdAt: new Date(r.created_at).toISOString() });

const toPolicy = (r: PolicyRow): Policy => ({
  dataset: r.dataset,
  hourly: r.hourly,
  daily: r.daily,
  weekly: r.weekly,
  monthly: r.monthly,
  updatedAt: new Date(r.updated_at).toISOString(),
});
