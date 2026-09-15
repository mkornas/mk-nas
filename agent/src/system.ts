/**
 * The box at a glance: CPU, load, memory, swap, network and disk rates,
 * temperatures. Read from /proc and /sys every few seconds, kept for half
 * an hour in memory, nothing on disk and nothing run. mk-dashboard is the
 * deep monitor; this is what the Storage overview shows in one row.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sample, SamplePoint } from '../../shared/types.ts';

/** Counters as the kernel keeps them; rates come from two of these. */
export interface Raw {
  at: number;
  /** jiffies: everything but idle and iowait, and everything */
  cpuBusy: number;
  cpuTotal: number;
  cores: number;
  load: [number, number, number];
  uptime: number;
  memory: { total: number; available: number };
  swap: { total: number; free: number };
  net: Map<string, { rx: number; tx: number }>;
  /** sectors of 512 bytes, and ms spent doing I/O */
  disks: Map<string, { read: number; write: number; ioMs: number }>;
  temps: { sensor: string; label: string | null; celsius: number }[];
}

const WHOLE_DISK = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
/** Physical-looking interfaces: not the loopback, not the container plumbing. */
export const NIC = /^(?!lo$|veth|docker|br-|virbr|tap|tun)/;

const kb = (line: string | undefined): number => (line ? Number(line.split(/\s+/)[1]) * 1024 : 0);

async function text(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function temps(hwmon: string): Promise<Raw['temps']> {
  const out: Raw['temps'] = [];
  let dirs: string[] = [];
  try {
    dirs = (await readdir(hwmon)).sort();
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = join(hwmon, d);
    const sensor = (await text(join(dir, 'name'))).trim();
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((f) => /^temp\d+_input$/.test(f)).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const v = Number((await text(join(dir, f))).trim());
      if (!Number.isFinite(v) || v === 0) continue;
      const label = (await text(join(dir, f.replace('_input', '_label')))).trim() || null;
      out.push({ sensor, label, celsius: Math.round(v / 100) / 10 });
    }
  }
  return out;
}

/** One read of everything, under `root` ('/' on the box, a fixture in tests). */
export async function readRaw(root = '/', at = Date.now()): Promise<Raw> {
  const p = (f: string) => join(root, 'proc', f);
  const stat = (await text(p('stat'))).split('\n');
  const cpu = (stat.find((l) => /^cpu\s/.test(l)) ?? 'cpu 0 0 0 0 0 0 0 0').trim().split(/\s+/).slice(1).map(Number);
  const idle = (cpu[3] ?? 0) + (cpu[4] ?? 0);
  const total = cpu.reduce((a, b) => a + b, 0);
  const mem = (await text(p('meminfo'))).split('\n');
  const row = (k: string) => mem.find((l) => l.startsWith(`${k}:`));
  const load = (await text(p('loadavg'))).trim().split(/\s+/).slice(0, 3).map(Number) as [number, number, number];
  const net = new Map<string, { rx: number; tx: number }>();
  for (const line of (await text(p('net/dev'))).split('\n')) {
    const m = /^\s*([^\s:]+):\s*(.*)$/.exec(line);
    if (!m || !NIC.test(m[1])) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    net.set(m[1], { rx: f[0] ?? 0, tx: f[8] ?? 0 });
  }
  const disks = new Map<string, { read: number; write: number; ioMs: number }>();
  for (const line of (await text(p('diskstats'))).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 13 || !WHOLE_DISK.test(f[2])) continue;
    disks.set(f[2], { read: Number(f[5]), write: Number(f[9]), ioMs: Number(f[12]) });
  }
  return {
    at,
    cpuBusy: total - idle,
    cpuTotal: total,
    cores: stat.filter((l) => /^cpu\d/.test(l)).length || 1,
    load: load.length === 3 && load.every(Number.isFinite) ? load : [0, 0, 0],
    uptime: Number((await text(p('uptime'))).split(/\s+/)[0]) || 0,
    memory: { total: kb(row('MemTotal')), available: kb(row('MemAvailable')) },
    swap: { total: kb(row('SwapTotal')), free: kb(row('SwapFree')) },
    net,
    disks,
    temps: await temps(join(root, 'sys/class/hwmon')),
  };
}

const pct = (n: number): number => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

/** The sample between two reads: rates per second, percentages of the interval. Pure. */
export function diff(prev: Raw, cur: Raw): Sample {
  const dt = Math.max(0.001, (cur.at - prev.at) / 1000);
  const dTotal = cur.cpuTotal - prev.cpuTotal;
  const rate = (a: number, b: number) => Math.max(0, Math.round((b - a) / dt));
  return {
    at: new Date(cur.at).toISOString(),
    cpu: dTotal > 0 ? pct(((cur.cpuBusy - prev.cpuBusy) / dTotal) * 100) : 0,
    load: cur.load,
    memory: { total: cur.memory.total, used: Math.max(0, cur.memory.total - cur.memory.available), available: cur.memory.available },
    swap: { total: cur.swap.total, used: Math.max(0, cur.swap.total - cur.swap.free) },
    net: [...cur.net]
      .filter(([name]) => prev.net.has(name))
      .map(([name, c]) => ({ name, rx: rate(prev.net.get(name)!.rx, c.rx), tx: rate(prev.net.get(name)!.tx, c.tx) })),
    disks: [...cur.disks]
      .filter(([dev]) => prev.disks.has(dev))
      .map(([dev, c]) => {
        const p = prev.disks.get(dev)!;
        return { dev, read: rate(p.read * 512, c.read * 512), write: rate(p.write * 512, c.write * 512), busy: pct(((c.ioMs - p.ioMs) / (dt * 1000)) * 100) };
      }),
    temps: cur.temps,
  };
}

/** The point kept in history: the totals, so half an hour is a few numbers per sample. */
export function pointOf(s: Sample): SamplePoint {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    at: s.at,
    cpu: s.cpu,
    load: s.load[0],
    memoryUsed: s.memory.used,
    rx: sum(s.net.map((n) => n.rx)),
    tx: sum(s.net.map((n) => n.tx)),
    read: sum(s.disks.map((d) => d.read)),
    write: sum(s.disks.map((d) => d.write)),
    temp: s.temps.length ? Math.max(...s.temps.map((t) => t.celsius)) : null,
  };
}

export interface VitalsOptions {
  /** ms between samples. */
  every: number;
  /** how many samples to keep (30 minutes at 5 s = 360). */
  keep: number;
  root?: string;
}

export class Vitals {
  private readonly opts: VitalsOptions;
  private prev: Raw | null = null;
  private last: Sample | null = null;
  private readonly points: SamplePoint[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(opts: VitalsOptions) {
    this.opts = opts;
  }

  start(): void {
    void this.sample();
    this.timer = setInterval(() => void this.sample(), this.opts.every);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sample(at = Date.now()): Promise<Sample | null> {
    if (this.busy) return this.last;
    this.busy = true;
    try {
      const raw = await readRaw(this.opts.root, at);
      if (this.prev) {
        this.last = diff(this.prev, raw);
        this.points.push(pointOf(this.last));
        if (this.points.length > this.opts.keep) this.points.splice(0, this.points.length - this.opts.keep);
      }
      this.prev = raw;
      return this.last;
    } catch {
      return this.last;
    } finally {
      this.busy = false;
    }
  }

  /** The latest sample and the history, oldest first; plus what the last read said about the machine itself. */
  snapshot(): { now: Sample | null; history: SamplePoint[]; uptime: number; cores: number } {
    return { now: this.last, history: [...this.points], uptime: this.prev?.uptime ?? 0, cores: this.prev?.cores ?? 0 };
  }
}
