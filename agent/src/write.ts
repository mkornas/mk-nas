/**
 * The verbs that change something. Each one: validate every caller value
 * (names.ts), look before leaping (a disk must be free, a snapshot must be
 * a snapshot), build one argv, run it, read the result back from ZFS.
 * Destructive ones take `confirm` = the name, typed by a person.
 */
import { rmdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  Compression,
  Dataset,
  DatasetCreateArgs,
  DatasetDestroyArgs,
  DatasetSetArgs,
  Disk,
  Pool,
  PoolCreateArgs,
  PoolLayout,
  Snapshot,
} from '../../shared/types.ts';
import type { Db } from './db.ts';
import { listDisks, LSBLK_ARGV, parseLsblk, resolveDisk } from './disks.ts';
import { BadArgs, datasetName, diskId, poolName, snapshotName } from './names.ts';
import { must, type Runner } from './run.ts';
import { getPool, listDatasets, listPools, listSnapshots } from './zfs.ts';
import { stamp } from './policy.ts';

export const COMPRESSIONS: Compression[] = ['off', 'lz4', 'zstd', 'gzip'];

export const LAYOUTS: Record<PoolLayout, { min: number; vdev: string | null }> = {
  single: { min: 1, vdev: null },
  mirror: { min: 2, vdev: 'mirror' },
  raidz1: { min: 3, vdev: 'raidz1' },
  raidz2: { min: 4, vdev: 'raidz2' },
};

/** Properties every new pool gets: 4K sectors, cheap compression, no atime writes, Samba-friendly xattrs and ACLs. */
const POOL_PROPS = ['-o', 'ashift=12', '-O', 'compression=lz4', '-O', 'atime=off', '-O', 'xattr=sa', '-O', 'acltype=posixacl', '-O', 'normalization=formD'];

export function confirmed(confirm: unknown, name: string): void {
  if (confirm !== name) throw new BadArgs(`type the name "${name}" to confirm`);
}

export function layoutOf(v: unknown): PoolLayout {
  if (typeof v !== 'string' || !(v in LAYOUTS)) throw new BadArgs('layout must be single, mirror, raidz1 or raidz2');
  return v as PoolLayout;
}

export function quotaOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || v === 0) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1024 * 1024) throw new BadArgs('quota must be a whole number of bytes (at least 1 MiB) or null');
  return v;
}

export function compressionOf(v: unknown): DatasetSetArgs['compression'] {
  if (typeof v !== 'string' || !COMPRESSIONS.includes(v as never)) throw new BadArgs(`compression must be one of ${COMPRESSIONS.join(', ')}`);
  return v as DatasetSetArgs['compression'];
}

export function boolOf(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new BadArgs(`${what} must be true or false`);
  return v;
}

/** What a disk may be used for: 'foreign' is a ZFS label no pool imported here uses — not free, but wipeable. */
type Use = Exclude<Disk['use']['kind'], 'pool'> | 'pool' | 'foreign';

const useOfDisk = (d: Disk): Use => (d.use.kind === 'pool' && d.use.imported === false ? 'foreign' : d.use.kind);

async function freeDisk(run: Runner, id: string, byIdDir: string | undefined, allow: Use[]): Promise<Disk> {
  const disks = await listDisks(run, byIdDir);
  const d = disks.find((x) => x.id === id || x.ids.includes(id));
  if (!d) throw new BadArgs(`${id}: no such disk`);
  const use = useOfDisk(d);
  if (!allow.includes(use)) {
    const why =
      use === 'pool'
        ? `it belongs to pool ${(d.use as { pool: string }).pool}`
        : use === 'foreign'
          ? `it carries the pool ${(d.use as { pool: string }).pool} from another system; wipe it first, or import that pool to keep its data`
          : use === 'os'
            ? 'it holds the operating system'
            : `it carries ${(d.use as { what: string }).what}`;
    throw new BadArgs(`${id}: ${why}`);
  }
  return d;
}

export async function createPool(run: Runner, a: PoolCreateArgs, byIdDir?: string): Promise<Pool> {
  const name = poolName(a.name, 'name');
  confirmed(a.confirm, name);
  const layout = layoutOf(a.layout);
  if (!Array.isArray(a.disks) || a.disks.length === 0) throw new BadArgs('disks must be a list of disk ids');
  const ids = a.disks.map((d) => diskId(d));
  if (new Set(ids).size !== ids.length) throw new BadArgs('the same disk is listed twice');
  const { min, vdev } = LAYOUTS[layout];
  if (ids.length < min) throw new BadArgs(`${layout} needs at least ${min} disk${min > 1 ? 's' : ''}`);
  if (layout === 'single' && ids.length !== 1) throw new BadArgs('single takes exactly one disk');
  const paths: string[] = [];
  for (const id of ids) {
    await freeDisk(run, id, byIdDir, ['free']);
    await resolveDisk(id, byIdDir);
    paths.push(join(byIdDir ?? '/dev/disk/by-id', id));
  }
  await must(run, ['zpool', 'create', ...POOL_PROPS, '-m', `/${name}`, name, ...(vdev ? [vdev] : []), ...paths]);
  return getPool(run, name);
}

