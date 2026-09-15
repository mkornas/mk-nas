/**
 * Disks by stable id. lsblk gives the block devices, /dev/disk/by-id gives
 * the names the verbs take, smartctl gives health. A disk that carries a
 * ZFS label (or whose partition does) is reported as used by that pool, and as
 * imported only when ZFS says a pool imported here uses it: a label from another
 * machine (an old TrueNAS pool, a disk replaced out) is not in use and may be wiped.
 */
import { readdir, readlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Disk, SelfTest, SelfTestKind, Smart, SmartSummary } from '../../shared/types.ts';
import { BadArgs } from './names.ts';
import { must, type Runner } from './run.ts';

export interface Lsblk {
  name: string;
  path: string;
  size: number | string;
  model: string | null;
  serial: string | null;
  rota: boolean | string;
  type: string;
  tran: string | null;
  mountpoint: string | null;
  fstype: string | null;
  label: string | null;
  children?: Lsblk[];
}

export const LSBLK_ARGV = ['lsblk', '-J', '-b', '-o', 'NAME,PATH,SIZE,MODEL,SERIAL,ROTA,TYPE,TRAN,MOUNTPOINT,FSTYPE,LABEL'];

/** Only whole disks; skips loop, ram, zram, zd (zvols) and the like. */
export function parseLsblk(json: string): Lsblk[] {
  const parsed = JSON.parse(json) as { blockdevices: Lsblk[] };
  return parsed.blockdevices.filter((d) => d.type === 'disk' && !/^(loop|ram|zram|zd|dm-|md|sr|fd)/.test(d.name));
}

/** Prefers a model+serial id (ata-, nvme-, scsi-) over wwn- and eui- ones, which people cannot read. */
export function pickId(ids: string[]): string {
  const readable = ids.filter((i) => !/^(wwn-|nvme-eui\.|scsi-[0-9a-f]{16,})/.test(i) && !/-part\d+$/.test(i));
  return (readable.sort((a, b) => a.length - b.length)[0] ?? ids[0]) as string;
}

/** dev path (/dev/sda) → all by-id link names for it (not partitions). */
export async function byIdMap(dir = '/dev/disk/by-id'): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return map;
  }
  for (const name of names) {
    if (/-part\d+$/.test(name)) continue;
    try {
      const target = resolve(dir, await readlink(`${dir}/${name}`));
      map.set(target, [...(map.get(target) ?? []), name]);
    } catch {
      /* not a link */
    }
  }
  return map;
}

/** The whole-disk device a by-id name points at; refuses a partition or anything outside /dev. */
export async function resolveDisk(id: string, dir = '/dev/disk/by-id'): Promise<string> {
  if (/-part\d+$/.test(id)) throw new BadArgs(`${id}: a partition, not a disk`);
  let target: string;
  try {
    target = resolve(dir, await readlink(`${dir}/${id}`));
  } catch {
    throw new BadArgs(`${id}: no such disk`);
  }
  if (!/^\/dev\/[a-z0-9]+$/.test(target)) throw new BadArgs(`${id}: not a whole disk`);
  return target;
}

/** A device path as the kernel names it: /dev/disk/by-id/…-part1 → /dev/sda1; a path that is not a link stays as it is. */
async function kernelPath(p: string): Promise<string> {
  try {
    return resolve(dirname(p), await readlink(p));
  } catch {
    return p;
  }
}

/**
 * Every device a pool imported on this box uses, by kernel path (/dev/sda1): the leaves of `zpool list -v -P`, spares,
 * logs and caches included. The label's pool name is not trusted for this — a disk replaced out keeps its old label,
 * and a foreign pool may share a name with one imported here. No zfs, or no pool, is an empty set.
 */
