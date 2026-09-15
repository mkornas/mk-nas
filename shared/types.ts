/**
 * The mk-nasd contract: what goes over /run/mk-nas.sock. mk-drive's
 * server/src/routes/nas.ts types against this file; the agent implements it.
 * Newline-delimited JSON, one Request per line, one Response per line.
 */

export interface Request {
  id: string | number;
  verb: Verb;
  args?: Record<string, unknown>;
}

export type Response<T = unknown> = { id: string | number; ok: true; result: T } | { id: string | number | null; ok: false; error: NasError };

export interface NasError {
  code: 'bad-request' | 'unknown-verb' | 'bad-args' | 'not-found' | 'unavailable' | 'command-failed' | 'internal';
  message: string;
  /** For command-failed: the exit code and stderr of the tool that failed. */
  detail?: { argv?: string[]; exitCode?: number | null; stderr?: string };
}

/** The allow-list. Phase 1 reads; phase 2 makes. Anything destructive takes `confirm` = the name, typed. */
export type Verb =
  | 'version'
  | 'disks'
  | 'smart'
  | 'smart.test'
  | 'pools'
  | 'pool'
  | 'datasets'
  | 'snapshots'
  | 'scrubs'
  | 'health'
  | 'jobs'
  | 'events'
  | 'system'
  | 'power'
  | 'system.reboot'
  | 'system.shutdown'
  | 'update'
  | 'update.check'
  | 'update.install'
  | 'network'
  | 'network.set'
  | 'network.confirm'
  | 'backup'
  | 'backup.set'
  | 'backup.run'
  | 'backup.restore'
  | 'policies'
  | 'pool.create'
  | 'pool.scrub'
  | 'disk.wipe'
  | 'dataset.create'
  | 'dataset.set'
  | 'dataset.destroy'
  | 'snapshot.create'
  | 'snapshot.destroy'
  | 'snapshot.rollback'
  | 'policy.set'
  | 'scrub.policies'
  | 'scrub.policy.set'
  | 'shares'
  | 'share.set'
  | 'share.remove'
  | 'users'
  | 'user.set'
  | 'user.smbPassword'
  | 'user.remove'
  | 'replications'
  | 'replication.set'
  | 'replication.remove'
  | 'replication.run'
  | 'replication.test'
  | 'replication.key'
  | 'disk.replace'
  | 'pool.importable'
  | 'pool.import';

/** A pool that `zpool import` sees but that is not imported: from another box, or exported. */
export interface ImportablePool {
  name: string;
  id: string;
  state: string;
  status: string | null;
  action: string | null;
  /** The disks it is on, as the by-id names zpool shows. */
  devices: string[];
}

export type ReplicationSchedule = 'manual' | 'hourly' | 'daily' | 'weekly';

/** A dataset pushed to another ZFS host over ssh: incremental from the newest snapshot both sides have, resumable, never rolling the target back. */
export interface Replication {
  id: number;
  dataset: string;
  host: string;
  user: string;
  port: number;
  targetDataset: string;
  /** Send the dataset's children too (zfs send -R). */
  recursive: boolean;
  schedule: ReplicationSchedule;
  /** How many of the job's own repl-* snapshots to keep on each side. */
  keep: number;
  lastRunAt: string | null;
  lastResult: 'ok' | 'failed' | null;
  lastMessage: string | null;
  /** The job that is running right now, when one is. */
  running: Job | null;
  createdAt: string;
}

export interface ReplicationSetArgs {
  /** Omit to create. */
  id?: number;
  dataset: string;
  host: string;
  user?: string;
  port?: number;
  targetDataset: string;
  recursive?: boolean;
  schedule?: ReplicationSchedule;
  keep?: number;
}

export interface ReplicationTest {
  ok: boolean;
  /** What the target answered, or why it could not be reached (the key is not installed, the dataset does not exist, …). */
  message: string;
  /** Snapshots already on the target dataset. */
  snapshots: string[];
}