/** What zpool status calls a member: a by-id name, a guid, or a kernel name; never an option. */
export function memberName(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,254}$/.test(v) || v.includes('..')) throw new BadArgs('old: not a pool member name');
  return v;
}

export async function replaceDisk(run: Runner, a: { pool: unknown; old: unknown; disk: unknown; confirm: unknown }, byIdDir?: string): Promise<Pool> {
  const pool = poolName(a.pool);
  confirmed(a.confirm, pool);
  const old = memberName(a.old);
  const id = diskId(a.disk, 'disk');
  await freeDisk(run, id, byIdDir, ['free']);
  await resolveDisk(id, byIdDir);
  await must(run, ['zpool', 'replace', pool, old, join(byIdDir ?? '/dev/disk/by-id', id)]);
  return getPool(run, pool);
}

export async function importPool(run: Runner, pool: unknown): Promise<Pool> {
  const name = poolName(pool);
  const here = await listPools(run);
  if (here.some((p) => p.name === name)) throw new BadArgs(`${name}: a pool of that name is already here`);
  await must(run, ['zpool', 'import', name], { timeout: 300_000 });
  return getPool(run, name);
}

export async function scrubPool(run: Runner, pool: unknown): Promise<{ started: true }> {
  await must(run, ['zpool', 'scrub', poolName(pool)]);
  return { started: true };
}

/**
 * Makes a disk free: never one a pool imported here uses, never the OS disk. ZFS labels are cleared first with
 * `zpool labelclear` (which itself refuses a member of an active pool), because a label left inside a partition
 * survives a wiped partition table and shows up again in `zpool import`; then every partition's signatures, then the
 * disk's own (its partition table), and udev is given the time to forget the partitions.
 */
export async function wipeDisk(run: Runner, disk: unknown, confirm: unknown, byIdDir?: string): Promise<Disk> {
  const id = diskId(disk);
  confirmed(confirm, id);
  await freeDisk(run, id, byIdDir, ['free', 'other', 'foreign']);
  const dev = await resolveDisk(id, byIdDir);
  const layout = parseLsblk(await must(run, [...LSBLK_ARGV, dev])).find((x) => x.path === dev);
  const parts = layout?.children ?? [];
  for (const p of [layout, ...parts]) {
    if (p?.fstype === 'zfs_member') await must(run, ['zpool', 'labelclear', '-f', p.path]);
  }
  for (const p of parts) await must(run, ['wipefs', '-a', p.path]);
  await must(run, ['wipefs', '-a', dev]);
  await run(['udevadm', 'settle', '--timeout=10']);
  return freeDisk(run, id, byIdDir, ['free', 'other']);
}

async function datasetByName(run: Runner, name: string): Promise<Dataset> {
  const [d] = await listDatasets(run, name);
  if (!d || d.name !== name) throw new BadArgs(`${name}: no such dataset`);
  return d;
}

export async function createDataset(run: Runner, a: DatasetCreateArgs, locationsDir: string, owner = { uid: 1000, gid: 1000 }): Promise<Dataset> {
  const name = datasetName(a.name, 'name');
  if (!name.includes('/')) throw new BadArgs('name must be pool/dataset');
  const props: string[] = [];
  if (a.quota !== undefined) {
    const q = quotaOf(a.quota);
    if (q !== null) props.push('-o', `quota=${q}`);
  }
  if (a.compression !== undefined) props.push('-o', `compression=${compressionOf(a.compression)}`);
  if (a.atime !== undefined) props.push('-o', `atime=${boolOf(a.atime, 'atime') ? 'on' : 'off'}`);
  const location = a.location === undefined ? false : boolOf(a.location, 'location');
  const mountpoint = location ? join(locationsDir, basename(name)) : null;
  if (mountpoint) {
    // a location is named by the last component alone: pool/a/x and pool/b/x would mount one over the other
    const taken = (await listDatasets(run)).find((d) => d.mountpoint === mountpoint);
    if (taken) throw new BadArgs(`${taken.name} is already the location "${basename(name)}"; pick another name`);
    props.push('-o', `mountpoint=${mountpoint}`);
  }
  await must(run, ['zfs', 'create', ...props, name]);
  // the dataset is the container's to write from the first second: owned by the user it runs as (DRIVE_UID/DRIVE_GID in the stack's .env)
  if (mountpoint) await must(run, ['chown', `${owner.uid}:${owner.gid}`, mountpoint]);
  return datasetByName(run, name);
}

export async function setDataset(run: Runner, a: DatasetSetArgs): Promise<Dataset> {
  const name = datasetName(a.dataset);
  const props: string[] = [];
  if (a.quota !== undefined) props.push(`quota=${quotaOf(a.quota) ?? 'none'}`);
  if (a.compression !== undefined) props.push(`compression=${compressionOf(a.compression)}`);
  if (a.atime !== undefined) props.push(`atime=${boolOf(a.atime, 'atime') ? 'on' : 'off'}`);
  if (props.length === 0) throw new BadArgs('nothing to set');
  await must(run, ['zfs', 'set', ...props, name]);
  return datasetByName(run, name);
}

