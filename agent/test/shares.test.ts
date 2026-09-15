/** Shares: the generated files, the verbs' argv, the refusals, the password kept off argv and out of the audit. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Share } from '../../shared/types.ts';
import { Db } from '../src/db.ts';
import type { RunOptions, Runner, RunResult } from '../src/run.ts';
import { handle } from '../src/server.ts';
import { exportsFile, listShares, nfsClient, smbConf, smbUserName, type ShareConfig } from '../src/shares.ts';
import type { Deps } from '../src/verbs.ts';

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
const DS =
  'zfs list -H -p -t filesystem,volume -o name,type,used,avail,refer,mountpoint,mounted,quota,compression,compressratio,atime,recordsize,creation -s name';
const row = (name: string, mp: string) => `${name}\tfilesystem\t0\t100\t0\t${mp}\tyes\t0\tlz4\t1.00x\toff\t131072\t1757600000\n`;
const ALL = row('tank', '/tank') + row('tank/photos', '/srv/locations/photos') + row('tank/docs', '/srv/locations/docs');

const cfg = (dir: string): ShareConfig => ({
  smbConf: join(dir, 'smb.conf'),
  exportsFile: join(dir, 'mk-nas.exports'),
  smbGroup: 'mk-nas-smb',
  ownerUid: 1000,
  ownerGid: 1000,
  hostname: 'nas',
});
const share = (over: Partial<Share>): Share => ({
  dataset: 'tank/photos',
  name: 'photos',
  mountpoint: '/srv/locations/photos',
  smb: true,
  timeMachine: false,
  nfs: false,
  nfsClients: [],
  updatedAt: '',
  ...over,
});

test('smb.conf: one section per SMB share, the owner forced, Time Machine only when asked', () => {
  const conf = smbConf(
    [
      share({}),
      share({ dataset: 'tank/tm', name: 'tm', mountpoint: '/srv/locations/tm', timeMachine: true }),
      share({ dataset: 'tank/nfsonly', name: 'nfsonly', smb: false, nfs: true }),
      share({ dataset: 'tank/gone', name: 'gone', mountpoint: null }),
    ],
    cfg('/x'),
    'alice',
    'alice',
  );
  assert.match(conf, /^\[global\]$/m);
  assert.match(conf, /server string = nas/);
  assert.match(conf, /^\[photos\]\n {3}path = \/srv\/locations\/photos\n/m);
  assert.match(conf, /force user = alice/);
  assert.match(conf, /force group = alice/);
  assert.ok(!conf.includes('#1000'), 'never a numeric gid: Samba refuses the share');
  assert.match(conf, /valid users = @mk-nas-smb/);
  assert.match(conf, /^\[tm\][\s\S]*?fruit:time machine = yes/m);
  assert.ok(!/\[photos\][\s\S]*?fruit:time machine/.test(conf.split('[tm]')[0]), 'photos has no Time Machine line');
  assert.ok(!conf.includes('[nfsonly]') && !conf.includes('[gone]'));
});

test('exports: one line per NFS share, private networks by default, everyone squashed to the owner', () => {
  const out = exportsFile(
    [
      share({ smb: false, nfs: true }),
      share({ dataset: 'tank/docs', name: 'docs', mountpoint: '/srv/locations/docs', smb: false, nfs: true, nfsClients: ['192.168.1.0/24', 'laptop'] }),
    ],
    cfg('/x'),
  );
  assert.match(out, /^\/srv\/locations\/photos 10\.0\.0\.0\/8\(rw,sync,no_subtree_check,all_squash,anonuid=1000,anongid=1000\) 172\.16/m);
  assert.match(out, /^\/srv\/locations\/docs 192\.168\.1\.0\/24\(rw,[^)]*\) laptop\(rw/m);
});

test('names: SMB user names and NFS clients are tight', () => {
  assert.equal(smbUserName('alice.smith'), 'alice.smith');
  for (const bad of ['root', 'Alice', '-x', 'a b', '', 'a'.repeat(40), 42]) assert.throws(() => smbUserName(bad), /not an SMB user name/, String(bad));
  assert.equal(nfsClient('192.168.1.0/24'), '192.168.1.0/24');
  assert.equal(nfsClient('*'), '*');
  for (const bad of ['-x', 'a(rw)', '', 'host name', 'x;y']) assert.throws(() => nfsClient(bad), /not a host/, bad);
});

function fake(table: Record<string, string | RunResult>): { run: Runner; calls: { argv: string[]; input?: string }[] } {
  const calls: { argv: string[]; input?: string }[] = [];
  const run: Runner = async (argv, opts?: RunOptions) => {
    calls.push({ argv, input: opts?.input });
    const key = argv.join(' ');
    const hit = table[key] ?? table[Object.keys(table).find((k) => k.endsWith('*') && key.startsWith(k.slice(0, -1))) ?? ''];
    if (hit === undefined) return { argv, exitCode: 1, stdout: '', stderr: `fake: no such command: ${key}` };
    return typeof hit === 'string' ? { argv, exitCode: 0, stdout: hit, stderr: '' } : { ...hit, argv };
  };
  return { run, calls };
}

test('share.set writes both files whole, starts the daemons it needs, reloads; share.remove takes it back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-shares-'));
  const audits: { args: unknown }[] = [];
  const audit = async (l: unknown) => void audits.push(l as { args: unknown });
  try {
    const f = fake({
      [DS]: ALL,
      [`${DS} -r tank/photos`]: row('tank/photos', '/srv/locations/photos'),
      [`${DS} -r tank/nope`]: { argv: [], exitCode: 1, stdout: '', stderr: "cannot open 'tank/nope': dataset does not exist" },
      'getent passwd 1000': 'alice:x:1000:1000::/home/alice:/bin/bash\n',
      'getent group 1000': 'alice:x:1000:\n',
      'systemctl *': '',
      'smbcontrol *': '',
      'exportfs *': '',
    });
    const deps: Deps = {
      run: f.run,
      version: 't',
      db: new Db(':memory:'),
      locationsDir: '/srv/locations',
      shares: cfg(dir),
      replication: { keyFile: join(dir, 'key'), knownHosts: join(dir, 'kh') },
      spawn: () => {},
      network: NET,
      backup: BKP,
    };
    let res = await handle({ id: 1, verb: 'share.set', args: { dataset: 'tank/photos', smb: true, timeMachine: true } }, deps, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    const s = res.ok ? (res.result as Share) : null;
    assert.equal(s?.name, 'photos');
    assert.equal(s?.mountpoint, '/srv/locations/photos');
    assert.equal(s?.timeMachine, true);
    const conf = await readFile(join(dir, 'smb.conf'), 'utf8');
    assert.match(conf, /\[photos\]/);
    assert.match(conf, /fruit:time machine = yes/);
    assert.equal((await readFile(join(dir, 'mk-nas.exports'), 'utf8')).trim().split('\n').length, 1, 'no NFS lines yet');
    assert.ok(f.calls.some((c) => c.argv.join(' ') === 'systemctl enable --now smbd'));
    assert.ok(f.calls.some((c) => c.argv.join(' ') === 'smbcontrol all reload-config'));
    assert.ok(f.calls.some((c) => c.argv.join(' ') === 'systemctl disable --now nfs-server'));

    f.calls.length = 0;
    res = await handle({ id: 2, verb: 'share.set', args: { dataset: 'tank/photos', nfs: true, nfsClients: ['192.168.1.0/24'] } }, deps, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.ok && (res.result as Share).smb, true, 'smb stays on when only nfs is given');
    assert.match(await readFile(join(dir, 'mk-nas.exports'), 'utf8'), /^\/srv\/locations\/photos 192\.168\.1\.0\/24\(rw/m);
    assert.ok(f.calls.some((c) => c.argv.join(' ') === 'systemctl enable --now nfs-server'));
    assert.ok(f.calls.some((c) => c.argv.join(' ') === 'exportfs -ra'));

    for (const [args, re] of [
      [{ dataset: 'tank/nope', smb: true }, /not-found|no such/],
      [{ dataset: 'tank/photos', nfsClients: ['a(rw)'] }, /not a host/],
      [{ dataset: 'tank/photos', smb: 'yes' }, /must be true or false/],
      [{ dataset: 'tank/photos', smb: true, guest: true }, /unexpected argument/],
    ] as [Record<string, unknown>, RegExp][]) {
      const r = await handle({ id: 3, verb: 'share.set', args }, deps, audit);
      assert.equal(r.ok, false, JSON.stringify(args));
      assert.match(!r.ok ? `${r.error.code} ${r.error.message}` : '', re);
    }

    const list = await handle({ id: 4, verb: 'shares' }, deps, audit);
    assert.equal(list.ok && (list.result as Share[]).length, 1);
    res = await handle({ id: 5, verb: 'share.remove', args: { dataset: 'tank/photos' } }, deps, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(!(await readFile(join(dir, 'smb.conf'), 'utf8')).includes('[photos]'));
    assert.ok(
      f.calls.some((c) => c.argv.join(' ') === 'systemctl disable --now smbd'),
      'no share left: samba goes down',
    );
    res = await handle({ id: 6, verb: 'share.remove', args: { dataset: 'tank/photos' } }, deps, audit);
    assert.equal(!res.ok && res.error.code, 'bad-args');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SMB users: useradd without a shell, the password on stdin only, redacted in the audit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-users-'));
  const audits: { verb: string; args: Record<string, unknown> }[] = [];
  const audit = async (l: unknown) => void audits.push(l as never);
  try {
    const f = fake({
      'getent group mk-nas-smb': { argv: [], exitCode: 2, stdout: '', stderr: '' },
      'groupadd --system mk-nas-smb': '',
      'getent passwd anna': { argv: [], exitCode: 2, stdout: '', stderr: '' },
      'useradd *': '',
      'smbpasswd *': '',
    });
    const deps: Deps = {
      run: f.run,
      version: 't',
      db: new Db(':memory:'),
      locationsDir: '/srv/locations',
      shares: cfg(dir),
      replication: { keyFile: join(dir, 'key'), knownHosts: join(dir, 'kh') },
      spawn: () => {},
      network: NET,
      backup: BKP,
    };
    let res = await handle({ id: 1, verb: 'user.smbPassword', args: { name: 'anna', password: 'correct horse battery' } }, deps, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    const useradd = f.calls.find((c) => c.argv[0] === 'useradd')!;
    assert.deepEqual(useradd.argv, [
      'useradd',
      '--system',
      '--no-create-home',
      '--shell',
      '/usr/sbin/nologin',
      '--gid',
      'mk-nas-smb',
      '--comment',
      'mk-nas SMB user',
      'anna',
    ]);
    const smbpasswd = f.calls.find((c) => c.argv[0] === 'smbpasswd' && c.argv.includes('-a'))!;
    assert.deepEqual(smbpasswd.argv, ['smbpasswd', '-a', '-s', 'anna']);
    assert.equal(smbpasswd.input, 'correct horse battery\ncorrect horse battery\n');
    assert.ok(
      f.calls.every((c) => !c.argv.includes('correct horse battery')),
      'the password is never an argument',
    );
    assert.equal(audits.at(-1)?.args.password, '[redacted]');
    const users = await handle({ id: 2, verb: 'users' }, deps, audit);
    assert.deepEqual(users.ok && (users.result as { name: string; hasPassword: boolean }[]).map((u) => [u.name, u.hasPassword]), [['anna', true]]);

    for (const [args, re] of [
      [{ name: 'root', password: 'correct horse battery' }, /not an SMB user name/],
      [{ name: 'anna', password: 'short' }, /8 to 128/],
      [{ name: 'anna', password: 'has\nnewline' }, /8 to 128/],
    ] as [Record<string, unknown>, RegExp][]) {
      const r = await handle({ id: 3, verb: 'user.smbPassword', args }, deps, audit);
      assert.match(!r.ok ? r.error.message : 'ok', re, JSON.stringify(args));
    }

    res = await handle({ id: 4, verb: 'user.remove', args: { name: 'anna' } }, deps, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(f.calls.some((c) => c.argv.join(' ') === 'smbpasswd -x anna'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SMB users: only accounts mk-nas made are changed or removed; an existing system account is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-users-'));
  const audit = async () => {};
  try {
    const none = { argv: [], exitCode: 2, stdout: '', stderr: '' };
    const f = fake({
      'getent group mk-nas-smb': 'mk-nas-smb:x:996:\n',
      'getent passwd www-data': 'www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\n',
      'getent passwd admin': 'admin:x:1000:1000:Admin,,,:/home/admin:/bin/bash\n',
      // the comment is ours but the primary group is not: someone else's account
      'getent passwd eve': 'eve:x:994:100:mk-nas SMB user:/nonexistent:/usr/sbin/nologin\n',
      'getent passwd bob': 'bob:x:995:996:mk-nas SMB user:/home/bob:/usr/sbin/nologin\n',
      'getent passwd carol': none,
      'useradd *': '',
      'smbpasswd *': '',
      'userdel *': '',
    });
    const deps: Deps = {
      run: f.run,
      version: 't',
      db: new Db(':memory:'),
      locationsDir: '/srv/locations',
      shares: cfg(dir),
      replication: { keyFile: join(dir, 'key'), knownHosts: join(dir, 'kh') },
      spawn: () => {},
      network: NET,
      backup: BKP,
    };
    const call = (verb: string, args: Record<string, unknown>) => handle({ id: 1, verb: verb as never, args }, deps, audit);
    const changes = () => f.calls.filter((c) => ['useradd', 'usermod', 'userdel', 'smbpasswd'].includes(c.argv[0]));

    for (const name of ['www-data', 'admin', 'eve']) {
      for (const [verb, args, re] of [
        ['user.set', { name }, /existing system account; use another name/],
        ['user.smbPassword', { name, password: 'correct horse battery' }, /existing system account; use another name/],
        ['user.remove', { name }, /mk-nas did not make/],
      ] as [string, Record<string, unknown>, RegExp][]) {
        const r = await call(verb, args);
        assert.equal(!r.ok && r.error.code, 'bad-args', `${verb} ${name}`);
        assert.match(!r.ok ? r.error.message : '', re);
      }
    }
    assert.deepEqual(changes(), [], 'nothing touched a foreign account');
    assert.deepEqual(deps.db.smbUsers(), []);

    let res = await call('user.set', { name: 'carol' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(changes()[0].argv.at(-1), 'carol');
    assert.equal(changes()[0].argv[0], 'useradd', 'a new name makes a new account');

    f.calls.length = 0;
    res = await call('user.smbPassword', { name: 'bob', password: 'correct horse battery' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(
      changes().map((c) => c.argv.join(' ')),
      ['smbpasswd -a -s bob', 'smbpasswd -e bob'],
      'an account mk-nas made (before the table knew it) gets its password, no useradd or usermod',
    );
    res = await call('user.remove', { name: 'bob' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(f.calls.some((c) => c.argv.join(' ') === 'userdel bob'));

    // an existing account an older agent put in the table: out of Samba and the table, the account itself stays
    deps.db.setSmbUser('admin', true);
    f.calls.length = 0;
    res = await call('user.remove', { name: 'admin' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(
      changes().map((c) => c.argv.join(' ')),
      ['smbpasswd -x admin'],
    );
    assert.equal(deps.db.smbUser('admin'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rows from a restored database: a share with an NFS client share.set would refuse, or a bad dataset name, never reaches the exports', async () => {
  const db = new Db(':memory:');
  db.setShare({ dataset: 'tank/ok', smb: false, timeMachine: false, nfs: true, nfsClients: ['192.168.1.0/24'] });
  db.setShare({ dataset: 'tank/evil', smb: false, timeMachine: false, nfs: true, nfsClients: ['*(rw,no_root_squash)'] });
  db.setShare({ dataset: '-o/evil', smb: true, timeMachine: false, nfs: false, nfsClients: [] });
  const run: Runner = async (argv) => ({ argv, exitCode: 0, stdout: '', stderr: '' });
  const errors: string[] = [];
  const original = console.error;
  console.error = (m: string) => void errors.push(m);
  try {
    const shares = await listShares(run, db);
    assert.deepEqual(
      shares.map((s) => s.dataset),
      ['tank/ok'],
    );
    assert.equal(errors.length, 2);
  } finally {
    console.error = original;
    db.close();
  }
});
