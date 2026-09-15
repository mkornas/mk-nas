import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDatasetList, parsePoolList, parsePoolStatus, parseScan, parseSnapshotList } from '../src/zfs.ts';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('zpool list -Hp', () => {
  const pools = parsePoolList('tank\tONLINE\t1992864825344\t812345\t1992052480000\t0\t-\nscratch\tDEGRADED\t500\t250\t250\t50\t12\n');
  assert.equal(pools.length, 2);
  assert.deepEqual(pools[0], { name: 'tank', health: 'ONLINE', size: 1992864825344, allocated: 812345, free: 1992052480000, capacity: 0, fragmentation: null });
  assert.equal(pools[1].fragmentation, 12);
  assert.equal(pools[1].health, 'DEGRADED');
});

test('zpool status: healthy mirror', () => {
  const s = parsePoolStatus(fx('zpool-status-mirror.txt'));
  assert.equal(s.state, 'ONLINE');
  assert.equal(s.status, null);
  assert.equal(s.errors, 'No known data errors');
  assert.match(s.scan!, /^scrub repaired 0B/);
  assert.equal(s.vdevs.length, 1);
  assert.equal(s.vdevs[0].name, 'tank');
  assert.equal(s.vdevs[0].children[0].name, 'mirror-0');
  assert.deepEqual(
    s.vdevs[0].children[0].children.map((v) => v.name),
    ['ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA', 'ata-WDC_WD20EFRX-68EUZN0_WD-BBBBBBBBBBBB'],
  );
  const scrub = parseScan('tank', s.scan);
  assert.equal(scrub?.state, 'finished');
  assert.equal(scrub?.errors, 0);
  assert.equal(scrub?.finishedAt, new Date('Sun Sep 7 00:29:13 2026').toISOString(), 'the scan line is in the local time of the box');
});

test('zpool status: degraded, scrub running, multi-line status', () => {
  const s = parsePoolStatus(fx('zpool-status-degraded.txt'));
  assert.equal(s.state, 'DEGRADED');
  assert.match(s.status!, /label is missing or invalid\.\s+Sufficient replicas/);
  assert.match(s.action!, /zpool replace/);
  const missing = s.vdevs[0].children[0].children[1];
  assert.equal(missing.state, 'UNAVAIL');
  assert.match(missing.note!, /^was \/dev\/disk\/by-id\//);
  const scrub = parseScan('tank', s.scan);
  assert.equal(scrub?.state, 'running');
  assert.equal(scrub?.percent, 23.53);
});

test('scan line: none requested', () => {
  assert.equal(parseScan('t', 'none requested')?.state, 'none');
  assert.equal(parseScan('t', null), null);
});

test('zfs list -Hp datasets', () => {
  const out =
    'tank\tfilesystem\t1000\t2000\t100\t/tank\tyes\t0\tlz4\t1.45x\ton\t131072\t1757600000\ntank/photos\tfilesystem\t500\t2000\t500\t/tank/photos\tyes\t107374182400\tzstd\t1.00x\toff\t1048576\t1757600100\ntank/vm\tvolume\t10\t2000\t10\t-\tno\t-\tlz4\t1.00x\t-\t8192\t1757600200\n';
  const ds = parseDatasetList(out);
  assert.equal(ds.length, 3);
  assert.equal(ds[0].quota, null);
  assert.equal(ds[0].compressratio, 1.45);
  assert.equal(ds[0].atime, true);
  assert.equal(ds[0].creation, '2025-09-11T14:13:20.000Z');
  assert.equal(ds[1].quota, 107374182400);
  assert.equal(ds[1].pool, 'tank');
  assert.equal(ds[1].atime, false);
  assert.equal(ds[2].type, 'volume');
  assert.equal(ds[2].mountpoint, null);
  assert.equal(ds[2].mounted, false);
});

test('zfs list -Hp snapshots', () => {
  const s = parseSnapshotList('tank/photos@auto-2026-09-12_10-00\t0\t500\t1757671200\n');
  assert.deepEqual(s, [
    {
      name: 'tank/photos@auto-2026-09-12_10-00',
      dataset: 'tank/photos',
      snapshot: 'auto-2026-09-12_10-00',
      used: 0,
      referenced: 500,
      creation: '2025-09-12T10:00:00.000Z',
    },
  ]);
});
