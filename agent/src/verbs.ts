/**
 * The allow-list. This file is the whole privilege boundary: a verb that
 * is not here cannot be called, and every argument a verb accepts is named
 * and validated here before anything runs.
 */
import { hostname } from 'node:os';
import type {
  DatasetCreateArgs,
  DatasetDestroyArgs,
  DatasetSetArgs,
  Health,
  NetworkSetArgs,
  PolicySetArgs,
  PoolCreateArgs,
  ReplicationSetArgs,
  ScrubInterval,
  ShareSetArgs,
  System,
  Verb,
  Verbs,
  Version,
} from '../../shared/types.ts';
import type { Db } from './db.ts';
import type { EventLog } from './events.ts';
import type { Vitals } from './system.ts';
import { byIdMap, getSmart, listDisks, LSBLK_ARGV, parseLsblk, pickId, smartctlVersion, startSelfTest, useOf } from './disks.ts';
import { readBackup, restoreBackup, runBackup, setBackup, type BackupConfig } from './backup.ts';
import { BadArgs, datasetName, diskId, only, optional, poolName } from './names.ts';
import { readPower, schedulePower } from './power.ts';
import { readTunnel, removeTunnel, setTunnel, type TunnelConfig } from './tunnel.ts';
import { checkForUpdate, installable, readUpdate, type Fetch, type UpdateConfig } from './updates.ts';
import { confirmNetwork, readNetwork, revertIfExpired, setNetwork, type NetConfig } from './network.ts';
import { must, type Runner } from './run.ts';
import { ensureKey, hostName, portNumber, replicate, setReplication, testTarget, userName, withRunning, type ReplConfig } from './replication.ts';
import { listShares, removeShare, removeUser, setShare, setSmbPassword, setUser, type ShareConfig } from './shares.ts';
import {
  boolOf,
  createDataset,
  createPool,
  createSnapshot,
  destroyDataset,
  destroySnapshot,
  importPool,
  replaceDisk,
  rollbackSnapshot,
  scrubPool,
  setDataset,
  wipeDisk,
} from './write.ts';
import { SCRUB_INTERVALS } from './policy.ts';
import { noteScan, reconcileScans } from './scans.ts';
import { getPool, listDatasets, listImportable, listPools, listSnapshots, parseScan, zfsVersion } from './zfs.ts';

/** Bumped when a verb or a result changes shape in a way an older drive would misread. */
export const CONTRACT = 2;

export interface Deps {
  run: Runner;
  version: string;
  db: Db;
  locationsDir: string;
  shares: ShareConfig;
  replication: ReplConfig;
  /** Starts a detached job (the replication runner, the restore finisher) that outlives the agent, and forgets it. */
  spawn: (argv: string[]) => void;
  /** The zpool events tail; absent in tests that do not care. */
  events?: EventLog;
  /** The vitals sampler; absent in tests that do not care. */
  vitals?: Vitals;
  network: NetConfig;
  backup: Omit<BackupConfig, 'spawn'>;
  byIdDir?: string;
  /** /run/reboot-required, moved in tests. */
  rebootRequired?: string;
  /** Absent in tests that do not care. */
  updates?: UpdateConfig;
  /** Absent in tests that do not care. */
  tunnel?: TunnelConfig;
  /** GitHub, for the update check; a fake in tests. */
  fetch?: Fetch;
}

const tunnelOf = (deps: Deps): TunnelConfig => {
  if (!deps.tunnel) throw new Error('the tunnel is not configured');
  return deps.tunnel;
};

const updatesOf = (deps: Deps): UpdateConfig => {
  if (!deps.updates) throw new Error('updates are not configured');
  return deps.updates;
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function count(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1000) throw new BadArgs(`${what} must be a whole number from 0 to 1000`);
  return v;
}

type Handler<V extends Verb> = (args: Record<string, unknown> | undefined, deps: Deps) => Promise<Verbs[V]['result']>;

