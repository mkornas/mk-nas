/** The wire: NDJSON over a Unix socket, ids matched, bad lines answered. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, type Server } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listen } from '../src/server.ts';
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
