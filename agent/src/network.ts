/**
 * The box's address and name. Reading is `ip -j` and a few files; writing
 * is one netplan file of our own (90-mk-nas.yaml, so it wins over the
 * installer's) and hostnamectl. An address change is the one thing that
 * can lock the person out of the box they are changing it on, so it is
 * applied with a revert: the file that was there before is kept next to
 * an expiry, and unless `network.confirm` arrives in time the old file
 * goes back and netplan applies again. The check runs whenever the
 * network is read, when the agent starts, and on the timer's tick.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { NetInterface, Network, NetworkSetArgs } from '../../shared/types.ts';
import { BadArgs } from './names.ts';
import { must, type Runner } from './run.ts';
import { NIC } from './system.ts';

export interface NetConfig {
  /** The one netplan file the agent owns. */
  netplanFile: string;
  /** What was there before a change, with when it reverts. */
  pendingFile: string;
  hostsFile: string;
  resolvConf: string;
  sysNet: string;
}

interface Pending {
  interface: string;
  /** The netplan file's previous content, or null when there was none. */
  previous: string | null;
  since: string;
  expiresAt: string;
}

const IFACE = /^[a-z][a-z0-9.-]{0,14}$/;
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function ipv4(v: unknown, what: string): string {
  if (typeof v !== 'string' || !IPV4.test(v) || v.split('.').some((o) => Number(o) > 255)) throw new BadArgs(`${what}: not an IPv4 address`);
  return v;
}

/** a.b.c.d/nn, the prefix 1–32. */
export function cidr(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.includes('/')) throw new BadArgs(`${what}: not an address with a prefix (like 192.168.1.10/24)`);
  const [ip, len] = v.split('/');
  ipv4(ip, what);
  if (!/^\d{1,2}$/.test(len) || Number(len) < 1 || Number(len) > 32) throw new BadArgs(`${what}: the prefix must be 1 to 32`);
  return v;
}

export function hostName(v: unknown): string {
  if (typeof v !== 'string' || !HOST.test(v)) throw new BadArgs('hostname: letters, digits and dashes, up to 63, not starting or ending with a dash');
  return v.toLowerCase();
}

export function interfaceName(v: unknown): string {
  if (typeof v !== 'string' || !IFACE.test(v)) throw new BadArgs('interface: not an interface name');
  return v;
}

const toInt = (ip: string): number => ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);

function sameSubnet(addr: string, gateway: string): boolean {
  const [ip, len] = addr.split('/');
  const mask = len === '0' ? 0 : (0xffffffff << (32 - Number(len))) >>> 0;
  return (toInt(ip) & mask) === (toInt(gateway) & mask);
}

/** Our file, written by `render` and read back by `parseOwn`: a fixed shape, so no YAML library is needed. */
export function render(iface: string, cfg: NetInterface['configured'] & object): string {
  const lines = ['# Written by mk-nasd. Change it on the Storage → Network page, not here.', 'network:', '  version: 2', '  ethernets:', `    ${iface}:`];
  if (cfg.dhcp) lines.push('      dhcp4: true');
  else {
    lines.push('      dhcp4: false', `      addresses: [${cfg.address}]`);
    if (cfg.gateway) lines.push('      routes:', '        - to: default', `          via: ${cfg.gateway}`);
    if (cfg.dns.length) lines.push('      nameservers:', `        addresses: [${cfg.dns.join(', ')}]`);
  }
  return lines.join('\n') + '\n';
}

