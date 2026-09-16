/**
 * What the system cannot hold: snapshot policies (later shares, job history,
 * SMB users). node:sqlite, one file, WAL. ZFS itself is never mirrored here.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Alert,
  AlertSeverity,
  Job,
  Policy,
  PolicySetArgs,
  Release,
  Replication,
  ReplicationSchedule,
  ScrubInterval,
  ScrubPolicy,
  Share,
  SmbUser,
  StoredAlert,
  UpdateRun,
} from '../../shared/types.ts';

const RANK: Record<AlertSeverity, number> = { critical: 2, warning: 1, info: 0 };

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
  `CREATE TABLE IF NOT EXISTS update_check (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    checked_at INTEGER NOT NULL,
    latest TEXT,
    error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS update_runs (
    id INTEGER PRIMARY KEY,
    version TEXT NOT NULL,
    state TEXT NOT NULL,
    step TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    message TEXT,
    pid INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS alerts (
    key TEXT PRIMARY KEY,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    since INTEGER NOT NULL,
    raised_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    confirmed_at INTEGER,
    acked_at INTEGER,
    cleared_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS alerts_cleared ON alerts(cleared_at)`,
  `CREATE TABLE IF NOT EXISTS smb_users (
    name TEXT PRIMARY KEY,
    has_password INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
];

interface AlertRow {
  key: string;
  severity: string;
  title: string;
  detail: string | null;
  since: number;
  raised_at: number;
  last_seen: number;
  confirmed_at: number | null;
  acked_at: number | null;
  cleared_at: number | null;
}

const toAlert = (r: AlertRow, now: number): StoredAlert => ({
  key: r.key,
  severity: r.severity as AlertSeverity,
  title: r.title,
  detail: r.detail,
  since: new Date(r.since).toISOString(),
  raisedAt: new Date(r.raised_at).toISOString(),
  lastSeen: new Date(r.last_seen).toISOString(),
  // confirmed once it has been true for long enough; a cleared one keeps whatever it reached
  confirmed: r.confirmed_at !== null && r.confirmed_at <= now,
  ackedAt: r.acked_at === null ? null : new Date(r.acked_at).toISOString(),
  clearedAt: r.cleared_at === null ? null : new Date(r.cleared_at).toISOString(),
});

interface ShareRow {
  dataset: string;
  smb: number;
  time_machine: number;
  nfs: number;
  nfs_clients: string;
  smb_access: string | null;
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
    // 0.8.0: who may open a share over SMB; NULL keeps a share from before (every SMB user) until someone sets a list
    const shareCols = (this.db.prepare('PRAGMA table_info(shares)').all() as unknown as { name: string }[]).map((c) => c.name);
    if (!shareCols.includes('smb_access')) this.db.exec('ALTER TABLE shares ADD COLUMN smb_access TEXT');
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
        `INSERT INTO shares (dataset, smb, time_machine, nfs, nfs_clients, smb_access, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dataset) DO UPDATE SET smb = excluded.smb, time_machine = excluded.time_machine, nfs = excluded.nfs, nfs_clients = excluded.nfs_clients, smb_access = excluded.smb_access, updated_at = excluded.updated_at`,
      )
      .run(
        s.dataset,
        s.smb ? 1 : 0,
        s.timeMachine ? 1 : 0,
        s.nfs ? 1 : 0,
        s.nfsClients.join(' '),
        s.smbAccess === null ? null : JSON.stringify(s.smbAccess),
        now,
      );
    return this.share(s.dataset)!;
  }

  /** Takes a removed SMB user off every share's list; returns whether any list changed. */
  dropSmbUserFromShares(name: string, now = Date.now()): boolean {
    let changed = false;
    for (const s of this.shares()) {
      if (!s.smbAccess?.some((a) => a.user === name)) continue;
      this.setShare({ ...s, smbAccess: s.smbAccess.filter((a) => a.user !== name) }, now);
      changed = true;
    }
    return changed;
  }

  removeShare(dataset: string): boolean {
    return this.db.prepare('DELETE FROM shares WHERE dataset = ?').run(dataset).changes > 0;
  }

  // ---- alerts: what is wrong right now, and what cleared recently (alerts.ts decides, this only remembers) ----

  /** Open alerts (still true), worst first, then newest. */
  openAlerts(now = Date.now()): StoredAlert[] {
    const rows = this.db.prepare('SELECT * FROM alerts WHERE cleared_at IS NULL ORDER BY since DESC').all() as unknown as AlertRow[];
    return rows.map((r) => toAlert(r, now)).sort((a, b) => RANK[b.severity] - RANK[a.severity] || Date.parse(b.since) - Date.parse(a.since));
  }

  /** Cleared in the last `days`, newest first. */
  clearedAlerts(days = 30, limit = 100, now = Date.now()): StoredAlert[] {
    const rows = this.db
      .prepare('SELECT * FROM alerts WHERE cleared_at IS NOT NULL AND cleared_at >= ? ORDER BY cleared_at DESC LIMIT ?')
      .all(now - days * 86_400_000, limit) as unknown as AlertRow[];
    return rows.map((r) => toAlert(r, now));
  }

  alerts(now = Date.now()): Alert[] {
    return this.openAlerts(now);
  }

  /**
   * The difference alerts.ts worked out. A key that is raised again after clearing starts over (new `since`, no
   * acknowledgement); one that is still true keeps its `since` and its acknowledgement.
   */
  applyAlerts(
    plan: {
      raise: { key: string; severity: AlertSeverity; title: string; detail: string | null }[];
      update: { key: string; severity: AlertSeverity; title: string; detail: string | null }[];
      touch: string[];
      clear: string[];
    },
    now = Date.now(),
    confirmAfterMs = 60_000,
  ): void {
    const raise = this.db.prepare(
      `INSERT INTO alerts (key, severity, title, detail, since, raised_at, last_seen, confirmed_at, acked_at, cleared_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(key) DO UPDATE SET severity = excluded.severity, title = excluded.title, detail = excluded.detail,
         since = excluded.since, raised_at = excluded.raised_at, last_seen = excluded.last_seen,
         confirmed_at = excluded.confirmed_at, acked_at = NULL, cleared_at = NULL`,
    );
    for (const c of plan.raise) raise.run(c.key, c.severity, c.title, c.detail, now, now, now, now + confirmAfterMs);
    const update = this.db.prepare('UPDATE alerts SET severity = ?, title = ?, detail = ?, last_seen = ? WHERE key = ? AND cleared_at IS NULL');
    for (const c of plan.update) update.run(c.severity, c.title, c.detail, now, c.key);
    const seen = this.db.prepare('UPDATE alerts SET last_seen = ? WHERE key = ? AND cleared_at IS NULL');
    for (const key of plan.touch) seen.run(now, key);
    const clear = this.db.prepare('UPDATE alerts SET cleared_at = ?, last_seen = ? WHERE key = ? AND cleared_at IS NULL');
    for (const key of plan.clear) clear.run(now, now, key);
  }

  /** Marks an open alert as seen. Returns false when there is no such open alert. */
  ackAlert(key: string, now = Date.now()): boolean {
    return this.db.prepare('UPDATE alerts SET acked_at = ? WHERE key = ? AND cleared_at IS NULL AND acked_at IS NULL').run(now, key).changes > 0;
  }

  /** Keeps a month of cleared alerts; the open ones are never dropped. */
  pruneAlerts(now = Date.now(), days = 30): void {
    this.db.prepare('DELETE FROM alerts WHERE cleared_at IS NOT NULL AND cleared_at < ?').run(now - days * 86_400_000);
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

  /** The last check for a release: when, what it found (kept when a later check fails), and why it failed. */
  updateCheck(): { checkedAt: string; latest: Release | null; error: string | null } | null {
    const row = this.db.prepare('SELECT * FROM update_check WHERE id = 1').get() as
      { checked_at: number; latest: string | null; error: string | null } | undefined;
    return row
      ? { checkedAt: new Date(row.checked_at).toISOString(), latest: row.latest ? (JSON.parse(row.latest) as Release) : null, error: row.error }
      : null;
  }

  /** A found release replaces the last one; a failed check keeps it and writes down why. */
  recordUpdateCheck(latest: Release | null, error: string | null, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO update_check (id, checked_at, latest, error) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET checked_at = excluded.checked_at, latest = COALESCE(excluded.latest, update_check.latest), error = excluded.error`,
      )
      .run(now, latest ? JSON.stringify(latest) : null, error);
  }

  startUpdateRun(version: string, pid: number, now = Date.now()): UpdateRun {
    const res = this.db
      .prepare(`INSERT INTO update_runs (version, state, step, started_at, pid) VALUES (?, 'running', 'starting', ?, ?)`)
      .run(version, now, pid);
    return this.updateRun(Number(res.lastInsertRowid))!;
  }

  updateRun(id?: number): UpdateRun | null {
    const row = (id === undefined
      ? this.db.prepare('SELECT * FROM update_runs ORDER BY started_at DESC, id DESC LIMIT 1').get()
      : this.db.prepare('SELECT * FROM update_runs WHERE id = ?').get(id)) as unknown as UpdateRunRow | undefined;
    return row ? toUpdateRun(row) : null;
  }

  stepUpdateRun(id: number, step: string): void {
    this.db.prepare(`UPDATE update_runs SET step = ? WHERE id = ?`).run(step, id);
  }

  finishUpdateRun(id: number, state: 'done' | 'failed', message: string, now = Date.now()): UpdateRun {
    this.db.prepare(`UPDATE update_runs SET state = ?, message = ?, finished_at = ? WHERE id = ?`).run(state, message, now, id);
    return this.updateRun(id)!;
  }

  /** A run whose process is gone did not finish: the box restarted, or the runner was killed. */
  failDeadUpdateRuns(alive: (pid: number) => boolean, now = Date.now()): number {
    let n = 0;
    for (const row of this.db.prepare(`SELECT id, pid FROM update_runs WHERE state = 'running'`).all() as unknown as { id: number; pid: number | null }[]) {
      if (row.pid !== null && alive(row.pid)) continue;
      this.db
        .prepare(`UPDATE update_runs SET state = 'failed', finished_at = ?, message = ? WHERE id = ?`)
        .run(now, 'interrupted: the runner stopped before it finished', row.id);
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
  smbAccess: parseAccess(r.smb_access),
  updatedAt: new Date(r.updated_at).toISOString(),
});

/** The stored list, or null for a share from before lists existed; anything unreadable counts as nobody. */
function parseAccess(v: string | null): StoredShare['smbAccess'] {
  if (v === null) return null;
  try {
    const list = JSON.parse(v) as unknown;
    return Array.isArray(list) ? (list as StoredShare['smbAccess'] & object[]) : [];
  } catch {
    return [];
  }
}
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
interface UpdateRunRow {
  id: number;
  version: string;
  state: string;
  step: string;
  started_at: number;
  finished_at: number | null;
  message: string | null;
  pid: number | null;
}

const toUpdateRun = (r: UpdateRunRow): UpdateRun => ({
  id: r.id,
  version: r.version,
  state: r.state as UpdateRun['state'],
  step: r.step,
  startedAt: new Date(r.started_at).toISOString(),
  finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  message: r.message,
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
