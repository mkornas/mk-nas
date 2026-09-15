/** The settings backup against temp files and a fake zfs: what lands in the dataset, the snapshot and its pruning, the restore hand-off. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConfigBackup } from '../../shared/types.ts';
import { backupDue } from '../src/backup.ts';
import { Db } from '../src/db.ts';
import type { Runner, RunResult } from '../src/run.ts';
import { handle } from '../src/server.ts';
import type { Deps } from '../src/verbs.ts';

const DS =
  'zfs list -H -p -t filesystem,volume -o name,type,used,avail,refer,mountpoint,mounted,quota,compression,compressratio,atime,recordsize,creation -s name';
const SNAPS = 'zfs list -H -p -t snapshot -o name,used,refer,creation -s creation';
const row = (name: string, mp: string, mounted = 'yes') => `${name}\tfilesystem\t0\t100\t0\t${mp}\t${mounted}\t0\tlz4\t1.00x\toff\t131072\t1757600000\n`;

test('backup: set, run, read; the snapshot per run and the last 30 kept; restore hands the databases to the finisher', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-bkp-'));
  try {
    const mp = join(dir, 'tank', 'config');
    await mkdir(mp, { recursive: true });
    await mkdir(join(dir, 'ssh'));
    await writeFile(join(dir, 'ssh', 'id_ed25519'), 'KEY');
    await writeFile(join(dir, 'ssh', 'id_ed25519.pub'), 'PUB');
    await writeFile(join(dir, 'drive.env'), 'DRIVE_UID=1000\n');
    const driveDb = new DatabaseSync(join(dir, 'mk-drive.db'));
    driveDb.exec("CREATE TABLE users (email TEXT); INSERT INTO users VALUES ('alice@example.com')");
    driveDb.close();
    const agentDbFile = join(dir, 'mk-nas.db');
    const db = new Db(agentDbFile);
    db.setPolicy({ dataset: 'tank/photos', hourly: 1, daily: 0, weekly: 0, monthly: 0 });
    const snaps: string[] = [];
    const calls: string[][] = [];
    const spawned: string[][] = [];
    const run: Runner = async (argv): Promise<RunResult> => {
      calls.push(argv);
      const key = argv.join(' ');
      if (key === `${DS} -r tank/config`) return { argv, exitCode: 0, stdout: row('tank/config', mp), stderr: '' };
      if (key === `${DS} -r tank/nope`) return { argv, exitCode: 1, stdout: '', stderr: "cannot open 'tank/nope': dataset does not exist" };
      if (key === `${DS} -r tank/off`) return { argv, exitCode: 0, stdout: row('tank/off', '/tank/off', 'no'), stderr: '' };
      if (key === `${SNAPS} -r tank/config`) return { argv, exitCode: 0, stdout: snaps.map((s, i) => `${s}\t0\t0\t${1757600000 + i}\n`).join(''), stderr: '' };
      if (argv[0] === 'zfs' && argv[1] === 'snapshot') {
        snaps.push(argv[2]);
        return { argv, exitCode: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'zfs' && argv[1] === 'destroy') {
        snaps.splice(snaps.indexOf(argv[2]), 1);
        return { argv, exitCode: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'pdbedit') {
        await writeFile(argv[2].slice('tdbsam:'.length), 'TDB');
        return { argv, exitCode: 0, stdout: '', stderr: '' };
      }
      return { argv, exitCode: 1, stdout: '', stderr: `fake: no such command: ${key}` };
    };
    const d: Deps = {
      run,
      version: 't',
      db,
      locationsDir: '',
      shares: { smbConf: '', exportsFile: '', smbGroup: 'g', ownerUid: 1000, ownerGid: 1000, hostname: 't' },
      replication: { keyFile: '', knownHosts: '' },
      spawn: (argv) => void spawned.push(argv),
      network: { netplanFile: join(dir, '90-mk-nas.yaml'), pendingFile: join(dir, 'pending.json'), hostsFile: '', resolvConf: '', sysNet: '' },
      backup: {
        db: agentDbFile,
        sshKey: join(dir, 'ssh', 'id_ed25519'),
        knownHosts: join(dir, 'ssh', 'known_hosts'),
        netplanFile: join(dir, '90-mk-nas.yaml'),
        driveEnv: join(dir, 'drive.env'),
        driveDb: join(dir, 'mk-drive.db'),
      },
    };
    const audit = async () => {};
    const call = async (verb: string, args?: Record<string, unknown>) => handle({ id: 1, verb: verb as never, args }, d, audit);

    let res = await call('backup');
    assert.deepEqual(res.ok && res.result, { dataset: null, lastAt: null, lastResult: null, lastMessage: null, snapshots: 0, files: [], takenAt: null });
    assert.equal(backupDue(db), false, 'nothing chosen: never due');
    res = await call('backup.run');
    assert.match(!res.ok ? res.error.message : '', /no dataset was chosen/);
    res = await call('backup.set', { dataset: 'tank' });
    assert.match(!res.ok ? res.error.message : '', /not a pool/);
    res = await call('backup.set', { dataset: 'tank/nope' });
    assert.equal(res.ok, false);
    res = await call('backup.set', { dataset: 'tank/off' });
    assert.match(!res.ok ? res.error.message : '', /not mounted/);
    res = await call('backup.set', { dataset: 'tank/config' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(backupDue(db), true, 'chosen, never run: due');

    res = await call('backup.run');
    assert.equal(res.ok, true, JSON.stringify(res));
    let b = res.ok ? (res.result as ConfigBackup) : null;
    assert.deepEqual(
      b?.files,
      ['mk-nas.db', 'passdb.tdb', 'ssh/id_ed25519', 'ssh/id_ed25519.pub', 'mk-drive.env', 'mk-drive.db'],
      'no known_hosts, no netplan file: skipped, not failed',
    );
    assert.equal(b?.lastResult, 'ok');
    assert.equal(b?.snapshots, 1);
    assert.equal(backupDue(db), false, 'just ran');
    assert.equal(backupDue(db, Date.now() + 21 * 3_600_000), true, 'a day later');
    const out = join(mp, 'mk-nas-config');
    assert.deepEqual((await readdir(out)).sort(), ['manifest.json', 'mk-drive.db', 'mk-drive.env', 'mk-nas.db', 'passdb.tdb', 'ssh']);
    const copy = new Db(join(out, 'mk-nas.db'));
    assert.equal(copy.policies().length, 1, 'a real, consistent copy of the live database');
    copy.close();
    const driveCopy = new DatabaseSync(join(out, 'mk-drive.db'));
    assert.equal((driveCopy.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n, 1);
    driveCopy.close();
    assert.equal((await stat(join(out, 'manifest.json'))).mode & 0o777, 0o600);
    assert.match(snaps[0], /^tank\/config@config-/);

    // 31 more runs: the oldest snapshots go, 30 stay, the directory is replaced whole each time
    for (let i = 0; i < 31; i++) {
      const r = await call('backup.run');
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    assert.equal(snaps.length, 30);
    assert.ok(!(await readdir(mp)).includes('mk-nas-config.new'));

    res = await call('backup.restore', { dataset: 'tank/config', confirm: 'nope' });
    assert.match(!res.ok ? res.error.message : '', /type the name/);
    await rm(join(dir, 'ssh', 'id_ed25519'));
    res = await call('backup.restore', { dataset: 'tank/config', confirm: 'tank/config' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(await readFile(join(dir, 'ssh', 'id_ed25519'), 'utf8'), 'KEY', 'the key is back');
    assert.equal((await stat(join(dir, 'ssh', 'id_ed25519'))).mode & 0o777, 0o600);
    assert.ok(await stat(`${agentDbFile}.restore`), 'the live databases wait for the finisher');
    assert.ok(await stat(join(dir, 'mk-drive.db.restore')));
    assert.equal(spawned.length, 1);
    assert.match(spawned[0][1], /restore-finish\.ts$/);
    assert.match(spawned[0][2], /passdb\.tdb$/);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
