/** The network verbs against a fake ip/netplan/hostnamectl and temp files: what is read, what is written, the revert. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Network } from '../../shared/types.ts';
import { Db } from '../src/db.ts';
import type { NetConfig } from '../src/network.ts';
import { parseOwn, render, revertIfExpired } from '../src/network.ts';
import type { Runner, RunResult } from '../src/run.ts';
import { handle } from '../src/server.ts';
import type { Deps } from '../src/verbs.ts';

const ADDR = JSON.stringify([
  {
    ifname: 'lo',
    operstate: 'UNKNOWN',
    link_type: 'loopback',
    address: '00:00:00:00:00:00',
    addr_info: [{ family: 'inet', local: '127.0.0.1', prefixlen: 8, scope: 'host' }],
  },
  {
    ifname: 'enp3s0',
    operstate: 'UP',
    link_type: 'ether',
    address: '02:00:00:00:00:0a',
    addr_info: [
      { family: 'inet', local: '192.168.1.147', prefixlen: 24, scope: 'global', dynamic: true },
      { family: 'inet6', local: 'fe80::1', prefixlen: 64, scope: 'link' },
    ],
  },
  { ifname: 'wlp0s20f3', operstate: 'DOWN', link_type: 'ether', address: '02:00:00:00:00:0b', addr_info: [] },
  {
    ifname: 'docker0',
    operstate: 'UP',
    link_type: 'ether',
    address: '02:42:00:00:00:01',
    addr_info: [{ family: 'inet', local: '172.17.0.1', prefixlen: 16, scope: 'global' }],
  },
]);
const ROUTE = JSON.stringify([{ dst: 'default', gateway: '192.168.1.1', dev: 'enp3s0' }]);

function fake(extra: Record<string, string | RunResult> = {}): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const table: Record<string, string | RunResult> = {
    'ip -j addr': ADDR,
    'ip -j route show default': ROUTE,
    'systemctl is-active avahi-daemon': 'active\n',
    'netplan generate': '',
    'netplan apply': '',
    'systemctl try-restart avahi-daemon': '',
    ...extra,
  };
  const run: Runner = async (argv) => {
    calls.push(argv);
    const key = argv.join(' ');
    const hit = table[key] ?? table[Object.keys(table).find((k) => k.endsWith('*') && key.startsWith(k.slice(0, -1))) ?? ''];
    if (hit === undefined) return { argv, exitCode: 1, stdout: '', stderr: `fake: no such command: ${key}` };
    return typeof hit === 'string' ? { argv, exitCode: 0, stdout: hit, stderr: '' } : { ...hit, argv };
  };
  return { run, calls };
}

async function setup(): Promise<{ dir: string; net: NetConfig }> {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-net-'));
  await mkdir(join(dir, 'sys', 'enp3s0'), { recursive: true });
  await writeFile(join(dir, 'sys', 'enp3s0', 'speed'), '1000\n');
  await writeFile(join(dir, 'resolv.conf'), '# generated\nnameserver 192.168.1.1\nnameserver 1.1.1.1\nsearch .\n');
  await writeFile(join(dir, 'hosts'), `127.0.0.1 localhost\n127.0.1.1 ${hostname()}\n\n::1 ip6-localhost\n`);
  return {
    dir,
    net: {
      netplanFile: join(dir, 'netplan', '90-mk-nas.yaml'),
      pendingFile: join(dir, 'pending.json'),
      hostsFile: join(dir, 'hosts'),
      resolvConf: join(dir, 'resolv.conf'),
      sysNet: join(dir, 'sys'),
    },
  };
}
const deps = (run: Runner, net: NetConfig): Deps => ({
  run,
  version: 't',
  db: new Db(':memory:'),
  locationsDir: '',
  shares: { smbConf: '', exportsFile: '', smbGroup: 'g', ownerUid: 1000, ownerGid: 1000, hostname: 't' },
  replication: { keyFile: '', knownHosts: '' },
  spawn: () => {},
  network: net,
  backup: { db: '', sshKey: '', knownHosts: '', netplanFile: '', driveEnv: '', driveDb: '' },
});
const audit = async () => {};

test('network: interfaces from ip -j addr (no loopback, no docker), speed from sys, gateway, dns, mdns', async () => {
  const { dir, net } = await setup();
  try {
    const f = fake();
    const res = await handle({ id: 1, verb: 'network' }, deps(f.run, net), audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    const n = res.ok ? (res.result as Network) : null;
    assert.equal(n?.hostname, hostname());
    assert.equal(n?.mdns, true);
    assert.equal(n?.gateway, '192.168.1.1');
    assert.deepEqual(n?.dns, ['192.168.1.1', '1.1.1.1']);
    assert.deepEqual(
      n?.interfaces.map((i) => [i.name, i.up, i.speed, i.addresses, i.dhcp, i.configured]),
      [
        ['enp3s0', true, 1000, ['192.168.1.147/24'], true, null],
        ['wlp0s20f3', false, null, [], false, null],
      ],
    );
    assert.equal(n?.pending, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('render and parseOwn round-trip the one file the agent owns', () => {
  const dhcp = render('enp3s0', { dhcp: true });
  const fixed = render('enp3s0', { dhcp: false, address: '192.168.1.10/24', gateway: '192.168.1.1', dns: ['1.1.1.1', '9.9.9.9'] });
  assert.match(dhcp, /^network:\n {2}version: 2\n {2}ethernets:\n {4}enp3s0:\n {6}dhcp4: true\n$/m);
  assert.deepEqual(parseOwn(dhcp).get('enp3s0'), { dhcp: true });
  assert.deepEqual(parseOwn(fixed).get('enp3s0'), { dhcp: false, address: '192.168.1.10/24', gateway: '192.168.1.1', dns: ['1.1.1.1', '9.9.9.9'] });
  assert.equal(parseOwn(null).size, 0);
});

test('network.set: refusals never touch anything; the hostname goes through hostnamectl and /etc/hosts; an address is written, applied and pending', async () => {
  const { dir, net } = await setup();
  try {
    const f = fake({ 'hostnamectl set-hostname *': '' });
    const d = deps(f.run, net);
    const refused = async (args: Record<string, unknown>, re: RegExp) => {
      const res = await handle({ id: 1, verb: 'network.set', args }, d, audit);
      assert.equal(res.ok, false, JSON.stringify(args));
      assert.match(!res.ok ? res.error.message : '', re);
    };
    await refused({}, /nothing to set/);
    await refused({ hostname: '-bad' }, /hostname:/);
    await refused({ hostname: 'a b' }, /hostname:/);
    await refused({ interface: 'eth0; rm', dhcp: true }, /not an interface name/);
    await refused({ interface: 'eth9', dhcp: true }, /no such interface/);
    await refused({ interface: 'enp3s0' }, /dhcp: true or an address/);
    await refused({ interface: 'enp3s0', dhcp: true, address: '10.0.0.1/24' }, /dhcp takes no/);
    await refused({ interface: 'enp3s0', address: '10.0.0.1' }, /prefix/);
    await refused({ interface: 'enp3s0', address: '10.0.0.300/24' }, /not an IPv4/);
    await refused({ interface: 'enp3s0', address: '10.0.0.1/24', gateway: '10.0.1.1' }, /not on the subnet/);
    await refused({ interface: 'enp3s0', address: '10.0.0.1/24', dns: ['a'] }, /dns\[0\]/);
    await refused({ interface: 'enp3s0', address: '10.0.0.1/24', revertAfter: 5 }, /revertAfter/);
    assert.ok(!f.calls.some((c) => c[0] === 'netplan' || c[0] === 'hostnamectl'), 'nothing applied by a refused call');
    await assert.rejects(stat(net.netplanFile));

    let res = await handle({ id: 2, verb: 'network.set', args: { hostname: 'Nas' } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(
      f.calls.some((c) => c.join(' ') === 'hostnamectl set-hostname nas'),
      'lower-cased',
    );
    assert.ok(f.calls.some((c) => c.join(' ') === 'systemctl try-restart avahi-daemon'));
    assert.match(await readFile(net.hostsFile, 'utf8'), /^127\.0\.1\.1 nas$/m);
    assert.match(await readFile(net.hostsFile, 'utf8'), /^127\.0\.0\.1 localhost$/m, 'the rest of hosts untouched');

    const before = new Date('2026-09-13T10:00:00Z');
    res = await handle(
      { id: 3, verb: 'network.set', args: { interface: 'enp3s0', address: '192.168.1.10/24', gateway: '192.168.1.1', dns: ['192.168.1.1', '1.1.1.1'] } },
      d,
      audit,
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    const n = res.ok ? (res.result as Network) : null;
    assert.equal(n?.pending?.interface, 'enp3s0');
    assert.ok(Date.parse(n!.pending!.expiresAt) - Date.parse(n!.pending!.since) === 120_000, '120 s by default');
    assert.equal(
      await readFile(net.netplanFile, 'utf8'),
      [
        '# Written by mk-nasd. Change it on the Storage → Network page, not here.',
        'network:',
        '  version: 2',
        '  ethernets:',
        '    enp3s0:',
        '      dhcp4: false',
        '      addresses: [192.168.1.10/24]',
        '      routes:',
        '        - to: default',
        '          via: 192.168.1.1',
        '      nameservers:',
        '        addresses: [192.168.1.1, 1.1.1.1]',
        '',
      ].join('\n'),
    );
    assert.equal((await stat(net.netplanFile)).mode & 0o777, 0o600, 'netplan wants it private');
    const netplan = f.calls.filter((c) => c[0] === 'netplan').map((c) => c.join(' '));
    assert.deepEqual(netplan, ['netplan generate', 'netplan apply']);
    assert.deepEqual(n?.interfaces[0].configured, { dhcp: false, address: '192.168.1.10/24', gateway: '192.168.1.1', dns: ['192.168.1.1', '1.1.1.1'] });

    await refused({ interface: 'enp3s0', dhcp: true }, /still waiting/);

    // kept: the pending note goes, the file stays
    res = await handle({ id: 4, verb: 'network.confirm' }, d, audit);
    assert.equal(res.ok && (res.result as Network).pending, null);
    assert.ok(await stat(net.netplanFile));

    // a second interface joins the same file; the first keeps its lines
    res = await handle({ id: 5, verb: 'network.set', args: { interface: 'wlp0s20f3', dhcp: true, revertAfter: 30 } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    const own = parseOwn(await readFile(net.netplanFile, 'utf8'));
    assert.deepEqual([...own.keys()], ['enp3s0', 'wlp0s20f3']);
    assert.deepEqual(own.get('wlp0s20f3'), { dhcp: true });
    assert.equal(own.get('enp3s0')?.dhcp, false);

    // not kept in time: the previous file comes back and netplan applies again
    assert.equal(await revertIfExpired(f.run, net, new Date(Date.now() + 29_000)), false, 'not yet');
    f.calls.length = 0;
    assert.equal(await revertIfExpired(f.run, net, new Date(Date.now() + 31_000)), true);
    assert.deepEqual([...parseOwn(await readFile(net.netplanFile, 'utf8')).keys()], ['enp3s0']);
    assert.deepEqual(
      f.calls.filter((c) => c[0] === 'netplan').map((c) => c.join(' ')),
      ['netplan generate', 'netplan apply'],
    );
    await assert.rejects(stat(net.pendingFile));
    void before;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('network.set: when netplan refuses the file, the old one is back at once and the error is the reason', async () => {
  const { dir, net } = await setup();
  try {
    await mkdir(join(dir, 'netplan'));
    await writeFile(net.netplanFile, render('enp3s0', { dhcp: true }));
    const f = fake();
    let generates = 0;
    // the new file is refused; the old one, put back, passes
    const run: Runner = (argv, o) =>
      argv.join(' ') === 'netplan generate' && ++generates === 1
        ? Promise.resolve({ argv, exitCode: 1, stdout: '', stderr: 'Error in network definition: invalid IP address\n' })
        : f.run(argv, o);
    const res = await handle({ id: 1, verb: 'network.set', args: { interface: 'enp3s0', address: '10.0.0.1/24' } }, deps(run, net), audit);
    assert.equal(res.ok, false);
    assert.match(!res.ok ? res.error.message : '', /invalid IP address/);
    assert.equal(await readFile(net.netplanFile, 'utf8'), render('enp3s0', { dhcp: true }), 'the previous file is back');
    await assert.rejects(stat(net.pendingFile));
    // the refused generate never reached the fake; the revert's generate and apply did
    assert.equal(generates, 2);
    assert.deepEqual(
      f.calls.filter((c) => c[0] === 'netplan').map((c) => c.join(' ')),
      ['netplan generate', 'netplan apply'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
