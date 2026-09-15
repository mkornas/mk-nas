import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadArgs, datasetName, diskId, only, poolName, snapshotName } from '../src/names.ts';

test('pool names', () => {
  assert.equal(poolName('tank'), 'tank');
  assert.equal(poolName('my-pool_2.0:x'), 'my-pool_2.0:x');
  for (const bad of ['-f', '', 'tank/x', '1tank', 'tank name', 'tank;rm', '../x', 42, null, 'a'.repeat(300)])
    assert.throws(() => poolName(bad), BadArgs, String(bad));
});

test('dataset names', () => {
  assert.equal(datasetName('tank/photos/2026'), 'tank/photos/2026');
  assert.throws(() => datasetName('1tank/x'), BadArgs, 'the pool part keeps the letter rule');
  for (const bad of ['tank/', '/tank', 'tank//x', 'tank/-x', 'tank@snap', 'tank/x y']) assert.throws(() => datasetName(bad), BadArgs, bad);
});

test('snapshot names', () => {
  assert.equal(snapshotName('tank/photos@auto-2026-09-12_10-00'), 'tank/photos@auto-2026-09-12_10-00');
  for (const bad of ['tank/photos', '@snap', 'tank@', 'tank@-x', 'tank@a b']) assert.throws(() => snapshotName(bad), BadArgs, bad);
});

test('disk ids: a by-id name, never a path', () => {
  assert.equal(diskId('ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA'), 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA');
  for (const bad of ['/dev/sda', '../sda', '-x', 'a b', '']) assert.throws(() => diskId(bad), BadArgs, bad);
});

test('only: undeclared keys are refused', () => {
  assert.deepEqual(only(undefined, []), {});
  assert.deepEqual(only({ pool: 't' }, ['pool']), { pool: 't' });
  assert.throws(() => only({ pool: 't', force: true }, ['pool']), /unexpected argument: force/);
});
