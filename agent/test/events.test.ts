/** zpool events, parsed and kept: what is new, what matters, what is one line with a count. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog, parseEvents } from '../src/events.ts';
import type { Runner } from '../src/run.ts';

const T0 = 1_789_000_000; // 2026-09-09T…Z
const ev = (eid: number, cls: string, extra: Record<string, string> = {}, at = T0 + eid) =>
  [
    `Sep 13 2026 05:00:0${eid % 10}.000000000 ${cls}`,
    '        version = 0x0',
    `        class = "${cls}"`,
    '        pool = "tank"',
    '        pool_guid = 0x9a1',
    ...Object.entries(extra).map(([k, v]) => `        ${k} = ${v}`),
    `        time = 0x${at.toString(16)} 0x1c9c380`,
    `        eid = 0x${eid.toString(16)}`,
    '',
  ].join('\n');

const DISK = '"/dev/disk/by-id/ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA-part1"';

test('parseEvents: the class, pool, disk, states and time of each event; states spelled out or as hex', () => {
  const out =
    ev(1, 'sysevent.fs.zfs.config_sync') +
    ev(2, 'resource.fs.zfs.statechange', { vdev_state: '"FAULTED" (0x5)', vdev_path: DISK, prev_state: '0x7' }) +
    ev(3, 'ereport.fs.zfs.checksum', { vdev_path: DISK }) +
    ev(4, 'sysevent.fs.zfs.scrub_finish');
  const e = parseEvents(out);
  assert.deepEqual(
    e.map((x) => [x.eid, x.class, x.pool, x.vdev, x.state, x.prevState, x.matters]),
    [
      [1, 'sysevent.fs.zfs.config_sync', 'tank', null, null, null, false],
      [2, 'resource.fs.zfs.statechange', 'tank', 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA', 'FAULTED', 'ONLINE', true],
      [3, 'ereport.fs.zfs.checksum', 'tank', 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA', null, null, true],
      [4, 'sysevent.fs.zfs.scrub_finish', 'tank', null, null, null, false],
    ],
  );
  assert.equal(e[1].summary, 'tank: ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA went FAULTED (was ONLINE)');
  assert.equal(e[2].summary, 'tank: checksum error on ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA');
  assert.equal(e[3].summary, 'tank: scrub finished');
  assert.equal(e[1].time, new Date((T0 + 2) * 1000).toISOString());
  assert.deepEqual(parseEvents(''), []);
});

test('EventLog: only new ids on each poll, the tail newest first, repeats folded, a scan end noticed', async () => {
  let out = ev(1, 'sysevent.fs.zfs.config_sync') + ev(2, 'resource.fs.zfs.statechange', { vdev_state: '"DEGRADED" (0x6)', vdev_path: DISK, prev_state: '0x7' });
  let scanEnds = 0;
  const run: Runner = async () => ({ argv: [], exitCode: 0, stdout: out, stderr: '' });
  const log = new EventLog(run, { every: 60_000, onScanEnd: async () => void scanEnds++ });
  assert.equal((await log.poll()).length, 2);
  assert.equal((await log.poll()).length, 0, 'nothing new');
  out +=
    ev(3, 'ereport.fs.zfs.checksum', { vdev_path: DISK }) +
    ev(4, 'ereport.fs.zfs.checksum', { vdev_path: DISK }) +
    ev(5, 'ereport.fs.zfs.checksum', { vdev_path: DISK });
  out += ev(6, 'sysevent.fs.zfs.scrub_finish');
  assert.equal((await log.poll()).length, 4);
  assert.equal(scanEnds, 1);
  const recent = log.recent();
  assert.deepEqual(
    recent.map((e) => [e.eid, e.count, e.summary]),
    [
      [5, 3, 'tank: checksum error on ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA'],
      [2, 1, 'tank: ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA went DEGRADED (was ONLINE)'],
    ],
  );
  assert.equal(log.recent(50, true).length, 4, 'with the routine ones');
  assert.deepEqual(
    log.recent(50, true, new Date((T0 + 4) * 1000)).map((e) => [e.eid, e.count]),
    [
      [6, 1],
      [5, 2],
    ],
    'since, folded',
  );
  const quiet = new EventLog(async () => ({ argv: [], exitCode: 1, stdout: '', stderr: 'no zfs' }), { every: 60_000 });
  assert.deepEqual(await quiet.poll(), [], 'no zfs yet is not an error');
});