export function parseOwn(text: string | null): Map<string, NetInterface['configured'] & object> {
  const out = new Map<string, NetInterface['configured'] & object>();
  if (!text) return out;
  let name: string | null = null;
  let cur: { dhcp: boolean; address: string; gateway: string | null; dns: string[] } | null = null;
  for (const line of text.split('\n')) {
    const iface = /^    ([a-z][a-z0-9.-]*):\s*$/.exec(line);
    if (iface) {
      name = iface[1];
      cur = { dhcp: false, address: '', gateway: null, dns: [] };
      out.set(name, cur as NetInterface['configured'] & object);
      continue;
    }
    if (!cur) continue;
    const dhcp = /^      dhcp4: (true|false)/.exec(line);
    const addr = /^      addresses: \[(.*)\]/.exec(line);
    const via = /^          via: (\S+)/.exec(line);
    const dns = /^        addresses: \[(.*)\]/.exec(line);
    if (dhcp) cur.dhcp = dhcp[1] === 'true';
    else if (addr) cur.address = addr[1].trim();
    else if (via) cur.gateway = via[1];
    else if (dns)
      cur.dns = dns[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  }
  for (const [k, v] of out) if (v.dhcp) out.set(k, { dhcp: true });
  return out;
}

async function text(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function pending(cfg: NetConfig): Promise<Pending | null> {
  const t = await text(cfg.pendingFile);
  if (!t) return null;
  try {
    return JSON.parse(t) as Pending;
  } catch {
    return null;
  }
}

interface IpAddr {
  ifname: string;
  operstate: string;
  address?: string;
  link_type?: string;
  addr_info: { family: string; local: string; prefixlen: number; scope: string; dynamic?: boolean }[];
}

export async function readNetwork(run: Runner, cfg: NetConfig): Promise<Network> {
  const [addrs, routes, own, pend, resolv, mdns] = await Promise.all([
    must(run, ['ip', '-j', 'addr']).then((o) => JSON.parse(o || '[]') as IpAddr[]),
    run(['ip', '-j', 'route', 'show', 'default']).then((r) => (r.exitCode === 0 ? (JSON.parse(r.stdout || '[]') as { gateway?: string; dev?: string }[]) : [])),
    text(cfg.netplanFile).then(parseOwn),
    pending(cfg),
    text(cfg.resolvConf),
    run(['systemctl', 'is-active', 'avahi-daemon']).then((r) => r.exitCode === 0),
  ]);
  const interfaces: NetInterface[] = [];
  for (const a of addrs) {
    if (!NIC.test(a.ifname) || a.link_type === 'loopback') continue;
    const speed = await text(join(cfg.sysNet, a.ifname, 'speed'));
    const global = a.addr_info.filter((x) => x.scope === 'global');
    interfaces.push({
      name: a.ifname,
      mac: a.address ?? null,
      up: a.operstate === 'UP',
      speed: speed && Number(speed) > 0 ? Number(speed) : null,
      addresses: global.map((x) => `${x.local}/${x.prefixlen}`),
      dhcp: global.some((x) => x.dynamic === true),
      configured: own.get(a.ifname) ?? null,
    });
  }
  return {
    hostname: hostname(),
    mdns,
    gateway: routes[0]?.gateway ?? null,
    dns: (resolv ?? '')
      .split('\n')
      .filter((l) => l.startsWith('nameserver '))
      .map((l) => l.slice('nameserver '.length).trim()),
    interfaces,
    pending: pend ? { interface: pend.interface, since: pend.since, expiresAt: pend.expiresAt } : null,
  };
}

async function applyFile(run: Runner, cfg: NetConfig, content: string | null): Promise<void> {
  if (content === null) await rm(cfg.netplanFile, { force: true });
  else {
    await mkdir(dirname(cfg.netplanFile), { recursive: true });
    await writeFile(cfg.netplanFile, content, { mode: 0o600 });
  }
  await must(run, ['netplan', 'generate']);
  await must(run, ['netplan', 'apply'], { timeout: 120_000 });
}

/** Puts back what was there before the pending change and forgets it. */
export async function revert(run: Runner, cfg: NetConfig): Promise<boolean> {
  const p = await pending(cfg);
  if (!p) return false;
  // the note goes only once netplan took the old file: a revert that failed is tried again (the next read, start or tick)
  await applyFile(run, cfg, p.previous);
  await rm(cfg.pendingFile, { force: true });
  return true;
}

/** The revert that was promised: only once its time is up. */
export async function revertIfExpired(run: Runner, cfg: NetConfig, now = new Date()): Promise<boolean> {
  const p = await pending(cfg);
  if (!p || Date.parse(p.expiresAt) > now.getTime()) return false;
  return revert(run, cfg);
}

export async function confirmNetwork(run: Runner, cfg: NetConfig): Promise<Network> {
  await rm(cfg.pendingFile, { force: true });
  return readNetwork(run, cfg);
}

/** Only the 127.0.1.1 line that Ubuntu keeps for the box's own name; the rest of the file is not touched. */
function renameInHosts(hosts: string, from: string, to: string): string {
  return hosts
    .split('\n')
    .map((l) => (/^127\.0\.1\.1\s/.test(l) ? l.replace(new RegExp(`(\\s)${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i'), `$1${to}$2`) : l))
    .join('\n');
}

export async function setNetwork(run: Runner, cfg: NetConfig, a: NetworkSetArgs, now = new Date()): Promise<Network> {
  const wantsHost = a.hostname !== undefined;
  const wantsIface = a.interface !== undefined;
  if (!wantsHost && !wantsIface) throw new BadArgs('nothing to set: a hostname, or an interface with dhcp or an address');
  const host = wantsHost ? hostName(a.hostname) : null;
  let iface: string | null = null;
  let configured: (NetInterface['configured'] & object) | null = null;
  if (wantsIface) {
    iface = interfaceName(a.interface);
    const dhcp = a.dhcp === true;
    if (!dhcp && a.address === undefined) throw new BadArgs('an interface takes dhcp: true or an address');
    if (dhcp && (a.address !== undefined || a.gateway !== undefined || a.dns !== undefined)) throw new BadArgs('dhcp takes no address, gateway or dns');
    if (dhcp) configured = { dhcp: true };
    else {
      const address = cidr(a.address, 'address');
      const gateway = a.gateway === undefined || a.gateway === null || a.gateway === '' ? null : ipv4(a.gateway, 'gateway');
      if (gateway && !sameSubnet(address, gateway)) throw new BadArgs(`gateway ${gateway} is not on the subnet of ${address}`);
      if (a.dns !== undefined && !Array.isArray(a.dns)) throw new BadArgs('dns must be a list of addresses');
      const dns = (a.dns ?? []).map((d, i) => ipv4(d, `dns[${i}]`));
      if (dns.length > 3) throw new BadArgs('dns: up to three servers');
      configured = { dhcp: false, address, gateway, dns };
    }
    const net = await readNetwork(run, cfg);
    if (!net.interfaces.some((i) => i.name === iface)) throw new BadArgs(`${iface}: no such interface`);
    if (net.pending) throw new BadArgs(`a change to ${net.pending.interface} is still waiting to be kept or to revert`);
  }
  const revertAfter = a.revertAfter === undefined ? 120 : a.revertAfter;
  if (typeof revertAfter !== 'number' || !Number.isInteger(revertAfter) || revertAfter < 15 || revertAfter > 3600)
    throw new BadArgs('revertAfter: 15 to 3600 seconds');

  if (host !== null && host !== hostname()) {
    const before = hostname();
    await must(run, ['hostnamectl', 'set-hostname', host]);
    const hosts = await text(cfg.hostsFile);
    if (hosts !== null) await writeFile(cfg.hostsFile, renameInHosts(hosts, before, host));
    // avahi announces the name it started with; a restart announces the new one (and is harmless when it is not there)
    await run(['systemctl', 'try-restart', 'avahi-daemon']);
  }
  if (iface && configured) {
    const previous = await text(cfg.netplanFile);
    const own = parseOwn(previous);
    own.set(iface, configured);
    // one file, every interface we were ever told about; the rest stays with the installer's file
    const content = [...own].map(([n, c]) => render(n, c)).reduce((acc, r, i) => (i === 0 ? r : acc + r.split('\n').slice(4).join('\n') + '\n'), '');
    const p: Pending = { interface: iface, previous, since: now.toISOString(), expiresAt: new Date(now.getTime() + revertAfter * 1000).toISOString() };
    await mkdir(dirname(cfg.pendingFile), { recursive: true });
    await writeFile(cfg.pendingFile, JSON.stringify(p), { mode: 0o600 });
    try {
      await applyFile(run, cfg, content);
    } catch (e) {
      // netplan did not take it: nothing to wait for, the old file is back before anyone notices
      await revert(run, cfg).catch(() => {});
      throw e;
    }
  }
  return readNetwork(run, cfg);
}
