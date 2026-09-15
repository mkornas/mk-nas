/** Updates: what GitHub's answer becomes, what may be installed, and an install that believes nothing unsigned. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.ts';
import { run as realRun, type Runner } from '../src/run.ts';
import {
  checkDue,
  checkForUpdate,
  fetchLatest,
  installable,
  installRelease,
  newer,
  parseSums,
  readUpdate,
  type Fetch,
  type UpdateConfig,
} from '../src/updates.ts';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const REL = 'https://github.com/o/mk-nas/releases/download';

function cfgIn(dir: string): UpdateConfig {
  return {
    repo: 'o/mk-nas',
    driveRepo: 'o/mk-drive',
    driveImage: 'ghcr.io/o/mk-drive',
    dir: join(dir, 'updates'),
    signers: join(dir, 'signers'),
    driveImageFile: join(dir, 'mk-drive-image.tgz'),
    loadImage: '/opt/load-image.sh',
    pinnedDriveFile: join(dir, 'drive-version'),
    agentPackage: join(dir, 'package.json'),
  };
}

/** A fake GitHub: URL → body (object = JSON). Anything else is a 404. */
function github(files: Record<string, string | Buffer | object>): { fetch: Fetch; asked: string[] } {
  const asked: string[] = [];
  const f = (async (input: string | URL) => {
    const url = String(input);
    asked.push(url);
    const hit = files[url];
    if (hit === undefined) return new Response('not found', { status: 404 });
    const body = typeof hit === 'string' || Buffer.isBuffer(hit) ? hit : JSON.stringify(hit);
    return new Response(body as BodyInit, { status: 200 });
  }) as Fetch;
  return { fetch: f, asked };
}

const asset = (name: string, url = `${REL}/v0.6.0/${name}`) => ({ name, browser_download_url: url });
const apiRelease = (names: string[], extra: object = {}) => ({
  tag_name: 'v0.6.0',
  body: '## Changes\n- a thing',
  published_at: '2026-09-20T10:00:00Z',
  html_url: 'https://github.com/o/mk-nas/releases/tag/v0.6.0',
  assets: names.map((n) => asset(n)),
  ...extra,
});
const META = { agent: '0.6.0', drive: '0.3.1', contract: 2, driveImageSha256: 'a'.repeat(64) };

test('newer and parseSums', () => {
  assert.ok(newer('0.10.0', '0.9.9'));
  assert.ok(newer('1.0.0', '0.99.99'));
  assert.ok(!newer('0.5.0', '0.5.0'));
  assert.ok(!newer('0.4.9', '0.5.0'));
  const sums = parseSums(`${'1'.repeat(64)}  mk-nas_0.6.0_amd64.deb\n${'2'.repeat(64)} *release.json\ngarbage\n`);
  assert.deepEqual(
    [...sums],
    [
      ['mk-nas_0.6.0_amd64.deb', '1'.repeat(64)],
      ['release.json', '2'.repeat(64)],
    ],
  );
});

test("fetchLatest: GitHub's latest release and its release.json; signed only with the signature and the image checksum", async () => {
  const cfg = cfgIn('/nowhere');
  const latest = 'https://api.github.com/repos/o/mk-nas/releases/latest';
  let g = github({ [latest]: apiRelease(['release.json', 'SHA256SUMS', 'SHA256SUMS.sig']), [`${REL}/v0.6.0/release.json`]: META });
  const r = await fetchLatest(g.fetch, cfg, '0.5.0');
  assert.deepEqual(
    { ...r, notes: r.notes.length > 0 },
    {
      version: '0.6.0',
      drive: '0.3.1',
      contract: 2,
      notes: true,
      publishedAt: '2026-09-20T10:00:00Z',
      url: 'https://github.com/o/mk-nas/releases/tag/v0.6.0',
      signed: true,
    },
  );

  g = github({ [latest]: apiRelease(['release.json', 'SHA256SUMS']), [`${REL}/v0.6.0/release.json`]: META });
  assert.equal((await fetchLatest(g.fetch, cfg, '0.5.0')).signed, false, 'no .sig, not installable');
  g = github({
    [latest]: apiRelease(['release.json', 'SHA256SUMS', 'SHA256SUMS.sig']),
    [`${REL}/v0.6.0/release.json`]: { ...META, driveImageSha256: undefined },
  });
  assert.equal((await fetchLatest(g.fetch, cfg, '0.5.0')).signed, false, 'a release from before the image checksum');

  const elsewhere = { ...apiRelease([]), assets: [asset('release.json', 'https://evil.example/release.json')] };
  g = github({ [latest]: elsewhere, 'https://evil.example/release.json': META });
  await assert.rejects(fetchLatest(g.fetch, cfg, '0.5.0'), /no release.json/, 'an asset URL outside the repository is not followed');
  assert.ok(!g.asked.includes('https://evil.example/release.json'));

  g = github({ [latest]: { ...apiRelease(['release.json']), tag_name: 'v0.6.0; rm -rf /' } });
  await assert.rejects(fetchLatest(g.fetch, cfg, '0.5.0'), /X\.Y\.Z/);
  g = github({ [latest]: apiRelease(['release.json']), [`${REL}/v0.6.0/release.json`]: { ...META, agent: '0.7.0' } });
  await assert.rejects(fetchLatest(g.fetch, cfg, '0.5.0'), /says 0\.7\.0/);
});

