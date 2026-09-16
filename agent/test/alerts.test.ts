import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Disk, Job, PoolSummary, StoredAlert } from '../../shared/types.ts';
import { conditions, reconcile, worstOf, type ConditionInput } from '../src/alerts.ts';
import { Db } from '../src/db.ts';

const pool = (over: Partial<PoolSummary> = {}): PoolSummary => ({ name: 'tank', health: 'ONLINE', size: 2e12, allocated: 1e12, free: 1e12, capacity: 50, fragmentation: 1, ...over });
const disk = (over: Partial<Disk> = {}): Disk =>
  ({
    id: 'ata-DISK_1',
    ids: ['ata-DISK_1'],
    dev: '/dev/sda',
    size: 2e12,
    model: 'DISK',
    serial: '1',
    transport: 'sata',
    rotational: true,
    use: { kind: 'pool', pool: 'tank' },
    smart: { passed: true, temperature: 38, powerOnHours: 100, reallocated: 0, pending: 0, wear: null, testing: null },
    ...over,
  }) as Disk;
const input = (over: Partial<ConditionInput> = {}): ConditionInput => ({
  pools: [pool()],
  disks: [disk()],
  open: new Map(),
  backup: null,
  replications: [],
  scans: [],
  update: null,
  version: '0.8.2',
  ...over,
});
const keys = (i: ConditionInput) => conditions(i).map((c) => c.key).sort();
const open = (over: Partial<StoredAlert>): StoredAlert => ({
  key: 'pool:tank:full',
  severity: 'warning',
  title: 't',
  detail: null,
  since: '2026-09-16T00:00:00.000Z',
  raisedAt: '2026-09-16T00:00:00.000Z',
  lastSeen: '2026-09-16T00:00:00.000Z',
  confirmed: true,
  ackedAt: null,
  clearedAt: null,
  ...over,
});

test('a healthy box has nothing wrong', () => {
  assert.deepEqual(conditions(input()), []);
});

test('pools: not ONLINE is critical, full is a warning then critical, each with its own key', () => {
  assert.deepEqual(keys(input({ pools: [pool({ health: 'DEGRADED' })] })), ['pool:tank:state']);
  const full = conditions(input({ pools: [pool({ capacity: 91 })] }));
  assert.deepEqual(full.map((c) => [c.key, c.severity]), [['pool:tank:full', 'warning']]);
  assert.match(full[0].title, /91% full/);
  assert.equal(conditions(input({ pools: [pool({ capacity: 96 })] }))[0].severity, 'critical');
  assert.deepEqual(keys(input({ pools: [pool({ health: 'FAULTED', capacity: 99 })] })), ['pool:tank:full', 'pool:tank:state']);
});

test('a pool sitting on the line does not flap: raised at 90, held until it drops under 88', () => {
  assert.deepEqual(keys(input({ pools: [pool({ capacity: 89 })] })), [], 'not raised below the line');
  const held = new Map([['pool:tank:full', open({})]]);
  assert.deepEqual(keys(input({ pools: [pool({ capacity: 89 })], open: held })), ['pool:tank:full'], 'still raised while it hovers');
  assert.deepEqual(keys(input({ pools: [pool({ capacity: 87 })], open: held })), [], 'cleared once it really came down');
});

test('disks: a failed self-assessment, reallocated and pending sectors share one key; heat is its own, with hysteresis', () => {
  const smart = (over: Partial<NonNullable<Disk['smart']>>) =>
    input({ disks: [disk({ smart: { passed: true, temperature: 38, powerOnHours: 1, reallocated: 0, pending: 0, wear: null, testing: null, ...over } })] });
  assert.deepEqual(conditions(smart({ passed: false })).map((c) => [c.key, c.severity]), [['disk:ata-DISK_1:smart', 'critical']]);
  assert.equal(conditions(smart({ reallocated: 8 }))[0].severity, 'critical');
  assert.equal(conditions(smart({ pending: 2 }))[0].severity, 'warning');
  assert.deepEqual(keys(smart({ temperature: 56 })), ['disk:ata-DISK_1:temp']);
  assert.deepEqual(keys(smart({ temperature: 52 })), [], 'warm but not hot');
  const hot = new Map([['disk:ata-DISK_1:temp', open({ key: 'disk:ata-DISK_1:temp' })]]);
  assert.deepEqual(keys({ ...smart({ temperature: 52 }), open: hot }), ['disk:ata-DISK_1:temp'], 'stays until it cools below 50');
  assert.deepEqual(keys({ ...smart({ temperature: 48 }), open: hot }), []);
  assert.deepEqual(keys(input({ disks: [disk({ smart: null })] })), [], 'a disk asleep with no reading says nothing');
});