/** A dataset handed out over the network. Both protocols may be on; the share name is the dataset's last component. */
export interface Share {
  dataset: string;
  name: string;
  mountpoint: string | null;
  smb: boolean;
  /** SMB only: Time Machine backups may target this share. */
  timeMachine: boolean;
  nfs: boolean;
  /** NFS only: who may mount it (hosts, CIDRs, or *). */
  nfsClients: string[];
  updatedAt: string;
}

export interface ShareSetArgs {
  dataset: string;
  smb?: boolean;
  timeMachine?: boolean;
  nfs?: boolean;
  nfsClients?: string[];
}

/** A Unix + Samba user the agent made for a drive account. The password lives in Samba only. */
export interface SmbUser {
  name: string;
  /** Set once user.smbPassword ran at least once. */
  hasPassword: boolean;
  createdAt: string;
}

export type PoolLayout = 'single' | 'mirror' | 'raidz1' | 'raidz2';
export type Compression = 'off' | 'lz4' | 'zstd' | 'gzip';

export interface PoolCreateArgs {
  name: string;
  layout: PoolLayout;
  /** by-id names of free disks (see Disk.id); single = 1, mirror ≥ 2, raidz1 ≥ 3, raidz2 ≥ 4. */
  disks: string[];
  /** Must equal `name`: the disks are formatted. */
  confirm: string;
}

export interface DatasetCreateArgs {
  /** pool/name or pool/parent/name. */
  name: string;
  quota?: number | null;
  compression?: Compression;
  atime?: boolean;
  /** Mount it under the drive's locations directory and hand it to the container's user, so mk-drive can offer it. */
  location?: boolean;
}

export interface DatasetSetArgs {
  dataset: string;
  quota?: number | null;
  compression?: Compression;
  atime?: boolean;
}

export interface DatasetDestroyArgs {
  dataset: string;
  /** Must equal `dataset`. */
  confirm: string;
  /** Destroy its snapshots with it; without this a dataset that has any is refused. */
  snapshots?: boolean;
}

/** How many automatic snapshots of each period to keep; 0 = do not take that period. */
export interface Policy {
  dataset: string;
  hourly: number;
  daily: number;
  weekly: number;
  monthly: number;
  updatedAt: string;
}

export type PolicySetArgs = Omit<Policy, 'updatedAt'>;

export type ScrubInterval = 'off' | 'weekly' | 'monthly';

/** How often the timer scrubs a pool. A pool without one is scrubbed monthly; the last result is what `pool` reads from zpool status. */
export interface ScrubPolicy {
  pool: string;
  interval: ScrubInterval;
  /** null for the default that was never set. */
  updatedAt: string | null;
}

export interface Version {
  agent: string;
  /** The verb contract this agent speaks; a drive built for a newer one asks for an upgrade. */
  contract: number;
  node: string;
  zfs: string | null;
  smartctl: string | null;
  hostname: string;
}

export interface Disk {
  /** The stable name: /dev/disk/by-id/<id>, the one every verb takes. */
  id: string;
  /** All by-id links pointing at this device. */
  ids: string[];
  /** The kernel name of the moment (/dev/sda); informational only. */
  dev: string;
  size: number;
  model: string | null;
  serial: string | null;
  transport: string | null;
  rotational: boolean;
  /**
   * 'pool' with the pool name when a ZFS label is on it or a partition of it — `imported` when a pool imported on this box
   * uses it, false for a label from another machine (an old TrueNAS pool, a disk replaced out), which disk.wipe accepts;
   * 'os' when it holds a mounted filesystem; 'free' otherwise. (An agent before 0.4.4 sends no `imported`: treat it as true.)
   */
  use: { kind: 'pool'; pool: string; imported?: boolean } | { kind: 'os' } | { kind: 'free' } | { kind: 'other'; what: string };
  /** In standby: `smart` is then the last reading the agent took while it was awake (null when it has none), so a listing never wakes a disk. From 0.6.1. */
  asleep?: boolean;
  smart: SmartSummary | null;
}

export interface SmartSummary {
  passed: boolean | null;
  temperature: number | null;
  powerOnHours: number | null;
  reallocated: number | null;
  pending: number | null;
  /** NVMe percentage used, 0..100+ */
  wear: number | null;
  /** A self-test running on the disk now. From 0.6.1. */
  testing?: { kind: SelfTestKind; percentDone: number | null } | null;
}

