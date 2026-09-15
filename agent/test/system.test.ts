/** Vitals from /proc and /sys fixtures: what is read, how rates and percentages come out of two reads, what the ring keeps. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff, pointOf, readRaw, Vitals } from '../src/system.ts';

const A = new URL('./fixtures/proc-a/', import.meta.url).pathname;
const B = new URL('./fixtures/proc-b/', import.meta.url).pathname;

test('readRaw: cpu jiffies, cores, load, uptime, memory in bytes, physical NICs only, whole disks only, hwmon temperatures', async () => {
  const r = await readRaw(A, 1000);
  assert.deepEqual([r.cpuBusy, r.cpuTotal, r.cores], [1500, 10000, 2]);
  assert.deepEqual(r.load, [0.52, 0.4, 0.31]);
  assert.equal(r.uptime, 86400);
  assert.deepEqual(r.memory, { total: 16000000 * 1024, available: 10000000 * 1024 });
  assert.deepEqual(r.swap, { total: 4000000 * 1024, free: 3000000 * 1024 });
  assert.deepEqual([...r.net.keys()], ['enp3s0'], 'lo, docker0 and veth are plumbing');
  assert.deepEqual([...r.disks.keys()], ['sda', 'sdb', 'nvme0n1'], 'no partitions, no loop, no zvol');
  assert.deepEqual(r.temps, [
    { sensor: 'coretemp', label: 'Package id 0', celsius: 45 },
    { sensor: 'nvme', label: 'Composite', celsius: 38 },
  ]);
  const none = await readRaw('/nonexistent', 1);
  assert.equal(none.cpuTotal, 0, 'a box without /proc reads as zeros, not an error');
});

test('diff: five seconds apart — cpu %, per-second rates, busy %, memory used', async () => {
  const s = diff(await readRaw(A, 0), await readRaw(B, 5000));
  assert.equal(s.cpu, 50, '500 busy of 1000 jiffies');
  assert.deepEqual(s.load, [1.52, 0.6, 0.35]);
  assert.equal(s.memory.used, 6000000 * 1024);
  assert.equal(s.swap.used, 1000000 * 1024);
  assert.deepEqual(s.net, [{ name: 'enp3s0', rx: 1_000_000, tx: 100_000 }]);
  assert.deepEqual(s.disks[0], { dev: 'sda', read: (20480 * 512) / 5, write: (10240 * 512) / 5, busy: 20 });
  assert.deepEqual(s.disks[2], { dev: 'nvme0n1', read: 0, write: 0, busy: 0 });
  assert.equal(s.temps[0].celsius, 52);
  const p = pointOf(s);
  assert.deepEqual([p.cpu, p.load, p.rx, p.tx, p.read, p.write, p.temp], [50, 1.52, 1_000_000, 100_000, 2 * 20480 * 102.4, 2 * 10240 * 102.4, 52]);
});

test('Vitals: nothing until the second read, then a sample per read, the ring capped', async () => {
  const v = new Vitals({ every: 60_000, keep: 3, root: A });
  assert.equal(await v.sample(0), null);
  assert.equal(v.snapshot().uptime, 86400);
  assert.equal(v.snapshot().cores, 2);
  const s = await v.sample(5000);
  assert.ok(s);
  for (let i = 2; i <= 5; i++) await v.sample(i * 5000);
  const snap = v.snapshot();
  assert.equal(snap.history.length, 3);
  assert.equal(snap.history.at(-1)?.at, new Date(25000).toISOString());
  assert.equal(snap.now?.at, new Date(25000).toISOString());
});
