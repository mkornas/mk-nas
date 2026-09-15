/**
 * The second half of backup.restore, as its own process: the agent could not
 * replace its own database while answering. Stop the agent and the drive,
 * move the restored databases into place, import the Samba passwords, write
 * smb.conf and the exports from the restored database, start everything.
 *   node src/restore-finish.ts [<passdb.tdb>]
 */
import { chown, rename, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createAudit } from './audit.ts';
import { config } from './config.ts';
import { Db } from './db.ts';
import { must, run } from './run.ts';
import { apply } from './shares.ts';

const audit = createAudit(config.audit);
const passdb = process.argv[2] || '';
const now = new Date();
await new Promise((r) => setTimeout(r, 1500));
const steps: string[] = [];
try {
  await must(run, ['systemctl', 'stop', 'mk-nasd', 'mk-drive']);
  for (const file of [config.db, config.driveDb]) {
    const restored = `${file}.restore`;
    try {
      await stat(restored);
    } catch {
      continue;
    }
    let owner: { uid: number; gid: number } | null = null;
    try {
      const s = await stat(file);
      owner = { uid: s.uid, gid: s.gid };
    } catch {
      /* first time: no file to take the owner from */
    }
    await rm(`${file}-wal`, { force: true });
    await rm(`${file}-shm`, { force: true });
    await rename(restored, file);
    if (owner) await chown(file, owner.uid, owner.gid);
    steps.push(file);
  }
  if (passdb) {
    await must(run, ['pdbedit', '-i', `tdbsam:${passdb}`]);
    steps.push('passdb');
  }
  const db = new Db(config.db);
  try {
    await apply(run, db, {
      smbConf: config.smbConf,
      exportsFile: config.exportsFile,
      smbGroup: config.smbGroup,
      ownerUid: config.ownerUid,
      ownerGid: config.ownerGid,
      hostname: hostname(),
    });
    steps.push('shares');
  } finally {
    db.close();
  }
  await must(run, ['systemctl', 'start', 'mk-nasd', 'mk-drive']);
  await audit({ ts: now.toISOString(), verb: 'restore.finish', args: { steps }, ok: true, ms: Date.now() - now.getTime() });
} catch (e) {
  await audit({ ts: now.toISOString(), verb: 'restore.finish', args: { steps }, ok: false, ms: Date.now() - now.getTime(), error: (e as Error).message });
  // whatever happened, the services must not stay down
  await run(['systemctl', 'start', 'mk-nasd', 'mk-drive']);
  process.exit(1);
}
