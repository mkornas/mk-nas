/**
 * The snapshot timer's tick: `node src/tick.ts`, run by mk-nas-snapshot.timer
 * every 15 minutes. For every policy: take what is due, destroy what is
 * beyond the counts. Then every pool whose scrub is due gets one started,
 * and one disk without a long SMART self-test in the last 720 power-on
 * hours gets one (one per tick, so they do not all run at once; a disk
 * in standby is left asleep). Prints one line per action; exits non-zero
 * if any failed.
 */
import { createAudit } from './audit.ts';
import { backupConfig, config, netConfig, updateConfig } from './config.ts';
import { backupDue, runBackup } from './backup.ts';
import { Db } from './db.ts';
import { byIdMap, longTestDue, LSBLK_ARGV, parseLsblk, pickId, readSmart, smartQuietArgv } from './disks.ts';
import { plan, scrubDue } from './policy.ts';
import { revertIfExpired } from './network.ts';
import { noteScan, reconcileScans } from './scans.ts';
import { must, run } from './run.ts';
import { checkDue, checkForUpdate } from './updates.ts';
import { getPool, listPools, listSnapshots } from './zfs.ts';

const audit = createAudit(config.audit);
const db = new Db(config.db);
const now = new Date();
let failed = 0;
try {
  // a network change nobody confirmed goes back; the agent does the same when it is asked or starts, this is the backstop
  if (await revertIfExpired(run, netConfig(config)).catch(() => false)) {
    console.log('reverted an unconfirmed network change');
    await audit({ ts: now.toISOString(), verb: 'tick.network-revert', args: {}, ok: true, ms: 0 });
  }
  const policies = db.policies();
  if (policies.length) {
    const existing = await listSnapshots(run);
    for (const p of policies) {
      const todo = plan(p, existing, now);
      for (const t of todo.take) {
        const name = `${t.dataset}@${t.name}`;
        try {
          await must(run, ['zfs', 'snapshot', name]);
          console.log(`took ${name}`);
          await audit({ ts: now.toISOString(), verb: 'tick.snapshot', args: { name }, ok: true, ms: 0 });
        } catch (e) {
          failed++;
          console.error(`could not take ${name}: ${(e as Error).message}`);
          await audit({ ts: now.toISOString(), verb: 'tick.snapshot', args: { name }, ok: false, ms: 0, error: (e as Error).message });
        }
      }
      for (const name of todo.destroy) {
        try {
          await must(run, ['zfs', 'destroy', name]);
          console.log(`pruned ${name}`);
          await audit({ ts: now.toISOString(), verb: 'tick.prune', args: { name }, ok: true, ms: 0 });
        } catch (e) {
          failed++;
          console.error(`could not prune ${name}: ${(e as Error).message}`);
          await audit({ ts: now.toISOString(), verb: 'tick.prune', args: { name }, ok: false, ms: 0, error: (e as Error).message });
        }
      }
    }
  }
  // a scan that ended since the last look gets its row closed even when nobody opened the UI
  await reconcileScans(run, db);
  for (const p of await listPools(run)) {
    // a pool that cannot be read is not scrubbed either; it would only fail every 15 minutes
    if (p.health !== 'ONLINE' && p.health !== 'DEGRADED') continue;
    const interval = db.scrubPolicy(p.name)?.interval ?? 'monthly';
    if (!scrubDue(interval, (await getPool(run, p.name)).scrub, now)) continue;
    try {
      await must(run, ['zpool', 'scrub', p.name]);
      noteScan(db, 'scrub', p.name);
      console.log(`scrub started on ${p.name}`);
      await audit({ ts: now.toISOString(), verb: 'tick.scrub', args: { pool: p.name, interval }, ok: true, ms: 0 });
    } catch (e) {
      failed++;
      console.error(`could not scrub ${p.name}: ${(e as Error).message}`);
      await audit({ ts: now.toISOString(), verb: 'tick.scrub', args: { pool: p.name, interval }, ok: false, ms: 0, error: (e as Error).message });
    }
  }
  // the settings, once a day, into the dataset the person chose
  if (backupDue(db, now.getTime())) {
    try {
      const b = await runBackup(run, db, { ...backupConfig(config), spawn: () => {} }, now);
      console.log(`settings backed up to ${b.dataset} (${b.files.length} files)`);
      await audit({ ts: now.toISOString(), verb: 'tick.backup', args: { dataset: b.dataset }, ok: true, ms: 0 });
    } catch (e) {
      failed++;
      console.error(`settings backup failed: ${(e as Error).message}`);
      await audit({ ts: now.toISOString(), verb: 'tick.backup', args: {}, ok: false, ms: 0, error: (e as Error).message });
    }
  }
  // once a day: is there a newer release (the drive shows it; nothing installs by itself)
  if (checkDue(db, now.getTime())) {
    await checkForUpdate(fetch, db, updateConfig(config), config.version, now.getTime());
    const c = db.updateCheck();
    console.log(c?.error ? `update check failed: ${c.error}` : `newest release: ${c?.latest?.version ?? 'none'}`);
  }
  const [devices, ids] = await Promise.all([parseLsblk(await must(run, LSBLK_ARGV)), byIdMap()]);
  for (const d of devices) {
    const raw = await readSmart(run, d.path, smartQuietArgv(d.path));
    if (!raw || !longTestDue(raw)) continue;
    const id = (ids.get(d.path) ?? []).length ? pickId(ids.get(d.path)!) : d.path;
    try {
      await must(run, ['smartctl', '-j', '-t', 'long', d.path]);
      console.log(`long self-test started on ${id}`);
      await audit({ ts: now.toISOString(), verb: 'tick.smart-test', args: { disk: id }, ok: true, ms: 0 });
    } catch (e) {
      failed++;
      console.error(`could not start a self-test on ${id}: ${(e as Error).message}`);
      await audit({ ts: now.toISOString(), verb: 'tick.smart-test', args: { disk: id }, ok: false, ms: 0, error: (e as Error).message });
    }
    break;
  }
} finally {
  db.close();
}
process.exit(failed ? 1 : 0);
