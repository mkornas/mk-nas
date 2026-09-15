/**
 * Readers over zpool and zfs. Each function builds one argv, runs it, and
 * parses the machine-readable output (-H -p) — or, for `zpool status`, the
 * only output there is on ZFS 2.2. Parsers are pure so tests feed them
 * fixtures.
 */
import type { Dataset, ImportablePool, Pool, PoolHealth, PoolSummary, Scrub, Snapshot, Vdev } from '../../shared/types.ts';
import { CommandError, must, type Runner } from './run.ts';

const num = (s: string): number => (s === '-' || s === '' ? 0 : Number(s));
const numOrNull = (s: string): number | null => (s === '-' || s === '' ? null : Number(s));
const iso = (epoch: string): string => new Date(Number(epoch) * 1000).toISOString();

const POOL_LIST = ['name', 'health', 'size', 'allocated', 'free', 'capacity', 'fragmentation'];

export function parsePoolList(out: string): PoolSummary[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const f = line.split('\t');
      return {
        name: f[0],
        health: f[1] as PoolHealth,
        size: num(f[2]),
        allocated: num(f[3]),
        free: num(f[4]),
        capacity: num(f[5]),
        fragmentation: numOrNull(f[6]),
      };
    });
}

export async function listPools(run: Runner, pool?: string): Promise<PoolSummary[]> {
  const out = await must(run, ['zpool', 'list', '-H', '-p', '-o', POOL_LIST.join(','), ...(pool ? [pool] : [])]);
  return parsePoolList(out);
}

export interface PoolStatus {
  state: string;
  status: string | null;
  action: string | null;
  scan: string | null;
  errors: string | null;
  vdevs: Vdev[];
}

/**
 * `zpool status <pool>` on ZFS 2.2 is prose with a config tree. The header
 * fields are "  key: value" with continuation lines indented; the tree is
 * tab-indented, two spaces per level, and ends at the blank line before
 * "errors:".
 */
export function parsePoolStatus(out: string): PoolStatus {
  const lines = out.split('\n');
  const fields: Record<string, string> = {};
  let key: string | null = null;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s*(pool|state|status|action|see|scan|scrub|config|errors|remove|checkpoint):\s?(.*)$/.exec(line);
    if (m) {
      key = m[1];
      fields[key] = m[2].trim();
      if (key === 'config') break;
      continue;
    }
    if (key && line.trim()) fields[key] += ' ' + line.trim();
  }
  const vdevs: Vdev[] = [];
  const stack: { depth: number; node: Vdev }[] = [];
  let sawHeader = false;
  for (i++; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      if (sawHeader && stack.length) break;
      continue;
    }
    const em = /^\s*errors:\s?(.*)$/.exec(line);
    if (em) {
      fields.errors = em[1].trim();
      break;
    }
    const body = line.replace(/^\t/, '');
    if (!sawHeader) {
      if (/^\s*NAME\s+STATE/.test(body)) sawHeader = true;
      continue;
    }
    const depth = (body.match(/^ */)?.[0].length ?? 0) / 2;
    const cols = body.trim().split(/\s+/);
    const node: Vdev = {
      name: cols[0],
      state: cols[1] ?? '',
      read: Number(cols[2] ?? 0) || 0,
      write: Number(cols[3] ?? 0) || 0,
      cksum: Number(cols[4] ?? 0) || 0,
      note: cols.length > 5 ? cols.slice(5).join(' ') : null,
      children: [],
    };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else vdevs.push(node);
    stack.push({ depth, node });
  }
  // The rest of the file may still hold "errors:" after the tree's blank line.
  for (; i < lines.length; i++) {
    const em = /^\s*errors:\s?(.*)$/.exec(lines[i]);
    if (em) fields.errors = em[1].trim();
  }
  return {
    state: fields.state ?? 'UNKNOWN',
    status: fields.status ?? null,
    action: fields.action ?? null,
    scan: fields.scan ?? null,
    errors: fields.errors ?? null,
    vdevs,
  };
}

/** The scan line, as far as it can be read without a JSON zpool. */
export function parseScan(pool: string, scan: string | null): Scrub | null {
  if (!scan || /^none requested/.test(scan))
    return scan ? { pool, kind: 'scrub', state: 'none', text: scan, percent: null, finishedAt: null, errors: null } : null;
  const kind: Scrub['kind'] = /^resilver/.test(scan) ? 'resilver' : 'scrub';
  const errors = /with (\d+) errors/.exec(scan);
  if (/^(scrub|resilver) in progress/.test(scan)) {
    const pct = /([\d.]+)% done/.exec(scan);
    return { pool, kind, state: 'running', text: scan, percent: pct ? Number(pct[1]) : null, finishedAt: null, errors: errors ? Number(errors[1]) : null };
  }
  if (/^(scrub (repaired|canceled)|resilvered)/.test(scan)) {
    const at = / on (.+)$/.exec(scan);
    const finishedAt = at ? new Date(at[1]).toISOString() : null;
    return {
      pool,
      kind,
      state: scan.startsWith('scrub canceled') ? 'canceled' : 'finished',
      text: scan,
      percent: null,
      finishedAt: Number.isNaN(Date.parse(at?.[1] ?? '')) ? null : finishedAt,
      errors: errors ? Number(errors[1]) : null,
    };
  }
  return { pool, kind, state: 'none', text: scan, percent: null, finishedAt: null, errors: null };
}

