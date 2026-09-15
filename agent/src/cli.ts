#!/opt/mk-nas/node/bin/node
/**
 * mk-nas: the agent's verbs from a shell, over the same socket, with the
 * same audit. For ssh sessions, scripts, and the day the web UI is down.
 *
 *   mk-nas health | disks | pools | datasets | snapshots | scrubs | policies | version
 *   mk-nas pool <name>
 *   mk-nas pool create <name> --mirror|--raidz1|--raidz2|--single <disk-id>...   (asks you to type the name)
 *   mk-nas scrub <pool> | scrub policies | scrub policy <pool> off|weekly|monthly   (a pool without a policy is scrubbed monthly)
 *   mk-nas jobs [pool]                       every job, or one pool's scrubs and resilvers
 *   mk-nas events [--all]                    what ZFS reported, newest first (--all: the routine ones too)
 *   mk-nas system                            the box at a glance: load, cpu, memory, network and disk rates, temperatures
 *   mk-nas backup | backup set <dataset>|off | backup now | backup restore <dataset>   (asks you to type the dataset)
 *   mk-nas network | network hostname <name> | network keep
 *   mk-nas network set <iface> --dhcp | --address 192.168.1.10/24 [--gateway 192.168.1.1] [--dns 1.1.1.1,9.9.9.9] [--revert 120]
 *                                            (an address change reverts after --revert seconds unless `network keep` is run from the new address)
 *   mk-nas replace <pool> <old-member> <new-disk-id>   (asks you to type the pool name)
 *   mk-nas importable | import <pool>
 *   mk-nas wipe <disk-id>
 *   mk-nas smart <disk-id> | smart test <disk-id> short|long
 *   mk-nas dataset create <pool/name> [--quota 10G] [--compression lz4|zstd|gzip|off] [--atime on|off] [--location]
 *   mk-nas dataset set <pool/name> [--quota 10G|none] [--compression …] [--atime on|off]
 *   mk-nas dataset destroy <pool/name> [--snapshots]   (asks you to type the name; refused with children)
 *   mk-nas snapshot <dataset> [name]
 *   mk-nas snapshot destroy <dataset@name> | rollback <dataset@name>
 *   mk-nas policy <dataset> <hourly> <daily> <weekly> <monthly>
 *   mk-nas shares | share <dataset> [--smb on|off] [--time-machine on|off] [--nfs on|off] [--clients 192.168.1.0/24,laptop] | unshare <dataset>
 *   mk-nas users | user <name> (asks for the SMB password) | user remove <name>
 *   mk-nas replication key | test <user@host[:port]> <target-dataset> | list | jobs
 *   mk-nas replication add <dataset> <user@host[:port]> <target-dataset> [--schedule manual|hourly|daily|weekly] [--keep 3] [--recursive]
 *   mk-nas replication run <id> | remove <id>
 *   mk-nas call <verb> [json-args]           any verb, raw
 *   mk-nas __complete <words…>               what may come next (for the bash and zsh completion in the package)
 *
 * --json prints the result as JSON. --confirm <name> types the name for you (scripts).
 * Needs root or the mk-nas group. MK_NAS_SOCKET overrides /run/mk-nas.sock.
 */
import { connect } from 'node:net';
import { createInterface } from 'node:readline/promises';
import type { Response, Verb } from '../../shared/types.ts';

const socket = process.env.MK_NAS_SOCKET || '/run/mk-nas.sock';
const argv = process.argv.slice(2);
const json = take('--json') !== undefined;
const preConfirm = take('--confirm', true);

function take(flag: string, withValue = false): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = withValue ? argv[i + 1] : '';
  argv.splice(i, withValue ? 2 : 1);
  return v;
}

function usage(msg?: string): never {
  if (msg) console.error(`mk-nas: ${msg}`);
  console.error(
    'usage: mk-nas health|disks|pools|datasets|snapshots|scrubs|policies|version | pool <name> | pool create … | scrub <pool> | wipe <disk> | dataset create|set|destroy … | snapshot … | policy … | call <verb> [json]',
  );
  process.exit(2);
}

function call(verb: string, args?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const c = connect(socket);
    let buf = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write(JSON.stringify({ id: 1, verb, args }) + '\n'));
    c.on('data', (d: string) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      c.end();
      const res = JSON.parse(buf.slice(0, nl)) as Response;
      if (res.ok) resolve(res.result);
      else reject(new Error(`${res.error.message}${res.error.detail?.stderr ? '\n' + res.error.detail.stderr.trim() : ''}`));
    });
    c.on('error', (e: NodeJS.ErrnoException) =>
      reject(
        new Error(
          e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
            ? `the agent is not running (${socket})`
            : e.code === 'EACCES'
              ? `no access to ${socket}: run as root or join the mk-nas group`
              : e.message,
        ),
      ),
    );
  });
}

