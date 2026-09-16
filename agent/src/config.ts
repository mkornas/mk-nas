/** Everything from the environment, read once. */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

/** DRIVE_UID or DRIVE_GID in the drive stack's .env text: the last line for it, digits only; null otherwise. */
export function driveId(env: string, key: 'DRIVE_UID' | 'DRIVE_GID'): number | null {
  const line = env
    .split(/\r?\n/)
    .filter((l) => new RegExp(`^\\s*${key}\\s*=`).test(l))
    .at(-1);
  const value = line
    ?.slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2');
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const driveEnv = process.env.MK_NAS_DRIVE_ENV || '/opt/mk-drive/.env';
// never loaded into the environment (a NODE_OPTIONS there would run as root): only these two numbers are taken from it
const driveEnvText = readText(driveEnv);

export interface Config {
  socket: string;
  /** The group that may talk to the socket; chown skipped when it does not exist or we are not root. */
  group: string;
  /** A file path, or '-' for stderr. */
  audit: string;
  version: string;
  /** Per-command timeout in ms. */
  timeout: number;
  /** How often zpool events is read, in ms. */
  eventsEvery: number;
  /** How often the vitals are sampled, in ms. */
  vitalsEvery: number;
  /** How often the box is checked over for things that are wrong (alerts.ts), in ms. A ZFS event that matters checks at once anyway. */
  alertsEvery: number;
  /** The SQLite file for policies (later shares, jobs, SMB users). */
  db: string;
  /** Where datasets made "as a location" are mounted; the mk-drive container sees it as /locations. */
  locationsDir: string;
  /** Shares: the files the agent writes whole, the group SMB users join, who owns files written over the network. */
  smbConf: string;
  exportsFile: string;
  smbGroup: string;
  ownerUid: number;
  ownerGid: number;
  /** Replication: the NAS's ssh key and its own known_hosts. */
  sshKey: string;
  knownHosts: string;
  /** Network: the one netplan file the agent owns, and where a pending change keeps what was there before. */
  netplanFile: string;
  netplanPending: string;
  /** The drive's .env and database, for the settings backup. */
  driveEnv: string;
  driveDb: string;
  /** Updates: the GitHub repositories releases come from, where an install downloads to, the release key the package ships. */
  updatesRepo: string;
  driveRepo: string;
  updatesDir: string;
  releaseSigners: string;
}

export const config: Config = {
  socket: process.env.MK_NAS_SOCKET || '/run/mk-nas.sock',
  group: process.env.MK_NAS_GROUP || 'mk-nas',
  audit: process.env.MK_NAS_AUDIT || '/var/log/mk-nas/audit.jsonl',
  version: pkg.version,
  timeout: Number(process.env.MK_NAS_TIMEOUT) || 60_000,
  eventsEvery: Number(process.env.MK_NAS_EVENTS_EVERY) || 5_000,
  vitalsEvery: Number(process.env.MK_NAS_VITALS_EVERY) || 5_000,
  alertsEvery: Number(process.env.MK_NAS_ALERTS_EVERY) || 5 * 60_000,
  db: process.env.MK_NAS_DB || '/var/lib/mk-nas/mk-nas.db',
  locationsDir: process.env.MK_NAS_LOCATIONS || '/srv/locations',
  smbConf: process.env.MK_NAS_SMB_CONF || '/etc/samba/smb.conf',
  exportsFile: process.env.MK_NAS_EXPORTS || '/etc/exports.d/mk-nas.exports',
  smbGroup: process.env.MK_NAS_SMB_GROUP || 'mk-nas-smb',
  // DRIVE_UID/DRIVE_GID in the stack's .env own locations and files written over the network
  ownerUid: Number(process.env.MK_NAS_OWNER_UID) || driveId(driveEnvText, 'DRIVE_UID') || 1000,
  ownerGid: Number(process.env.MK_NAS_OWNER_GID) || driveId(driveEnvText, 'DRIVE_GID') || 1000,
  sshKey: process.env.MK_NAS_SSH_KEY || '/var/lib/mk-nas/ssh/id_ed25519',
  knownHosts: process.env.MK_NAS_KNOWN_HOSTS || '/var/lib/mk-nas/ssh/known_hosts',
  netplanFile: process.env.MK_NAS_NETPLAN || '/etc/netplan/90-mk-nas.yaml',
  netplanPending: process.env.MK_NAS_NETPLAN_PENDING || '/var/lib/mk-nas/netplan-pending.json',
  driveEnv,
  driveDb: process.env.MK_NAS_DRIVE_DB || '/opt/mk-drive/data/mk-drive.db',
  updatesRepo: process.env.MK_NAS_UPDATES_REPO || 'mkornas/mk-nas',
  driveRepo: process.env.MK_NAS_DRIVE_REPO || 'mkornas/mk-drive',
  updatesDir: process.env.MK_NAS_UPDATES_DIR || '/var/lib/mk-nas/updates',
  releaseSigners: process.env.MK_NAS_RELEASE_SIGNERS || '/opt/mk-nas/install/release-signers',
};

/** The drive stack's tunnel: its .env line, the script that starts or stops the container, cloudflared's readiness on localhost. */
export const tunnelConfig = (c: Config) => ({
  envFile: c.driveEnv,
  stackUp: '/opt/mk-nas/install/stack-up.sh',
  container: 'mk-drive-tunnel',
  readyUrl: 'http://127.0.0.1:20241/ready',
});

/** Where releases come from and go to, as the agent, the tick and the install runner see it. */
export const updateConfig = (c: Config) => ({
  repo: c.updatesRepo,
  driveRepo: c.driveRepo,
  driveImage: 'ghcr.io/mkornas/mk-drive',
  dir: c.updatesDir,
  signers: c.releaseSigners,
  driveImageFile: '/opt/mk-nas/mk-drive-image.tgz',
  loadImage: '/opt/mk-nas/install/load-image.sh',
  pinnedDriveFile: '/opt/mk-nas/install/mk-drive/version',
  agentPackage: new URL('../package.json', import.meta.url).pathname,
});

/** What the settings backup copies, minus the runner that finishes a restore. */
export const backupConfig = (c: Config) => ({
  db: c.db,
  sshKey: c.sshKey,
  knownHosts: c.knownHosts,
  netplanFile: c.netplanFile,
  driveEnv: c.driveEnv,
  driveDb: c.driveDb,
});

/** The network files as the agent and the tick see them. */
export const netConfig = (c: Config) => ({
  netplanFile: c.netplanFile,
  pendingFile: c.netplanPending,
  hostsFile: '/etc/hosts',
  resolvConf: '/run/systemd/resolve/resolv.conf',
  sysNet: '/sys/class/net',
});
