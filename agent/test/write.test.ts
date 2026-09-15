/** The write verbs against a fake runner: the exact argv, the refusals, the look-before-leap checks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.ts';
import type { ShareConfig } from '../src/shares.ts';
const REPL = { keyFile: '/tmp/never-written.key', knownHosts: '/tmp/never-written.known_hosts' };
const NOSPAWN = () => {};
const NET = {
  netplanFile: '/tmp/never-written.yaml',
  pendingFile: '/tmp/never-written.json',
  hostsFile: '/tmp/never-written.hosts',
  resolvConf: '/tmp/never-written.resolv',
  sysNet: '/tmp/never-written.sys',
};
const BKP = {
  db: '/tmp/never-written.db',
  sshKey: '/tmp/never-written.key',
  knownHosts: '/tmp/never-written.known_hosts',
  netplanFile: '/tmp/never-written.yaml',
  driveEnv: '/tmp/never-written.env',
  driveDb: '/tmp/never-written-drive.db',
};

const SHARES: ShareConfig = {
  smbConf: '/tmp/never-written.conf',
  exportsFile: '/tmp/never-written.exports',
  smbGroup: 'mk-nas-smb',
  ownerUid: 1000,
  ownerGid: 1000,
  hostname: 'test',
};
import type { Runner, RunResult } from '../src/run.ts';
import { handle } from '../src/server.ts';
import type { Deps } from '../src/verbs.ts';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const LSBLK = 'lsblk -J -b -o NAME,PATH,SIZE,MODEL,SERIAL,ROTA,TYPE,TRAN,MOUNTPOINT,FSTYPE,LABEL';
const POOLS = 'zpool list -H -p -o name,health,size,allocated,free,capacity,fragmentation';
const DS =
  'zfs list -H -p -t filesystem,volume -o name,type,used,avail,refer,mountpoint,mounted,quota,compression,compressratio,atime,recordsize,creation -s name';
const SNAPS = 'zfs list -H -p -t snapshot -o name,used,refer,creation -s creation';
const A = 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA';
const B = 'ata-WDC_WD20EFRX-68EUZN0_WD-BBBBBBBBBBBB';
const audit = async () => {};

function fake(table: Record<string, string | RunResult | ((argv: string[]) => string | RunResult)>): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    const key = argv.join(' ');
    let hit: (typeof table)[string] | undefined = table[key];
    if (hit === undefined) {
      const prefix = Object.keys(table).find((k) => k.endsWith('*') && key.startsWith(k.slice(0, -1)));
      if (prefix) hit = table[prefix];
    }
    if (typeof hit === 'function') hit = hit(argv);
    if (hit === undefined) return { argv, exitCode: 1, stdout: '', stderr: `fake: no such command: ${key}` };
    return typeof hit === 'string' ? { argv, exitCode: 0, stdout: hit, stderr: '' } : { ...hit, argv };
  };
  return { run, calls };
}

/** lsblk where sdb (B) is free, sda (A) carries a tank label, nvme is the OS. */
const disksTable = { [LSBLK]: fx('lsblk.json'), 'smartctl *': { argv: [], exitCode: 2, stdout: '', stderr: '' } };
/** zpool list -v -H -P for a tank imported here whose member is A's partition (by-id path inside the test's dir). */
const tankUses = (dir: string) =>
  `tank\t1.8T\t1M\t1.8T\t-\t-\t0%\t0%\t1.00x\tONLINE\t-\n\tmirror-0\t1.8T\t1M\t1.8T\t-\t-\t0%\t0%\t-\tONLINE\n\t${join(dir, `${A}-part1`)}\t1.8T\t-\t-\t-\t-\t-\t-\t-\tONLINE\n`;

async function byIdDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-byid-'));
  await symlink('/dev/sda', join(dir, A));
  await symlink('/dev/sda1', join(dir, `${A}-part1`));
  await symlink('/dev/sdb', join(dir, B));
  await symlink('/dev/nvme0n1', join(dir, 'nvme-Samsung_SSD_970_EVO_250GB_S4EWNX0N000000'));
  return dir;
}
const deps = (run: Runner, extra: Partial<Deps> = {}): Deps => ({
  run,
  version: 't',
  db: new Db(':memory:'),
  locationsDir: '/srv/locations',
  shares: SHARES,
  replication: REPL,
  spawn: NOSPAWN,
  network: NET,
  backup: BKP,
  ...extra,
});