export type SelfTestKind = 'short' | 'long' | 'other';

/** One finished self-test from the disk's own log. */
export interface SelfTest {
  kind: SelfTestKind;
  passed: boolean | null;
  /** As smartctl words it ("Completed without error", "Completed: read failure"). */
  result: string;
  /** The disk's power-on hours when it finished. */
  hours: number | null;
}

export interface Smart extends SmartSummary {
  id: string;
  model: string | null;
  serial: string | null;
  firmware: string | null;
  /** The test running now, and the log newest first. The timer starts a long test when none finished in the last 720 power-on hours. */
  selfTest: {
    running: { kind: SelfTestKind; percentDone: number | null } | null;
    tests: SelfTest[];
    /** Whether the disk can run self-tests at all (null when smartctl does not say). From 0.6.1. */
    supported?: boolean | null;
  };
  /** The raw smartctl JSON for the detail view. */
  raw: unknown;
}

export type PoolHealth = 'ONLINE' | 'DEGRADED' | 'FAULTED' | 'OFFLINE' | 'UNAVAIL' | 'REMOVED' | 'SUSPENDED';

export interface PoolSummary {
  name: string;
  health: PoolHealth;
  size: number;
  allocated: number;
  free: number;
  /** 0..100 */
  capacity: number;
  fragmentation: number | null;
}

export interface Pool extends PoolSummary {
  status: string | null;
  action: string | null;
  scan: string | null;
  errors: string | null;
  vdevs: Vdev[];
  scrub: Scrub | null;
}

export interface Vdev {
  name: string;
  state: string;
  read: number;
  write: number;
  cksum: number;
  note: string | null;
  children: Vdev[];
}

export interface Scrub {
  pool: string;
  /** A scrub checks; a resilver rebuilds a replaced disk. The same scan line reports both. */
  kind: 'scrub' | 'resilver';
  /** 'none' when the pool has never been scrubbed. */
  state: 'none' | 'running' | 'finished' | 'canceled';
  /** The scan line as zpool prints it. */
  text: string;
  /** For a running scrub: 0..100 when it can be read from the line. */
  percent: number | null;
  /** For a finished scrub: the ISO date when it can be read from the line. */
  finishedAt: string | null;
  errors: number | null;
}

export interface Dataset {
  name: string;
  pool: string;
  type: 'filesystem' | 'volume';
  used: number;
  available: number;
  referenced: number;
  mountpoint: string | null;
  mounted: boolean;
  quota: number | null;
  compression: string;
  compressratio: number;
  atime: boolean;
  recordsize: number;
  creation: string;
}

export interface Snapshot {
  name: string;
  dataset: string;
  /** The part after '@'. */
  snapshot: string;
  used: number;
  referenced: number;
  creation: string;
}

export interface Health {
  ok: boolean;
  pools: { name: string; health: PoolHealth; capacity: number; ok: boolean }[];
  disks: { id: string; ok: boolean; reason: string | null }[];
  /** Human lines for the top of the Storage page. */
  problems: string[];
  /** What ZFS reported in the last day that a person should hear about, newest first (a disk faulted, a checksum failed, a disk removed). */
  events: ZfsEvent[];
}

/** One reading of the box, taken every few seconds. Rates are per second since the reading before. */
export interface Sample {
  at: string;
  /** 0..100 across all cores. */
  cpu: number;
  load: [number, number, number];
  /** bytes; used = total − available */
  memory: { total: number; used: number; available: number };
  swap: { total: number; used: number };
  /** bytes/s per physical-looking interface (no loopback, no container plumbing). */
  net: { name: string; rx: number; tx: number }[];
  /** bytes/s and busy 0..100 per whole disk, by kernel name (see System.disks for the by-id name and pool). */
  disks: { dev: string; read: number; write: number; busy: number }[];
  temps: { sensor: string; label: string | null; celsius: number }[];
}

