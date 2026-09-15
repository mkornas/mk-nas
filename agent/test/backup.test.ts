/** The settings backup against temp files and a fake zfs: what lands in the dataset, the snapshot and its pruning, the restore hand-off. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConfigBackup } from '../../shared/types.ts';
import { backupDue, DIR, mergeDriveEnv, restoreBackup, setBackup, type BackupConfig } from '../src/backup.ts';
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
    await chmod(mp, 0o755);
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
    assert.match(spawned[0][2], /passdb\.tdb\.restore$/);
    assert.equal(await readFile(spawned[0][2], 'utf8'), 'TDB', "Samba's passwords wait outside the dataset");
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const TOKEN = Buffer.from(
  JSON.stringify({ a: '0123456789abcdef0123456789abcdef', t: '11111111-2222-3333-4444-555555555555', s: 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldA==' }),
).toString('base64');

test("mergeDriveEnv: this box's file, the allow-listed keys from the backup, nothing that could choose what runs", () => {
  const current = '# mk-drive on this NAS\nTZ=UTC\nMK_NAS_GID=998\nDRIVE_UID=1000\n# DRIVE_IMAGE=ghcr.io/mkornas/mk-drive:<version>\nDRIVE_UID=1000\n';
  const backup = [
    'TZ=Europe/Warsaw',
    'MK_NAS_GID=0',
    'DRIVE_IMAGE=evil.example/drive:latest',
    'NODE_OPTIONS=--import=/tmp/evil.mjs',
    'LD_PRELOAD=/tmp/evil.so',
    'DRIVE_UID=1001',
    'DRIVE_GID="1001"',
    'DRIVE_PASSWORD_LOGIN=lan',
    'DRIVE_OIDC_ISSUER=https://id.example.com/application/o/drive/',
    'DRIVE_OIDC_CLIENT_ID=drive',
    "DRIVE_OIDC_CLIENT_SECRET='s3cr3t-value'",
    'DRIVE_OIDC_NAME=Company sign-in',
    `CLOUDFLARE_TUNNEL_TOKEN=${TOKEN}`,
    'DRIVE_NAS_MONITOR_TOKEN=k2x9T4qLmP8vR3wY7nB1cZ6hJ5dF0gS2',
  ].join('\n');
  assert.equal(
    mergeDriveEnv(current, backup),
    [
      '# mk-drive on this NAS',
      'TZ=Europe/Warsaw',
      'MK_NAS_GID=998',
      'DRIVE_UID=1001',
      '# DRIVE_IMAGE=ghcr.io/mkornas/mk-drive:<version>',
      'DRIVE_GID="1001"',
      'DRIVE_PASSWORD_LOGIN=lan',
      'DRIVE_OIDC_ISSUER=https://id.example.com/application/o/drive/',
      'DRIVE_OIDC_CLIENT_ID=drive',
      "DRIVE_OIDC_CLIENT_SECRET='s3cr3t-value'",
      'DRIVE_OIDC_NAME=Company sign-in',
      `CLOUDFLARE_TUNNEL_TOKEN=${TOKEN}`,
      'DRIVE_NAS_MONITOR_TOKEN=k2x9T4qLmP8vR3wY7nB1cZ6hJ5dF0gS2',
      '',
    ].join('\n'),
  );

  // a value that fails its check keeps this box's line and leaves a note, never the value
  const bad = [
    'DRIVE_UID=0; id',
    'TZ=../../etc/passwd',
    'DRIVE_PASSWORD_LOGIN=maybe',
    'DRIVE_OIDC_ISSUER=javascript:alert(1)',
    'DRIVE_OIDC_CLIENT_SECRET=${NODE_OPTIONS}',
    'DRIVE_OIDC_NAME="unterminated',
    'CLOUDFLARE_TUNNEL_TOKEN=--token abc',
    'DRIVE_NAS_MONITOR_TOKEN=short',
    'export DRIVE_GID=1001',
    'DRIVE_OIDC_CLIENT_ID=a\u0007b',
  ].join('\n');
  const out = mergeDriveEnv(current, bad);
  assert.ok(out.startsWith(current), 'the current lines stay as they were');
  for (const key of [
    'DRIVE_UID',
    'TZ',
    'DRIVE_PASSWORD_LOGIN',
    'DRIVE_OIDC_ISSUER',
    'DRIVE_OIDC_CLIENT_SECRET',
    'DRIVE_OIDC_NAME',
    'CLOUDFLARE_TUNNEL_TOKEN',
    'DRIVE_NAS_MONITOR_TOKEN',
    'DRIVE_GID',
    'DRIVE_OIDC_CLIENT_ID',
  ])
    assert.match(out, new RegExp(`^# ${key} from the settings backup was not restored`, 'm'), key);
  assert.ok(!/0; id|etc\/passwd|javascript|\$\{|unterminated|--token|\u0007/.test(out), out);
  assert.equal(mergeDriveEnv(out, bad), out, 'a second restore does not repeat the notes');
  assert.equal(mergeDriveEnv('', 'DRIVE_UID=1001\n'), 'DRIVE_UID=1001\n', 'no file on this box yet');
});

test('restore: only regular files from the backup, and no link at a destination is ever written through', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-restore-'));
  try {
    const mp = join(dir, 'tank', 'config');
    const src = join(mp, DIR);
    await mkdir(join(src, 'ssh'), { recursive: true });
    const files = ['mk-nas.db', 'mk-drive.db', 'ssh/id_ed25519', 'mk-drive.env'];
    await writeFile(join(src, 'manifest.json'), JSON.stringify({ at: '2026-09-15T00:00:00.000Z', hostname: 'nas', files }));
    await writeFile(join(src, 'mk-nas.db'), 'AGENT-DB');
    await writeFile(join(src, 'mk-drive.db'), 'DRIVE-DB');
    await writeFile(join(src, 'ssh', 'id_ed25519'), 'BACKUP-KEY');
    await writeFile(join(src, 'mk-drive.env'), 'DRIVE_UID=1001\nDRIVE_IMAGE=evil.example/drive\nNODE_OPTIONS=--import=/tmp/evil.mjs\n');
    const box = join(dir, 'box');
    await mkdir(join(box, 'data'), { recursive: true });
    await writeFile(join(box, 'drive.env'), 'MK_NAS_GID=998\nDRIVE_UID=1000\n');
    const secret = join(dir, 'root-only-secret');
    await writeFile(secret, 'SECRET');
    const victim = join(dir, 'victim');
    await writeFile(victim, 'VICTIM');
    const spawned: string[][] = [];
    const cfg: BackupConfig = {
      db: join(box, 'mk-nas.db'),
      sshKey: join(box, 'ssh', 'id_ed25519'),
      knownHosts: join(box, 'ssh', 'known_hosts'),
      netplanFile: join(box, '90-mk-nas.yaml'),
      driveEnv: join(box, 'drive.env'),
      driveDb: join(box, 'data', 'mk-drive.db'),
      spawn: (argv) => void spawned.push(argv),
    };
    const run: Runner = async (argv) =>
      argv.join(' ') === `${DS} -r tank/config`
        ? { argv, exitCode: 0, stdout: row('tank/config', mp), stderr: '' }
        : { argv, exitCode: 1, stdout: '', stderr: 'fake: no such command' };

    // a source that is a link (to a root-only file), or reached through one, restores nothing at all
    await rm(join(src, 'ssh', 'id_ed25519'));
    await symlink(secret, join(src, 'ssh', 'id_ed25519'));
    await assert.rejects(restoreBackup(run, cfg, 'tank/config', 'tank/config'), /ssh\/id_ed25519 in the backup is not a regular file/);
    await rm(join(src, 'ssh'), { recursive: true });
    await mkdir(join(dir, 'elsewhere'));
    await writeFile(join(dir, 'elsewhere', 'id_ed25519'), 'SECRET');
    await symlink(join(dir, 'elsewhere'), join(src, 'ssh'));
    await assert.rejects(restoreBackup(run, cfg, 'tank/config', 'tank/config'), /ssh is not a directory/);
    assert.equal(await readFile(cfg.driveEnv, 'utf8'), 'MK_NAS_GID=998\nDRIVE_UID=1000\n', 'nothing was written');
    assert.equal(await lstat(`${cfg.db}.restore`).catch(() => null), null);
    assert.equal(spawned.length, 0);
    await rm(join(src, 'ssh'));
    await mkdir(join(src, 'ssh'));
    await writeFile(join(src, 'ssh', 'id_ed25519'), 'BACKUP-KEY');

    // links planted at the destinations: the one the container can make in its data directory, and at the key
    await symlink(victim, `${cfg.driveDb}.restore`);
    await mkdir(join(box, 'ssh'));
    await symlink(victim, cfg.sshKey);
    const res = await restoreBackup(run, cfg, 'tank/config', 'tank/config');
    assert.deepEqual(res.files, files);
    assert.equal(await readFile(victim, 'utf8'), 'VICTIM', 'no link followed');
    for (const [file, content] of [
      [`${cfg.driveDb}.restore`, 'DRIVE-DB'],
      [cfg.sshKey, 'BACKUP-KEY'],
      [`${cfg.db}.restore`, 'AGENT-DB'],
    ]) {
      const s = await lstat(file);
      assert.ok(s.isFile(), `${file} is a file of its own`);
      assert.equal(s.mode & 0o777, 0o600, file);
      assert.equal(await readFile(file, 'utf8'), content);
    }
    const env = await readFile(cfg.driveEnv, 'utf8');
    assert.equal(env, 'MK_NAS_GID=998\nDRIVE_UID=1001\n', 'the allow-listed key merged in; DRIVE_IMAGE and NODE_OPTIONS left behind');
    assert.equal((await stat(cfg.driveEnv)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(box)).sort(), ['data', 'drive.env', 'mk-nas.db.restore', 'ssh'], 'no temp file left behind');
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0][2], '', 'no passdb in this backup');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('backup: a dataset anyone but root can write (a location) is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-bkp-open-'));
  try {
    const mp = join(dir, 'photos');
    await mkdir(mp);
    await chmod(mp, 0o777);
    const db = new Db(':memory:');
    const run: Runner = async (argv) =>
      argv.join(' ') === `${DS} -r tank/photos`
        ? { argv, exitCode: 0, stdout: row('tank/photos', mp), stderr: '' }
        : { argv, exitCode: 1, stdout: '', stderr: 'fake: no such command' };
    const cfg = { db: '', sshKey: '', knownHosts: '', netplanFile: '', driveEnv: '', driveDb: '', spawn: () => {} };
    await assert.rejects(setBackup(run, db, cfg, 'tank/photos'), /others can write to it/);
    await chmod(mp, 0o755);
    assert.equal((await setBackup(run, db, cfg, 'tank/photos')).dataset, 'tank/photos');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
