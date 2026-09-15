/** The CLI against an in-process agent on a temp socket with a fake runner. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
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
import type { Runner } from '../src/run.ts';
import { listen } from '../src/server.ts';

let dir: string;
let server: Server;
let sock: string;
let db: Db;
const cli = new URL('../src/cli.ts', import.meta.url).pathname;
const run: Runner = async (argv) => ({
  argv,
  exitCode: 0,
  stdout: argv[1] === 'list' && argv[0] === 'zpool' ? 'tank\tONLINE\t1000\t100\t900\t10\t0\n' : argv[0] === 'lsblk' ? '{"blockdevices":[]}' : '',
  stderr: '',
});

function mk(args: string[], stdin = '', env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = execFile(process.execPath, [cli, ...args], { env: { ...process.env, MK_NAS_SOCKET: sock, NODE_NO_WARNINGS: '1', ...env } }, (e, out, err) =>
      resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: String(out), err: String(err) }),
    );
    p.stdin?.end(stdin);
  });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mk-nas-cli-'));
  sock = join(dir, 'mk-nas.sock');
  db = new Db(':memory:');
  server = await listen({
    socket: sock,
    audit: async () => {},
    deps: { run, version: 't', db, locationsDir: dir, shares: SHARES, replication: REPL, spawn: NOSPAWN, network: NET, backup: BKP },
  });
});
after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('pools: a table, or JSON with --json', async () => {
  const t = await mk(['pools']);
  assert.equal(t.code, 0, t.err);
  assert.match(t.out, /^POOL\s+HEALTH\s+SIZE/m);
  assert.match(t.out, /tank\s+ONLINE\s+1000B\s+100B\s+900B\s+10%/);
  const j = await mk(['pools', '--json']);
  assert.equal(JSON.parse(j.out)[0].name, 'tank');
});

test('destructive commands need the name: refused without a terminal, accepted with --confirm', async () => {
  const refused = await mk(['snapshot', 'destroy', 'tank/x@y']);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--confirm tank\/x@y/);
  const wrong = await mk(['snapshot', 'destroy', 'tank/x@y', '--confirm', 'nope']);
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /type the name/);
  const ok = await mk(['snapshot', 'destroy', 'tank/x@y', '--confirm', 'tank/x@y']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /destroyed tank\/x@y/);
  const sp = await mk(['scrub', 'policy', 'tank', 'weekly']);
  assert.equal(sp.code, 0, sp.err);
  assert.match(sp.out, /tank: scrub weekly/);
  const ds = await mk(['dataset', 'destroy', 'tank/x', '--snapshots']);
  assert.equal(ds.code, 2);
  assert.match(ds.err, /--confirm tank\/x/);
});

test('__complete: commands, then what fits — pool names from the agent, flags where they belong, nothing when the agent cannot answer', async () => {
  const top = await mk(['__complete']);
  assert.equal(top.code, 0, top.err);
  assert.ok(top.out.split('\n').includes('dataset'));
  const pool = await mk(['__complete', 'pool']);
  assert.deepEqual(pool.out.trim().split('\n'), ['create', 'tank']);
  const scrub = await mk(['__complete', 'scrub', 'policy', 'tank']);
  assert.deepEqual(scrub.out.trim().split('\n'), ['off', 'weekly', 'monthly']);
  const flags = await mk(['__complete', 'dataset', 'set', 'tank/x']);
  assert.ok(flags.out.includes('--quota'));
  const nothing = await mk(['__complete', 'wipe', 'x']);
  assert.equal(nothing.out, '');
  const down = await new Promise<{ out: string; code: number | null }>((resolve) =>
    execFile(process.execPath, [cli, '__complete', 'pool'], { env: { ...process.env, MK_NAS_SOCKET: '/nonexistent.sock', NODE_NO_WARNINGS: '1' } }, (e, out) =>
      resolve({ out: String(out), code: e ? ((e as { code?: number }).code ?? 1) : 0 }),
    ),
  );
  assert.equal(down.code, 0, 'the shell must never see an error');
  assert.equal(down.out.trim(), 'create', 'the static words still come');
});

test("sizes and flags become the verb's arguments", async () => {
  const bad = await mk(['dataset', 'create', 'tank/docs', '--quota', 'lots']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /not a size/);
  const r = await mk(['call', 'nope']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no such verb/);
  const down = await mk(['pools']).then(() => mk(['health']));
  assert.equal(down.code, 0, down.err);
  const none = await new Promise<{ code: number | null; err: string }>((resolve) =>
    execFile(process.execPath, [cli, 'pools'], { env: { ...process.env, MK_NAS_SOCKET: join(dir, 'absent.sock'), NODE_NO_WARNINGS: '1' } }, (e, _o, err) =>
      resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, err: String(err) }),
    ),
  );
  assert.equal(none.code, 1);
  assert.match(none.err, /the agent is not running/);
});

test('shares: NFS shows who may mount it, or that nobody may yet', async () => {
  db.setShare({ dataset: 'tank/docs', smb: false, timeMachine: false, nfs: true, nfsClients: ['192.168.1.0/24', 'laptop'], smbAccess: null });
  db.setShare({ dataset: 'tank/old', smb: false, timeMachine: false, nfs: true, nfsClients: [], smbAccess: null });
  try {
    const t = await mk(['shares']);
    assert.equal(t.code, 0, t.err);
    assert.match(t.out, /tank\/docs .*on for 192\.168\.1\.0\/24 laptop/);
    assert.match(t.out, /tank\/old .*on, no clients yet/);
    assert.ok(!t.out.includes('private networks'));
  } finally {
    db.removeShare('tank/docs');
    db.removeShare('tank/old');
  }
});

test('setup-code: root only, read straight from the stack env, never through the agent', async () => {
  const env = join(dir, 'drive.env');
  await writeFile(env, 'TZ=UTC\nDRIVE_SETUP_TOKEN=\nDRIVE_SETUP_TOKEN=K7PQ-2MZX-9RTD\n', { mode: 0o600 });
  const r = await mk(['setup-code'], '', { MK_NAS_DRIVE_ENV: env, MK_NAS_SOCKET: join(dir, 'absent.sock') });
  if (process.getuid?.() === 0) {
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'K7PQ-2MZX-9RTD\n');
    await writeFile(env, 'TZ=UTC\n');
    const none = await mk(['setup-code'], '', { MK_NAS_DRIVE_ENV: env });
    assert.equal(none.code, 1);
    assert.match(none.err, /no DRIVE_SETUP_TOKEN/);
  } else {
    assert.equal(r.code, 1);
    assert.equal(r.out, '');
    assert.match(r.err, /only root can read: sudo mk-nas setup-code/);
  }
  const top = await mk(['__complete']);
  assert.ok(top.out.split('\n').includes('setup-code'));
});
