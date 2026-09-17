/** The wire: NDJSON over a Unix socket, ids matched, bad lines answered. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect, type Server } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle, listen, systemdFd } from '../src/server.ts';
import type { Runner } from '../src/run.ts';
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

let dir: string;
let server: Server;
let sockPath: string;
const audits: { verb: string }[] = [];

const run: Runner = async (argv) => ({ argv, exitCode: 0, stdout: argv[0] === 'zpool' ? 'tank\tONLINE\t10\t1\t9\t10\t0\n' : '', stderr: '' });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mk-nas-sock-'));
  sockPath = join(dir, 'mk-nas.sock');
  server = await listen({
    socket: sockPath,
    audit: async (l) => void audits.push(l),
    deps: {
      run,
      version: 't',
      db: new Db(':memory:'),
      locationsDir: '/srv/locations',
      shares: SHARES,
      replication: REPL,
      spawn: NOSPAWN,
      network: NET,
      backup: BKP,
    },
  });
});
after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

function talk(lines: string[], expect: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const out: Record<string, unknown>[] = [];
    let buf = '';
    const c = connect(sockPath);
    c.setEncoding('utf8');
    c.on('connect', () => c.write(lines.join('\n') + '\n'));
    c.on('data', (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        out.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
      if (out.length >= expect) {
        c.end();
        resolve(out);
      }
    });
    c.on('error', reject);
  });
}

test('socket is 0660', async () => {
  const s = await stat(sockPath);
  assert.equal(s.mode & 0o777, 0o660);
});

test('several requests on one connection, answered by id', async () => {
  const res = await talk([JSON.stringify({ id: 'x', verb: 'pools' }), JSON.stringify({ id: 2, verb: 'version' })], 2);
  const byId = Object.fromEntries(res.map((r) => [String(r.id), r]));
  assert.equal(byId.x.ok, true);
  assert.equal((byId.x.result as { name: string }[])[0].name, 'tank');
  assert.equal(byId['2'].ok, true);
  assert.deepEqual(audits.map((a) => a.verb).sort(), ['pools', 'version']);
});

test('bad lines are answered, not fatal', async () => {
  const res = await talk(
    ['not json', '[]', JSON.stringify({ verb: 'pools' }), JSON.stringify({ id: 1, verb: 'pools', args: [] }), JSON.stringify({ id: 9, verb: 'nope' })],
    5,
  );
  assert.deepEqual(
    res.map((r) => (r.error as { code: string }).code),
    ['bad-request', 'bad-request', 'bad-request', 'bad-request', 'unknown-verb'],
  );
  assert.equal(res[4].id, 9);
});

test('an audit that cannot be written (a full disk) does not change the answer or take the agent down', async () => {
  const full = async () => {
    throw new Error('ENOSPC: no space left on device');
  };
  const deps = { db: { policies: () => [] } } as never;
  const lines: string[] = [];
  const error = console.error;
  console.error = (l: string) => void lines.push(l);
  try {
    assert.deepEqual(await handle({ id: 1, verb: 'policies' }, deps, full), { id: 1, ok: true, result: [] });
    // the failing path audits too: still an answer, not a rejection
    const refused = await handle({ id: 2, verb: 'policies', args: { junk: 1 } }, deps, full);
    assert.equal(refused.ok, false);
    assert.equal((await handle({ id: 3, verb: 'nope' as never }, deps, full)).ok, false);
  } finally {
    console.error = error;
  }
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^audit not written \(ENOSPC.*"verb":"policies"/);
});

test('the 64 KB limit is per line: a burst of requests larger than that is answered whole, one over-long line is refused', async () => {
  const pad = 'x'.repeat(3000);
  const burst = Array.from({ length: 40 }, (_, i) => JSON.stringify({ id: i, verb: 'pools', pad }));
  assert.ok(burst.join('\n').length > 64 * 1024);
  const res = await talk(burst, 40);
  assert.equal(res.filter((r) => r.ok === true).length, 40);
  const long = await talk([JSON.stringify({ id: 1, verb: 'pools', pad: 'x'.repeat(70 * 1024) })], 1);
  assert.deepEqual(long[0], { id: null, ok: false, error: { code: 'bad-request', message: 'line too long' } });
  // a line that never ends is cut off as soon as it is too long, without waiting for its newline
  const endless = await new Promise<string>((resolve, reject) => {
    const c = connect(sockPath);
    let got = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write('y'.repeat(70 * 1024)));
    c.on('data', (d: string) => (got += d));
    c.on('close', () => resolve(got));
    c.on('error', reject);
  });
  assert.match(endless, /line too long/);
});

test('systemdFd: descriptor 3 only when LISTEN_FDS is meant for this process', () => {
  assert.equal(systemdFd({ LISTEN_PID: '42', LISTEN_FDS: '1' }, 42), 3);
  assert.equal(systemdFd({ LISTEN_PID: '41', LISTEN_FDS: '1' }, 42), null, 'inherited from a parent: not ours');
  assert.equal(systemdFd({ LISTEN_PID: '42', LISTEN_FDS: '0' }, 42), null);
  assert.equal(systemdFd({}, 42), null);
});

const activate = ['/usr/bin/systemd-socket-activate', '/bin/systemd-socket-activate'].find((p) => existsSync(p));

test(
  'a socket handed over by systemd: the agent answers on it and leaves the file alone when it goes',
  { skip: activate ? false : 'needs systemd-socket-activate' },
  async () => {
    const path = join(dir, 'activated.sock');
    const fixture = new URL('./fixtures/activated.ts', import.meta.url).pathname;
    const child = spawn(activate!, ['-l', path, process.execPath, fixture], { stdio: 'ignore', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    try {
      for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 20));
      const before = await stat(path);
      const ask = () =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const c = connect(path);
          c.setEncoding('utf8');
          c.on('connect', () => c.write(JSON.stringify({ id: 1, verb: 'policies' }) + '\n'));
          c.on('data', (d: string) => (c.end(), resolve(JSON.parse(d))));
          c.on('error', reject);
        });
      // the first call is what starts the agent, and it waited for it instead of failing
      assert.deepEqual(await ask(), { id: 1, ok: true, result: [] });
      assert.deepEqual(await ask(), { id: 1, ok: true, result: [] });
      const gone = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await gone;
      const after = await stat(path);
      assert.equal(after.ino, before.ino, 'the same file: a container that has it mounted still reaches the next agent');
    } finally {
      child.kill('SIGKILL');
    }
  },
);
