/**
 * mk-nasd: the mk-nas root agent. `node src/index.ts` (Node ≥ 24 strips
 * types). Listens on MK_NAS_SOCKET, audits to MK_NAS_AUDIT.
 */
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { createAudit } from './audit.ts';
import { backupConfig, config, netConfig, updateConfig } from './config.ts';
import { Db } from './db.ts';
import { detachedArgv } from './detach.ts';
import { EventLog } from './events.ts';
import { revertIfExpired } from './network.ts';
import { reconcileScans } from './scans.ts';
import { Vitals } from './system.ts';
import { run } from './run.ts';
import { listen } from './server.ts';

const audit = createAudit(config.audit);
const db = new Db(config.db);
// what ZFS reports, every few seconds, so a fault is known when it happens; a scan that ended closes its job at once
const events = new EventLog((a, o) => run(a, { timeout: config.timeout, ...o }), { every: config.eventsEvery, onScanEnd: () => reconcileScans(run, db) });
events.start();
// the box at a glance, every 5 s, half an hour in memory
const vitals = new Vitals({ every: config.vitalsEvery, keep: Math.round(1_800_000 / config.vitalsEvery) });
vitals.start();
// a network change that was never confirmed goes back even if the agent was restarted in between
await revertIfExpired(run, netConfig(config)).catch((e: Error) => console.error(`network revert failed: ${e.message}`));
const server = await listen({
  socket: config.socket,
  group: config.group,
  audit,
  deps: {
    run: (a, o) => run(a, { timeout: config.timeout, ...o }),
    version: config.version,
    db,
    locationsDir: config.locationsDir,
    replication: { keyFile: config.sshKey, knownHosts: config.knownHosts },
    events,
    vitals,
    network: netConfig(config),
    backup: backupConfig(config),
    updates: updateConfig(config),
    spawn: (argv) => {
      const env: Record<string, string> = {
        PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
        MK_NAS_DB: config.db,
        MK_NAS_AUDIT: config.audit,
        MK_NAS_SSH_KEY: config.sshKey,
        MK_NAS_KNOWN_HOSTS: config.knownHosts,
        MK_NAS_DRIVE_DB: config.driveDb,
        MK_NAS_SMB_CONF: config.smbConf,
        MK_NAS_EXPORTS: config.exportsFile,
        MK_NAS_SMB_GROUP: config.smbGroup,
        MK_NAS_OWNER_UID: String(config.ownerUid),
        MK_NAS_OWNER_GID: String(config.ownerGid),
        NODE_NO_WARNINGS: '1',
      };
      // its own transient unit as root, so stopping or upgrading the agent does not kill the job (detach.ts)
      const full = detachedArgv(argv, env, process.getuid?.() === 0);
      const child = spawn(full[0], full.slice(1), { detached: true, stdio: 'ignore', env });
      child.unref();
    },
    shares: {
      smbConf: config.smbConf,
      exportsFile: config.exportsFile,
      smbGroup: config.smbGroup,
      ownerUid: config.ownerUid,
      ownerGid: config.ownerGid,
      hostname: hostname(),
    },
  },
});
console.error(`mk-nasd ${config.version} on ${config.socket}`);

const shutdown = () => {
  events.stop();
  vitals.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