test('check: recorded with the time; a failed check keeps the last release and says why; due once a day', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-upd-'));
  const cfg = cfgIn(dir);
  await writeFile(cfg.pinnedDriveFile, '0.3.0\n');
  const db = new Db(':memory:');
  const t0 = Date.parse('2026-09-20T12:00:00Z');
  try {
    assert.ok(checkDue(db, t0));
    const latest = 'https://api.github.com/repos/o/mk-nas/releases/latest';
    await checkForUpdate(
      github({ [latest]: apiRelease(['release.json', 'SHA256SUMS', 'SHA256SUMS.sig']), [`${REL}/v0.6.0/release.json`]: META }).fetch,
      db,
      cfg,
      '0.5.0',
      t0,
    );
    let u = await readUpdate(db, cfg, '0.5.0', () => true);
    assert.deepEqual([u.current, u.drive, u.latest?.version, u.available, u.error, u.run], ['0.5.0', '0.3.0', '0.6.0', true, null, null]);
    assert.ok(!checkDue(db, t0 + 3_600_000));

    await checkForUpdate(github({}).fetch, db, cfg, '0.5.0', t0 + 25 * 3_600_000);
    u = await readUpdate(db, cfg, '0.5.0', () => true);
    assert.equal(u.latest?.version, '0.6.0', 'the last known release stays');
    assert.match(u.error ?? '', /404/);
    assert.equal(u.checkedAt, new Date(t0 + 25 * 3_600_000).toISOString());
    assert.equal((await readUpdate(db, cfg, '0.6.0', () => true)).available, false, 'nothing newer than what runs');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('installable: only the newest checked release, newer, signed, one at a time; a dead run does not block', () => {
  const db = new Db(':memory:');
  const rel = { version: '0.6.0', drive: '0.3.1', contract: 2, notes: '', publishedAt: '', url: '', signed: true };
  assert.throws(() => installable(db, '0.5.0', '0.6.0'), /check again/);
  db.recordUpdateCheck(rel, null);
  assert.throws(() => installable(db, '0.5.0', '../../etc'), /X\.Y\.Z/);
  assert.throws(() => installable(db, '0.5.0', '0.5.9'), /newest release/);
  assert.throws(() => installable(db, '0.6.0', '0.6.0'), /not newer/);
  assert.equal(installable(db, '0.5.0', '0.6.0'), '0.6.0');
  const r = db.startUpdateRun('0.6.0', 424242);
  assert.throws(() => installable(db, '0.5.0', '0.6.0'), /already running/);
  db.failDeadUpdateRuns(() => false);
  assert.equal(db.updateRun(r.id)?.state, 'failed');
  assert.equal(installable(db, '0.5.0', '0.6.0'), '0.6.0');
  db.recordUpdateCheck({ ...rel, signed: false }, null);
  assert.throws(() => installable(db, '0.5.0', '0.6.0'), /not signed/);
  db.close();
});

/** A release on disk, signed with a throwaway key, served by the fake GitHub; the runner's system commands faked except ssh-keygen. */
async function signedRelease(opts: { tamperDeb?: boolean; wrongKey?: boolean; imageOnBox?: boolean; badImage?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-inst-'));
  const cfg = cfgIn(dir);
  const deb = Buffer.from('a debian package');
  const image = Buffer.from('a docker image tarball');
  const meta = JSON.stringify({ agent: '0.6.0', drive: '0.3.1', contract: 2, driveImageSha256: sha(opts.badImage ? 'something else' : image) }) + '\n';
  const sums = `${sha(deb)}  mk-nas_0.6.0_amd64.deb\n${sha(meta)}  release.json\n`;
  await writeFile(join(dir, 'SHA256SUMS'), sums);
  const must = async (argv: string[]) => {
    const r = await realRun(argv);
    assert.equal(r.exitCode, 0, r.stderr);
  };
  await must(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 't', '-f', join(dir, 'key')]);
  await must(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 't', '-f', join(dir, 'other')]);
  await must(['ssh-keygen', '-Y', 'sign', '-q', '-f', join(dir, opts.wrongKey ? 'other' : 'key'), '-n', 'mk-nas-release', join(dir, 'SHA256SUMS')]);
  const pub = (await readFile(join(dir, 'key.pub'), 'utf8')).split(' ').slice(0, 2).join(' ');
  await writeFile(cfg.signers, `releases@mk-nas namespaces="mk-nas-release" ${pub}\n`);
  await writeFile(cfg.agentPackage, JSON.stringify({ version: '0.5.0' }));
  const names = ['SHA256SUMS', 'SHA256SUMS.sig', 'release.json', 'mk-nas_0.6.0_amd64.deb'];
  const g = github({
    'https://api.github.com/repos/o/mk-nas/releases/tags/v0.6.0': apiRelease(names),
    [`${REL}/v0.6.0/SHA256SUMS`]: sums,
    [`${REL}/v0.6.0/SHA256SUMS.sig`]: await readFile(join(dir, 'SHA256SUMS.sig')),
    [`${REL}/v0.6.0/release.json`]: meta,
    [`${REL}/v0.6.0/mk-nas_0.6.0_amd64.deb`]: opts.tamperDeb ? Buffer.from('something else') : deb,
    'https://github.com/o/mk-drive/releases/download/v0.3.1/mk-drive-0.3.1.tgz': image,
  });
  const calls: string[][] = [];
  const run: Runner = async (argv, o) => {
    calls.push(argv);
    if (argv[0] === 'ssh-keygen') return realRun(argv, o);
    if (argv[0] === 'docker') return { argv, exitCode: opts.imageOnBox ? 0 : 1, stdout: '', stderr: '' };
    if (argv.includes('apt-get')) await writeFile(cfg.agentPackage, JSON.stringify({ version: '0.6.0' }));
    return { argv, exitCode: 0, stdout: '', stderr: '' };
  };
  const db = new Db(':memory:');
  const backups: number[] = [];
  const ctx = { run, fetch: g.fetch, db, cfg, agent: '0.5.0', pid: process.pid, backup: async () => void backups.push(1), settle: 50 };
  const done = async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, cfg, ctx, calls, db, backups, done, image };
}

