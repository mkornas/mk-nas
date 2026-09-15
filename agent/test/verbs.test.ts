/** The registry against a fake runner: exact argv, refusals, results. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, symlink, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner, RunResult } from '../src/run.ts';
import { handle } from '../src/server.ts';
import type { Deps } from '../src/verbs.ts';
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

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const POOLS = 'tank\tONLINE\t1992864825344\t812345\t1992052480000\t0\t-\n';

function fake(table: Record<string, string | RunResult>): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    const hit = table[argv.join(' ')];
    if (hit === undefined) return { argv, exitCode: 1, stdout: '', stderr: `fake: no such command: ${argv.join(' ')}` };
    return typeof hit === 'string' ? { argv, exitCode: 0, stdout: hit, stderr: '' } : { ...hit, argv };
  };
  return { run, calls };
}

const audits: unknown[] = [];
const audit = async (line: unknown) => void audits.push(line);
const deps = (run: Runner, extra: Partial<Deps> = {}): Deps => ({
  run,
  version: '0.1.0-test',
  db: new Db(':memory:'),
  locationsDir: '/srv/locations',
  shares: SHARES,
  replication: REPL,
  spawn: NOSPAWN,
  network: NET,
  backup: BKP,
  ...extra,
});

test('unknown verb is refused and audited', async () => {
  const f = fake({});
  const res = await handle({ id: 1, verb: 'shell' as never, args: { cmd: 'rm -rf /' } }, deps(f.run), audit);
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.error.code, 'unknown-verb');
  assert.equal(f.calls.length, 0);
  assert.equal((audits.at(-1) as { error: string }).error, 'unknown-verb');
});

test('pools: the exact argv, parsed', async () => {
  const f = fake({ 'zpool list -H -p -o name,health,size,allocated,free,capacity,fragmentation': POOLS });
  const res = await handle({ id: 'a', verb: 'pools' }, deps(f.run), audit);
  assert.equal(res.ok, true);
  assert.equal(res.ok && (res.result as { name: string }[])[0].name, 'tank');
  assert.deepEqual(f.calls[0], ['zpool', 'list', '-H', '-p', '-o', 'name,health,size,allocated,free,capacity,fragmentation']);
});

test('pool: bad names never reach a command', async () => {
  const f = fake({});
  for (const pool of ['-f', 'tank; rm', '../etc', 'tank/child']) {
    const res = await handle({ id: 1, verb: 'pool', args: { pool } }, deps(f.run), audit);
    assert.equal(!res.ok && res.error.code, 'bad-args', pool);
  }
  assert.equal(f.calls.length, 0);
});

test('pool: status is merged with the summary', async () => {
  const f = fake({
    'zpool list -H -p -o name,health,size,allocated,free,capacity,fragmentation tank': POOLS,
    'zpool status tank': fx('zpool-status-degraded.txt'),
  });
  const res = await handle({ id: 1, verb: 'pool', args: { pool: 'tank' } }, deps(f.run), audit);
  assert.equal(res.ok, true);
  const p = res.ok ? (res.result as { scrub: { state: string }; vdevs: unknown[]; action: string }) : null;
  assert.equal(p?.scrub.state, 'running');
  assert.equal(p?.vdevs.length, 1);
  assert.match(p?.action ?? '', /zpool replace/);
});

test('pool: a missing pool is not-found, with the argv in the detail', async () => {
  const f = fake({
    'zpool list -H -p -o name,health,size,allocated,free,capacity,fragmentation nope': {
      argv: [],
      exitCode: 1,
      stdout: '',
      stderr: "cannot open 'nope': no such pool\n",
    },
  });
  const res = await handle({ id: 1, verb: 'pool', args: { pool: 'nope' } }, deps(f.run), audit);
  assert.equal(!res.ok && res.error.code, 'not-found');
  assert.equal(!res.ok && res.error.detail?.exitCode, 1);
});

test('datasets and snapshots: optional scope adds -r', async () => {
  const f = fake({
    'zfs list -H -p -t filesystem,volume -o name,type,used,avail,refer,mountpoint,mounted,quota,compression,compressratio,atime,recordsize,creation -s name -r tank':
      'tank\tfilesystem\t1\t2\t3\t/tank\tyes\t0\tlz4\t1.00x\ton\t131072\t1757600000\n',
    'zfs list -H -p -t snapshot -o name,used,refer,creation -s creation': '',
  });
  const d = await handle({ id: 1, verb: 'datasets', args: { pool: 'tank' } }, deps(f.run), audit);
  assert.equal(d.ok && (d.result as unknown[]).length, 1);
  const s = await handle({ id: 2, verb: 'snapshots', args: {} }, deps(f.run), audit);
  assert.deepEqual(s.ok && s.result, []);
  const bad = await handle({ id: 3, verb: 'snapshots', args: { dataset: 'tank@x' } }, deps(f.run), audit);
  assert.equal(!bad.ok && bad.error.code, 'bad-args');
});

test('unavailable: a tool that cannot start', async () => {
  const f = fake({
    'zpool list -H -p -o name,health,size,allocated,free,capacity,fragmentation': { argv: [], exitCode: null, stdout: '', stderr: 'spawn zpool ENOENT' },
  });
  const res = await handle({ id: 1, verb: 'pools' }, deps(f.run), audit);
  assert.equal(!res.ok && res.error.code, 'unavailable');
});

test('disks: lsblk + by-id + smart, health sees the pending sectors', async () => {
  const byId = await mkdtemp(join(tmpdir(), 'mk-nas-byid-'));
  try {
    await symlink('/dev/sda', join(byId, 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA'));
    await symlink('/dev/sda', join(byId, 'wwn-0x50014ee2b5a1c2d3'));
    await symlink('/dev/sda1', join(byId, 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA-part1'));
    await symlink('/dev/nvme0n1', join(byId, 'nvme-Samsung_SSD_970_EVO_250GB_S4EWNX0N000000'));
    const f = fake({
      'lsblk -J -b -o NAME,PATH,SIZE,MODEL,SERIAL,ROTA,TYPE,TRAN,MOUNTPOINT,FSTYPE,LABEL': fx('lsblk.json'),
      'zpool list -v -H -P': `tank\t1.8T\t1M\t1.8T\t-\t-\t0%\t0%\t1.00x\tONLINE\t-\n\tmirror-0\t1.8T\t1M\t1.8T\t-\t-\t0%\t0%\t-\tONLINE\n\t${join(byId, 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA-part1')}\t1.8T\t-\t-\t-\t-\t-\t-\t-\tONLINE\n`,
      'smartctl -j -H -A -i /dev/sda': fx('smartctl-ata.json'),
      'smartctl -j -H -A -i /dev/sdb': { argv: [], exitCode: 2, stdout: '', stderr: 'Smartctl open device: /dev/sdb failed' },
      'smartctl -j -H -A -i /dev/nvme0n1': { argv: [], exitCode: 4, stdout: fx('smartctl-nvme.json'), stderr: '' },
      'smartctl -j -H -A -i -c -l selftest /dev/nvme0n1': { argv: [], exitCode: 4, stdout: fx('smartctl-nvme.json'), stderr: '' },
      'zpool list -H -p -o name,health,size,allocated,free,capacity,fragmentation': POOLS,
    });
    const d = deps(f.run, { byIdDir: byId });
    const res = await handle({ id: 1, verb: 'disks' }, d, audit);
    assert.equal(res.ok, true);
    const disks = res.ok ? (res.result as { id: string; ids: string[]; use: unknown; smart: { pending: number } | null; rotational: boolean }[]) : [];
    assert.equal(disks.length, 3);
    assert.equal(disks[0].id, 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA');
    assert.deepEqual(disks[0].ids.sort(), ['ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA', 'wwn-0x50014ee2b5a1c2d3']);
    assert.deepEqual(disks[0].use, { kind: 'pool', pool: 'tank', imported: true }, 'zpool says its partition serves an imported pool');
    assert.equal(disks[0].smart?.pending, 2);
    assert.equal(disks[1].id, '/dev/sdb', 'no by-id link: falls back to the dev path');
    assert.equal(disks[1].smart, null);
    assert.equal(disks[2].rotational, false);
    assert.equal(disks[2].smart?.pending, null, 'smartctl exit 4 (a failed ATA command) still yields JSON');

    const smart = await handle({ id: 2, verb: 'smart', args: { disk: 'nvme-Samsung_SSD_970_EVO_250GB_S4EWNX0N000000' } }, d, audit);
    assert.equal(smart.ok && (smart.result as { wear: number }).wear, 3);
    const part = await handle({ id: 3, verb: 'smart', args: { disk: 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA-part1' } }, d, audit);
    assert.equal(!part.ok && part.error.code, 'bad-args');
    const path = await handle({ id: 4, verb: 'smart', args: { disk: '/dev/sda' } }, d, audit);
    assert.equal(!path.ok && path.error.code, 'bad-args');

    const health = await handle({ id: 5, verb: 'health' }, d, audit);
    assert.equal(health.ok, true);
    const h = health.ok ? (health.result as { ok: boolean; problems: string[] }) : null;
    assert.equal(h?.ok, false);
    assert.deepEqual(h?.problems, ['Disk ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA: 2 pending sectors']);
  } finally {
    await rm(byId, { recursive: true, force: true });
  }
});

test('smart and smart.test: the detail read adds the self-test log; a test starts with -t and is refused while one runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-byid-'));
  const A = 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA';
  await symlink('/dev/sda', join(dir, A));
  try {
    let raw = fx('smartctl-ata-selftest.json');
    const f = fake({});
    const run: Runner = async (argv) => {
      f.calls.push(argv);
      if (argv.join(' ') === `smartctl -j -H -A -i -c -l selftest /dev/sda`) return { argv, exitCode: 0, stdout: raw, stderr: '' };
      if (argv.join(' ') === 'smartctl -j -t short /dev/sda') return { argv, exitCode: 0, stdout: '{}', stderr: '' };
      return { argv, exitCode: 1, stdout: '', stderr: 'no' };
    };
    const d = deps(run, { byIdDir: dir });
    let res = await handle({ id: 1, verb: 'smart', args: { disk: A } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.ok && (res.result as { selfTest: { running: { kind: string } } }).selfTest.running.kind, 'long');
    res = await handle({ id: 2, verb: 'smart.test', args: { disk: A, kind: 'short' } }, d, audit);
    assert.match(!res.ok ? res.error.message : '', /already running/);
    res = await handle({ id: 3, verb: 'smart.test', args: { disk: A, kind: 'weekly' } }, d, audit);
    assert.match(!res.ok ? res.error.message : '', /short or long/);
    const idle = JSON.parse(raw);
    delete idle.ata_smart_data;
    raw = JSON.stringify(idle);
    res = await handle({ id: 4, verb: 'smart.test', args: { disk: A, kind: 'short' } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(f.calls.some((c) => c.join(' ') === 'smartctl -j -t short /dev/sda'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('version: works without zfs or smartctl on the box', async () => {
  const f = fake({});
  const res = await handle({ id: 1, verb: 'version' }, deps(f.run), audit);
  assert.equal(res.ok, true);
  assert.equal(res.ok && (res.result as { zfs: string | null }).zfs, null);
});

test('power: restart asked for by updates, and the running work a restart would cut short', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-power-'));
  const flag = join(dir, 'reboot-required');
  const f = fake({
    'zpool list -H -p -o name,health,size,allocated,free,capacity,fragmentation': POOLS,
    'zpool list -H -p -o name,health,size,allocated,free,capacity,fragmentation tank': POOLS,
    'zpool status tank': fx('zpool-status-resilver.txt'),
    'lsblk -J -b -o NAME,PATH,SIZE,MODEL,SERIAL,ROTA,TYPE,TRAN,MOUNTPOINT,FSTYPE,LABEL': fx('lsblk.json'),
    'smartctl -j -n standby -c -l selftest /dev/sda': fx('smartctl-ata-selftest.json'),
  });
  const d = deps(f.run, { rebootRequired: flag });
  d.db.startJob('replication', null, 'tank/photos → backup@far:backup/photos', 1);
  try {
    let res = await handle({ id: 1, verb: 'power' }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    let p = res.ok ? (res.result as { restartNeeded: boolean; packages: string[]; busy: string[] }) : null;
    assert.equal(p?.restartNeeded, false);
    assert.deepEqual(p?.busy, ['Rebuild of tank, 23.53%', 'Copy of tank/photos → backup@far:backup/photos', 'Long SMART test on sda, 10%']);
    assert.ok(!f.calls.some((c) => c.includes('/dev/sdb')), 'only pool disks are asked about self-tests');

    await writeFile(flag, '*** System restart required ***\n');
    await writeFile(`${flag}.pkgs`, 'linux-base\nlibc6\nlinux-base\n');
    res = await handle({ id: 2, verb: 'power' }, d, audit);
    p = res.ok ? (res.result as typeof p) : null;
    assert.equal(p?.restartNeeded, true);
    assert.deepEqual(p?.packages, ['linux-base', 'libc6']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('system.reboot and system.shutdown: the typed hostname, one timer a few seconds out, never twice', async () => {
  const timer = 'systemctl is-active --quiet mk-nas-power.timer';
  const idle = { argv: [], exitCode: 3, stdout: '', stderr: '' };
  let f = fake({ [timer]: idle });
  let res = await handle({ id: 1, verb: 'system.reboot', args: { confirm: 'not-the-name' } }, deps(f.run), audit);
  assert.equal(!res.ok && res.error.code, 'bad-args');
  assert.equal(f.calls.length, 0, 'nothing runs without the name');

  f = fake({ [timer]: idle, 'systemd-run --quiet --collect --unit=mk-nas-power --on-active=5 systemctl poweroff': '' });
  res = await handle({ id: 2, verb: 'system.shutdown', args: { confirm: hostname() } }, deps(f.run), audit);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.ok && (res.result as { action: string }).action, 'shutdown');
  assert.deepEqual(f.calls.at(-1), ['systemd-run', '--quiet', '--collect', '--unit=mk-nas-power', '--on-active=5', 'systemctl', 'poweroff']);

  f = fake({ [timer]: '' });
  res = await handle({ id: 3, verb: 'system.reboot', args: { confirm: hostname() } }, deps(f.run), audit);
  assert.equal(!res.ok && res.error.code, 'bad-args');
  assert.match(!res.ok ? res.error.message : '', /already on its way/);
  assert.equal(f.calls.length, 1);
});

test('update.install: the runner is started detached for exactly the checked release; anything else is refused before it', async () => {
  const f = fake({});
  const spawned: string[][] = [];
  const db = new Db(':memory:');
  const UPD = {
    repo: 'o/mk-nas',
    driveRepo: 'o/mk-drive',
    driveImage: 'ghcr.io/o/mk-drive',
    dir: '/tmp/never-written-updates',
    signers: '/tmp/never-written-signers',
    driveImageFile: '/tmp/never-written.tgz',
    loadImage: '/bin/true',
    pinnedDriveFile: '/tmp/never-written-version',
    agentPackage: '/tmp/never-written-package.json',
  };
  const d = deps(f.run, {
    db,
    updates: UPD,
    spawn: (argv) => {
      spawned.push(argv);
      db.startUpdateRun(argv.at(-1)!, process.pid);
    },
  });
  let res = await handle({ id: 1, verb: 'update.install', args: { version: '0.9.0' } }, d, audit);
  assert.equal(!res.ok && res.error.code, 'bad-args');
  db.recordUpdateCheck({ version: '0.9.0', drive: '0.4.0', contract: 2, notes: '', publishedAt: '', url: '', signed: true }, null);
  res = await handle({ id: 2, verb: 'update.install', args: { version: '0.9.0', extra: 1 } }, d, audit);
  assert.equal(!res.ok && res.error.code, 'bad-args', 'unknown keys are refused');
  res = await handle({ id: 3, verb: 'update.install', args: { version: '0.9.0' } }, d, audit);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(spawned.length, 1);
  assert.match(spawned[0][1], /src\/update\.ts$/);
  assert.equal(spawned[0][2], '0.9.0');
  const u = res.ok ? (res.result as { run: { state: string; version: string }; available: boolean }) : null;
  assert.deepEqual([u?.run.state, u?.run.version, u?.available], ['running', '0.9.0', true]);
  res = await handle({ id: 4, verb: 'update.install', args: { version: '0.9.0' } }, d, audit);
  assert.match(!res.ok ? res.error.message : '', /already running/);
  assert.equal(spawned.length, 1);
});
