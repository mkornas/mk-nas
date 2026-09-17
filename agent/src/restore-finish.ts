/**
 * The second half of backup.restore, as its own process: the agent could not
 * replace its own database while answering. Stop the agent and the drive,
 * move the restored databases into place, import the Samba passwords, write
 * smb.conf and the exports from the restored database, start everything.
 *   node src/restore-finish.ts [<passdb.tdb>]
 */
import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
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
  // the socket unit too: left up, a call arriving now (the drive, the CLI) would start the agent in the middle of the swap
  await must(run, ['systemctl', 'stop', 'mk-drive', 'mk-nasd.socket', 'mk-nasd']);
  for (const file of [config.db, config.driveDb]) {
    const restored = `${file}.restore`;
    // the drive's data directory is the container's, which could leave a link at either name: never follow one
    const r = await lstat(restored).catch(() => null);
    if (!r) continue;
    if (!r.isFile()) throw new Error(`${restored} is not a regular file`);
    const live = await lstat(file).catch(() => null);
    if (live && !live.isFile()) throw new Error(`${file} is not a regular file`);
    await rm(`${file}-wal`, { force: true });
    await rm(`${file}-shm`, { force: true });
    await rename(restored, file);
    // the owner goes to what was renamed, through a descriptor opened without following, and only if it is the file checked
    const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = await h.stat();
      if (!s.isFile() || s.ino !== r.ino || s.dev !== r.dev) throw new Error(`${restored} changed before it was moved into place`);
      if (live) await h.chown(live.uid, live.gid);
    } finally {
      await h.close();
    }
    steps.push(file);
  }
  if (passdb) {
    await must(run, ['pdbedit', '-i', `tdbsam:${passdb}`]);
    await rm(passdb, { force: true });
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
  await must(run, ['systemctl', 'start', 'mk-nasd.socket', 'mk-nasd', 'mk-drive']);
  await audit({ ts: now.toISOString(), verb: 'restore.finish', args: { steps }, ok: true, ms: Date.now() - now.getTime() });
} catch (e) {
  await audit({ ts: now.toISOString(), verb: 'restore.finish', args: { steps }, ok: false, ms: Date.now() - now.getTime(), error: (e as Error).message });
  // whatever happened, the services must not stay down
  await run(['systemctl', 'start', 'mk-nasd.socket', 'mk-nasd', 'mk-drive']);
  process.exit(1);
}
