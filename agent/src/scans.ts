/**
 * Scrubs and resilvers as jobs. ZFS runs them and shows the live scan on
 * zpool status, which stays the truth; the agent only writes down when one
 * was started and, the next time anyone looks, how it ended — the history
 * ZFS does not keep. Nothing here is read back to decide anything about a
 * pool.
 */
import type { Job } from '../../shared/types.ts';
import type { Db } from './db.ts';
import { poolName } from './names.ts';
import type { Runner } from './run.ts';
import { getPool } from './zfs.ts';

/** A scan was just started on `pool`: a running job for it, unless one is already written down. */
export function noteScan(db: Db, kind: 'scrub' | 'resilver', pool: string): Job {
  return db.runningScan(pool) ?? db.startScan(kind, pool);
}

/** Brings every running scan job up to date with its pool's scan line: progress while it runs, done or failed once it is over. */
export async function reconcileScans(run: Runner, db: Db): Promise<void> {
  for (const job of db.runningScans()) {
    let scrub;
    try {
      // the row may come from a restored database: its pool is checked like any caller's before it reaches zpool
      scrub = (await getPool(run, poolName(job.pool))).scrub;
    } catch (e) {
      db.finishJob(job.id, 'failed', `the pool could not be read: ${(e as Error).message}`);
      continue;
    }
    if (scrub?.state === 'running' && scrub.kind === job.kind) {
      db.progressScan(job.id, scrub.percent);
      continue;
    }
    // over: the line now says how it went (or something else is running, or nothing is — then it was cut short)
    const over = scrub?.kind === job.kind && scrub.state === 'finished' && !scrub.errors;
    db.finishJob(job.id, over ? 'done' : 'failed', scrub?.text ?? 'no scan reported by the pool');
  }
}
