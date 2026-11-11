/** The off-site backup against real restic and a repository on a path; only zfs is faked (a snapshot is a copy of the directory). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.ts';
import { BadArgs } from '../src/names.ts';
import { backup, due, listOffsiteSnapshots, readOffsite, readSecrets, removeOffsite, repositoryOf, restore, setOffsite, SNAPSHOT, stream, type OffsiteDeps } from '../src/offsite.ts';
import { run as realRun, type Runner } from '../src/run.ts';

const hasRestic = (() => {
  try {
    execFileSync('restic', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const DS = 'zfs list -H -p -t filesystem,volume -o name,type,used,avail,refer,mountpoint,mounted,quota,compression,compressratio,atime,recordsize,creation -s name';
const row = (name: string, mp: string, type = 'filesystem') => `${name}\t${type}\t0\t100\t0\t${mp}\tyes\t0\tlz4\t1.00x\toff\t131072\t1757600000\n`;

test('a repository is one of three kinds, and never something restic could read as an option', () => {
  assert.deepEqual(repositoryOf('s3:https://s3.eu-central-003.backblazeb2.com/my-bucket/nas'), { repository: 's3:https://s3.eu-central-003.backblazeb2.com/my-bucket/nas', kind: 's3' });
  assert.equal(repositoryOf('s3:http://minio.lan:9000/backups').kind, 's3');
  assert.equal(repositoryOf('b2:my-bucket:nas/box').kind, 'b2');
  assert.equal(repositoryOf('/mnt/usb/restic').kind, 'path');
  for (const bad of ['-o', '--repo=/x', 'relative/path', '/mnt/../etc', 's3:https://key:secret@host/bucket', 'rest:https://user:pw@host/', 'sftp:host:/x', 's3:https://host', '/mnt/usb disk', '', 42, null])
    assert.throws(() => repositoryOf(bad), BadArgs, String(bad));
});

test('due: manual never, the period with slack, at once when it never ran', () => {
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  assert.equal(due({ schedule: 'manual', lastRunAt: null }), false);
  assert.equal(due({ schedule: 'daily', lastRunAt: null }), true);
  assert.equal(due({ schedule: 'daily', lastRunAt: ago(23.9) }), true);
  assert.equal(due({ schedule: 'daily', lastRunAt: ago(2) }), false);
  assert.equal(due({ schedule: 'weekly', lastRunAt: ago(24 * 6) }), false);
});

test('set up, back up, thin out, restore — through real restic', { skip: hasRestic ? false : 'needs restic' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-offsite-'));
  try {
    const files = join(dir, 'tank', 'files');
    const other = join(dir, 'tank', 'other');
    await mkdir(join(files, 'sub'), { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(join(files, 'a.txt'), 'first version\n');
    await writeFile(join(files, 'sub', 'b.bin'), Buffer.alloc(300_000, 7));
    const repo = join(dir, 'repo');
    const zfsCalls: string[] = [];
    const snaps = new Set<string>();
    const run: Runner = async (argv, opts) => {
      if (argv[0] !== 'zfs') return realRun(argv, opts);
      const key = argv.join(' ');
      zfsCalls.push(key);
      const ok = (stdout = '') => ({ argv, exitCode: 0, stdout, stderr: '' });
      if (key === DS || key === `${DS} -r tank/files`) return ok(row('tank/files', files) + row('tank/other', other) + row('tank/vol', '-', 'volume'));
      if (key === `${DS} -r tank/other`) return ok(row('tank/other', other));
      if (key.startsWith('zfs list -H -p -t snapshot')) return ok([...snaps].filter((s) => s.startsWith(argv.at(-1)! + '@')).map((s) => `${s}\t0\t0\t1757600000\n`).join(''));
      // a snapshot is the directory as it is now, where ZFS would show it
      if (argv[1] === 'snapshot') {
        const [ds, name] = argv[2].split('@');
        const mp = ds === 'tank/files' ? files : other;
        await cp(mp, join(dir, 'staging'), { recursive: true });
        await mkdir(join(mp, '.zfs', 'snapshot'), { recursive: true });
        await cp(join(dir, 'staging'), join(mp, '.zfs', 'snapshot', name), { recursive: true });
        await rm(join(dir, 'staging'), { recursive: true });
        snaps.add(argv[2]);
        return ok();
      }
      if (argv[1] === 'destroy') {
        const [ds] = argv[2].split('@');
        await rm(join(ds === 'tank/files' ? files : other, '.zfs'), { recursive: true, force: true });
        return snaps.delete(argv[2]) ? ok() : { argv, exitCode: 1, stdout: '', stderr: 'could not find any snapshots to destroy' };
      }
      return { argv, exitCode: 1, stdout: '', stderr: `fake: no such command: ${key}` };
    };
    const db = new Db(':memory:');
    const cfg = { secrets: join(dir, 'secrets', 'offsite-secrets.json'), cache: join(dir, 'cache'), hostname: 'nas' };
    let now = new Date('2026-11-11T20:00:00Z');
    const deps: OffsiteDeps = { run, stream, db, cfg, pid: process.pid, now: () => now };

    assert.deepEqual(await readOffsite(run, db, cfg), { available: true, repository: null, datasets: [], schedule: 'daily', credentials: [], hasPassword: false, lastRunAt: null, lastResult: null, lastMessage: null, running: null });
    await assert.rejects(setOffsite(run, db, cfg, { repository: repo, datasets: ['tank/nope'] }), /no such dataset/);
    await assert.rejects(setOffsite(run, db, cfg, { repository: repo, datasets: ['tank/vol'] }), /only filesystems/);
    await assert.rejects(setOffsite(run, db, cfg, { repository: 's3:https://s3.example.com/bucket', datasets: ['tank/files'] }), /AWS_ACCESS_KEY_ID is needed/);
    await assert.rejects(setOffsite(run, db, cfg, { repository: repo, datasets: ['tank/files'], credentials: { NODE_OPTIONS: '--x' } }), /NODE_OPTIONS is not one/);
    assert.equal(db.offsite(), null, 'a refused setup stores nothing');

    // a new repository: made, and its password said once
    const made = await setOffsite(run, db, cfg, { repository: repo, datasets: ['tank/files'], schedule: 'weekly' });
    assert.match(made.password ?? '', /^[A-Za-z0-9_-]{32}$/);
    assert.deepEqual([made.repository, made.datasets, made.schedule, made.hasPassword], [repo, ['tank/files'], 'weekly', true]);
    assert.ok((await readdir(repo)).includes('config'), 'restic init ran');
    assert.equal((await stat(cfg.secrets)).mode & 0o777, 0o600);
    assert.equal((await readSecrets(cfg.secrets))?.password, made.password);
    const again = await setOffsite(run, db, cfg, { repository: repo, datasets: ['tank/files', 'tank/other'] });
    assert.equal(again.password, undefined, 'never said again');
    assert.equal((await readSecrets(cfg.secrets))?.password, made.password, 'and kept while the repository stays the same');
    assert.ok(!JSON.stringify(await readOffsite(run, db, cfg)).includes(made.password!));

    // another box, the same repository: only with its password
    const db2 = new Db(':memory:');
    const cfg2 = { ...cfg, secrets: join(dir, 'secrets2.json') };
    await assert.rejects(setOffsite(run, db2, cfg2, { repository: repo, datasets: ['tank/files'] }), /exists already: give its password/);
    await assert.rejects(setOffsite(run, db2, cfg2, { repository: repo, datasets: ['tank/files'], password: 'not-the-right-one' }), /not its password/);
    assert.equal((await setOffsite(run, db2, cfg2, { repository: repo, datasets: ['tank/files'], password: made.password })).password, undefined);
    db2.close();

    await writeFile(join(other, 'c.txt'), 'in the other dataset\n');
    let job = await backup(deps);
    assert.equal(job.state, 'done', job.message ?? '');
    assert.match(job.message ?? '', /^3 files in 2 datasets, \d+ MB new$/);
    assert.equal(job.kind, 'offsite');
    assert.equal(db.offsite()?.lastResult, 'ok');
    assert.equal(snaps.size, 0, `the ${SNAPSHOT} snapshots are gone when the run ends`);
    let list = await listOffsiteSnapshots(deps);
    assert.deepEqual(list.map((s) => s.dataset).sort(), ['tank/files', 'tank/other']);

    // a second run the same day: the change arrives. restic keeps one snapshot a day per dataset, and from 0.17 the
    // oldest one too while the history is still short, so two or four are left
    await writeFile(join(files, 'a.txt'), 'second version\n');
    snaps.add(`tank/files@${SNAPSHOT}`); // one left behind by a run that was cut short
    job = await backup(deps);
    assert.equal(job.state, 'done', job.message ?? '');
    list = await listOffsiteSnapshots(deps);
    assert.ok(list.length === 2 || list.length === 4, `${list.length} snapshots`);
    assert.ok(list[0].time >= list.at(-1)!.time, 'newest first');
    assert.ok(!list.some((s) => 'path' in s), 'the path it was read from is not part of the answer');

    // back, into a new directory
    await writeFile(join(files, 'a.txt'), 'ruined\n');
    const snap = list.find((s) => s.dataset === 'tank/files')!;
    job = await restore(deps, snap.id, 'tank/other');
    assert.equal(job.state, 'done', job.message ?? '');
    const target = join(other, 'restored-2026-11-11_20-00');
    assert.equal(await readFile(join(target, 'a.txt'), 'utf8'), 'second version\n');
    assert.deepEqual(await readFile(join(target, 'sub', 'b.bin')), Buffer.alloc(300_000, 7));
    assert.equal(await readFile(join(files, 'a.txt'), 'utf8'), 'ruined\n', 'nothing that exists is written over');
    job = await restore(deps, snap.id, 'tank/other');
    assert.equal(job.state, 'failed', 'the same minute: the directory is there, so it is a refusal and not a merge');
    assert.equal((await restore(deps, 'deadbeef00', 'tank/other')).state, 'failed');

    // a dataset that went away fails the run and leaves the history alone
    db.setOffsite({ repository: repo, datasets: ['tank/files', 'tank/gone'], schedule: 'daily' });
    job = await backup(deps);
    assert.equal(job.state, 'failed');
    assert.match(job.message ?? '', /tank\/gone: not there or not mounted/);
    assert.equal(db.offsite()?.lastResult, 'failed');
    assert.ok(!zfsCalls.some((c) => /offsite-secrets|RESTIC_PASSWORD/.test(c)));

    await removeOffsite(run, db, cfg);
    assert.equal(db.offsite(), null);
    assert.equal(await readSecrets(cfg.secrets), null);
    assert.ok((await readdir(repo)).includes('config'), 'the repository itself is left alone');
    await assert.rejects(backup(deps).then((j) => (j.state === 'failed' ? Promise.reject(new Error(j.message ?? '')) : j)), /no off-site backup is set up/);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