test('pool.create: needs the name typed, free disks, enough of them; then one zpool create', async () => {
  const dir = await byIdDir();
  try {
    const f = fake({
      ...disksTable,
      'zpool list -v -H -P': tankUses(dir),
      [`zpool create -o ashift=12 -O compression=lz4 -O atime=off -O xattr=sa -O acltype=posixacl -O normalization=formD -m /tank2 tank2 ${dir}/${B}`]: '',
      [`${POOLS} tank2`]: 'tank2\tONLINE\t100\t1\t99\t1\t0\n',
      'zpool status tank2': fx('zpool-status-mirror.txt'),
    });
    const d = deps(f.run, { byIdDir: dir });
    const refused = async (args: Record<string, unknown>, re: RegExp) => {
      const res = await handle({ id: 1, verb: 'pool.create', args }, d, audit);
      assert.equal(!res.ok && res.error.code, 'bad-args', JSON.stringify(args));
      assert.match(!res.ok ? res.error.message : '', re);
    };
    await refused({ name: 'tank2', layout: 'single', disks: [B], confirm: 'tank' }, /type the name/);
    await refused({ name: 'tank2', layout: 'mirror', disks: [B], confirm: 'tank2' }, /mirror needs at least 2/);
    await refused({ name: 'tank2', layout: 'mirror', disks: [B, B], confirm: 'tank2' }, /listed twice/);
    await refused({ name: 'tank2', layout: 'raidz9', disks: [B], confirm: 'tank2' }, /layout must be/);
    await refused({ name: 'tank2', layout: 'single', disks: [A], confirm: 'tank2' }, /belongs to pool tank/);
    await refused({ name: 'tank2', layout: 'single', disks: ['nvme-Samsung_SSD_970_EVO_250GB_S4EWNX0N000000'], confirm: 'tank2' }, /operating system/);
    await refused({ name: 'tank2', layout: 'single', disks: ['/dev/sdb'], confirm: 'tank2' }, /not a disk id/);
    await refused({ name: 'tank2', layout: 'single', disks: [B], confirm: 'tank2', force: true }, /unexpected argument/);
    assert.ok(!f.calls.some((c) => c[0] === 'zpool' && c[1] === 'create'), 'nothing was created by a refused call');

    const res = await handle({ id: 1, verb: 'pool.create', args: { name: 'tank2', layout: 'single', disks: [B], confirm: 'tank2' } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    const create = f.calls.find((c) => c[0] === 'zpool' && c[1] === 'create')!;
    assert.deepEqual(create.slice(-2), ['tank2', `${dir}/${B}`]);
    assert.ok(!create.includes('-f'), 'never forced');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pool.create: mirror puts the vdev word before the disks', async () => {
  const dir = await byIdDir();
  try {
    const lsblk = JSON.parse(fx('lsblk.json'));
    lsblk.blockdevices[1].children = undefined; // sda is free too now
    const f = fake({
      [LSBLK]: JSON.stringify(lsblk),
      'smartctl *': { argv: [], exitCode: 2, stdout: '', stderr: '' },
      'zpool create *': '',
      [`${POOLS} tank`]: 'tank\tONLINE\t1\t1\t0\t0\t0\n',
      'zpool status tank': fx('zpool-status-mirror.txt'),
    });
    const res = await handle(
      { id: 1, verb: 'pool.create', args: { name: 'tank', layout: 'mirror', disks: [A, B], confirm: 'tank' } },
      deps(f.run, { byIdDir: dir }),
      audit,
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    const create = f.calls.find((c) => c[0] === 'zpool' && c[1] === 'create')!;
    assert.deepEqual(create.slice(-4), ['tank', 'mirror', `${dir}/${A}`, `${dir}/${B}`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disk.wipe: never a member of an imported pool; a free disk, or a foreign pool's disk with its labels cleared first", async () => {
  const dir = await byIdDir();
  try {
    let imported = true;
    let wiped = false;
    const lsblk = JSON.parse(fx('lsblk.json'));
    const sdaWiped = { ...lsblk.blockdevices[1], children: undefined };
    const f = fake({
      ...disksTable,
      [LSBLK]: () => JSON.stringify({ ...lsblk, blockdevices: lsblk.blockdevices.map((b: { name: string }) => (wiped && b.name === 'sda' ? sdaWiped : b)) }),
      'zpool list -v -H -P': () => (imported ? tankUses(dir) : ''),
      [`${LSBLK} /dev/sda`]: () => JSON.stringify({ blockdevices: [wiped ? sdaWiped : lsblk.blockdevices[1]] }),
      [`${LSBLK} /dev/sdb`]: JSON.stringify({ blockdevices: [lsblk.blockdevices[2]] }),
      'zpool labelclear -f /dev/sda1': '',
      'wipefs -a /dev/sda1': '',
      'wipefs -a /dev/sda': () => ((wiped = true), ''),
      'wipefs -a /dev/sdb': '',
      'udevadm settle --timeout=10': '',
    });
    const d = deps(f.run, { byIdDir: dir });
    let res = await handle({ id: 1, verb: 'disk.wipe', args: { disk: A, confirm: A } }, d, audit);
    assert.match(!res.ok ? res.error.message : '', /belongs to pool tank/, 'a disk the imported tank uses');
    assert.ok(!f.calls.some((c) => c[0] === 'wipefs' || c[1] === 'labelclear'));
    res = await handle({ id: 2, verb: 'disk.wipe', args: { disk: B, confirm: 'B' } }, d, audit);
    assert.match(!res.ok ? res.error.message : '', /type the name/);
    res = await handle({ id: 3, verb: 'disk.wipe', args: { disk: B, confirm: B } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(f.calls.some((c) => c.join(' ') === 'wipefs -a /dev/sdb'));

    // the same label, but no pool here uses the disk: an old pool from another system (TrueNAS, a disk replaced out)
    imported = false;
    res = await handle({ id: 4, verb: 'pool.create', args: { name: 'tank2', layout: 'single', disks: [A], confirm: 'tank2' } }, d, audit);
    assert.match(!res.ok ? res.error.message : '', /carries the pool tank from another system; wipe it first/);
    f.calls.length = 0;
    res = await handle({ id: 5, verb: 'disk.wipe', args: { disk: A, confirm: A } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.ok && (res.result as { use: unknown }).use, { kind: 'free' });
    assert.deepEqual(
      f.calls.filter((c) => ['zpool', 'wipefs'].includes(c[0]) && c[1] !== 'list').map((c) => c.join(' ')),
      ['zpool labelclear -f /dev/sda1', 'wipefs -a /dev/sda1', 'wipefs -a /dev/sda'],
      'the ZFS label first, then the partition, then the partition table',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dataset.create: properties become -o pairs; a location gets the mountpoint and the chown', async () => {
  const row = (name: string, mp: string) => `${name}\tfilesystem\t0\t100\t0\t${mp}\tyes\t0\tlz4\t1.00x\toff\t131072\t1757600000\n`;
  const f = fake({
    'zfs create -o quota=1073741824 -o compression=zstd -o atime=off tank/docs': '',
    [`${DS} -r tank/docs`]: row('tank/docs', '/tank/docs'),
    'zfs create -o mountpoint=/srv/locations/photos tank/photos': '',
    'chown 1000:1000 /srv/locations/photos': '',
    [`${DS} -r tank/photos`]: row('tank/photos', '/srv/locations/photos'),
  });
  const d = deps(f.run);
  let res = await handle({ id: 1, verb: 'dataset.create', args: { name: 'tank/docs', quota: 1073741824, compression: 'zstd', atime: false } }, d, audit);
  assert.equal(res.ok, true, JSON.stringify(res));
  res = await handle({ id: 2, verb: 'dataset.create', args: { name: 'tank/photos', location: true } }, d, audit);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.ok && (res.result as { mountpoint: string }).mountpoint, '/srv/locations/photos');
  for (const [args, re] of [
    [{ name: 'tank' }, /pool\/dataset/],
    [{ name: 'tank/x', quota: 12 }, /quota must be/],
    [{ name: 'tank/x', compression: 'lzma' }, /compression must be/],
    [{ name: 'tank/x', atime: 'yes' }, /atime must be/],
    [{ name: 'tank/-x' }, /not a dataset name/],
  ] as [Record<string, unknown>, RegExp][]) {
    const r = await handle({ id: 3, verb: 'dataset.create', args }, d, audit);
    assert.match(!r.ok ? r.error.message : 'ok', re, JSON.stringify(args));
  }
  assert.equal(f.calls.filter((c) => c[0] === 'zfs' && c[1] === 'create').length, 2);
});

test('dataset.set: one zfs set with every changed property; quota null clears it', async () => {
  const f = fake({
    'zfs set quota=none compression=lz4 atime=on tank/docs': '',
    [`${DS} -r tank/docs`]: 'tank/docs\tfilesystem\t0\t100\t0\t/tank/docs\tyes\t0\tlz4\t1.00x\ton\t131072\t1757600000\n',
  });
  const d = deps(f.run);
  const res = await handle({ id: 1, verb: 'dataset.set', args: { dataset: 'tank/docs', quota: null, compression: 'lz4', atime: true } }, d, audit);
  assert.equal(res.ok, true, JSON.stringify(res));
  const empty = await handle({ id: 2, verb: 'dataset.set', args: { dataset: 'tank/docs' } }, d, audit);
  assert.match(!empty.ok ? empty.error.message : '', /nothing to set/);
});

test('snapshots: create names by the clock, destroy and rollback need the full name typed; rollback only to the newest, never -r, nothing taken first', async () => {
  let listing = `tank/docs@old\t0\t0\t1757600000\ntank/docs@nightly\t0\t0\t1757600100\ntank/docs/child@later\t0\t0\t1757600200\n`;
  const f = fake({
    'zfs snapshot *': '',
    'zfs destroy tank/docs@old': '',
    'zfs rollback tank/docs@nightly': '',
    [`${SNAPS} -r tank/docs`]: () => listing,
  });
  const d = deps(f.run);
  let res = await handle({ id: 1, verb: 'snapshot.create', args: { dataset: 'tank/docs', name: 'nightly' } }, d, audit);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.ok && (res.result as { name: string }).name, 'tank/docs@nightly');
  assert.deepEqual(f.calls[0], ['zfs', 'snapshot', 'tank/docs@nightly']);

  res = await handle({ id: 2, verb: 'snapshot.destroy', args: { snapshot: 'tank/docs', confirm: 'tank/docs' } }, d, audit);
  assert.equal(!res.ok && res.error.code, 'bad-args', 'a dataset is not a snapshot');
  res = await handle({ id: 3, verb: 'snapshot.destroy', args: { snapshot: 'tank/docs@old', confirm: 'old' } }, d, audit);
  assert.match(!res.ok ? res.error.message : '', /type the name/);
  res = await handle({ id: 4, verb: 'snapshot.destroy', args: { snapshot: 'tank/docs@old', confirm: 'tank/docs@old' } }, d, audit);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(
    f.calls.filter((c) => c[1] === 'destroy').every((c) => !c.includes('-r')),
    'never recursive',
  );

  f.calls.length = 0;
  res = await handle({ id: 5, verb: 'snapshot.rollback', args: { snapshot: 'tank/docs@old', confirm: 'tank/docs@old' } }, d, audit);
  assert.match(
    !res.ok ? res.error.message : '',
    /has 1 newer snapshot \(nightly\); destroy it first to roll back to old/,
    "a child dataset's snapshot does not count",
  );
  assert.ok(!f.calls.some((c) => c[1] === 'rollback' || c[1] === 'snapshot'), 'refused before anything ran');
  res = await handle({ id: 6, verb: 'snapshot.rollback', args: { snapshot: 'tank/docs@gone', confirm: 'tank/docs@gone' } }, d, audit);
  assert.match(!res.ok ? res.error.message : '', /no such snapshot/);
  res = await handle({ id: 7, verb: 'snapshot.rollback', args: { snapshot: 'tank/docs@nightly', confirm: 'nightly' } }, d, audit);
  assert.match(!res.ok ? res.error.message : '', /type the name/);

  listing = `tank/docs@nightly\t0\t0\t1757600100\n`;
  res = await handle({ id: 8, verb: 'snapshot.rollback', args: { snapshot: 'tank/docs@nightly', confirm: 'tank/docs@nightly' } }, d, audit);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.ok && res.result, { rolledBackTo: 'tank/docs@nightly' });
  const writes = f.calls.filter((c) => c[0] === 'zfs' && c[1] !== 'list');
  assert.deepEqual(writes, [['zfs', 'rollback', 'tank/docs@nightly']], 'no snapshot first, no -r');
});

test('dataset.destroy: the name typed, no pool, no children, no share, no copy; snapshots only when said; the policy and the location dir go too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-loc-'));
  await mkdir(join(dir, 'docs'));
  try {
    const row = (name: string, mp: string) => `${name}\tfilesystem\t0\t100\t0\t${mp}\tyes\t0\tlz4\t1.00x\toff\t131072\t1757600000\n`;
    let snaps = `tank/docs@a\t0\t0\t1757600000\ntank/docs@b\t0\t0\t1757600100\n`;
    const f = fake({
      [`${DS} -r tank/docs`]: row('tank/docs', join(dir, 'docs')),
      [`${DS} -r tank/kids`]: row('tank/kids', '/tank/kids') + row('tank/kids/a', '/tank/kids/a') + row('tank/kids/b', '/tank/kids/b'),
      [`${DS} -r tank/nope`]: { argv: [], exitCode: 1, stdout: '', stderr: "cannot open 'tank/nope': dataset does not exist\n" },
      [`${SNAPS} -r tank/docs`]: () => snaps,
      'zfs destroy tank/docs@a,b': () => ((snaps = ''), ''),
      'zfs destroy tank/docs': '',
    });
    const d = deps(f.run, { locationsDir: dir });
    d.db.setPolicy({ dataset: 'tank/docs', hourly: 1, daily: 0, weekly: 0, monthly: 0 });
    const refused = async (args: Record<string, unknown>, re: RegExp) => {
      const res = await handle({ id: 1, verb: 'dataset.destroy', args }, d, audit);
      assert.equal(res.ok, false, JSON.stringify(args));
      assert.match(!res.ok ? res.error.message : '', re);
    };
    await refused({ dataset: 'tank', confirm: 'tank' }, /a pool cannot be destroyed/);
    await refused({ dataset: 'tank/docs', confirm: 'docs' }, /type the name/);
    await refused({ dataset: 'tank/nope', confirm: 'tank/nope' }, /does not exist/);
    await refused({ dataset: 'tank/kids', confirm: 'tank/kids' }, /has children \(a, b\)/);
    await refused({ dataset: 'tank/docs', confirm: 'tank/docs' }, /has 2 snapshots/);
    await refused({ dataset: 'tank/docs', confirm: 'tank/docs', snapshots: 'yes' }, /snapshots must be/);
    d.db.setShare({ dataset: 'tank/docs', smb: true, timeMachine: false, nfs: false, nfsClients: [] });
    await refused({ dataset: 'tank/docs', confirm: 'tank/docs', snapshots: true }, /is shared/);
    d.db.removeShare('tank/docs');
    const r = d.db.setReplication({
      dataset: 'tank/docs',
      host: 'far',
      user: 'root',
      port: 22,
      targetDataset: 'backup/docs',
      recursive: false,
      schedule: 'manual',
      keep: 3,
    });
    await refused({ dataset: 'tank/docs', confirm: 'tank/docs', snapshots: true }, /is copied to root@far/);
    d.db.removeReplication(r.id);
    assert.ok(!f.calls.some((c) => c[1] === 'destroy'), 'nothing was destroyed by a refused call');

    const res = await handle({ id: 2, verb: 'dataset.destroy', args: { dataset: 'tank/docs', confirm: 'tank/docs', snapshots: true } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.ok && res.result, { destroyed: 'tank/docs', snapshots: 2, location: 'docs' });
    const destroys = f.calls.filter((c) => c[1] === 'destroy');
    assert.deepEqual(destroys, [
      ['zfs', 'destroy', 'tank/docs@a,b'],
      ['zfs', 'destroy', 'tank/docs'],
    ]);
    assert.equal(d.db.policy('tank/docs'), null, 'the policy went with it');
    await assert.rejects(stat(join(dir, 'docs')), 'the empty location directory is gone');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scans as jobs: pool.scrub writes one down; jobs reads its progress off the pool, closes it when the scan line says so, keeps the history', async () => {
  const status = (scan: string) => fx('zpool-status-mirror.txt').replace(/^  scan: .*$/m, `  scan: ${scan}`);
  let scan =
    'scrub in progress since Fri Sep 12 10:00:00 2026\n\t1.20G / 3.40G scanned at 120M/s, 800M / 3.40G issued at 80M/s\n\t0B repaired, 23.53% done, 00:00:33 to go';
  const f = fake({
    'zpool scrub tank': '',
    [`${POOLS} tank`]: 'tank\tONLINE\t100\t1\t99\t1\t0\n',
    'zpool status tank': () => status(scan),
  });
  const d = deps(f.run);
  let res = await handle({ id: 1, verb: 'pool.scrub', args: { pool: 'tank' } }, d, audit);
  assert.equal(res.ok, true, JSON.stringify(res));
  res = await handle({ id: 2, verb: 'pool.scrub', args: { pool: 'tank' } }, d, audit);
  assert.equal(d.db.scanJobs('tank').length, 1, 'starting again while it runs does not write a second job');

  res = await handle({ id: 3, verb: 'jobs', args: { pool: 'tank' } }, d, audit);
  let jobs = res.ok ? (res.result as { kind: string; pool: string; state: string; progress: number | null; message: string | null }[]) : [];
  assert.equal(jobs.length, 1);
  assert.deepEqual([jobs[0].kind, jobs[0].pool, jobs[0].state, jobs[0].progress], ['scrub', 'tank', 'running', 23.53]);

  scan = 'scrub repaired 0B in 00:05:12 with 0 errors on Sat Sep 13 10:05:12 2026';
  res = await handle({ id: 4, verb: 'jobs', args: { pool: 'tank' } }, d, audit);
  jobs = res.ok ? (res.result as typeof jobs) : [];
  assert.deepEqual([jobs[0].state, jobs[0].progress], ['done', 100]);
  assert.match(jobs[0].message ?? '', /^scrub repaired 0B/);

  // the next one finds errors: failed, with the line that says so
  res = await handle({ id: 5, verb: 'pool.scrub', args: { pool: 'tank' } }, d, audit);
  scan = 'scrub repaired 4K in 00:05:12 with 2 errors on Sat Sep 13 11:05:12 2026';
  res = await handle({ id: 6, verb: 'jobs', args: { pool: 'tank' } }, d, audit);
  jobs = res.ok ? (res.result as typeof jobs) : [];
  assert.equal(jobs.length, 2, 'history: newest first');
  assert.equal(jobs[0].state, 'failed');
  assert.match(jobs[0].message ?? '', /2 errors/);
  assert.equal(jobs[1].state, 'done');

  // a scan that was cut short (nothing running, an older line) is failed, never left running forever
  res = await handle({ id: 7, verb: 'pool.scrub', args: { pool: 'tank' } }, d, audit);
  scan = 'scrub canceled on Sat Sep 13 11:06:00 2026';
  res = await handle({ id: 8, verb: 'jobs', args: { pool: 'tank' } }, d, audit);
  jobs = res.ok ? (res.result as typeof jobs) : [];
  assert.equal(jobs[0].state, 'failed');
  assert.match(jobs[0].message ?? '', /canceled/);
  assert.equal(d.db.runningScans().length, 0);

  // a replication runner's dead-job sweep leaves scans alone: they have no process
  res = await handle({ id: 9, verb: 'pool.scrub', args: { pool: 'tank' } }, d, audit);
  assert.equal(
    d.db.failDeadJobs(() => false, 'interrupted'),
    0,
  );
  assert.equal(d.db.runningScans().length, 1);
  const all = await handle({ id: 10, verb: 'jobs' }, d, audit);
  assert.equal(all.ok && (all.result as unknown[]).length, 4, 'the plain list has them too');
  const bad = await handle({ id: 11, verb: 'jobs', args: { pool: '-f' } }, d, audit);
  assert.equal(!bad.ok && bad.error.code, 'bad-args');
});

test('scrub.policy.set: per existing pool, one of off|weekly|monthly; scrub.policies fills in monthly for the rest', async () => {
  const f = fake({
    [POOLS]: 'tank\tONLINE\t100\t1\t99\t1\t0\nspare\tONLINE\t100\t1\t99\t1\t0\n',
    [`${POOLS} tank`]: 'tank\tONLINE\t100\t1\t99\t1\t0\n',
    [`${POOLS} nope`]: { argv: [], exitCode: 1, stdout: '', stderr: "cannot open 'nope': no such pool\n" },
  });
  const d = deps(f.run);
  let res = await handle({ id: 1, verb: 'scrub.policy.set', args: { pool: 'tank', interval: 'daily' } }, d, audit);
  assert.match(!res.ok ? res.error.message : '', /interval must be/);
  res = await handle({ id: 2, verb: 'scrub.policy.set', args: { pool: 'nope', interval: 'weekly' } }, d, audit);
  assert.equal(!res.ok && res.error.code, 'not-found');
  res = await handle({ id: 3, verb: 'scrub.policy.set', args: { pool: 'tank', interval: 'weekly' } }, d, audit);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.ok && (res.result as { interval: string }).interval, 'weekly');
  const list = await handle({ id: 4, verb: 'scrub.policies' }, d, audit);
  const rows = list.ok ? (list.result as { pool: string; interval: string; updatedAt: string | null }[]) : [];
  assert.deepEqual(
    rows.map((r) => [r.pool, r.interval, r.updatedAt === null]),
    [
      ['tank', 'weekly', false],
      ['spare', 'monthly', true],
    ],
  );
});

test('policy.set: stored per existing dataset, all zeros removes it, counts are bounded', async () => {
  const f = fake({
    [`${DS} -r tank/docs`]: 'tank/docs\tfilesystem\t0\t100\t0\t/tank/docs\tyes\t0\tlz4\t1.00x\ton\t131072\t1757600000\n',
    [`${DS} -r tank/nope`]: { argv: [], exitCode: 1, stdout: '', stderr: "cannot open 'tank/nope': dataset does not exist\n" },
  });
  const d = deps(f.run);
  let res = await handle({ id: 1, verb: 'policy.set', args: { dataset: 'tank/docs', hourly: 24, daily: 7, weekly: 4, monthly: 0 } }, d, audit);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(d.db.policies().length, 1);
  res = await handle({ id: 2, verb: 'policy.set', args: { dataset: 'tank/nope', hourly: 1, daily: 0, weekly: 0, monthly: 0 } }, d, audit);
  assert.equal(!res.ok && res.error.code, 'not-found');
  res = await handle({ id: 3, verb: 'policy.set', args: { dataset: 'tank/docs', hourly: -1, daily: 0, weekly: 0, monthly: 0 } }, d, audit);
  assert.match(!res.ok ? res.error.message : '', /hourly must be/);
  res = await handle({ id: 4, verb: 'policy.set', args: { dataset: 'tank/docs', hourly: 0, daily: 0, weekly: 0, monthly: 0 } }, d, audit);
  assert.equal(res.ok, true);
  assert.equal(d.db.policies().length, 0);
  const list = await handle({ id: 5, verb: 'policies' }, d, audit);
  assert.deepEqual(list.ok && list.result, []);
});
