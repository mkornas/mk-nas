import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.ts';

test('a write waits for another process holding the database instead of failing on it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-db-'));
  const file = join(dir, 'nas.db');
  const db = new Db(file);
  // the timer's tick, a replication or an install: another process in the middle of its own write
  const holder = spawn(process.execPath, [
    '-e',
    `const { DatabaseSync } = require('node:sqlite');
     const d = new DatabaseSync(process.argv[1]);
     d.exec('BEGIN IMMEDIATE');
     console.log('held');
     setTimeout(() => { d.exec('COMMIT'); d.close(); }, 400);`,
    file,
  ]);
  try {
    await new Promise<void>((resolve, reject) => {
      holder.stdout.once('data', () => resolve());
      holder.once('error', reject);
      holder.once('exit', () => reject(new Error('the holder exited before it held the database')));
    });
    const t0 = Date.now();
    db.recordUpdateCheck(null, 'x');
    assert.ok(Date.now() - t0 >= 200, 'it waited for the other write');
    assert.equal(db.updateCheck()?.error, 'x');
  } finally {
    holder.kill();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('history: finished jobs older than a year go, the newest of each kind per target stays, a running one is never touched', () => {
  const db = new Db(':memory:');
  const day = 86_400_000;
  const now = Date.parse('2026-11-11T00:00:00Z');
  const old = db.startScan('scrub', 'tank', now - 800 * day);
  db.finishJob(old.id, 'done', 'clean', now - 800 * day);
  const failed = db.startScan('scrub', 'tank', now - 400 * day);
  db.finishJob(failed.id, 'failed', '2 errors', now - 400 * day);
  const stuck = db.startScan('resilver', 'tank', now - 500 * day);
  const recent = db.startScan('scrub', 'cold', now - 30 * day);
  db.finishJob(recent.id, 'done', 'clean', now - 30 * day);
  for (let i = 0; i < 60; i++) db.finishUpdateRun(db.startUpdateRun(`0.0.${i}`, 1, now - (60 - i) * day).id, 'done', 'ok', now);
  assert.equal(db.pruneHistory(now), 11);
  assert.deepEqual(db.jobs().map((j) => j.id).sort(), [failed.id, stuck.id, recent.id].sort(), 'the last scrub of tank stays though it is old');
  assert.equal(db.updateRun()?.version, '0.0.59');
  assert.equal(db.pruneHistory(now), 0);
  db.close();
});
