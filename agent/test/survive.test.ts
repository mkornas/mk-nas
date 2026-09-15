/** Phase 5: the resilver on the scan line, importable pools, disk.replace and pool.import argv. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.ts';
import type { Runner, RunResult } from '../src/run.ts';
import { handle } from '../src/server.ts';
import type { Deps } from '../src/verbs.ts';
import { parseImportable, parsePoolStatus, parseScan } from '../src/zfs.ts';

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
const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const LSBLK = 'lsblk -J -b -o NAME,PATH,SIZE,MODEL,SERIAL,ROTA,TYPE,TRAN,MOUNTPOINT,FSTYPE,LABEL';
const POOLS = 'zpool list -H -p -o name,health,size,allocated,free,capacity,fragmentation';
const audit = async () => {};
const deps = (run: Runner, extra: Partial<Deps> = {}): Deps => ({
  run,
  version: 't',
  db: new Db(':memory:'),
  locationsDir: '',
  shares: { smbConf: '', exportsFile: '', smbGroup: 'g', ownerUid: 1000, ownerGid: 1000, hostname: 't' },
  replication: { keyFile: '', knownHosts: '' },
  spawn: () => {},
  network: NET,
  backup: BKP,
  ...extra,
});

function fake(table: Record<string, string | RunResult>): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    const key = argv.join(' ');
    const hit = table[key] ?? table[Object.keys(table).find((k) => k.endsWith('*') && key.startsWith(k.slice(0, -1))) ?? ''];
    if (hit === undefined) return { argv, exitCode: 1, stdout: '', stderr: `fake: no such command: ${key}` };
    return typeof hit === 'string' ? { argv, exitCode: 0, stdout: hit, stderr: '' } : { ...hit, argv };
  };
  return { run, calls };
}

test('a resilver shows on the scan line as a running resilver; the tree shows the replacing pair', () => {
  const s = parsePoolStatus(fx('zpool-status-resilver.txt'));
  const scan = parseScan('tank', s.scan);
  assert.equal(scan?.kind, 'resilver');
  assert.equal(scan?.state, 'running');
  assert.equal(scan?.percent, 23.53);
  const replacing = s.vdevs[0].children[0].children[1];
  assert.equal(replacing.name, 'replacing-1');
  assert.deepEqual(
    replacing.children.map((c) => [c.name, c.state, c.note]),
    [
      ['virtio-mknas-data-2', 'OFFLINE', null],
      ['virtio-mknas-data-3', 'ONLINE', '(resilvering)'],
    ],
  );
  assert.equal(parseScan('t', 'resilvered 3.40G in 00:02:10 with 0 errors on Sat Sep 12 21:02:10 2026')?.state, 'finished');
  assert.equal(parseScan('t', 'resilvered 3.40G in 00:02:10 with 0 errors on Sat Sep 12 21:02:10 2026')?.kind, 'resilver');
});

test('zpool import: every pool with its id, state, action and leaf devices', () => {
  const pools = parseImportable(fx('zpool-import.txt'));
  assert.equal(pools.length, 2);
  assert.equal(pools[0].name, 'old');
  assert.equal(pools[0].id, '12345678901234567890');
  assert.match(pools[0].status ?? '', /Some supported features/);
  assert.match(pools[0].action ?? '', /zpool upgrade/);
  assert.deepEqual(pools[0].devices, ['ata-OLD_A', 'ata-OLD_B']);
  assert.deepEqual(pools[1].devices, ['usb-WD_Elements_XYZ']);
});

test('disk.replace: pool name typed, a free disk, the member as zpool names it; pool.import refuses a name already here', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-byid-'));
  try {
    await symlink('/dev/sdb', join(dir, 'ata-WDC_WD20EFRX-68EUZN0_WD-BBBBBBBBBBBB'));
    await symlink('/dev/sda', join(dir, 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA'));
    await symlink('/dev/sda1', join(dir, 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA-part1'));
    const f = fake({
      [LSBLK]: fx('lsblk.json'),
      // sda's partition is a member of the imported tank
      'zpool list -v -H -P': `tank\t1.8T\t1M\t1.8T\t-\t-\t0%\t0%\t1.00x\tONLINE\t-\n\tmirror-0\t1.8T\t1M\t1.8T\t-\t-\t0%\t0%\t-\tONLINE\n\t${join(dir, 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA-part1')}\t1.8T\t-\t-\t-\t-\t-\t-\t-\tONLINE\n`,
      'smartctl *': { argv: [], exitCode: 2, stdout: '', stderr: '' },
      'zpool replace *': '',
      [`${POOLS} tank`]: 'tank\tDEGRADED\t100\t1\t99\t1\t0\n',
      [POOLS]: 'tank\tDEGRADED\t100\t1\t99\t1\t0\n',
      'zpool status tank': fx('zpool-status-resilver.txt'),
      'zpool import': fx('zpool-import.txt'),
      'zpool import old': '',
      [`${POOLS} old`]: 'old\tONLINE\t100\t1\t99\t1\t0\n',
      'zpool status old': fx('zpool-status-mirror.txt'),
    });
    const d = deps(f.run, { byIdDir: dir });
    let res = await handle(
      { id: 1, verb: 'disk.replace', args: { pool: 'tank', old: '1234567890123456789', disk: 'ata-WDC_WD20EFRX-68EUZN0_WD-BBBBBBBBBBBB', confirm: 'tank' } },
      d,
      audit,
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(
      f.calls.find((c) => c[1] === 'replace'),
      ['zpool', 'replace', 'tank', '1234567890123456789', join(dir, 'ata-WDC_WD20EFRX-68EUZN0_WD-BBBBBBBBBBBB')],
    );
    assert.equal(res.ok && (res.result as { scrub: { kind: string } }).scrub.kind, 'resilver');
    for (const [args, re] of [
      [{ pool: 'tank', old: 'x', disk: 'ata-WDC_WD20EFRX-68EUZN0_WD-BBBBBBBBBBBB', confirm: 'nope' }, /type the name/],
      [{ pool: 'tank', old: '-f', disk: 'ata-WDC_WD20EFRX-68EUZN0_WD-BBBBBBBBBBBB', confirm: 'tank' }, /not a pool member/],
      [{ pool: 'tank', old: 'x', disk: 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA', confirm: 'tank' }, /belongs to pool/],
    ] as [Record<string, unknown>, RegExp][]) {
      const r = await handle({ id: 2, verb: 'disk.replace', args }, d, audit);
      assert.match(!r.ok ? r.error.message : 'ok', re, JSON.stringify(args));
    }

    const list = await handle({ id: 3, verb: 'pool.importable' }, d, audit);
    assert.equal(list.ok && (list.result as unknown[]).length, 2);
    res = await handle({ id: 4, verb: 'pool.import', args: { pool: 'tank' } }, d, audit);
    assert.match(!res.ok ? res.error.message : 'ok', /already here/);
    res = await handle({ id: 5, verb: 'pool.import', args: { pool: 'old' } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(f.calls.some((c) => c.join(' ') === 'zpool import old'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('health names the failed member and the action when a pool is degraded', async () => {
  const f = fake({
    [POOLS]: 'tank\tDEGRADED\t100\t1\t99\t1\t0\n',
    [`${POOLS} tank`]: 'tank\tDEGRADED\t100\t1\t99\t1\t0\n',
    'zpool status tank': fx('zpool-status-degraded.txt'),
    [LSBLK]: '{"blockdevices":[]}',
  });
  const res = await handle({ id: 1, verb: 'health' }, deps(f.run), audit);
  assert.equal(res.ok, true, JSON.stringify(res));
  const h = res.ok ? (res.result as { ok: boolean; problems: string[] }) : null;
  assert.equal(h?.ok, false);
  assert.match(h?.problems[0] ?? '', /^Pool tank is DEGRADED \(1234567890123456789 UNAVAIL\) — Replace the device using 'zpool replace'/);
});
