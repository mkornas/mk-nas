import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Policy, Scrub, Snapshot } from '../../shared/types.ts';
import { plan, scrubDue } from '../src/policy.ts';

const policy = (over: Partial<Policy> = {}): Policy => ({ dataset: 'tank/docs', hourly: 0, daily: 0, weekly: 0, monthly: 0, updatedAt: '', ...over });
const snap = (name: string, at: string): Snapshot => ({
  name: `tank/docs@${name}`,
  dataset: 'tank/docs',
  snapshot: name,
  used: 0,
  referenced: 0,
  creation: at,
});
const now = new Date('2026-09-12T12:03:00Z');

test('nothing exists: one snapshot per enabled period', () => {
  const p = plan(policy({ hourly: 24, daily: 7 }), [], now);
  assert.deepEqual(
    p.take.map((t) => t.name),
    ['auto-hourly-2026-09-12_12-03', 'auto-daily-2026-09-12_12-03'],
  );
  assert.deepEqual(p.destroy, []);
});

test('not due yet: a recent hourly holds it off; a stale one is due', () => {
  assert.deepEqual(plan(policy({ hourly: 3 }), [snap('auto-hourly-2026-09-12_11-30', '2026-09-12T11:30:00Z')], now).take, []);
  assert.equal(
    plan(policy({ hourly: 3 }), [snap('auto-hourly-2026-09-12_10-55', '2026-09-12T10:55:00Z')], now).take.length,
    1,
    'slack: 68 minutes counts as an hour',
  );
});

test('pruning keeps the newest N of a period, counting the one about to be taken', () => {
  const existing = ['09-00', '10-00', '11-00'].map((h) => snap(`auto-hourly-2026-09-12_${h}`, `2026-09-12T${h.replace('-', ':')}:00Z`));
  const p = plan(policy({ hourly: 2 }), existing, now);
  assert.equal(p.take.length, 1);
  assert.deepEqual(p.destroy, ['tank/docs@auto-hourly-2026-09-12_09-00', 'tank/docs@auto-hourly-2026-09-12_10-00']);
});

test('a period switched off drops its automatic snapshots; manual and other datasets are never touched', () => {
  const existing = [
    snap('auto-hourly-2026-09-12_11-00', '2026-09-12T11:00:00Z'),
    snap('manual-keep', '2026-09-12T11:00:00Z'),
    { ...snap('auto-hourly-x', '2026-09-12T11:00:00Z'), dataset: 'tank/other', name: 'tank/other@auto-hourly-x' },
  ];
  const p = plan(policy({ daily: 1 }), existing, now);
  assert.deepEqual(p.destroy, ['tank/docs@auto-hourly-2026-09-12_11-00']);
  assert.equal(p.take[0].name, 'auto-daily-2026-09-12_12-03');
});

test('scrubDue: from the scan line alone — never while running, after the interval, at once when never scrubbed or after a resilver, never when off', () => {
  const scan = (over: Partial<Scrub>): Scrub => ({
    pool: 'tank',
    kind: 'scrub',
    state: 'finished',
    text: '',
    percent: null,
    finishedAt: null,
    errors: 0,
    ...over,
  });
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  assert.equal(scrubDue('monthly', null, now), true, 'never scrubbed');
  assert.equal(scrubDue('monthly', scan({ state: 'none' }), now), true, 'none requested');
  assert.equal(scrubDue('monthly', scan({ state: 'running', percent: 40 }), now), false);
  assert.equal(scrubDue('monthly', scan({ kind: 'resilver', state: 'running' }), now), false);
  assert.equal(scrubDue('monthly', scan({ finishedAt: days(29) }), now), false);
  assert.equal(scrubDue('monthly', scan({ finishedAt: days(30) }), now), true);
  assert.equal(scrubDue('weekly', scan({ finishedAt: days(6) }), now), false);
  assert.equal(scrubDue('weekly', scan({ finishedAt: days(7) }), now), true);
  assert.equal(scrubDue('weekly', scan({ state: 'canceled', finishedAt: days(1) }), now), false, 'a canceled scrub waits the interval too');
  assert.equal(scrubDue('weekly', scan({ kind: 'resilver', finishedAt: days(0) }), now), true, 'a scrub right after a rebuild');
  assert.equal(scrubDue('off', null, now), false);
  assert.equal(scrubDue('off', scan({ finishedAt: days(400) }), now), false);
});