const UNITS: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
export function size(v: string): number | null {
  if (v === 'none' || v === '0') return null;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt])?i?b?$/i.exec(v.trim());
  if (!m) usage(`not a size: ${v} (try 10G, 500M, none)`);
  return Math.round(Number(m[1]) * (m[2] ? UNITS[m[2].toLowerCase()] : 1));
}

const human = (n: number | null): string => {
  if (n === null) return '—';
  const u = ['B', 'K', 'M', 'G', 'T', 'P'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`;
};

function table(rows: Record<string, unknown>[], cols: string[]): string {
  if (rows.length === 0) return '(none)';
  const cells = rows.map((r) => cols.map((c) => String(r[c] ?? '')));
  const w = cols.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const line = (r: string[]) =>
    r
      .map((v, i) => v.padEnd(w[i]))
      .join('  ')
      .trimEnd();
  return [line(cols.map((c) => c.toUpperCase())), ...cells.map(line)].join('\n');
}

async function confirm(name: string): Promise<string> {
  if (preConfirm !== undefined) return preConfirm;
  if (!process.stdin.isTTY) usage(`type the name to confirm: add --confirm ${name}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = await rl.question(`Type ${name} to confirm: `);
  rl.close();
  return typed.trim();
}

/** A secret from the terminal without echo, or the first line of stdin when piped. */
async function secret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.split(/\r?\n/)[0] ?? '';
  }
  process.stderr.write(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  (rl as unknown as { _writeToOutput: () => void })._writeToOutput = () => {};
  try {
    return await rl.question('');
  } finally {
    rl.close();
    process.stderr.write('\n');
  }
}

function opts(rest: string[]): { flags: Record<string, string | true>; words: string[] } {
  const flags: Record<string, string | true> = {};
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else words.push(a);
  }
  return { flags, words };
}

function datasetProps(flags: Record<string, string | true>): Record<string, unknown> {
  const a: Record<string, unknown> = {};
  if (typeof flags.quota === 'string') a.quota = size(flags.quota);
  if (typeof flags.compression === 'string') a.compression = flags.compression;
  if (typeof flags.atime === 'string') a.atime = flags.atime === 'on';
  return a;
}

