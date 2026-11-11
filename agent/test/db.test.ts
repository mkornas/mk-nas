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