test('install: signature, checksums, the drive image, the backup, the package, the new agent — in that order', async () => {
  const s = await signedRelease();
  try {
    const r = s.db.startUpdateRun('0.6.0', process.pid);
    assert.equal(await installRelease(s.ctx, '0.6.0', r.id), 'mk-nas 0.6.0 with mk-drive 0.3.1');
    const verbs = s.calls.map((c) => (c.includes('apt-get') ? 'apt-get' : c[0] === 'ssh-keygen' ? `ssh-keygen ${c[1]} ${c[2]}` : c.slice(0, 3).join(' ')));
    assert.deepEqual(verbs, ['ssh-keygen -Y verify', 'docker image inspect', 'apt-get', '/opt/load-image.sh', 'systemctl is-active --quiet']);
    assert.deepEqual(s.calls.find((c) => c[0] === 'ssh-keygen')?.slice(0, 9), [
      'ssh-keygen',
      '-Y',
      'verify',
      '-f',
      s.cfg.signers,
      '-I',
      'releases@mk-nas',
      '-n',
      'mk-nas-release',
    ]);
    assert.deepEqual(
      s.calls.find((c) => c.includes('apt-get')),
      ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '-q', join(s.cfg.dir, '0.6.0', 'mk-nas_0.6.0_amd64.deb')],
    );
    assert.deepEqual(await readFile(s.cfg.driveImageFile), s.image, 'the verified image waits where mk-drive.service loads it');
    assert.equal(s.backups.length, 1);
    assert.equal(s.db.updateRun(r.id)?.step, 'waiting for the agent');
  } finally {
    await s.done();
  }
});

test('install refuses before touching the system: a tampered package, a wrong key, an image that does not match', async () => {
  for (const [opts, why] of [
    [{ tamperDeb: true }, /mk-nas_0\.6\.0_amd64\.deb does not match SHA256SUMS/],
    [{ wrongKey: true }, /ssh-keygen exited/],
    [{ badImage: true }, /mk-drive-0\.3\.1\.tgz does not match the signed release/],
  ] as const) {
    const s = await signedRelease(opts);
    try {
      const r = s.db.startUpdateRun('0.6.0', process.pid);
      await assert.rejects(installRelease(s.ctx, '0.6.0', r.id), why);
      assert.ok(!s.calls.some((c) => c.includes('apt-get')), 'no package installed');
      assert.equal(s.backups.length, 0);
    } finally {
      await s.done();
    }
  }
  const s = await signedRelease({ imageOnBox: true });
  try {
    const r = s.db.startUpdateRun('0.6.0', process.pid);
    await installRelease(s.ctx, '0.6.0', r.id);
    assert.ok(!s.calls.some((c) => c[0] === '/opt/load-image.sh'), 'an image already on the box is not downloaded or loaded');
  } finally {
    await s.done();
  }
});