/**
 * `zpool import` with no pool: blocks of "pool: x / id: N / state: ONLINE / status: … / action: … / config:" and a
 * device tree. Only names, ids, states, the two prose fields and the leaf device names are kept.
 */
export function parseImportable(out: string): ImportablePool[] {
  const pools: ImportablePool[] = [];
  let cur: ImportablePool | null = null;
  let inConfig = false;
  let key: 'status' | 'action' | null = null;
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    const m = /^\s*(pool|id|state|status|action|config|see|comment):\s?(.*)$/.exec(line);
    if (m) {
      inConfig = false;
      key = null;
      if (m[1] === 'pool') {
        cur = { name: m[2].trim(), id: '', state: '', status: null, action: null, devices: [] };
        pools.push(cur);
      } else if (cur && m[1] === 'id') cur.id = m[2].trim();
      else if (cur && m[1] === 'state') cur.state = m[2].trim();
      else if (cur && (m[1] === 'status' || m[1] === 'action')) {
        cur[m[1]] = m[2].trim();
        key = m[1];
      } else if (m[1] === 'config') inConfig = true;
      continue;
    }
    if (!cur) continue;
    if (inConfig) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 2 && !/^(NAME|mirror-|raidz|spare|log|cache|special|dedup)/.test(cols[0]) && cols[0] !== cur.name) cur.devices.push(cols[0]);
    } else if (key && line.trim()) cur[key] = `${cur[key]} ${line.trim()}`;
  }
  return pools;
}

export async function listImportable(run: Runner): Promise<ImportablePool[]> {
  // exit 1 with "no pools available to import" is the normal empty answer
  const r = await run(['zpool', 'import'], { timeout: 120_000 });
  if (r.exitCode !== 0 && /no pools available/i.test(r.stdout + r.stderr)) return [];
  if (r.exitCode !== 0) throw new CommandError(r);
  return parseImportable(r.stdout);
}

export async function getPool(run: Runner, pool: string): Promise<Pool> {
  const [summary] = await listPools(run, pool);
  const status = parsePoolStatus(await must(run, ['zpool', 'status', pool]));
  return {
    ...summary,
    status: status.status,
    action: status.action,
    scan: status.scan,
    errors: status.errors,
    vdevs: status.vdevs,
    scrub: parseScan(pool, status.scan),
  };
}

const DATASET_LIST = [
  'name',
  'type',
  'used',
  'avail',
  'refer',
  'mountpoint',
  'mounted',
  'quota',
  'compression',
  'compressratio',
  'atime',
  'recordsize',
  'creation',
];

export function parseDatasetList(out: string): Dataset[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const f = line.split('\t');
      return {
        name: f[0],
        pool: f[0].split('/')[0],
        type: f[1] as Dataset['type'],
        used: num(f[2]),
        available: num(f[3]),
        referenced: num(f[4]),
        mountpoint: f[5] === '-' || f[5] === 'none' || f[5] === 'legacy' ? null : f[5],
        mounted: f[6] === 'yes',
        quota: f[7] === '0' || f[7] === '-' ? null : num(f[7]),
        compression: f[8],
        compressratio: Number(f[9].replace(/x$/, '')) || 1,
        atime: f[10] === 'on',
        recordsize: num(f[11]),
        creation: iso(f[12]),
      };
    });
}

export async function listDatasets(run: Runner, pool?: string): Promise<Dataset[]> {
  const out = await must(run, [
    'zfs',
    'list',
    '-H',
    '-p',
    '-t',
    'filesystem,volume',
    '-o',
    DATASET_LIST.join(','),
    '-s',
    'name',
    ...(pool ? ['-r', pool] : []),
  ]);
  return parseDatasetList(out);
}

export function parseSnapshotList(out: string): Snapshot[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const f = line.split('\t');
      const at = f[0].indexOf('@');
      return { name: f[0], dataset: f[0].slice(0, at), snapshot: f[0].slice(at + 1), used: num(f[1]), referenced: num(f[2]), creation: iso(f[3]) };
    });
}

/** `zfs get written`: bytes written to each dataset since its newest snapshot (all of it when it has none). */
export function parseWritten(out: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const line of out.split('\n')) {
    const [name, value] = line.split('\t');
    if (name && /^\d+$/.test(value ?? '')) m.set(name, Number(value));
  }
  return m;
}

export async function writtenSince(run: Runner, datasets: string[]): Promise<Map<string, number>> {
  if (!datasets.length) return new Map();
  const r = await run(['zfs', 'get', '-H', '-p', '-o', 'name,value', 'written', ...datasets]);
  // a dataset that went away makes zfs exit 1 but still print the others; one that is missing counts as changed
  return parseWritten(r.stdout);
}

export async function listSnapshots(run: Runner, dataset?: string): Promise<Snapshot[]> {
  const out = await must(run, [
    'zfs',
    'list',
    '-H',
    '-p',
    '-t',
    'snapshot',
    '-o',
    'name,used,refer,creation',
    '-s',
    'creation',
    ...(dataset ? ['-r', dataset] : []),
  ]);
  return parseSnapshotList(out);
}

export async function zfsVersion(run: Runner): Promise<string | null> {
  const r = await run(['zfs', 'version']);
  if (r.exitCode !== 0) return null;
  return r.stdout.split('\n')[0]?.trim() || null;
}