function print(verb: string, result: unknown): void {
  if (json) return void console.log(JSON.stringify(result, null, 2));
  const r = result as any;
  switch (verb) {
    case 'version':
      return void console.log(
        `mk-nasd ${r.agent} on ${r.hostname} · node ${r.node} · ${r.zfs ?? 'no zfs'} · ${r.smartctl ? 'smartctl ' + r.smartctl : 'no smartctl'}`,
      );
    case 'health':
      console.log(r.ok ? 'OK — every pool online, every disk healthy' : `PROBLEMS:\n  ${r.problems.join('\n  ')}`);
      console.log(
        table(
          r.pools.map((p: any) => ({ pool: p.name, health: p.health, used: p.capacity + '%' })),
          ['pool', 'health', 'used'],
        ),
      );
      if (r.events?.length)
        console.log(
          `\nIN THE LAST DAY:\n  ${r.events.map((e: any) => `${e.time.replace('T', ' ').slice(0, 16)}  ${e.summary}${e.count > 1 ? ` (×${e.count})` : ''}`).join('\n  ')}`,
        );
      return;
    case 'system': {
      const up = Math.round(r.uptime / 3600);
      console.log(`${r.hostname}: up ${up >= 48 ? `${Math.round(up / 24)} days` : `${up} h`}, ${r.cores} cores, load ${r.now?.load.join(' ') ?? '?'}`);
      if (!r.now) return void console.log('(first reading; ask again in a few seconds)');
      const n = r.now;
      console.log(`cpu ${n.cpu}%  memory ${human(n.memory.used)} of ${human(n.memory.total)}  swap ${human(n.swap.used)} of ${human(n.swap.total)}`);
      for (const x of n.net) console.log(`${x.name}: ${human(x.rx)}/s in, ${human(x.tx)}/s out`);
      for (const d of n.disks) {
        const known = r.disks.find((k: any) => k.dev === d.dev);
        console.log(`${d.dev}${known?.pool ? ` (${known.pool})` : ''}: ${human(d.read)}/s read, ${human(d.write)}/s write, ${d.busy}% busy`);
      }
      if (n.temps.length) console.log(n.temps.map((t: any) => `${t.label ?? t.sensor} ${t.celsius} °C`).join('  '));
      return;
    }
    case 'backup':
    case 'backup.set':
    case 'backup.run':
      if (!r.dataset) return void console.log('no settings backup: mk-nas backup set <dataset>');
      console.log(
        `settings → ${r.dataset}: ${r.lastAt ? `last ${r.lastResult} ${r.lastAt.replace('T', ' ').slice(0, 16)}${r.lastMessage ? ` (${r.lastMessage})` : ''}` : 'never run yet'}; ${r.snapshots} snapshot${r.snapshots === 1 ? '' : 's'} kept`,
      );
      if (r.files.length) console.log(`holds ${r.files.join(', ')} from ${r.takenAt?.replace('T', ' ').slice(0, 16)}`);
      return;
    case 'backup.restore':
      return void console.log(
        `restoring ${r.files.length} files from ${r.takenAt.replace('T', ' ').slice(0, 16)}; the agent and the drive restart in a moment`,
      );
    case 'network':
    case 'network.set':
    case 'network.confirm': {
      console.log(`${r.hostname}${r.mdns ? ` (${r.hostname}.local)` : ''}  gateway ${r.gateway ?? '—'}  dns ${r.dns.join(' ') || '—'}`);
      console.log(
        table(
          r.interfaces.map((i: any) => ({
            interface: i.name,
            link: i.up ? `up${i.speed ? ` ${i.speed >= 1000 ? `${i.speed / 1000}G` : `${i.speed}M`}` : ''}` : 'down',
            addresses: i.addresses.join(' ') || '—',
            via: i.configured ? (i.configured.dhcp ? 'dhcp (mk-nas)' : 'static (mk-nas)') : i.dhcp ? 'dhcp' : 'static',
          })),
          ['interface', 'link', 'addresses', 'via'],
        ),
      );
      if (r.pending)
        console.log(
          `\nPENDING: ${r.pending.interface} changed; run \`mk-nas network keep\` from the new address before ${r.pending.expiresAt.replace('T', ' ').slice(0, 19)} or it reverts.`,
        );
      return;
    }
    case 'events':
      return void console.log(
        table(
          r.map((e: any) => ({ time: e.time.replace('T', ' ').slice(0, 19), what: e.summary + (e.count > 1 ? ` (×${e.count})` : ''), class: e.class })),
          ['time', 'what', 'class'],
        ),
      );
    case 'disks':
      return void console.log(
        table(
          r.map((d: any) => ({
            disk: d.id,
            size: human(d.size),
            type: `${d.transport ?? '?'} ${d.rotational ? 'hdd' : 'ssd'}`,
            use:
              d.use.kind === 'pool'
                ? d.use.imported === false
                  ? `old pool ${d.use.pool} (not imported)`
                  : `pool ${d.use.pool}`
                : d.use.kind === 'other'
                  ? d.use.what
                  : d.use.kind,
            smart: d.smart
              ? `${d.smart.passed === false ? 'FAILED' : 'ok'}${d.smart.temperature !== null ? ' ' + d.smart.temperature + '°C' : ''}${d.smart.pending ? ' pending:' + d.smart.pending : ''}${d.smart.reallocated ? ' realloc:' + d.smart.reallocated : ''}`
              : '—',
          })),
          ['disk', 'size', 'type', 'use', 'smart'],
        ),
      );
    case 'smart':
    case 'smart.test': {
      console.log(
        `${r.id}: ${r.model ?? '?'}  ${r.passed === null ? 'health unknown' : r.passed ? 'healthy' : 'FAILING'}  ${r.temperature ?? '?'} °C  ${r.powerOnHours ?? '?'} h on`,
      );
      if (r.selfTest.running)
        console.log(`${r.selfTest.running.kind} test running${r.selfTest.running.percentDone !== null ? `, ${r.selfTest.running.percentDone}% done` : ''}`);
      if (r.selfTest.tests.length)
        console.log(
          table(
            r.selfTest.tests.map((t: any) => ({ test: t.kind, result: t.result, at: t.hours === null ? '?' : `${t.hours} h` })),
            ['test', 'result', 'at'],
          ),
        );
      else console.log('no self-test on record');
      return;
    }
    case 'pools':
      return void console.log(
        table(
          r.map((p: any) => ({ pool: p.name, health: p.health, size: human(p.size), used: human(p.allocated), free: human(p.free), cap: p.capacity + '%' })),
          ['pool', 'health', 'size', 'used', 'free', 'cap'],
        ),
      );
    case 'pool.importable':
      return void console.log(
        table(
          r.map((p: any) => ({ pool: p.name, id: p.id, state: p.state, disks: p.devices.join(' '), note: p.status ?? '' })),
          ['pool', 'id', 'state', 'disks', 'note'],
        ),
      );
    case 'pool':
    case 'pool.create':
    case 'pool.import':
    case 'disk.replace': {
      console.log(`${r.name}  ${r.health}  ${human(r.allocated)} of ${human(r.size)} used (${r.capacity}%)`);
      if (r.status) console.log(`status: ${r.status}`);
      if (r.action) console.log(`action: ${r.action}`);
      const walk = (v: any, depth: number) => {
        console.log(
          `  ${'  '.repeat(depth)}${v.name}  ${v.state}${v.read || v.write || v.cksum ? `  ${v.read}/${v.write}/${v.cksum}` : ''}${v.note ? '  ' + v.note : ''}`,
        );
        v.children.forEach((c: any) => walk(c, depth + 1));
      };
      r.vdevs.forEach((v: any) => walk(v, 0));
      if (r.scan) console.log(`scan: ${r.scan}`);
      return;
    }
    case 'datasets':
      return void console.log(
        table(
          r.map((d: any) => ({
            dataset: d.name,
            used: human(d.used),
            avail: human(d.available),
            quota: human(d.quota),
            compression: `${d.compression} ${d.compressratio}x`,
            mountpoint: d.mountpoint ?? '—',
          })),
          ['dataset', 'used', 'avail', 'quota', 'compression', 'mountpoint'],
        ),
      );
    case 'snapshots':
      return void console.log(
        table(
          r.map((s: any) => ({ snapshot: s.name, used: human(s.used), refers: human(s.referenced), taken: s.creation.replace('T', ' ').slice(0, 16) })),
          ['snapshot', 'used', 'refers', 'taken'],
        ),
      );
    case 'scrubs':
      return void console.log(
        table(
          r.map((s: any) => ({ pool: s.pool, state: s.state, detail: s.text })),
          ['pool', 'state', 'detail'],
        ),
      );
    case 'policies':
      return void console.log(
        table(
          r.map((p: any) => ({ dataset: p.dataset, hourly: p.hourly, daily: p.daily, weekly: p.weekly, monthly: p.monthly })),
          ['dataset', 'hourly', 'daily', 'weekly', 'monthly'],
        ),
      );
    case 'scrub.policies':
      return void console.log(
        table(
          r.map((p: any) => ({ pool: p.pool, scrub: p.interval, set: p.updatedAt ? p.updatedAt.slice(0, 10) : 'default' })),
          ['pool', 'scrub', 'set'],
        ),
      );
    case 'scrub.policy.set':
      return void console.log(`${r.pool}: scrub ${r.interval}`);
    case 'dataset.create':
    case 'dataset.set':
      return void console.log(
        `${r.name}  quota ${human(r.quota)}  compression ${r.compression}  atime ${r.atime ? 'on' : 'off'}  ${r.mountpoint ?? 'not mounted'}`,
      );
    case 'dataset.destroy':
      return void console.log(`destroyed ${r.destroyed}${r.snapshots ? ` and its ${r.snapshots} snapshot${r.snapshots > 1 ? 's' : ''}` : ''}`);
    case 'snapshot.create':
      return void console.log(`took ${r.name}`);
    case 'snapshot.destroy':
      return void console.log(`destroyed ${r.destroyed}`);
    case 'snapshot.rollback':
      return void console.log(`rolled back to ${r.rolledBackTo}`);
    case 'policy.set':
      return void console.log(`${r.dataset}: hourly ${r.hourly}, daily ${r.daily}, weekly ${r.weekly}, monthly ${r.monthly}`);
    case 'pool.scrub':
      return void console.log('scrub started; mk-nas scrubs shows progress');
    case 'disk.wipe':
      return void console.log(`${r.id} wiped, now ${r.use.kind}`);
    case 'shares':
      return void console.log(
        table(
          r.map((s: any) => ({
            dataset: s.dataset,
            share: s.name,
            smb: s.smb ? (s.timeMachine ? 'on + time machine' : 'on') : 'off',
            nfs: s.nfs ? `on (${s.nfsClients.length ? s.nfsClients.join(' ') : 'private networks'})` : 'off',
            path: s.mountpoint ?? 'not mounted',
          })),
          ['dataset', 'share', 'smb', 'nfs', 'path'],
        ),
      );
    case 'share.set':
      return void console.log(
        `${r.dataset}: smb ${r.smb ? 'on' : 'off'}${r.timeMachine ? ' (time machine)' : ''}, nfs ${r.nfs ? 'on' : 'off'}${r.nfs ? ` for ${r.nfsClients.length ? r.nfsClients.join(' ') : 'private networks'}` : ''}`,
      );
    case 'share.remove':
      return void console.log(`${r.removed} is no longer shared`);
    case 'users':
      return void console.log(
        table(
          r.map((u: any) => ({ user: u.name, password: u.hasPassword ? 'set' : 'not set', since: u.createdAt.slice(0, 10) })),
          ['user', 'password', 'since'],
        ),
      );
    case 'user.set':
    case 'user.smbPassword':
      return void console.log(`${r.name}: SMB password ${r.hasPassword ? 'set' : 'not set'}`);
    case 'user.remove':
      return void console.log(`removed ${r.removed}`);
    case 'replication.key':
      return void console.log(r.publicKey);
    case 'replication.test':
      return void console.log(`${r.ok ? 'OK' : 'NOT OK'}: ${r.message}`);
    case 'replications':
      return void console.log(
        table(
          r.map((x: any) => ({
            id: x.id,
            dataset: x.dataset,
            target: `${x.user}@${x.host}${x.port !== 22 ? ':' + x.port : ''}:${x.targetDataset}`,
            schedule: x.schedule,
            last: x.running ? `running ${x.running.progress ?? '?'}%` : x.lastRunAt ? `${x.lastResult} ${x.lastRunAt.replace('T', ' ').slice(0, 16)}` : 'never',
          })),
          ['id', 'dataset', 'target', 'schedule', 'last'],
        ),
      );
    case 'replication.set':
      return void console.log(`replication ${r.id}: ${r.dataset} → ${r.user}@${r.host}:${r.targetDataset}, ${r.schedule}, keep ${r.keep}`);
    case 'replication.remove':
      return void console.log(`removed replication ${r.removed}`);
    case 'replication.run':
      return void console.log(`job ${r.id} ${r.state}: ${r.target}${r.message ? ' — ' + r.message : ''} (mk-nas replication jobs)`);
    case 'jobs':
      return void console.log(
        table(
          r.map((j: any) => ({
            job: j.id,
            kind: j.kind,
            target: j.target,
            state: j.state + (j.state === 'running' && j.progress !== null ? ` ${j.progress}%` : ''),
            started: j.startedAt.replace('T', ' ').slice(0, 16),
            message: j.message ?? '',
          })),
          ['job', 'kind', 'target', 'state', 'started', 'message'],
        ),
      );
    default:
      console.log(JSON.stringify(result, null, 2));
  }
}