export const verbs: { [V in Verb]: Handler<V> } = {
  async version(args, deps): Promise<Version> {
    only(args, []);
    return {
      agent: deps.version,
      contract: CONTRACT,
      node: process.version,
      zfs: await zfsVersion(deps.run),
      smartctl: await smartctlVersion(deps.run),
      hostname: hostname(),
    };
  },
  async disks(args, deps) {
    only(args, []);
    return listDisks(deps.run, deps.byIdDir);
  },
  async smart(args, deps) {
    const a = only(args, ['disk']);
    return getSmart(deps.run, diskId(a.disk), deps.byIdDir);
  },
  async 'smart.test'(args, deps) {
    const a = only(args, ['disk', 'kind']);
    return startSelfTest(deps.run, diskId(a.disk), a.kind, deps.byIdDir);
  },
  async pools(args, deps) {
    only(args, []);
    return listPools(deps.run);
  },
  async pool(args, deps) {
    const a = only(args, ['pool']);
    return getPool(deps.run, poolName(a.pool));
  },
  async datasets(args, deps) {
    const a = only(args, ['pool']);
    return listDatasets(deps.run, optional(a.pool, poolName));
  },
  async snapshots(args, deps) {
    const a = only(args, ['dataset']);
    return listSnapshots(deps.run, optional(a.dataset, datasetName));
  },
  async scrubs(args, deps) {
    only(args, []);
    const pools = await listPools(deps.run);
    const all = await Promise.all(pools.map(async (p) => parseScan(p.name, (await getPool(deps.run, p.name)).scan)));
    return all.filter((s) => s !== null);
  },
  async health(args, deps): Promise<Health> {
    only(args, []);
    const [pools, disks] = await Promise.all([listPools(deps.run), listDisks(deps.run, deps.byIdDir)]);
    const problems: string[] = [];
    const poolRows = await Promise.all(
      pools.map(async (p) => {
        const ok = p.health === 'ONLINE' && p.capacity < 90;
        if (p.health !== 'ONLINE') {
          const detail = await getPool(deps.run, p.name);
          const bad: string[] = [];
          const walk = (v: { name: string; state: string; children: typeof detail.vdevs }) => {
            if (v.children.length === 0 && v.state !== 'ONLINE') bad.push(`${v.name} ${v.state}`);
            v.children.forEach(walk);
          };
          detail.vdevs.forEach(walk);
          problems.push(`Pool ${p.name} is ${p.health}${bad.length ? ` (${bad.join(', ')})` : ''}${detail.action ? ` — ${detail.action}` : ''}`);
        } else if (p.capacity >= 90) problems.push(`Pool ${p.name} is ${p.capacity}% full`);
        return { name: p.name, health: p.health, capacity: p.capacity, ok };
      }),
    );
    const diskRows = disks.map((d) => {
      let reason: string | null = null;
      if (d.smart?.passed === false) reason = 'SMART self-assessment failed';
      else if ((d.smart?.reallocated ?? 0) > 0) reason = `${d.smart!.reallocated} reallocated sectors`;
      else if ((d.smart?.pending ?? 0) > 0) reason = `${d.smart!.pending} pending sectors`;
      else if ((d.smart?.temperature ?? 0) >= 55) reason = `${d.smart!.temperature} °C`;
      if (reason) problems.push(`Disk ${d.id}: ${reason}`);
      return { id: d.id, ok: reason === null, reason };
    });
    const events = deps.events?.recent(20, false, new Date(Date.now() - 86_400_000)) ?? [];
    return { ok: problems.length === 0, pools: poolRows, disks: diskRows, problems, events };
  },
  async jobs(args, deps) {
    const a = only(args, ['replicationId', 'pool']);
    if (a.replicationId !== undefined && typeof a.replicationId !== 'number') throw new BadArgs('replicationId must be a number');
    const pool = optional(a.pool, poolName);
    // a scan's progress and end are only ever read off the pool; the job rows are what is left of it afterwards
    await reconcileScans(deps.run, deps.db);
    return pool ? deps.db.scanJobs(pool) : deps.db.jobs(a.replicationId as number | undefined);
  },
  async events(args, deps) {
    const a = only(args, ['limit', 'all']);
    const limit = a.limit === undefined ? 50 : count(a.limit, 'limit');
    const all = a.all === undefined ? false : boolOf(a.all, 'all');
    return deps.events?.recent(limit, all) ?? [];
  },
  async system(args, deps): Promise<System> {
    only(args, []);
    const snap = deps.vitals?.snapshot() ?? { now: null, history: [], uptime: 0, cores: 0 };
    // which pool each kernel disk serves: lsblk and the by-id links, no SMART (that would wake a sleeping disk every few seconds)
    const [devices, ids] = await Promise.all([parseLsblk(await must(deps.run, LSBLK_ARGV)), byIdMap(deps.byIdDir)]);
    const disks = devices.map((d) => {
      const links = ids.get(d.path) ?? [];
      const use = useOf(d);
      return { dev: d.name, id: links.length ? pickId(links) : d.path, pool: use.kind === 'pool' ? use.pool : null };
    });
    return { hostname: hostname(), ...snap, disks };
  },
  async power(args, deps) {
    only(args, []);
    return readPower(deps.run, deps.db, deps.rebootRequired);
  },
  async 'system.reboot'(args, deps) {
    const a = only(args, ['confirm']);
    return schedulePower(deps.run, 'reboot', a.confirm);
  },
  async 'system.shutdown'(args, deps) {
    const a = only(args, ['confirm']);
    return schedulePower(deps.run, 'shutdown', a.confirm);
  },
  async tunnel(args, deps) {
    only(args, []);
    return readTunnel(deps.run, deps.fetch ?? fetch, tunnelOf(deps));
  },
  async 'tunnel.set'(args, deps) {
    const a = only(args, ['token']);
    return setTunnel(deps.run, deps.fetch ?? fetch, tunnelOf(deps), a.token);
  },
  async 'tunnel.remove'(args, deps) {
    only(args, []);
    return removeTunnel(deps.run, deps.fetch ?? fetch, tunnelOf(deps));
  },
  async update(args, deps) {
    only(args, []);
    return readUpdate(deps.db, updatesOf(deps), deps.version, alive);
  },
  async 'update.check'(args, deps) {
    only(args, []);
    await checkForUpdate(deps.fetch ?? fetch, deps.db, updatesOf(deps), deps.version);
    return readUpdate(deps.db, updatesOf(deps), deps.version, alive);
  },
  async 'update.install'(args, deps) {
    const a = only(args, ['version']);
    deps.db.failDeadUpdateRuns(alive);
    const version = installable(deps.db, deps.version, a.version);
    // its own unit (detach.ts): the package it installs restarts this agent
    deps.spawn([process.execPath, new URL('./update.ts', import.meta.url).pathname, version]);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const run = deps.db.updateRun();
      if (run?.version === version && Date.now() - Date.parse(run.startedAt) < 5000) break;
    }
    const u = await readUpdate(deps.db, updatesOf(deps), deps.version, alive);
    if (u.run?.version !== version || Date.now() - Date.parse(u.run.startedAt) > 5000) throw new Error('the update runner did not start');
    return u;
  },
  async network(args, deps) {
    only(args, []);
    // the promised revert, in case the timer's tick has not come round yet
    await revertIfExpired(deps.run, deps.network);
    return readNetwork(deps.run, deps.network);
  },
  async 'network.set'(args, deps) {
    const a = only(args, ['hostname', 'interface', 'dhcp', 'address', 'gateway', 'dns', 'revertAfter']);
    await revertIfExpired(deps.run, deps.network);
    return setNetwork(deps.run, deps.network, a as NetworkSetArgs);
  },
  async 'network.confirm'(args, deps) {
    only(args, []);
    return confirmNetwork(deps.run, deps.network);
  },
  async backup(args, deps) {
    only(args, []);
    return readBackup(deps.run, deps.db, { ...deps.backup, spawn: deps.spawn });
  },
  async 'backup.set'(args, deps) {
    const a = only(args, ['dataset']);
    return setBackup(deps.run, deps.db, { ...deps.backup, spawn: deps.spawn }, a.dataset);
  },
  async 'backup.run'(args, deps) {
    only(args, []);
    return runBackup(deps.run, deps.db, { ...deps.backup, spawn: deps.spawn });
  },
  async 'backup.restore'(args, deps) {
    const a = only(args, ['dataset', 'confirm']);
    return restoreBackup(deps.run, { ...deps.backup, spawn: deps.spawn }, a.dataset, a.confirm);
  },
  async policies(args, deps) {
    only(args, []);
    return deps.db.policies();
  },
  async 'pool.create'(args, deps) {
    const a = only(args, ['name', 'layout', 'disks', 'confirm']);
    return createPool(deps.run, a as unknown as PoolCreateArgs, deps.byIdDir);
  },
  async 'pool.scrub'(args, deps) {
    const a = only(args, ['pool']);
    const r = await scrubPool(deps.run, a.pool);
    noteScan(deps.db, 'scrub', poolName(a.pool));
    return r;
  },
  async 'disk.wipe'(args, deps) {
    const a = only(args, ['disk', 'confirm']);
    return wipeDisk(deps.run, a.disk, a.confirm, deps.byIdDir);
  },
  async 'dataset.create'(args, deps) {
    const a = only(args, ['name', 'quota', 'compression', 'atime', 'location']);
    return createDataset(deps.run, a as unknown as DatasetCreateArgs, deps.locationsDir, { uid: deps.shares.ownerUid, gid: deps.shares.ownerGid });
  },
  async 'dataset.set'(args, deps) {
    const a = only(args, ['dataset', 'quota', 'compression', 'atime']);
    return setDataset(deps.run, a as unknown as DatasetSetArgs);
  },
  async 'dataset.destroy'(args, deps) {
    const a = only(args, ['dataset', 'confirm', 'snapshots']);
    return destroyDataset(deps.run, deps.db, a as unknown as DatasetDestroyArgs, deps.locationsDir);
  },
  async 'snapshot.create'(args, deps) {
    const a = only(args, ['dataset', 'name']);
    return createSnapshot(deps.run, a.dataset, a.name);
  },
  async 'snapshot.destroy'(args, deps) {
    const a = only(args, ['snapshot', 'confirm']);
    return destroySnapshot(deps.run, a.snapshot, a.confirm);
  },
  async 'snapshot.rollback'(args, deps) {
    const a = only(args, ['snapshot', 'confirm']);
    return rollbackSnapshot(deps.run, a.snapshot, a.confirm);
  },
  async 'policy.set'(args, deps) {
    const a = only(args, ['dataset', 'hourly', 'daily', 'weekly', 'monthly']);
    const p: PolicySetArgs = {
      dataset: datasetName(a.dataset),
      hourly: count(a.hourly, 'hourly'),
      daily: count(a.daily, 'daily'),
      weekly: count(a.weekly, 'weekly'),
      monthly: count(a.monthly, 'monthly'),
    };
    // the dataset must exist: a policy for a name that is not there would only ever fail in the tick
    const [d] = await listDatasets(deps.run, p.dataset);
    if (!d || d.name !== p.dataset) throw new BadArgs(`${p.dataset}: no such dataset`);
    return deps.db.setPolicy(p) ?? { ...p, updatedAt: new Date().toISOString() };
  },
  async 'scrub.policies'(args, deps) {
    only(args, []);
    const pools = await listPools(deps.run);
    return pools.map((p) => deps.db.scrubPolicy(p.name) ?? { pool: p.name, interval: 'monthly' as const, updatedAt: null });
  },
  async 'scrub.policy.set'(args, deps) {
    const a = only(args, ['pool', 'interval']);
    const pool = poolName(a.pool);
    if (typeof a.interval !== 'string' || !SCRUB_INTERVALS.includes(a.interval as ScrubInterval))
      throw new BadArgs(`interval must be one of ${SCRUB_INTERVALS.join(', ')}`);
    await listPools(deps.run, pool); // not-found for a pool that is not here
    return deps.db.setScrubPolicy(pool, a.interval as ScrubInterval);
  },
  async shares(args, deps) {
    only(args, []);
    return listShares(deps.run, deps.db);
  },
  async 'share.set'(args, deps) {
    const a = only(args, ['dataset', 'smb', 'timeMachine', 'nfs', 'nfsClients']);
    return setShare(deps.run, deps.db, deps.shares, a as unknown as ShareSetArgs);
  },
  async 'share.remove'(args, deps) {
    const a = only(args, ['dataset']);
    return removeShare(deps.run, deps.db, deps.shares, a.dataset);
  },
  async users(args, deps) {
    only(args, []);
    return deps.db.smbUsers();
  },
  async 'user.set'(args, deps) {
    const a = only(args, ['name']);
    return setUser(deps.run, deps.db, deps.shares, a.name);
  },
  async 'user.smbPassword'(args, deps) {
    const a = only(args, ['name', 'password']);
    return setSmbPassword(deps.run, deps.db, deps.shares, a.name, a.password);
  },
  async 'user.remove'(args, deps) {
    const a = only(args, ['name']);
    return removeUser(deps.run, deps.db, a.name);
  },
  async replications(args, deps) {
    only(args, []);
    return deps.db.replications().map((r) => withRunning(deps.db, r));
  },
  async 'replication.set'(args, deps) {
    const a = only(args, ['id', 'dataset', 'host', 'user', 'port', 'targetDataset', 'recursive', 'schedule', 'keep']);
    return withRunning(deps.db, await setReplication(deps.run, deps.db, a as unknown as ReplicationSetArgs));
  },
  async 'replication.remove'(args, deps) {
    const a = only(args, ['id']);
    if (typeof a.id !== 'number' || !deps.db.removeReplication(a.id)) throw new BadArgs('id: no such replication');
    return { removed: a.id };
  },
  async 'replication.run'(args, deps) {
    const a = only(args, ['id']);
    if (typeof a.id !== 'number' || !deps.db.replication(a.id)) throw new BadArgs('id: no such replication');
    const running = deps.db.runningJob(a.id);
    if (running) return running;
    // the runner is its own unit (index.ts → detach.ts): a send may take hours and must survive the agent restarting
    deps.spawn([process.execPath, new URL('./replicate.ts', import.meta.url).pathname, String(a.id)]);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const job = deps.db.runningJob(a.id) ?? deps.db.jobs(a.id, 1)[0];
      if (job && Date.now() - Date.parse(job.startedAt) < 5000) return job;
    }
    throw new Error('the replication runner did not start');
  },
  async 'replication.test'(args, deps) {
    const a = only(args, ['host', 'user', 'port', 'targetDataset']);
    return testTarget(
      deps.run,
      deps.replication,
      { host: hostName(a.host), user: userName(a.user), port: portNumber(a.port) },
      datasetName(a.targetDataset, 'targetDataset'),
    );
  },
  async 'replication.key'(args, deps) {
    only(args, []);
    return { publicKey: await ensureKey(deps.run, deps.replication) };
  },
  async 'disk.replace'(args, deps) {
    const a = only(args, ['pool', 'old', 'disk', 'confirm']);
    const p = await replaceDisk(deps.run, a as { pool: unknown; old: unknown; disk: unknown; confirm: unknown }, deps.byIdDir);
    noteScan(deps.db, 'resilver', p.name);
    return p;
  },
  async 'pool.importable'(args, deps) {
    only(args, []);
    return listImportable(deps.run);
  },
  async 'pool.import'(args, deps) {
    const a = only(args, ['pool']);
    return importPool(deps.run, a.pool);
  },
};

export { replicate };

export const isVerb = (v: unknown): v is Verb => typeof v === 'string' && Object.hasOwn(verbs, v);