export async function poolMembers(run: Runner): Promise<Set<string>> {
  const r = await run(['zpool', 'list', '-v', '-H', '-P']);
  const out = new Set<string>();
  if (r.exitCode !== 0) return out;
  for (const line of r.stdout.split('\n')) {
    const m = /^\t(\/[^\t]+)\t/.exec(line);
    if (m) out.add(await kernelPath(m[1]));
  }
  return out;
}

export function useOf(d: Lsblk, members: Set<string> = new Set()): Disk['use'] {
  const all = [d, ...(d.children ?? [])];
  const zfs = all.find((p) => p.fstype === 'zfs_member');
  if (zfs) return { kind: 'pool', pool: zfs.label ?? '?', imported: all.some((p) => members.has(p.path)) };
  if (all.some((p) => p.mountpoint === '/' || p.mountpoint === '/boot' || p.mountpoint === '/boot/efi' || p.mountpoint === '[SWAP]')) return { kind: 'os' };
  const other = all.find((p) => p.fstype || p.mountpoint);
  if (other) return { kind: 'other', what: other.fstype ?? other.mountpoint ?? '?' };
  return { kind: 'free' };
}

export function summarizeSmart(raw: unknown): SmartSummary {
  const j = (raw ?? {}) as Record<string, any>;
  const attr = (id: number): number | null => {
    const t = j.ata_smart_attributes?.table as { id: number; raw: { value: number } }[] | undefined;
    const a = t?.find((x) => x.id === id);
    return a ? a.raw.value : null;
  };
  const nvme = j.nvme_smart_health_information_log as Record<string, number> | undefined;
  return {
    passed: typeof j.smart_status?.passed === 'boolean' ? j.smart_status.passed : null,
    temperature: typeof j.temperature?.current === 'number' ? j.temperature.current : null,
    powerOnHours: typeof j.power_on_time?.hours === 'number' ? j.power_on_time.hours : null,
    reallocated: attr(5),
    pending: attr(197),
    wear: typeof nvme?.percentage_used === 'number' ? nvme.percentage_used : null,
  };
}

export const smartArgv = (dev: string) => ['smartctl', '-j', '-H', '-A', '-i', dev];
/** The detail view adds the self-test status and log. */
export const smartDetailArgv = (dev: string) => ['smartctl', '-j', '-H', '-A', '-i', '-c', '-l', 'selftest', dev];
/** The timer's read: a disk in standby is left asleep (smartctl exits 2 and gives no JSON). */
export const smartQuietArgv = (dev: string) => ['smartctl', '-j', '-n', 'standby', '-c', '-l', 'selftest', dev];

const kindOf = (s: string | undefined): SelfTestKind => (/extended|long/i.test(s ?? '') ? 'long' : /short/i.test(s ?? '') ? 'short' : 'other');

/** Self-tests as smartctl reports them: ATA from the self-test status and log, NVMe from its self-test log. Newest first. */
export function parseSelfTests(raw: unknown): Smart['selfTest'] {
  const j = (raw ?? {}) as Record<string, any>;
  const ata = j.ata_smart_data?.self_test?.status as { string?: string; remaining_percent?: number } | undefined;
  const nvme = j.nvme_self_test_log as
    | { current_self_test_operation?: { value?: number; string?: string }; current_self_test_completion_percent?: number; table?: Record<string, any>[] }
    | undefined;
  let running: Smart['selfTest']['running'] = null;
  if (ata && typeof ata.remaining_percent === 'number')
    running = { kind: kindOf(ata.string) === 'other' ? 'long' : kindOf(ata.string), percentDone: 100 - ata.remaining_percent };
  else if (nvme?.current_self_test_operation?.value)
    running = { kind: kindOf(nvme.current_self_test_operation.string), percentDone: nvme.current_self_test_completion_percent ?? null };
  const tests: SelfTest[] = [];
  for (const t of (j.ata_smart_self_test_log?.standard?.table ?? []) as Record<string, any>[])
    tests.push({
      kind: kindOf(t.type?.string),
      passed: typeof t.status?.passed === 'boolean' ? t.status.passed : null,
      result: t.status?.string ?? '?',
      hours: t.lifetime_hours ?? null,
    });
  for (const t of nvme?.table ?? [])
    tests.push({
      kind: kindOf(t.self_test_code?.string),
      passed: t.self_test_result?.value === 0 ? true : typeof t.self_test_result?.value === 'number' ? false : null,
      result: t.self_test_result?.string ?? '?',
      hours: t.power_on_hours ?? null,
    });
  return { running, tests };
}

