/**
 * The real thing: a pool on file vdevs in a temp dir, read through the verbs.
 * Runs only as root with zfs installed (CI, or `sudo npm test` on a dev box);
 * skips otherwise. Never touches a real disk.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { handle } from '../src/server.ts';
import { run } from '../src/run.ts';
import { Db } from '../src/db.ts';
import type { ShareConfig } from '../src/shares.ts';
const REPL = { keyFile: '/tmp/never-written.key', knownHosts: '/tmp/never-written.known_hosts' };
const NOSPAWN = () => {};
const NET = {
  netplanFile: '/tmp/never-written.yaml',
  pendingFile: '/tmp/never-written.json',
  hostsFile: '/tmp/never-written.hosts',
  resolvConf: '/tmp/never-written.resolv',
  sysNet: '/tmp/never-written.sys',
};
const BKP = {
  db: '/tmp/never-written.db',
  sshKey: '/tmp/never-written.key',
  knownHosts: '/tmp/never-written.known_hosts',
  netplanFile: '/tmp/never-written.yaml',
  driveEnv: '/tmp/never-written.env',
  driveDb: '/tmp/never-written-drive.db',
};

const SHARES: ShareConfig = {
  smbConf: '/tmp/never-written.conf',
  exportsFile: '/tmp/never-written.exports',
  smbGroup: 'mk-nas-smb',
  ownerUid: 1000,
  ownerGid: 1000,
  hostname: 'test',
};
import { plan } from '../src/policy.ts';
import { listSnapshots } from '../src/zfs.ts';

const POOL = `mknastest${process.pid}`;
const hasZfs = (() => {
  try {
    execFileSync('zpool', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const enabled = process.getuid?.() === 0 && hasZfs;
const deps = { run, version: 't', db: new Db(':memory:'), locationsDir: '', shares: SHARES, replication: REPL, spawn: NOSPAWN, network: NET, backup: BKP };
const audit = async () => {};
let dir = '';

before(async () => {
  if (!enabled) return;
  dir = await mkdtemp('/var/tmp/mk-nas-test-');
  const a = join(dir, 'a.img');
  const b = join(dir, 'b.img');
  await writeFile(a, '');
  await writeFile(b, '');
  await truncate(a, 256 * 1024 * 1024);
  await truncate(b, 256 * 1024 * 1024);
  // no altroot (-R): the agent chowns and removes location directories at the mountpoint ZFS was given, as on a real box,
  // and under an altroot they would sit at <altroot><mountpoint> instead. Every dataset here names an absolute mountpoint.
  execFileSync('zpool', ['create', '-O', 'mountpoint=none', POOL, 'mirror', a, b]);
  execFileSync('zfs', ['create', '-o', `mountpoint=/${POOL}/photos`, '-o', 'quota=64M', `${POOL}/photos`]);
  execFileSync('zfs', ['snapshot', `${POOL}/photos@first`]);
});
after(async () => {
  if (!enabled) return;
  try {
    execFileSync('zpool', ['destroy', POOL]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(`/${POOL}`, { recursive: true, force: true });
  }
});

test('pools, pool, datasets, snapshots, scrubs, health on a file-vdev mirror', { skip: !enabled && 'needs root and zfs' }, async () => {
  const pools = await handle({ id: 1, verb: 'pools' }, deps, audit);
  assert.equal(pools.ok, true);
  const mine = (pools.ok ? (pools.result as { name: string; health: string; size: number }[]) : []).find((p) => p.name === POOL);
  assert.equal(mine?.health, 'ONLINE');
  assert.ok((mine?.size ?? 0) > 200 * 1024 * 1024);

  const pool = await handle({ id: 2, verb: 'pool', args: { pool: POOL } }, deps, audit);
  assert.equal(pool.ok, true);
  const p = pool.ok ? (pool.result as { vdevs: { name: string; children: { name: string; children: unknown[] }[] }[]; errors: string }) : null;
  assert.equal(p?.vdevs[0].name, POOL);
  assert.equal(p?.vdevs[0].children[0].name, 'mirror-0');
  assert.equal(p?.vdevs[0].children[0].children.length, 2);
  assert.match(p?.errors ?? '', /No known data errors/);

  const ds = await handle({ id: 3, verb: 'datasets', args: { pool: POOL } }, deps, audit);
  const list = ds.ok ? (ds.result as { name: string; quota: number | null; mounted: boolean }[]) : [];
  assert.deepEqual(
    list.map((d) => d.name),
    [POOL, `${POOL}/photos`],
  );
  assert.equal(list[1].quota, 64 * 1024 * 1024);
  assert.equal(list[1].mounted, true);

  const snaps = await handle({ id: 4, verb: 'snapshots', args: { dataset: `${POOL}/photos` } }, deps, audit);
  assert.deepEqual(snaps.ok && (snaps.result as { name: string }[]).map((s) => s.name), [`${POOL}/photos@first`]);

  execFileSync('zpool', ['scrub', '-w', POOL]);
  const scrubs = await handle({ id: 5, verb: 'scrubs' }, deps, audit);
  const s = scrubs.ok ? (scrubs.result as { pool: string; state: string; errors: number }[]).find((x) => x.pool === POOL) : null;
  assert.equal(s?.state, 'finished');
  assert.equal(s?.errors, 0);

  // a scrub started through the verb is a job that jobs closes once the pool says it is over
  const started = await handle({ id: 50, verb: 'pool.scrub', args: { pool: POOL } }, deps, audit);
  assert.equal(started.ok, true, JSON.stringify(started));
  execFileSync('zpool', ['wait', '-t', 'scrub', POOL]);
  const jobs = await handle({ id: 51, verb: 'jobs', args: { pool: POOL } }, deps, audit);
  const job = jobs.ok ? (jobs.result as { kind: string; pool: string; state: string; message: string | null }[])[0] : null;
  assert.equal(job?.kind, 'scrub');
  assert.equal(job?.pool, POOL);
  assert.equal(job?.state, 'done', JSON.stringify(job));
  assert.match(job?.message ?? '', /^scrub repaired/);

  const health = await handle({ id: 6, verb: 'health' }, deps, audit);
  const h = health.ok ? (health.result as { pools: { name: string; ok: boolean }[] }) : null;
  assert.equal(h?.pools.find((x) => x.name === POOL)?.ok, true);

  const missing = await handle({ id: 7, verb: 'pool', args: { pool: `${POOL}nope` } }, deps, audit);
  assert.equal(!missing.ok && missing.error.code, 'not-found');
});

test(
  'make: dataset.create/set, snapshot.create/destroy/rollback, policy + tick plan on the real pool',
  { skip: !enabled && 'needs root and zfs' },
  async () => {
    const locations = join(dir, 'locations');
    await mkdir(locations, { recursive: true });
    const d = { ...deps, locationsDir: locations };
    let res = await handle(
      { id: 1, verb: 'dataset.create', args: { name: `${POOL}/docs`, quota: 32 * 1024 * 1024, compression: 'zstd', atime: false, location: true } },
      d,
      audit,
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    const made = res.ok ? (res.result as { mountpoint: string; quota: number; compression: string; atime: boolean }) : null;
    assert.equal(made?.mountpoint, join(locations, 'docs'));
    assert.equal(made?.quota, 32 * 1024 * 1024);
    assert.equal(made?.compression, 'zstd');
    assert.equal(made?.atime, false);
    const st = await stat(join(locations, 'docs'));
    assert.equal(st.uid, 1000, 'handed to the container user');

    res = await handle({ id: 2, verb: 'dataset.set', args: { dataset: `${POOL}/docs`, quota: null, compression: 'lz4' } }, d, audit);
    assert.equal(res.ok && (res.result as { quota: number | null; compression: string }).quota, null);
    assert.equal(res.ok && (res.result as { compression: string }).compression, 'lz4');

    await writeFile(join(locations, 'docs', 'a.txt'), 'one');
    res = await handle({ id: 3, verb: 'snapshot.create', args: { dataset: `${POOL}/docs`, name: 'one' } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    await writeFile(join(locations, 'docs', 'a.txt'), 'two');
    res = await handle({ id: 4, verb: 'snapshot.rollback', args: { snapshot: `${POOL}/docs@one`, confirm: `${POOL}/docs@one` } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.ok && res.result, { rolledBackTo: `${POOL}/docs@one` });
    assert.equal(await readFile(join(locations, 'docs', 'a.txt'), 'utf8'), 'one', 'the change since "one" is undone');
    // with a newer snapshot, the refusal names it and nothing changes; after destroying it the rollback goes through
    await writeFile(join(locations, 'docs', 'a.txt'), 'three');
    res = await handle({ id: 5, verb: 'snapshot.create', args: { dataset: `${POOL}/docs`, name: 'two' } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    res = await handle({ id: 5, verb: 'snapshot.rollback', args: { snapshot: `${POOL}/docs@one`, confirm: `${POOL}/docs@one` } }, d, audit);
    assert.match(!res.ok ? res.error.message : '', /has 1 newer snapshot \(two\)/);
    assert.equal(await readFile(join(locations, 'docs', 'a.txt'), 'utf8'), 'three');
    res = await handle({ id: 6, verb: 'snapshot.destroy', args: { snapshot: `${POOL}/docs@two`, confirm: `${POOL}/docs@two` } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    res = await handle({ id: 6, verb: 'snapshot.rollback', args: { snapshot: `${POOL}/docs@one`, confirm: `${POOL}/docs@one` } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(await readFile(join(locations, 'docs', 'a.txt'), 'utf8'), 'one');

    res = await handle({ id: 7, verb: 'policy.set', args: { dataset: `${POOL}/docs`, hourly: 2, daily: 0, weekly: 0, monthly: 0 } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    const snaps = await listSnapshots(run, `${POOL}/docs`);
    const p = plan(d.db.policy(`${POOL}/docs`)!, snaps, new Date());
    assert.equal(p.take.length, 1);
    assert.deepEqual(p.destroy, []);

    // destroy: refused while the snapshot is there, then gone with it, the policy and the location directory too
    res = await handle({ id: 8, verb: 'dataset.destroy', args: { dataset: `${POOL}/docs`, confirm: `${POOL}/docs` } }, d, audit);
    assert.match(!res.ok ? res.error.message : 'ok', /has 1 snapshot/);
    res = await handle({ id: 9, verb: 'dataset.destroy', args: { dataset: `${POOL}/docs`, confirm: `${POOL}/docs`, snapshots: true } }, d, audit);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.ok && res.result, { destroyed: `${POOL}/docs`, snapshots: 1, location: 'docs' });
    assert.equal(d.db.policy(`${POOL}/docs`), null);
    await assert.rejects(stat(join(locations, 'docs')));
    const left = await handle({ id: 10, verb: 'datasets', args: { pool: POOL } }, d, audit);
    assert.deepEqual(left.ok && (left.result as { name: string }[]).map((x) => x.name), [POOL, `${POOL}/photos`]);
  },
);
