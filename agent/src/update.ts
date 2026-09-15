/**
 * The install runner: `node src/update.ts <version>`, spawned by
 * update.install in a transient unit of its own, so the agent restarting
 * under the new package does not stop it. Every step lands in update_runs.
 */
import { createAudit } from './audit.ts';
import { backupConfig, config, updateConfig } from './config.ts';
import { runBackup } from './backup.ts';
import { Db } from './db.ts';
import { run } from './run.ts';
import { installRelease, versionOf } from './updates.ts';

const audit = createAudit(config.audit);
const db = new Db(config.db);
const started = Date.now();
let version = '';
let ok = false;
try {
  version = versionOf(process.argv[2]);
  const r = db.startUpdateRun(version, process.pid);
  try {
    const message = await installRelease(
      {
        run: (a, o) => run(a, { timeout: 10 * 60_000, ...o }),
        fetch,
        db,
        cfg: updateConfig(config),
        agent: config.version,
        pid: process.pid,
        backup: db.configBackup()
          ? async () => {
              const b = await runBackup(run, db, { ...backupConfig(config), spawn: () => {} });
              if (b.lastResult !== 'ok') throw new Error(`the settings backup failed: ${b.lastMessage ?? 'no reason given'}`);
            }
          : null,
      },
      version,
      r.id,
    );
    db.finishUpdateRun(r.id, 'done', message);
    ok = true;
  } catch (e) {
    db.finishUpdateRun(r.id, 'failed', (e as Error).message);
  }
} catch (e) {
  console.error(`update.ts: ${(e as Error).message}`);
} finally {
  const last = db.updateRun();
  await audit({
    ts: new Date(started).toISOString(),
    verb: 'update.run',
    args: { version },
    ok,
    ms: Date.now() - started,
    error: ok ? undefined : (last?.message ?? undefined),
  });
  db.close();
}
process.exit(ok ? 0 : 1);