/**
 * Gone for good, so every reason to stop is checked first: the name typed, no
 * children, no share, no copy job, and its snapshots only when the caller said
 * so. Never -r: the snapshots go as one comma list, then the dataset alone.
 */
export async function destroyDataset(
  run: Runner,
  db: Db,
  a: DatasetDestroyArgs,
  locationsDir: string,
): Promise<{ destroyed: string; snapshots: number; location: string | null }> {
  const name = datasetName(a.dataset);
  if (!name.includes('/')) throw new BadArgs('a pool cannot be destroyed');
  confirmed(a.confirm, name);
  const withSnapshots = a.snapshots === undefined ? false : boolOf(a.snapshots, 'snapshots');
  const [ds, ...children] = await listDatasets(run, name);
  if (!ds || ds.name !== name) throw new BadArgs(`${name}: no such dataset`);
  if (children.length) throw new BadArgs(`${name} has children (${children.map((c) => c.name.slice(name.length + 1)).join(', ')}); destroy them first`);
  if (db.share(name)) throw new BadArgs(`${name} is shared over the network; remove the share first`);
  const copy = db.replications().find((r) => r.dataset === name);
  if (copy) throw new BadArgs(`${name} is copied to ${copy.user}@${copy.host} (replication ${copy.id}); remove the replication first`);
  const snaps = await listSnapshots(run, name);
  if (snaps.length && !withSnapshots) throw new BadArgs(`${name} has ${snaps.length} snapshot${snaps.length > 1 ? 's' : ''}; say so to destroy them with it`);
  if (snaps.length) await must(run, ['zfs', 'destroy', `${name}@${snaps.map((s) => s.snapshot).join(',')}`]);
  await must(run, ['zfs', 'destroy', name]);
  db.setPolicy({ dataset: name, hourly: 0, daily: 0, weekly: 0, monthly: 0 });
  // a location's mountpoint was set by hand, so zfs leaves the (now empty) directory behind and the drive would keep listing it
  const location = ds.mountpoint && dirname(ds.mountpoint) === locationsDir ? basename(ds.mountpoint) : null;
  if (location) await rmdir(ds.mountpoint!).catch(() => {});
  return { destroyed: name, snapshots: snaps.length, location };
}

export async function createSnapshot(run: Runner, dataset: unknown, name: unknown, now = new Date()): Promise<Snapshot> {
  const ds = datasetName(dataset);
  const snap = name === undefined || name === null || name === '' ? `manual-${stamp(now)}` : snapshotName(`${ds}@${String(name)}`, 'name').slice(ds.length + 1);
  const full = `${ds}@${snap}`;
  await must(run, ['zfs', 'snapshot', full]);
  const list = await listSnapshots(run, ds);
  const made = list.find((s) => s.name === full);
  if (!made) throw new Error(`${full} was created but is not listed`);
  return made;
}

export async function destroySnapshot(run: Runner, snapshot: unknown, confirm: unknown): Promise<{ destroyed: string }> {
  const full = snapshotName(snapshot);
  confirmed(confirm, full);
  // only ever a snapshot, never a dataset, never recursive: the name has '@' by construction and there is no -r
  await must(run, ['zfs', 'destroy', full]);
  return { destroyed: full };
}

/**
 * Back to a snapshot, the way ZFS does it: only to the newest snapshot of the dataset, and every change made since
 * is gone — the typed name is the whole guard. Newer snapshots are named in the refusal; they are destroyed one by
 * one by the person, never with -r here. (Before 0.4.1 a "before-rollback" snapshot was taken first, which was itself
 * newer than the target, so ZFS refused every rollback.) Getting single files back without losing anything is the
 * drive's file versions, from the same snapshots.
 */
export async function rollbackSnapshot(run: Runner, snapshot: unknown, confirm: unknown): Promise<{ rolledBackTo: string }> {
  const full = snapshotName(snapshot);
  confirmed(confirm, full);
  const ds = full.slice(0, full.indexOf('@'));
  const own = (await listSnapshots(run, ds)).filter((s) => s.dataset === ds);
  const at = own.findIndex((s) => s.name === full);
  if (at < 0) throw new BadArgs(`${full}: no such snapshot`);
  const newer = own.slice(at + 1).map((s) => s.snapshot);
  if (newer.length)
    throw new BadArgs(
      `${ds} has ${newer.length} newer snapshot${newer.length > 1 ? 's' : ''} (${newer.slice(-5).join(', ')}${newer.length > 5 ? ', …' : ''}); destroy ${newer.length > 1 ? 'them' : 'it'} first to roll back to ${full.slice(ds.length + 1)}`,
    );
  // no -r: should a snapshot appear in between, zfs refuses rather than destroy it
  await must(run, ['zfs', 'rollback', full]);
  return { rolledBackTo: full };
}