/** What is kept of a sample: the totals. */
export interface SamplePoint {
  at: string;
  cpu: number;
  load: number;
  memoryUsed: number;
  rx: number;
  tx: number;
  read: number;
  write: number;
  /** The hottest sensor. */
  temp: number | null;
}

export interface System {
  hostname: string;
  /** seconds */
  uptime: number;
  cores: number;
  /** null right after the agent started (one reading is not a rate yet). */
  now: Sample | null;
  /** Oldest first, up to 30 minutes at 5 s; in memory only, so it starts over with the agent. */
  history: SamplePoint[];
  /** Kernel disk name → the by-id name every verb takes, and the pool it serves. */
  disks: { dev: string; id: string; pool: string | null }[];
}

/** Before a reboot or shutdown: whether the box wants one, and what it would interrupt. */
export interface Power {
  /** Ubuntu's updates asked for a restart (/run/reboot-required): a new kernel or a core library. */
  restartNeeded: boolean;
  /** The packages that asked for it. */
  packages: string[];
  /** Running work a restart cuts short, in words: a scrub or rebuild (resumes), a copy (resumes), a SMART self-test (starts over). */
  busy: string[];
}

export type PowerAction = 'reboot' | 'shutdown';

export interface PowerScheduled {
  action: PowerAction;
  /** When the box goes: a few seconds after the answer, so the answer arrives. */
  at: string;
}

/** An mk-nas release as the box sees it on GitHub. */
export interface Release {
  version: string;
  /** The mk-drive version it pins. */
  drive: string;
  contract: number;
  /** The release notes, Markdown as written. */
  notes: string;
  publishedAt: string;
  url: string;
  /** The maintainer's signature is attached; the install checks it before anything else. */
  signed: boolean;
}

/** One install of a release from the box, start to end. */
export interface UpdateRun {
  id: number;
  version: string;
  state: 'running' | 'done' | 'failed';
  /** What it is doing now, or what it did last: downloading, verifying, backing up, installing, starting the drive. */
  step: string;
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
}

export interface Update {
  /** The agent's version and the drive version it pins. */
  current: string;
  drive: string;
  /** The newest release at the last check; null before the first one. */
  latest: Release | null;
  checkedAt: string | null;
  /** Why the last check failed (no network, GitHub refused); the previous `latest` stays. */
  error: string | null;
  /** `latest` is newer than `current` and signed. */
  available: boolean;
  /** The newest install run, running or not. */
  run: UpdateRun | null;
}

export interface NetInterface {
  name: string;
  mac: string | null;
  up: boolean;
  /** Mbit/s, when the link reports it. */
  speed: number | null;
  /** CIDR, the global ones. */
  addresses: string[];
  /** At least one address came from DHCP. */
  dhcp: boolean;
  /** What the agent's own netplan file says for it; null when the installer's file still rules it. */
  configured: { dhcp: true } | { dhcp: false; address: string; gateway: string | null; dns: string[] } | null;
}

export interface Network {
  hostname: string;
  /** avahi runs: <hostname>.local answers. */
  mdns: boolean;
  gateway: string | null;
  dns: string[];
  interfaces: NetInterface[];
  /** An address change waiting to be kept; unless network.confirm arrives before expiresAt the box goes back to what it had. */
  pending: { interface: string; since: string; expiresAt: string } | null;
}

export interface NetworkSetArgs {
  hostname?: string;
  /** The interface to configure, with either dhcp: true or an address. */
  interface?: string;
  dhcp?: boolean;
  /** a.b.c.d/nn */
  address?: string;
  gateway?: string | null;
  /** Up to three. */
  dns?: string[];
  /** Seconds before an address change reverts unless confirmed; 120 by default, 15 to 3600. */
  revertAfter?: number;
}

/** The box's settings kept in a dataset: the agent's and the drive's databases, Samba's passwords, the ssh key, the netplan file, the drive's .env. Daily, snapshotted there, replicates with the rest. */
export interface ConfigBackup {
  /** The dataset that holds it; null when none was chosen (then nothing is backed up). */
  dataset: string | null;
  lastAt: string | null;
  lastResult: 'ok' | 'failed' | null;
  lastMessage: string | null;
  /** config-* snapshots kept on the dataset (the last 30). */
  snapshots: number;
  /** What the newest backup on the dataset holds, and when it was taken — which may be from another box after a pool import. */
  files: string[];
  takenAt: string | null;
}

