/**
 * What ZFS says happened, as it happens. The kernel keeps a list of events
 * (`zpool events`) — a disk faulted, a checksum failed, a scrub ended — with
 * a running id; the agent reads it every few seconds and keeps the tail in
 * memory, nothing on disk. So a pool that went degraded at 03:12 is known
 * as that, not as "degraded" on the next page load. Nothing here is ever
 * used to decide anything: `zpool status` stays the truth of the moment.
 */
import { basename } from 'node:path';
import type { ZfsEvent } from '../../shared/types.ts';
import type { Runner } from './run.ts';

/** vdev states as zpool events prints them in hex, when it does not spell them out. */
const VDEV_STATE = ['UNKNOWN', 'CLOSED', 'OFFLINE', 'REMOVED', 'CANT_OPEN', 'FAULTED', 'DEGRADED', 'ONLINE'];
const HEAD = /^(\S.*?)\s+((?:sysevent|ereport|resource)\.fs\.zfs\.\S+)\s*$/;
const FIELD = /^\s+(\w+) = (.*)$/;

function unquote(v: string, key: string): string {
  const m = /^"(.*)"/.exec(v);
  if (m) return m[1];
  if (/_state$/.test(key) && /^0x[0-9a-f]+$/i.test(v)) return VDEV_STATE[Number(v)] ?? v;
  return v;
}

/** A disk as `disks` names it: the by-id link without the partition suffix. */
function diskOf(path: string | undefined, devid: string | undefined): string | null {
  const v = path ? basename(path) : devid;
  return v ? v.replace(/-part\d+$/, '') : null;
}

function summarize(cls: string, pool: string | null, vdev: string | null, state: string | null, prev: string | null, f: Record<string, string>): string {
  const where = pool ? `${pool}: ` : '';
  const disk = vdev ?? 'a disk';
  const kind = cls.replace(/^(sysevent|ereport|resource)\.fs\.zfs\./, '');
  switch (kind) {
    case 'statechange':
      return `${where}${disk} went ${state ?? '?'}${prev ? ` (was ${prev})` : ''}`;
    case 'removed':
      return `${where}${disk} was removed`;
    case 'checksum':
      return `${where}checksum error on ${disk}`;
    case 'io':
      return `${where}I/O error on ${disk}${f.zio_err ? ` (errno ${Number(f.zio_err)})` : ''}`;
    case 'data':
      return `${where}data could not be read (no good copy left)`;
    case 'probe_failure':
      return `${where}${disk} does not answer`;
    case 'io_failure':
      return `${where}the pool suspended I/O`;
    case 'scrub_start':
      return `${where}scrub started`;
    case 'scrub_finish':
      return `${where}scrub finished`;
    case 'resilver_start':
      return `${where}rebuild started`;
    case 'resilver_finish':
      return `${where}rebuild finished`;
    case 'vdev_clear':
      return `${where}errors on ${disk} cleared`;
    default:
      return `${where}${kind.replace(/_/g, ' ')}`;
  }
}

/** The events a person should hear about, as opposed to config syncs and history entries. */
function matters(cls: string, state: string | null): boolean {
  if (cls === 'resource.fs.zfs.statechange') return state !== 'ONLINE' && state !== 'HEALTHY';
  return /^(ereport\.fs\.zfs\.(io|checksum|data|probe_failure|io_failure|delay)|resource\.fs\.zfs\.removed)$/.test(cls);
}

/** `zpool events -v -H`: a "TIME CLASS" line, then indented `key = value` lines, then a blank line, per event. Oldest first, as printed. */
export function parseEvents(out: string): ZfsEvent[] {
  const events: ZfsEvent[] = [];
  let cls: string | null = null;
  let fields: Record<string, string> = {};
  const flush = () => {
    if (!cls) return;
    const eid = Number(fields.eid);
    const secs = fields.time ? Number(fields.time.split(/\s+/)[0]) : NaN;
    const state = fields.vdev_state ? unquote(fields.vdev_state, 'vdev_state') : null;
    const prev = fields.prev_state ? unquote(fields.prev_state, 'prev_state') : null;
    const pool = fields.pool ? unquote(fields.pool, 'pool') : null;
    const vdev = diskOf(
      fields.vdev_path ? unquote(fields.vdev_path, 'vdev_path') : undefined,
      fields.vdev_devid ? unquote(fields.vdev_devid, 'vdev_devid') : undefined,
    );
    if (Number.isFinite(eid))
      events.push({
        eid,
        time: Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : new Date(0).toISOString(),
        class: cls,
        pool,
        vdev,
        state,
        prevState: prev,
        summary: summarize(cls, pool, vdev, state, prev, fields),
        matters: matters(cls, state),
        count: 1,
      });
    cls = null;
    fields = {};
  };
  for (const line of out.split('\n')) {
    const h = HEAD.exec(line);
    if (h) {
      flush();
      cls = h[2];
      continue;
    }
    const f = FIELD.exec(line);
    if (f && cls) fields[f[1]] = f[2].trim();
    else if (!line.trim()) flush();
  }
  flush();
  return events;
}

const KEEP = 500;

export interface EventLogOptions {
  /** How often to ask, in ms. */
  every: number;
  /** Called after a scrub or resilver ended, so its job row can be closed within seconds. */
  onScanEnd?: () => Promise<void>;
  /** Called with the fresh events worth looking at the box for — a disk faulted, checksums failed, a disk came back, a
   * scan ended — so an alert appears, or goes, in seconds instead of at the next sweep. */
  onEvents?: (fresh: ZfsEvent[]) => void;
}

export class EventLog {
  private readonly run: Runner;
  private readonly opts: EventLogOptions;
  private readonly tail: ZfsEvent[] = [];
  private lastEid = -1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(run: Runner, opts: EventLogOptions) {
    this.run = run;
    this.opts = opts;
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.every);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads the kernel's list and keeps what is new; returns the new ones. A pool-less box (no zfs yet) is simply quiet. */
  async poll(): Promise<ZfsEvent[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      const r = await this.run(['zpool', 'events', '-v', '-H'], { timeout: 20_000 });
      if (r.exitCode !== 0) return [];
      const fresh = parseEvents(r.stdout).filter((e) => e.eid > this.lastEid);
      if (fresh.length === 0) return [];
      this.lastEid = fresh[fresh.length - 1].eid;
      this.tail.push(...fresh);
      if (this.tail.length > KEEP) this.tail.splice(0, this.tail.length - KEEP);
      if (this.opts.onScanEnd && fresh.some((e) => /\.(scrub|resilver)_finish$/.test(e.class))) await this.opts.onScanEnd().catch(() => {});
      // a state change in either direction: a disk that faulted raises something, one that came back clears it
      const worth = fresh.filter((e) => e.matters || /statechange|(scrub|resilver)_finish/.test(e.class));
      if (this.opts.onEvents && worth.length) this.opts.onEvents(worth);
      return fresh;
    } finally {
      this.busy = false;
    }
  }

  /** Newest first; `all` includes the routine ones; a run of the same thing on the same disk is one line with a count. */
  recent(limit = 50, all = false, since?: Date): ZfsEvent[] {
    const out: ZfsEvent[] = [];
    for (let i = this.tail.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.tail[i];
      if (!all && !e.matters) continue;
      if (since && Date.parse(e.time) < since.getTime()) break;
      const last = out[out.length - 1];
      if (last && last.class === e.class && last.pool === e.pool && last.vdev === e.vdev && last.state === e.state) last.count++;
      else out.push({ ...e });
    }
    return out;
  }
}