test('jobs and updates: a failed backup, replication or scrub, and a release worth installing', () => {
  const job = (over: Partial<Job>): Job => ({ id: 1, kind: 'scrub', replicationId: null, pool: 'tank', target: 'tank', state: 'failed', startedAt: '', finishedAt: null, progress: null, bytes: 0, total: null, message: 'errors', pid: null, ...over }) as Job;
  assert.deepEqual(keys(input({ backup: { dataset: 'tank/backups', lastAt: '', lastResult: 'failed', lastMessage: 'no space' } })), ['backup:settings']);
  assert.deepEqual(keys(input({ replications: [{ id: 3, dataset: 'tank/docs', host: 'other', lastResult: 'failed', lastMessage: null }] })), ['replication:3']);
  assert.deepEqual(keys(input({ scans: [job({})] })), ['scan:tank']);
  assert.deepEqual(keys(input({ scans: [job({ state: 'done' })] })), []);
  assert.deepEqual(keys(input({ update: { checkedAt: '', latest: { version: '0.9.0' }, error: null } })), ['update:available']);
  assert.deepEqual(keys(input({ update: { checkedAt: '', latest: { version: '0.8.2' }, error: null } })), [], 'already on it');
  assert.deepEqual(keys(input({ update: { checkedAt: '', latest: null, error: 'no network' } })), ['update:check']);
});

test('reconcile: new keys raise, changed text updates, unchanged only touch, gone ones clear', () => {
  const stored = [open({ key: 'pool:tank:full', title: 'Pool tank is 91% full' }), open({ key: 'backup:settings', title: 'The settings backup failed' })];
  const now = [
    { key: 'pool:tank:full', severity: 'warning' as const, title: 'Pool tank is 93% full', detail: null },
    { key: 'disk:ata-DISK_1:temp', severity: 'warning' as const, title: 'hot', detail: null },
  ];
  const plan = reconcile(stored, now);
  assert.deepEqual(plan.raise.map((c) => c.key), ['disk:ata-DISK_1:temp']);
  assert.deepEqual(plan.update.map((c) => c.key), ['pool:tank:full']);
  assert.deepEqual(plan.touch, []);
  assert.deepEqual(plan.clear, ['backup:settings']);
  const again = reconcile([open({ key: 'pool:tank:full', title: 'Pool tank is 93% full' })], [now[0]]);
  assert.deepEqual([again.raise.length, again.update.length, again.touch], [0, 0, ['pool:tank:full']]);
});

test('the database keeps since, forgets an acknowledgement when it clears, and prunes old history', () => {
  const db = new Db(':memory:');
  const t0 = Date.parse('2026-09-16T09:00:00Z');
  const c = { key: 'pool:tank:state', severity: 'critical' as const, title: 'Pool tank is DEGRADED', detail: null };
  db.applyAlerts({ raise: [c], update: [], touch: [], clear: [] }, t0, 60_000);
  let [a] = db.openAlerts(t0);
  assert.equal(a.confirmed, false, 'a fresh one is not worth waking anybody yet');
  assert.equal(a.since, new Date(t0).toISOString());

  // a minute later it is still true: confirmed, and the text may have changed
  const t1 = t0 + 60_000;
  db.applyAlerts({ raise: [], update: [{ ...c, title: 'Pool tank is DEGRADED (sdb FAULTED)' }], touch: [], clear: [] }, t1);
  [a] = db.openAlerts(t1);
  assert.equal(a.confirmed, true);
  assert.equal(a.since, new Date(t0).toISOString(), 'since is when it started, not when the text changed');
  assert.match(a.title, /sdb FAULTED/);

  assert.equal(db.ackAlert('pool:tank:state', t1), true);
  assert.equal(db.ackAlert('pool:tank:state', t1), false, 'acknowledging twice changes nothing');
  assert.equal(db.openAlerts(t1)[0].ackedAt, new Date(t1).toISOString());

  // the disk is replaced: cleared, and it moves to the history
  const t2 = t1 + 3_600_000;
  db.applyAlerts({ raise: [], update: [], touch: [], clear: ['pool:tank:state'] }, t2);
  assert.deepEqual(db.openAlerts(t2), []);
  assert.equal(db.clearedAlerts(30, 10, t2).length, 1);

  // it happens again: a new since, and the acknowledgement is gone, so it nags again
  const t3 = t2 + 86_400_000;
  db.applyAlerts({ raise: [c], update: [], touch: [], clear: [] }, t3);
  [a] = db.openAlerts(t3);
  assert.equal(a.since, new Date(t3).toISOString());
  assert.equal(a.ackedAt, null);
  assert.equal(db.clearedAlerts(30, 10, t3).length, 0, 'the row is the open one again');

  // history older than a month goes
  db.applyAlerts({ raise: [], update: [], touch: [], clear: ['pool:tank:state'] }, t3);
  db.pruneAlerts(t3 + 31 * 86_400_000);
  assert.deepEqual(db.clearedAlerts(60, 10, t3 + 31 * 86_400_000), []);
  db.close();
});

test('openAlerts: the worst first, and worstOf says how bad it is', () => {
  const db = new Db(':memory:');
  const t = Date.parse('2026-09-16T09:00:00Z');
  db.applyAlerts(
    {
      raise: [
        { key: 'update:available', severity: 'info', title: 'mk-nas 0.9.0 is out', detail: null },
        { key: 'disk:ata-DISK_1:temp', severity: 'warning', title: 'hot', detail: null },
        { key: 'pool:tank:state', severity: 'critical', title: 'DEGRADED', detail: null },
      ],
      update: [],
      touch: [],
      clear: [],
    },
    t,
  );
  assert.deepEqual(db.openAlerts(t).map((a) => a.key), ['pool:tank:state', 'disk:ata-DISK_1:temp', 'update:available']);
  assert.equal(worstOf(db.openAlerts(t)), 'critical');
  assert.equal(worstOf([]), null);
  db.close();
});