/** One line of `zpool events`, as the agent saw it. Kept in memory since the agent started (the kernel keeps them since boot). */
export interface ZfsEvent {
  /** The kernel's running id. */
  eid: number;
  time: string;
  /** sysevent.fs.zfs.*, ereport.fs.zfs.*, resource.fs.zfs.* */
  class: string;
  pool: string | null;
  /** The disk as `disks` names it, when the event is about one. */
  vdev: string | null;
  /** For a state change: the new and the old vdev state. */
  state: string | null;
  prevState: string | null;
  /** One human line. */
  summary: string;
  /** Worth telling a person, as opposed to a config sync or a history entry. */
  matters: boolean;
  /** How many of the same in a row this line stands for. */
  count: number;
}

export interface Job {
  id: number;
  kind: 'replication' | 'scrub' | 'resilver';
  /** The replication's id. */
  replicationId: number | null;
  /** For a scrub or resilver: the pool. */
  pool: string | null;
  /** dataset → user@host:target, or the pool */
  target: string;
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  /** 0..100 when the size is known. */
  progress: number | null;
  bytes: number;
  total: number | null;
  /** What was sent (full, incremental from X, resumed), the scan line a scrub or resilver ended with, or the error. */
  message: string | null;
}

/** What each verb takes and returns. */
export interface Verbs {
  version: { args: Record<string, never>; result: Version };
  disks: { args: Record<string, never>; result: Disk[] };
  smart: { args: { disk: string }; result: Smart };
  /** Starts a short (minutes) or long (hours) self-test; refused while one runs. The disk does the work; `smart` shows the progress and the result. */
  'smart.test': { args: { disk: string; kind: 'short' | 'long' }; result: Smart };
  pools: { args: Record<string, never>; result: PoolSummary[] };
  pool: { args: { pool: string }; result: Pool };
  datasets: { args: { pool?: string }; result: Dataset[] };
  snapshots: { args: { dataset?: string }; result: Snapshot[] };
  scrubs: { args: Record<string, never>; result: Scrub[] };
  health: { args: Record<string, never>; result: Health };
  /** Running jobs first, then the newest finished ones (up to 50); `pool` narrows it to that pool's scrubs and resilvers. */
  jobs: { args: { replicationId?: number; pool?: string }; result: Job[] };
  /** Newest first, the ones that matter unless `all`; up to `limit` (50). */
  events: { args: { limit?: number; all?: boolean }; result: ZfsEvent[] };
  /** The box at a glance; the deep monitor is mk-dashboard. */
  system: { args: Record<string, never>; result: System };
  power: { args: Record<string, never>; result: Power };
  /** `confirm` = the box's hostname, typed. Answers, then reboots a few seconds later. */
  'system.reboot': { args: { confirm: string }; result: PowerScheduled };
  /** `confirm` = the box's hostname, typed. Answers, then powers off a few seconds later; only the power button brings it back. */
  'system.shutdown': { args: { confirm: string }; result: PowerScheduled };
  /** What is installed, the newest release at the last check (the timer checks daily), and the newest install run. */
  update: { args: Record<string, never>; result: Update };
  /** Asks GitHub now. */
  'update.check': { args: Record<string, never>; result: Update };
  /** Starts installing `version`, which must be the newest checked release, newer than this one and signed; `update` follows it. */
  'update.install': { args: { version: string }; result: Update };
  network: { args: Record<string, never>; result: Network };
  /** The hostname takes effect at once. An interface change is applied with a revert: call network.confirm from the new address before `pending.expiresAt`, or it goes back. */
  'network.set': { args: NetworkSetArgs; result: Network };
  /** Keeps the pending change. */
  'network.confirm': { args: Record<string, never>; result: Network };
  backup: { args: Record<string, never>; result: ConfigBackup };
  /** Chooses the dataset (null switches the backup off); the first backup runs with backup.run or the next tick. */
  'backup.set': { args: { dataset: string | null }; result: ConfigBackup };
  'backup.run': { args: Record<string, never>; result: ConfigBackup };
  /** Puts the settings from that dataset's backup back, then restarts the agent and the drive (the answer arrives first). `confirm` = the dataset name. */
  'backup.restore': { args: { dataset: string; confirm: string }; result: { restoring: true; files: string[]; takenAt: string } };
  policies: { args: Record<string, never>; result: Policy[] };
  'pool.create': { args: PoolCreateArgs; result: Pool };
  /** Starts a scrub in the background and writes it down as a job; `jobs` with `pool` follows it. */
  'pool.scrub': { args: { pool: string }; result: { started: true } };
  /** Erases the ZFS labels, partition table and filesystem signatures of a disk that no pool imported here uses and that is not the OS disk. */
  'disk.wipe': { args: { disk: string; confirm: string }; result: Disk };
  'dataset.create': { args: DatasetCreateArgs; result: Dataset };
  'dataset.set': { args: DatasetSetArgs; result: Dataset };
  /** Refused when it has children, a share or a replication; its policy goes with it. `location` = the drive location it was, so the drive can drop it. */
  'dataset.destroy': { args: DatasetDestroyArgs; result: { destroyed: string; snapshots: number; location: string | null } };
  /** `name` defaults to manual-<date>_<time>. */
  'snapshot.create': { args: { dataset: string; name?: string }; result: Snapshot };
  'snapshot.destroy': { args: { snapshot: string; confirm: string }; result: { destroyed: string } };
  /** Rolls the dataset back to its newest snapshot; every change since is lost. Refused, naming them, when newer snapshots exist (destroy them first). Contract 2: no `saved`. */
  'snapshot.rollback': { args: { snapshot: string; confirm: string }; result: { rolledBackTo: string } };
  'policy.set': { args: PolicySetArgs; result: Policy };
  /** One per imported pool, the default filled in. */
  'scrub.policies': { args: Record<string, never>; result: ScrubPolicy[] };
  'scrub.policy.set': { args: { pool: string; interval: ScrubInterval }; result: ScrubPolicy };
  shares: { args: Record<string, never>; result: Share[] };
  /** Creates or updates; regenerates smb.conf and the NFS exports and reloads the daemons. */
  'share.set': { args: ShareSetArgs; result: Share };
  'share.remove': { args: { dataset: string }; result: { removed: string } };
  users: { args: Record<string, never>; result: SmbUser[] };
  /** Makes sure the Unix and Samba user exist (no password yet). */
  'user.set': { args: { name: string }; result: SmbUser };
  /** The password goes to smbpasswd on stdin, never on a command line. */
  'user.smbPassword': { args: { name: string; password: string }; result: SmbUser };
  'user.remove': { args: { name: string }; result: { removed: string } };
  replications: { args: Record<string, never>; result: Replication[] };
  'replication.set': { args: ReplicationSetArgs; result: Replication };
  'replication.remove': { args: { id: number }; result: { removed: number } };
  /** Starts the job in the background; watch it through `jobs`. */
  'replication.run': { args: { id: number }; result: Job };
  /** ssh to the target and list its snapshots of the target dataset; says what is wrong when it cannot. */
  'replication.test': { args: { host: string; user?: string; port?: number; targetDataset: string }; result: ReplicationTest };
  /** The NAS's public key, made on first ask; goes into the target user's authorized keys. */
  'replication.key': { args: Record<string, never>; result: { publicKey: string } };
  /** Puts a free disk in the place of a member (its name or guid as zpool status shows it); the resilver runs in the background, `pool` shows it. */
  'disk.replace': { args: { pool: string; old: string; disk: string; confirm: string }; result: Pool };
  'pool.importable': { args: Record<string, never>; result: ImportablePool[] };
  /** Imports by name; mounts where the pool says. Refused when a pool of that name is already here. */
  'pool.import': { args: { pool: string }; result: Pool };
}
