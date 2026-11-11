/**
 * The off-site runner: `node src/offsite-run.ts backup` runs one backup (the agent spawns this for offsite.run),
 * `restore <snapshot> <dataset>` brings one snapshot back, `--due` runs the backup when its schedule says so
 * (mk-nas-replication.timer, every 15 minutes). Progress and results land in the jobs table for the UI.
 */
import { createAudit, lenient } from './audit.ts';
import { config, offsiteConfig } from './config.ts';
import { Db } from './db.ts';
import { backup, due, restore, stream } from './offsite.ts';
import { run } from './run.ts';

const audit = lenient(createAudit(config.audit));
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
  const dead = db.failDeadJobs(alive, 'interrupted: the NAS restarted before it finished (the next run carries on from what arrived)', Date.now(), 'offsite');
  if (dead) console.error(`${dead} interrupted job(s) marked failed`);
  const [what, ...rest] = process.argv.slice(2);
  if (what !== 'backup' && what !== '--due' && !(what === 'restore' && rest.length === 2)) {
    console.error('usage: offsite-run.ts backup | --due | restore <snapshot> <dataset>');
    process.exit(2);
  }
  const row = db.offsite();
  if (what === '--due' && (!row || !due(row))) process.exit(0);
  const deps = { run, stream, db, cfg: offsiteConfig(config), pid: process.pid, log: (l: string) => console.log(l) };
  const job = what === 'restore' ? await restore(deps, rest[0], rest[1]) : await backup(deps);
  await audit({
    ts: new Date().toISOString(),
    verb: what === 'restore' ? 'offsite.job.restore' : 'offsite.job.backup',
    args: what === 'restore' ? { snapshot: rest[0], dataset: rest[1], job: job.id } : { job: job.id },
    ok: job.state === 'done',
    ms: Date.parse(job.finishedAt ?? '') - Date.parse(job.startedAt),
    error: job.state === 'done' ? undefined : (job.message ?? undefined),
  });
  if (job.state !== 'done') failed++;
} catch (e) {
  console.error((e as Error).message);
  failed++;
} finally {
  db.close();
}
process.exit(failed ? 1 : 0);
