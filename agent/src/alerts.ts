/**
 * What is wrong with the box right now. Not a log: a condition is raised when
 * it becomes true, kept while it stays true (so "degraded since Tuesday"
 * survives a restart), and cleared when it stops. The agent only decides and
 * remembers; it never sends anything itself — no mail server, no push endpoint
 * in the root process. mk-drive reads `alerts` and is the one that reaches a
 * phone.
 *
 * `conditions()` is pure: the same readings the Storage pages show go in,
 * keyed conditions come out. `reconcile()` is pure too: what is stored plus
 * what is true now gives the raises, updates and clears. Only `evaluate()`
 * touches the system and the database.
 */
import type { Alert, Alerts, AlertSeverity, Disk, Job, PoolSummary, StoredAlert } from '../../shared/types.ts';
import type { Db } from './db.ts';
import { listDisks } from './disks.ts';
import { listPools } from './zfs.ts';
import { newer } from './updates.ts';
import type { Runner } from './run.ts';

/** A condition that is true now. `key` is stable (never the English text), so rewording a message does not raise it again. */
export interface Condition {
  key: string;
  severity: AlertSeverity;
  title: string;
  detail: string | null;
}

/** A pool is unhealthy above this, and stays raised until it drops below `FULL_WARNING - HYSTERESIS`, so a pool sitting at the line does not flap. */
export const FULL_WARNING = 90;
export const FULL_CRITICAL = 95;
const HYSTERESIS = 2;
/** A disk this warm is worth saying something about; it stays raised until it is back under COOL. The health verb uses the same number. */
export const HOT = 55;
const COOL = 50;

export interface ConditionInput {
  pools: PoolSummary[];
  disks: Disk[];
  /** Cleared alerts still open, so a raised condition can be held until it truly goes (the hysteresis below). */
  open: Map<string, StoredAlert>;
  /** The last settings backup, `db.configBackup()`. */
  backup: { dataset: string; lastAt: string | null; lastResult: 'ok' | 'failed' | null; lastMessage: string | null } | null;
  /** Replications with their last result, `db.replications()`. */
  replications: { id: number; dataset: string; host: string; lastResult: 'ok' | 'failed' | null; lastMessage: string | null }[];
  /** The newest finished scrub or resilver per pool, from the job rows. */
  scans: Job[];
  /** `db.updateCheck()`: a newer release, or why the check failed. */
  update: { checkedAt: string; latest: { version: string } | null; error: string | null } | null;
  /** This agent's version, to tell "a newer one is out" from "you are on it". */
  version: string;
}

const pct = (n: number) => `${Math.round(n)}%`;

/** Everything that is wrong right now, as keyed conditions. Thresholds live here and in nothing else. */
export function conditions(i: ConditionInput): Condition[] {
  const out: Condition[] = [];
  const held = (key: string) => i.open.has(key);

  for (const p of i.pools) {
    if (p.health !== 'ONLINE') {
      out.push({
        key: `pool:${p.name}:state`,
        severity: 'critical',
        title: `Pool ${p.name} is ${p.health}`,
        detail: p.health === 'DEGRADED' ? 'A disk is missing or faulted. The data is still there; replace the disk from the Pools page.' : 'Open the Pools page: the pool cannot be used until this is fixed.',
      });
    }
    // once raised, it stays until the pool drops a couple of points below the line
    const full = held(`pool:${p.name}:full`) ? FULL_WARNING - HYSTERESIS : FULL_WARNING;
    if (p.capacity >= full) {
      out.push({
        key: `pool:${p.name}:full`,
        severity: p.capacity >= FULL_CRITICAL ? 'critical' : 'warning',
        title: `Pool ${p.name} is ${pct(p.capacity)} full`,
        detail: p.capacity >= FULL_CRITICAL ? 'A full pool stops accepting writes and slows down. Delete what you can, or add a disk.' : 'ZFS slows down as a pool fills. Make room, or plan more disks.',
      });
    }
  }

  for (const d of i.disks) {
    const s = d.smart;
    if (!s) continue;
    if (s.passed === false) out.push({ key: `disk:${d.id}:smart`, severity: 'critical', title: `Disk ${d.id} says it is failing`, detail: 'SMART self-assessment failed. Copy what matters off it and replace the disk.' });
    else if ((s.reallocated ?? 0) > 0) out.push({ key: `disk:${d.id}:smart`, severity: 'critical', title: `Disk ${d.id} has ${s.reallocated} reallocated sectors`, detail: 'The disk is running out of spare sectors. Plan a replacement.' });
    else if ((s.pending ?? 0) > 0) out.push({ key: `disk:${d.id}:smart`, severity: 'warning', title: `Disk ${d.id} has ${s.pending} sectors waiting to be checked`, detail: 'Often the first sign of a failing disk. A long self-test and a scrub will say more.' });
    const hot = held(`disk:${d.id}:temp`) ? COOL : HOT;
    if ((s.temperature ?? 0) >= hot) out.push({ key: `disk:${d.id}:temp`, severity: 'warning', title: `Disk ${d.id} is at ${s.temperature} °C`, detail: 'Warm disks die sooner. Check the airflow and the space between the disks.' });
  }

  if (i.backup?.lastResult === 'failed') {
    out.push({ key: 'backup:settings', severity: 'warning', title: 'The settings backup failed', detail: i.backup.lastMessage ?? 'The last run did not finish. Storage → Settings backup says where it writes.' });
  }

  for (const r of i.replications) {
    if (r.lastResult === 'failed') {
      out.push({ key: `replication:${r.id}`, severity: 'warning', title: `Copying ${r.dataset} to ${r.host} failed`, detail: r.lastMessage ?? 'The last run did not finish.' });
    }
  }

  for (const s of i.scans) {
    if (s.state === 'failed') {
      out.push({ key: `scan:${s.target}`, severity: 'warning', title: `The last ${s.kind === 'scrub' ? 'scrub' : 'scan'} of ${s.target} did not come back clean`, detail: s.message ?? 'Run it again from the Pools page; if errors stay, the disks need attention.' });
    }
  }

  if (i.update?.error) out.push({ key: 'update:check', severity: 'info', title: 'The box could not check for updates', detail: i.update.error });
  else if (i.update?.latest && newer(i.update.latest.version, i.version)) {
    out.push({ key: 'update:available', severity: 'info', title: `mk-nas ${i.update.latest.version} is out`, detail: 'Storage → Overview → System installs it. Your files stay where they are.' });
  }

  return out;
}

