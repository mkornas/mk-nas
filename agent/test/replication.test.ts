/** Replication: the plan, and one run end to end against a fake runner and a fake pipe. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.ts';
import { BadArgs } from '../src/names.ts';
import { due, plan, replicate, sshArgv, type Pipe } from '../src/replication.ts';
import type { Runner, RunResult } from '../src/run.ts';

test('plan: resume wins, empty target = full, newest common = incremental, nothing new = none, diverged = refusal', () => {
  assert.deepEqual(plan(['a', 'b'], [], null, 'b'), { kind: 'full', to: 'b' });
  assert.deepEqual(plan(['a', 'b', 'c'], ['a', 'b'], null, 'c'), { kind: 'incremental', from: 'b', to: 'c' });
  assert.deepEqual(
    plan(['a', 'b', 'c'], ['a'], null, 'c'),
    { kind: 'incremental', from: 'a', to: 'c' },
    'the newest one both sides have, even when the target is behind',
  );
  assert.deepEqual(plan(['a', 'b'], ['b'], null, 'b'), { kind: 'none' });
  assert.deepEqual(plan(['a'], ['zzz'], 'TOKEN', 'a'), { kind: 'resume', token: 'TOKEN' });
  assert.throws(() => plan(['a', 'b'], ['x', 'y'], null, 'b'), BadArgs);
});

test('due: manual never; the period with slack', () => {
  const r = { schedule: 'daily' as const, lastRunAt: new Date(Date.now() - 23.9 * 3_600_000).toISOString() };
  assert.equal(due({ ...r } as never), true);
  assert.equal(due({ ...r, lastRunAt: new Date(Date.now() - 3_600_000).toISOString() } as never), false);
  assert.equal(due({ ...r, lastRunAt: null } as never), true);
  assert.equal(due({ ...r, schedule: 'manual' } as never), false);
});

test('ssh argv: batch mode, our key, our known_hosts, the remote command as arguments', () => {
  const a = sshArgv({ keyFile: '/k', knownHosts: '/kh' }, { host: 'backup-host', user: 'root', port: 2222 }, ['zfs', 'list']);
  assert.deepEqual(a, [
    'ssh',
    '-i',
    '/k',
    '-o',
    'BatchMode=yes',
    '-o',
    'UserKnownHostsFile=/kh',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-p',
    '2222',
    'root@backup-host',
    'zfs',
    'list',
  ]);
});

const DS =
  'zfs list -H -p -t filesystem,volume -o name,type,used,avail,refer,mountpoint,mounted,quota,compression,compressratio,atime,recordsize,creation -s name';

function fake(table: Record<string, string | RunResult | ((argv: string[]) => string | RunResult)>): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    // the ssh wrapper is noise for matching: look at the remote command
    const key = argv[0] === 'ssh' ? 'ssh ' + argv.slice(argv.findIndex((x) => x.includes('@')) + 1).join(' ') : argv.join(' ');
    let hit = table[key] ?? table[Object.keys(table).find((k) => k.endsWith('*') && key.startsWith(k.slice(0, -1))) ?? ''];
    if (typeof hit === 'function') hit = hit(argv);
    if (hit === undefined) return { argv, exitCode: 1, stdout: '', stderr: `fake: no such command: ${key}` };
    return typeof hit === 'string' ? { argv, exitCode: 0, stdout: hit, stderr: '' } : { ...hit, argv };
  };
  return { run, calls };
}

test('a first run sends everything; the next one sends the difference and prunes beyond keep; a dead receiver fails the job with its message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-repl-'));
  try {
    await writeFile(join(dir, 'key.pub'), 'ssh-ed25519 AAAA mk-nas\n');
    const db = new Db(':memory:');
    const cfg = { keyFile: join(dir, 'key'), knownHosts: join(dir, 'kh') };
    const localSnaps: string[] = [];
    const remoteSnaps: string[] = [];
    let now = new Date('2026-09-12T20:00:00Z');
    const f = fake({
      [`${DS} -r tank/photos`]: 'tank/photos\tfilesystem\t0\t100\t0\t/srv/locations/photos\tyes\t0\tlz4\t1.00x\toff\t131072\t1757600000\n',
      'zfs snapshot *': (argv) => {
        localSnaps.push(argv.at(-1)!.split('@')[1]);
        return '';
      },
      'zfs list -H -o name -t snapshot -s creation -d 1 tank/photos': () => localSnaps.map((s) => `tank/photos@${s}`).join('\n') + '\n',
      'ssh zfs list -H -o name -t snapshot -d 1 backup/photos': () =>
        remoteSnaps.length
          ? { argv: [], exitCode: 0, stdout: remoteSnaps.map((s) => `backup/photos@${s}`).join('\n') + '\n', stderr: '' }
          : { argv: [], exitCode: 1, stdout: '', stderr: "cannot open 'backup/photos': dataset does not exist\n" },
      'ssh zfs get -H -o value receive_resume_token backup/photos': '-\n',
      'zfs send -n *': (argv) => ({
        argv,
        exitCode: 0,
        stdout: `${argv.includes('-I') ? 'incremental' : 'full'}\t${argv.at(-1)}\t${argv.includes('-I') ? 2048 : 10485760}\nsize\t${argv.includes('-I') ? 2048 : 10485760}\n`,
        stderr: '',
      }),
      'zfs destroy *': '',
      'ssh zfs destroy *': '',
    });
    const piped: { send: string[]; recv: string[] }[] = [];
    let receiverDies = false;
    const pipe: Pipe = async (send, recv, onProgress) => {
      piped.push({ send, recv });
      if (receiverDies) return { exitCode: 1, stderr: 'cannot receive: destination backup/photos has been modified since most recent snapshot' };
      onProgress(4 * 1048576);
      onProgress(10485760);
      remoteSnaps.push(send.at(-1)!.split('@')[1]);
      return { exitCode: 0, stderr: '' };
    };
    const r = db.setReplication({
      dataset: 'tank/photos',
      host: 'backup-host',
      user: 'root',
      port: 22,
      targetDataset: 'backup/photos',
      recursive: false,
      schedule: 'daily',
      keep: 2,
    });
    const deps = { run: f.run, pipe, db, cfg, pid: process.pid, now: () => now };

    let job = await replicate(deps, r.id);
    assert.equal(job.state, 'done', job.message ?? '');
    assert.match(job.message ?? '', /^full send of repl-2026-09-12_20-00, 10 MB$/);
    assert.equal(job.progress, 100);
    assert.deepEqual(piped[0].send, ['zfs', 'send', '-P', '-v', '-p', 'tank/photos@repl-2026-09-12_20-00']);
    assert.deepEqual(
      piped[0].recv.slice(-9),
      ['root@backup-host', 'zfs', 'receive', '-u', '-s', '-x', 'mountpoint', '-o', 'readonly=on', 'backup/photos'].slice(-9),
    );
    assert.equal(db.replication(r.id)?.lastResult, 'ok');

    now = new Date('2026-09-12T21:00:00Z');
    job = await replicate(deps, r.id);
    assert.equal(job.state, 'done', job.message ?? '');
    assert.match(job.message ?? '', /^incremental from repl-2026-09-12_20-00 to repl-2026-09-12_21-00/);
    assert.deepEqual(piped[1].send, ['zfs', 'send', '-P', '-v', '-p', '-I', 'tank/photos@repl-2026-09-12_20-00', 'tank/photos@repl-2026-09-12_21-00']);
    assert.ok(!f.calls.some((c) => c[0] === 'zfs' && c[1] === 'destroy'), 'keep 2: nothing pruned yet');

    now = new Date('2026-09-12T22:00:00Z');
    job = await replicate(deps, r.id);
    assert.equal(job.state, 'done', job.message ?? '');
    const pruned = f.calls.filter((c) => c.includes('destroy')).map((c) => c.at(-1));
    assert.deepEqual(
      pruned,
      ['tank/photos@repl-2026-09-12_20-00', 'backup/photos@repl-2026-09-12_20-00'],
      'the oldest of ours goes, on both sides, nothing else',
    );
    assert.ok(!f.calls.some((c) => c.includes('-F')), 'never a forced receive');

    receiverDies = true;
    now = new Date('2026-09-12T23:00:00Z');
    job = await replicate(deps, r.id);
    assert.equal(job.state, 'failed');
    assert.match(job.message ?? '', /has been modified since/);
    assert.equal(db.replication(r.id)?.lastResult, 'failed');
    assert.equal(db.jobs().length, 4);
    assert.equal(db.jobs(r.id)[0].state, 'failed', 'newest first');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a job whose process is gone is failed on the next start; a live one is left alone', () => {
  const db = new Db(':memory:');
  const r = db.setReplication({ dataset: 'a', host: 'h', user: 'root', port: 22, targetDataset: 'b', recursive: false, schedule: 'manual', keep: 1 });
  const dead = db.startJob('replication', r.id, 'a → h', 999999);
  const live = db.startJob('replication', r.id, 'a → h', process.pid);
  assert.equal(
    db.failDeadJobs((pid) => pid === process.pid, 'interrupted'),
    1,
  );
  assert.equal(db.job(dead.id)?.state, 'failed');
  assert.equal(db.job(live.id)?.state, 'running');
});

test('a row that would not pass replication.set (a restored database) fails its job before any command runs', async () => {
  const db = new Db(':memory:');
  const f = fake({});
  const pipe: Pipe = async () => ({ exitCode: 0, stderr: '' });
  const deps = { run: f.run, pipe, db, cfg: { keyFile: '/nonexistent/key', knownHosts: '/nonexistent/kh' }, pid: process.pid };
  const base = {
    dataset: 'tank/photos',
    host: 'backup-host',
    user: 'root',
    port: 22,
    targetDataset: 'backup/photos',
    recursive: false,
    schedule: 'daily' as const,
    keep: 2,
  };
  for (const [over, re] of [
    [{ host: '-oProxyCommand=touch /tmp/x' }, /host: not a host name/],
    [{ user: 'root -oProxyCommand' }, /user: not a user name/],
    [{ dataset: '-R' }, /dataset: not a dataset name/],
    [{ targetDataset: 'backup/photos@x' }, /targetDataset: not a dataset name/],
    [{ port: 0 }, /port: 1 to 65535/],
    [{ keep: 0 }, /keep: 1 to 100/],
  ] as [Record<string, unknown>, RegExp][]) {
    const r = db.setReplication({ ...base, ...over } as never);
    const job = await replicate(deps, r.id);
    assert.equal(job.state, 'failed', JSON.stringify(over));
    assert.match(job.message ?? '', /is not valid/);
    assert.match(job.message ?? '', re);
    assert.equal(db.replication(r.id)?.lastResult, 'failed');
  }
  assert.deepEqual(f.calls, [], 'no ssh, no zfs, not even ssh-keygen');
});
