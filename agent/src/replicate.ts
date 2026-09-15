/**
 * The replication runner: `node src/replicate.ts <id>` runs one job (the
 * agent spawns this for replication.run), `node src/replicate.ts --due`
 * runs every scheduled one that is due (mk-nas-replication.timer, every
 * 15 minutes). Progress and results land in the jobs table for the UI.
 */
import { createAudit } from './audit.ts';
import { config } from './config.ts';
import { Db } from './db.ts';
import { due, pipe, replicate } from './replication.ts';
import { run } from './run.ts';

const audit = createAudit(config.audit);
const db = new Db(config.db);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
let failed = 0;
try {
  const dead = db.failDeadJobs(alive, 'interrupted: the NAS restarted mid-send (the next run resumes it)');
  if (dead) console.error(`${dead} interrupted job(s) marked failed`);
  const arg = process.argv[2];
  const ids =
    arg === '--due'
      ? db
          .replications()
          .filter((r) => due(r))
          .map((r) => r.id)
      : arg && /^\d+$/.test(arg)
        ? [Number(arg)]
        : [];
  if (!ids.length && arg !== '--due') {
    console.error('usage: replicate.ts <id> | --due');
    process.exit(2);
  }
  for (const id of ids) {
    const job = await replicate(
      {
        run: (a, o) => run(a, { timeout: 24 * 3_600_000, ...o }),
        pipe,
        db,
        cfg: { keyFile: config.sshKey, knownHosts: config.knownHosts },
        pid: process.pid,
        log: (l) => console.log(l),
      },
      id,
    );
    await audit({
      ts: new Date().toISOString(),
      verb: 'replication.job',
      args: { id, job: job.id },
      ok: job.state === 'done',
      ms: Date.parse(job.finishedAt ?? '') - Date.parse(job.startedAt),
      error: job.state === 'done' ? undefined : (job.message ?? undefined),
    });
    if (job.state !== 'done') failed++;
  }
} finally {
  db.close();
}
process.exit(failed ? 1 : 0);