export interface Plan {
  /** New keys, and keys that came back after being cleared. */
  raise: Condition[];
  /** Still true, and the text or severity changed. */
  update: Condition[];
  /** Still true and unchanged: only "last seen" moves. */
  touch: string[];
  /** Keys that are no longer true. */
  clear: string[];
}

/** What to write: the stored open alerts against the conditions that are true now. */
export function reconcile(open: StoredAlert[], now: Condition[]): Plan {
  const byKey = new Map(open.map((a) => [a.key, a]));
  const raise: Condition[] = [];
  const update: Condition[] = [];
  const touch: string[] = [];
  for (const c of now) {
    const was = byKey.get(c.key);
    if (!was) raise.push(c);
    else if (was.title !== c.title || was.detail !== c.detail || was.severity !== c.severity) update.push(c);
    else touch.push(c.key);
  }
  const live = new Set(now.map((c) => c.key));
  return { raise, update, touch, clear: open.filter((a) => !live.has(a.key)).map((a) => a.key) };
}

/** A raised alert waits this long before the drive is allowed to wake anybody: a disk that reappears in seconds is not worth a push. */
export const CONFIRM_AFTER_MS = 60_000;

export interface AlertDeps {
  run: Runner;
  db: Db;
  version: string;
  byIdDir?: string;
}

/**
 * Read the box, write the difference. Returns the open alerts afterwards.
 * Disk readings come from `listDisks`, which leaves a sleeping disk asleep and
 * uses its last reading, so this never spins disks up.
 */
export async function evaluate(deps: AlertDeps, now = Date.now()): Promise<Alerts> {
  const [pools, disks] = await Promise.all([listPools(deps.run), listDisks(deps.run, deps.byIdDir)]);
  const open = deps.db.openAlerts();
  const cs = conditions({
    pools,
    disks,
    open: new Map(open.map((a) => [a.key, a])),
    backup: deps.db.configBackup(),
    replications: deps.db.replications().map((r) => ({ id: r.id, dataset: r.dataset, host: r.host, lastResult: r.lastResult, lastMessage: r.lastMessage })),
    scans: deps.db.scanJobs(undefined, 20),
    update: deps.db.updateCheck(),
    version: deps.version,
  });
  const plan = reconcile(open, cs);
  deps.db.applyAlerts(plan, now, CONFIRM_AFTER_MS);
  deps.db.pruneAlerts(now);
  return read(deps.db, now);
}

/** What the verb answers: open now, cleared lately, and the worst thing open. */
export function read(db: Db, now = Date.now()): Alerts {
  const open = db.openAlerts(now);
  return { open, recent: db.clearedAlerts(30, 50, now), worst: worstOf(open) };
}

export function severityRank(s: AlertSeverity): number {
  return s === 'critical' ? 2 : s === 'warning' ? 1 : 0;
}

/** The worst thing open right now, for a badge. */
export function worstOf(alerts: Alert[]): AlertSeverity | null {
  let worst: AlertSeverity | null = null;
  for (const a of alerts) if (!worst || severityRank(a.severity) > severityRank(worst)) worst = a.severity;
  return worst;
}