const COMMANDS = [
  'health',
  'disks',
  'pools',
  'datasets',
  'snapshots',
  'scrubs',
  'policies',
  'version',
  'system',
  'events',
  'jobs',
  'pool',
  'scrub',
  'replace',
  'importable',
  'import',
  'wipe',
  'smart',
  'dataset',
  'snapshot',
  'policy',
  'shares',
  'share',
  'unshare',
  'users',
  'user',
  'replication',
  'network',
  'call',
];

/** Names from the agent, for completion; nothing when it cannot be reached. */
async function names(verb: Verb, pick: (r: any) => string[], args?: Record<string, unknown>): Promise<string[]> {
  try {
    return pick(await call(verb, args));
  } catch {
    return [];
  }
}

/** The words typed so far (after `mk-nas`) → what may come next, one per line. Flags are offered only where they belong. */
async function complete(words: string[]): Promise<string[]> {
  const [cmd, ...rest] = words;
  const n = rest.length;
  const pools = () => names('pools', (r) => r.map((p: any) => p.name));
  const datasets = () => names('datasets', (r) => r.map((d: any) => d.name));
  const snapshots = () => names('snapshots', (r) => r.map((s: any) => s.name));
  const disks = (free = false) => names('disks', (r) => r.filter((d: any) => !free || d.use.kind === 'free').map((d: any) => d.id));
  if (words.length === 0) return COMMANDS;
  switch (cmd) {
    case 'pool':
      return n === 0
        ? ['create', ...(await pools())]
        : rest[0] === 'create'
          ? n === 1
            ? []
            : ['--mirror', '--raidz1', '--raidz2', '--single', ...(await disks(true))]
          : [];
    case 'scrub':
      if (n === 0) return ['policies', 'policy', ...(await pools())];
      if (rest[0] === 'policy') return n === 1 ? pools() : n === 2 ? ['off', 'weekly', 'monthly'] : [];
      return [];
    case 'jobs':
      return n === 0 ? pools() : [];
    case 'replace':
      return n === 0 ? pools() : n === 2 ? disks(true) : [];
    case 'import':
      return n === 0 ? names('pool.importable', (r) => r.map((p: any) => p.name)) : [];
    case 'wipe':
      return n === 0 ? disks() : [];
    case 'smart':
      if (n === 0) return ['test', ...(await disks())];
      if (rest[0] === 'test') return n === 1 ? disks() : n === 2 ? ['short', 'long'] : [];
      return [];
    case 'dataset':
      if (n === 0) return ['create', 'set', 'destroy'];
      if (rest[0] === 'create') return n === 1 ? [] : ['--quota', '--compression', '--atime', '--location'];
      if (rest[0] === 'set') return n === 1 ? datasets() : ['--quota', '--compression', '--atime'];
      if (rest[0] === 'destroy') return n === 1 ? datasets() : ['--snapshots'];
      return [];
    case 'snapshot':
      if (n === 0) return ['destroy', 'rollback', ...(await datasets())];
      if (rest[0] === 'destroy' || rest[0] === 'rollback') return n === 1 ? snapshots() : [];
      return [];
    case 'policy':
    case 'share':
    case 'unshare':
      return n === 0 ? datasets() : cmd === 'share' ? ['--smb', '--time-machine', '--nfs', '--clients'] : [];
    case 'user':
      return n === 0
        ? ['remove', ...(await names('users', (r) => r.map((u: any) => u.name)))]
        : rest[0] === 'remove' && n === 1
          ? names('users', (r) => r.map((u: any) => u.name))
          : [];
    case 'replication':
      if (n === 0) return ['key', 'test', 'list', 'jobs', 'add', 'run', 'remove'];
      if (rest[0] === 'add') return n === 1 ? datasets() : n === 3 ? [] : n >= 4 ? ['--schedule', '--keep', '--recursive'] : [];
      if (rest[0] === 'run' || rest[0] === 'remove') return n === 1 ? names('replications', (r) => r.map((x: any) => String(x.id))) : [];
      return [];
    case 'network':
      if (n === 0) return ['hostname', 'set', 'keep'];
      if (rest[0] === 'set')
        return n === 1 ? names('network', (r) => r.interfaces.map((i: any) => i.name)) : ['--dhcp', '--address', '--gateway', '--dns', '--revert'];
      return [];
    case 'events':
      return n === 0 ? ['--all'] : [];
    case 'call':
      return n === 0 ? names('version', () => []).then(() => []) : [];
    default:
      return [];
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') usage();
  if (cmd === '__complete') {
    const out = await complete(rest);
    if (out.length) console.log(out.join('\n'));
    return;
  }
  let verb: Verb;
  let args: Record<string, unknown> | undefined;
  switch (cmd) {
    case 'health':
    case 'disks':
    case 'pools':
    case 'datasets':
    case 'snapshots':
    case 'scrubs':
    case 'policies':
    case 'version':
    case 'system':
      verb = cmd;
      break;
    case 'jobs':
      verb = 'jobs';
      if (rest[0]) args = { pool: rest[0] };
      break;
    case 'events':
      verb = 'events';
      if (rest.includes('--all')) args = { all: true };
      break;
    case 'backup':
      if (!rest[0]) verb = 'backup';
      else if (rest[0] === 'now') verb = 'backup.run';
      else if (rest[0] === 'set') {
        if (!rest[1]) usage('backup set <dataset>|off');
        verb = 'backup.set';
        args = { dataset: rest[1] === 'off' ? null : rest[1] };
      } else if (rest[0] === 'restore') {
        if (!rest[1]) usage('backup restore <dataset>');
        console.error(
          `This replaces this box's settings — shares, copies, SMB users, the drive's accounts — with the backup in ${rest[1]}, then restarts the agent and the drive.`,
        );
        verb = 'backup.restore';
        args = { dataset: rest[1], confirm: await confirm(rest[1]) };
      } else usage('backup | backup set <dataset>|off | backup now | backup restore <dataset>');
      break;
    case 'network': {
      if (!rest[0]) verb = 'network';
      else if (rest[0] === 'keep') verb = 'network.confirm';
      else if (rest[0] === 'hostname') {
        if (!rest[1]) usage('network hostname <name>');
        verb = 'network.set';
        args = { hostname: rest[1] };
      } else if (rest[0] === 'set') {
        const { flags, words } = opts(rest.slice(1));
        if (!words[0] || (!flags.dhcp && typeof flags.address !== 'string'))
          usage('network set <iface> --dhcp | --address a.b.c.d/nn [--gateway g] [--dns a,b] [--revert 120]');
        verb = 'network.set';
        args = flags.dhcp
          ? { interface: words[0], dhcp: true }
          : {
              interface: words[0],
              address: flags.address,
              ...(typeof flags.gateway === 'string' ? { gateway: flags.gateway } : {}),
              ...(typeof flags.dns === 'string' ? { dns: flags.dns.split(',').map((s) => s.trim()) } : {}),
            };
        if (typeof flags.revert === 'string') args.revertAfter = Number(flags.revert);
        console.error(
          `This changes ${words[0]} now. If you are on it over ssh, this session will drop; reconnect at the new address and run \`mk-nas network keep\` in time, or it reverts.`,
        );
      } else usage('network | network hostname <name> | network set … | network keep');
      break;
    }
    case 'pool': {
      if (rest[0] === 'create') {
        const { flags, words } = opts(rest.slice(1));
        const [name, ...disks] = words;
        const layout = (['mirror', 'raidz1', 'raidz2', 'single'] as const).find((l) => flags[l] === true);
        if (!name || !layout || disks.length === 0) usage('pool create <name> --mirror|--raidz1|--raidz2|--single <disk-id>...');
        console.error(`This formats ${disks.join(', ')}. There is no undo.`);
        verb = 'pool.create';
        args = { name, layout, disks, confirm: await confirm(name) };
      } else {
        if (!rest[0]) usage('pool <name>');
        verb = 'pool';
        args = { pool: rest[0] };
      }
      break;
    }
    case 'scrub':
      if (rest[0] === 'policies') verb = 'scrub.policies';
      else if (rest[0] === 'policy') {
        if (!rest[1] || !rest[2]) usage('scrub policy <pool> off|weekly|monthly');
        verb = 'scrub.policy.set';
        args = { pool: rest[1], interval: rest[2] };
      } else {
        if (!rest[0]) usage('scrub <pool> | scrub policies | scrub policy <pool> off|weekly|monthly');
        verb = 'pool.scrub';
        args = { pool: rest[0] };
      }
      break;
    case 'replace':
      if (!rest[0] || !rest[1] || !rest[2]) usage('replace <pool> <old-member> <new-disk-id>');
      console.error(`This puts ${rest[2]} in the place of ${rest[1]} in ${rest[0]} and resilvers.`);
      verb = 'disk.replace';
      args = { pool: rest[0], old: rest[1], disk: rest[2], confirm: await confirm(rest[0]) };
      break;
    case 'importable':
      verb = 'pool.importable';
      break;
    case 'import':
      if (!rest[0]) usage('import <pool>');
      verb = 'pool.import';
      args = { pool: rest[0] };
      break;
    case 'smart':
      if (rest[0] === 'test') {
        if (!rest[1] || !rest[2]) usage('smart test <disk-id> short|long');
        verb = 'smart.test';
        args = { disk: rest[1], kind: rest[2] };
      } else {
        if (!rest[0]) usage('smart <disk-id> | smart test <disk-id> short|long');
        verb = 'smart';
        args = { disk: rest[0] };
      }
      break;
    case 'wipe':
      if (!rest[0]) usage('wipe <disk-id>');
      console.error(`This erases the partition table and filesystem signatures on ${rest[0]}.`);
      verb = 'disk.wipe';
      args = { disk: rest[0], confirm: await confirm(rest[0]) };
      break;
    case 'dataset': {
      const { flags, words } = opts(rest.slice(1));
      if (rest[0] === 'create') {
        if (!words[0]) usage('dataset create <pool/name> [--quota 10G] [--compression …] [--atime on|off] [--location]');
        verb = 'dataset.create';
        args = { name: words[0], ...datasetProps(flags), ...(flags.location ? { location: true } : {}) };
      } else if (rest[0] === 'set') {
        if (!words[0]) usage('dataset set <pool/name> [--quota 10G|none] [--compression …] [--atime on|off]');
        verb = 'dataset.set';
        args = { dataset: words[0], ...datasetProps(flags) };
      } else if (rest[0] === 'destroy') {
        if (!words[0]) usage('dataset destroy <pool/name> [--snapshots]');
        console.error(`This destroys ${words[0]}${flags.snapshots ? ' and every snapshot of it' : ''}. There is no undo.`);
        verb = 'dataset.destroy';
        args = { dataset: words[0], confirm: await confirm(words[0]), ...(flags.snapshots ? { snapshots: true } : {}) };
      } else usage('dataset create|set|destroy …');
      break;
    }
    case 'snapshot':
      if (rest[0] === 'destroy' || rest[0] === 'rollback') {
        if (!rest[1]) usage(`snapshot ${rest[0]} <dataset@name>`);
        verb = rest[0] === 'destroy' ? 'snapshot.destroy' : 'snapshot.rollback';
        console.error(
          rest[0] === 'destroy'
            ? `This deletes ${rest[1]}.`
            : `This undoes every change to ${rest[1].split('@')[0]} since ${rest[1].split('@')[1]}. Those changes are gone for good; to get single files back instead, copy them out of ${rest[1].split('@')[0]}'s .zfs/snapshot/${rest[1].split('@')[1]}.`,
        );
        args = { snapshot: rest[1], confirm: await confirm(rest[1]) };
      } else {
        if (!rest[0]) usage('snapshot <dataset> [name]');
        verb = 'snapshot.create';
        args = { dataset: rest[0], ...(rest[1] ? { name: rest[1] } : {}) };
      }
      break;
    case 'policy': {
      const [dataset, ...n] = rest;
      if (!dataset || n.length !== 4 || n.some((x) => !/^\d+$/.test(x))) usage('policy <dataset> <hourly> <daily> <weekly> <monthly>');
      verb = 'policy.set';
      args = { dataset, hourly: +n[0], daily: +n[1], weekly: +n[2], monthly: +n[3] };
      break;
    }
    case 'shares':
    case 'users':
      verb = cmd;
      break;
    case 'share': {
      const { flags, words } = opts(rest);
      if (!words[0]) usage('share <dataset> [--smb on|off] [--time-machine on|off] [--nfs on|off] [--clients a,b]');
      verb = 'share.set';
      const onoff = (v: string | true | undefined, what: string): boolean | undefined =>
        v === undefined ? undefined : v === 'on' || v === true ? true : v === 'off' ? false : usage(`${what} must be on or off`);
      args = { dataset: words[0] };
      const smb = onoff(flags.smb, '--smb');
      const tm = onoff(flags['time-machine'], '--time-machine');
      const nfs = onoff(flags.nfs, '--nfs');
      if (smb !== undefined) args.smb = smb;
      if (tm !== undefined) args.timeMachine = tm;
      if (nfs !== undefined) args.nfs = nfs;
      if (typeof flags.clients === 'string')
        args.nfsClients = flags.clients
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
      if (smb === undefined && nfs === undefined && tm === undefined && args.nfsClients === undefined) args.smb = true;
      break;
    }
    case 'unshare':
      if (!rest[0]) usage('unshare <dataset>');
      verb = 'share.remove';
      args = { dataset: rest[0] };
      break;
    case 'user': {
      if (rest[0] === 'remove') {
        if (!rest[1]) usage('user remove <name>');
        verb = 'user.remove';
        args = { name: rest[1] };
      } else {
        if (!rest[0]) usage('user <name>');
        verb = 'user.smbPassword';
        args = { name: rest[0], password: await secret(`SMB password for ${rest[0]}: `) };
      }
      break;
    }
    case 'replication': {
      const sub = rest[0];
      const where = (v: string | undefined): { host: string; user: string; port?: number } => {
        const m = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(v ?? '');
        if (!m) usage('the target is user@host or user@host:port');
        return { user: m[1] ?? 'root', host: m[2], ...(m[3] ? { port: Number(m[3]) } : {}) };
      };
      if (sub === 'key') verb = 'replication.key';
      else if (sub === 'list') verb = 'replications';
      else if (sub === 'jobs') verb = 'jobs';
      else if (sub === 'test') {
        if (!rest[1] || !rest[2]) usage('replication test <user@host[:port]> <target-dataset>');
        verb = 'replication.test';
        args = { ...where(rest[1]), targetDataset: rest[2] };
      } else if (sub === 'add') {
        const { flags, words } = opts(rest.slice(1));
        if (words.length !== 3) usage('replication add <dataset> <user@host[:port]> <target-dataset> [--schedule …] [--keep N] [--recursive]');
        verb = 'replication.set';
        args = { dataset: words[0], ...where(words[1]), targetDataset: words[2] };
        if (typeof flags.schedule === 'string') args.schedule = flags.schedule;
        if (typeof flags.keep === 'string') args.keep = Number(flags.keep);
        if (flags.recursive) args.recursive = true;
      } else if (sub === 'run' || sub === 'remove') {
        if (!rest[1] || !/^\d+$/.test(rest[1])) usage(`replication ${sub} <id>`);
        verb = sub === 'run' ? 'replication.run' : 'replication.remove';
        args = { id: Number(rest[1]) };
      } else usage('replication key | test | list | jobs | add | run | remove');
      break;
    }
    case 'call':
      if (!rest[0]) usage('call <verb> [json-args]');
      verb = rest[0] as Verb;
      args = rest[1] ? (JSON.parse(rest[1]) as Record<string, unknown>) : undefined;
      break;
    default:
      usage(`unknown command: ${cmd}`);
  }
  print(verb, await call(verb, args));
}

main().catch((e: Error) => {
  console.error(`mk-nas: ${e.message}`);
  process.exit(1);
});