/** The timer's rule: a long test is due when none finished in the last 720 hours of power-on time (about a month of an always-on box) and none runs. */
export function longTestDue(raw: unknown): boolean {
  const j = (raw ?? {}) as Record<string, any>;
  const { running, tests } = parseSelfTests(raw);
  if (running) return false;
  const hours = typeof j.power_on_time?.hours === 'number' ? j.power_on_time.hours : null;
  const last = tests.find((t) => t.kind === 'long' && t.hours !== null);
  if (!last || hours === null) return true;
  return hours - last.hours! >= 720;
}

/** smartctl exits non-zero for many non-fatal reasons; only bits 0 (bad command line) and 1 (device open failed) mean no JSON. */
export async function readSmart(run: Runner, dev: string, argv = smartArgv(dev)): Promise<unknown | null> {
  const r = await run(argv);
  if (r.exitCode === null || (r.exitCode & 0b11) !== 0 || !r.stdout.trim()) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

export async function listDisks(run: Runner, byIdDir?: string): Promise<Disk[]> {
  const [devices, ids, members] = await Promise.all([parseLsblk(await must(run, LSBLK_ARGV)), byIdMap(byIdDir), poolMembers(run)]);
  return Promise.all(
    devices.map(async (d) => {
      const links = ids.get(d.path) ?? [];
      const raw = await readSmart(run, d.path);
      return {
        id: links.length ? pickId(links) : d.path,
        ids: links,
        dev: d.path,
        size: Number(d.size),
        model: d.model?.trim() || null,
        serial: d.serial?.trim() || null,
        transport: d.tran || null,
        rotational: d.rota === true || d.rota === '1',
        use: useOf(d, members),
        smart: raw ? summarizeSmart(raw) : null,
      };
    }),
  );
}

export async function getSmart(run: Runner, id: string, byIdDir?: string): Promise<Smart> {
  const dev = await resolveDisk(id, byIdDir);
  const raw = (await readSmart(run, dev, smartDetailArgv(dev))) as Record<string, any> | null;
  if (!raw) throw new BadArgs(`${id}: smartctl gave no data`);
  return {
    id,
    model: raw.model_name ?? null,
    serial: raw.serial_number ?? null,
    firmware: raw.firmware_version ?? null,
    ...summarizeSmart(raw),
    selfTest: parseSelfTests(raw),
    raw,
  };
}

export function selfTestKind(v: unknown): 'short' | 'long' {
  if (v !== 'short' && v !== 'long') throw new BadArgs('kind must be short or long');
  return v;
}

/** Starts a self-test; the disk runs it on its own and the smart verb shows it going and, later, in the log. */
export async function startSelfTest(run: Runner, id: string, kind: unknown, byIdDir?: string): Promise<Smart> {
  const k = selfTestKind(kind);
  const dev = await resolveDisk(id, byIdDir);
  const before = await getSmart(run, id, byIdDir);
  if (before.selfTest.running) throw new BadArgs(`${id}: a ${before.selfTest.running.kind} test is already running`);
  await must(run, ['smartctl', '-j', '-t', k, dev]);
  return getSmart(run, id, byIdDir);
}

export async function smartctlVersion(run: Runner): Promise<string | null> {
  const r = await run(['smartctl', '-V']);
  if (r.exitCode !== 0) return null;
  return /smartctl ([\d.]+)/.exec(r.stdout)?.[1] ?? null;
}
