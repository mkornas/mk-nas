/**
 * Updates from the box. The timer asks GitHub once a day for the newest
 * mk-nas release; the drive shows it; an install is its own process
 * (update.ts, in a transient unit, since the package it installs restarts
 * the agent) that trusts nothing it downloaded until the maintainer's
 * signature over SHA256SUMS checks out against the key the package shipped.
 * SHA256SUMS covers the .deb and release.json; release.json names the pinned
 * drive and its image's checksum, so one signature covers all three. The
 * maintainer writes release.json and SHA256SUMS on their own machine from a
 * package they built from the tag themselves (install/sign-release.sh).
 * Never a branch, never a release older than what runs.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Release, Update } from '../../shared/types.ts';
import type { Db } from './db.ts';
import { BadArgs } from './names.ts';
import { must, type Runner } from './run.ts';

export interface UpdateConfig {
  /** owner/name of the mk-nas and mk-drive repositories on GitHub. */
  repo: string;
  driveRepo: string;
  driveImage: string;
  /** Where an install downloads to. */
  dir: string;
  /** ssh-keygen allowed-signers file with the release key, shipped in the package. */
  signers: string;
  /** Where mk-drive.service loads an image from before compose up, and the script that loads it (it writes the loaded image's ID to mk-drive-image.id next to the tgz). */
  driveImageFile: string;
  loadImage: string;
  /** The drive version the installed package pins. */
  pinnedDriveFile: string;
  /** The installed agent's package.json, read after the install to see it took. */
  agentPackage: string;
}

export type Fetch = typeof fetch;

export const SIGNER = 'releases@mk-nas';
export const NAMESPACE = 'mk-nas-release';
export const CHECK_EVERY_MS = 24 * 3_600_000;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function versionOf(v: unknown, what = 'version'): string {
  if (typeof v !== 'string' || !VERSION.test(v)) throw new BadArgs(`${what} must be X.Y.Z`);
  return v;
}

/** a > b, both X.Y.Z. */
export function newer(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** `sha256sum` output: name → hex. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *]?(\S+)$/.exec(line.trim());
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

interface ApiAsset {
  name: string;
  browser_download_url: string;
}

interface ApiRelease {
  tag_name?: unknown;
  body?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: ApiAsset[];
}

export interface ReleaseMeta {
  agent: string;
  drive: string;
  contract: number;
  /** Absent before 0.6.0: such a release cannot be installed from the box. */
  driveImageSha256: string | null;
}

export function parseReleaseMeta(raw: unknown): ReleaseMeta {
  const j = (raw ?? {}) as Record<string, unknown>;
  const sha = typeof j.driveImageSha256 === 'string' && SHA256.test(j.driveImageSha256) ? j.driveImageSha256 : null;
  if (typeof j.contract !== 'number' || !Number.isInteger(j.contract)) throw new Error('release.json: no contract');
  return { agent: versionOf(j.agent, 'release.json agent'), drive: versionOf(j.drive, 'release.json drive'), contract: j.contract, driveImageSha256: sha };
}

/** The asset URL, only when it is the repository's own release download. */
export function assetUrl(api: ApiRelease, repo: string, name: string): string | null {
  const a = api.assets?.find((x) => x.name === name);
  const url = a?.browser_download_url;
  return typeof url === 'string' && url.startsWith(`https://github.com/${repo}/releases/download/`) ? url : null;
}

async function getJson(fetchFn: Fetch, url: string, agent: string): Promise<unknown> {
  const res = await fetchFn(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `mk-nas/${agent}` },
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

/** The newest release: GitHub's latest one and its release.json. */
export async function fetchLatest(fetchFn: Fetch, cfg: UpdateConfig, agent: string): Promise<Release> {
  const api = (await getJson(fetchFn, `https://api.github.com/repos/${cfg.repo}/releases/latest`, agent)) as ApiRelease;
  if (api.draft || api.prerelease) throw new Error('the latest release is a draft or a pre-release');
  const tag = typeof api.tag_name === 'string' ? api.tag_name.replace(/^v/, '') : '';
  const version = versionOf(tag, 'the release tag');
  const metaUrl = assetUrl(api, cfg.repo, 'release.json');
  if (!metaUrl) throw new Error(`release ${version} has no release.json`);
  const meta = parseReleaseMeta(await getJson(fetchFn, metaUrl, agent));
  if (meta.agent !== version) throw new Error(`release ${version}: release.json says ${meta.agent}`);
  return {
    version,
    drive: meta.drive,
    contract: meta.contract,
    notes: typeof api.body === 'string' ? api.body.slice(0, 20_000) : '',
    publishedAt: typeof api.published_at === 'string' ? api.published_at : new Date(0).toISOString(),
    url: typeof api.html_url === 'string' ? api.html_url : `https://github.com/${cfg.repo}/releases/tag/v${version}`,
    signed: !!assetUrl(api, cfg.repo, 'SHA256SUMS.sig') && !!assetUrl(api, cfg.repo, 'SHA256SUMS') && meta.driveImageSha256 !== null,
  };
}

/** Asks GitHub and writes down what it said; a failure is recorded, not thrown. */
export async function checkForUpdate(fetchFn: Fetch, db: Db, cfg: UpdateConfig, agent: string, now = Date.now()): Promise<void> {
  try {
    db.recordUpdateCheck(await fetchLatest(fetchFn, cfg, agent), null, now);
  } catch (e) {
    db.recordUpdateCheck(null, (e as Error).message, now);
  }
}

export function checkDue(db: Db, now = Date.now()): boolean {
  const last = db.updateCheck();
  return !last || now - Date.parse(last.checkedAt) >= CHECK_EVERY_MS;
}

export async function readUpdate(db: Db, cfg: UpdateConfig, agent: string, alive: (pid: number) => boolean): Promise<Update> {
  db.failDeadUpdateRuns(alive);
  const check = db.updateCheck();
  const latest = check?.latest ?? null;
  const drive = (await readFile(cfg.pinnedDriveFile, 'utf8').catch(() => '')).trim() || '?';
  return {
    current: agent,
    drive,
    latest,
    checkedAt: check?.checkedAt ?? null,
    error: check?.error ?? null,
    available: !!latest && latest.signed && newer(latest.version, agent),
    run: db.updateRun(),
  };
}

/** Refuses anything but the newest checked, signed, newer release, and a second install while one runs. */
export function installable(db: Db, agent: string, versionArg: unknown): string {
  const version = versionOf(versionArg);
  const latest = db.updateCheck()?.latest;
  if (!latest || latest.version !== version) throw new BadArgs(`${version} is not the newest release the box knows of; check again first`);
  if (!newer(version, agent)) throw new BadArgs(`${version} is not newer than the installed ${agent}`);
  if (!latest.signed) throw new BadArgs(`${version} is not signed`);
  if (db.updateRun()?.state === 'running') throw new BadArgs('an install is already running');
  return version;
}

export interface InstallContext {
  run: Runner;
  fetch: Fetch;
  db: Db;
  cfg: UpdateConfig;
  agent: string;
  pid: number;
  /** Takes the settings backup when one is set up; null when none is. */
  backup: (() => Promise<void>) | null;
  /** How long to wait for the new agent, in ms. */
  settle?: number;
}

/** What a release's files may weigh: several times today's (a 32 MB package, a 180 MB image), far below the OS disk. */
export const MAX_SMALL = 1024 * 1024;
export const MAX_PACKAGE = 512 * 1024 * 1024;
export const MAX_IMAGE = 2 * 1024 * 1024 * 1024;

/** Streams a download to a file and returns its sha256. Nothing is verified yet at this point, so nothing past `max` bytes is written. */
export async function download(fetchFn: Fetch, url: string, file: string, agent: string, max: number): Promise<string> {
  const res = await fetchFn(url, { headers: { 'user-agent': `mk-nas/${agent}` }, redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
  const name = url.split('/').pop();
  if (!res.ok || !res.body) throw new Error(`download of ${name} failed: ${res.status}`);
  const tooBig = () => new Error(`${name} is larger than the ${Math.round(max / 1048576)} MB a release file of its kind may be`);
  if (Number(res.headers.get('content-length') ?? 0) > max) throw tooBig();
  const hash = createHash('sha256');
  let seen = 0;
  const tap = new Transform({
    transform(chunk, _enc, done) {
      seen += chunk.length;
      if (seen > max) return done(tooBig());
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), tap, createWriteStream(file, { mode: 0o600 }));
  return hash.digest('hex');
}

/**
 * The drive image is on the box and is the one load-image.sh loaded from a tgz it checked against the pinned
 * checksum: the ID docker gives it now is the ID written then. An image with the tag from anywhere else (pulled, loaded
 * by hand, or loaded before 0.8.1 wrote IDs) does not count, and the verified tgz is downloaded again.
 */
export async function verifiedImageOnBox(run: Runner, cfg: UpdateConfig, image: string): Promise<boolean> {
  const r = await run(['docker', 'image', 'inspect', '-f', '{{.Id}}', image]);
  if (r.exitCode !== 0) return false;
  const loaded = await readFile(join(dirname(cfg.driveImageFile), 'mk-drive-image.id'), 'utf8').catch(() => '');
  return loaded.trim() === `${image} ${r.stdout.trim()}`;
}

/** One install, step by step, each written to the run's row. Resolves with the finished run's message; throws with the reason. The downloads go either way. */
export async function installRelease(ctx: InstallContext, version: string, runId: number): Promise<string> {
  const dir = join(ctx.cfg.dir, version);
  try {
    return await installSteps(ctx, version, runId, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function installSteps(ctx: InstallContext, version: string, runId: number, dir: string): Promise<string> {
  const { run, db, cfg } = ctx;
  const step = (s: string) => db.stepUpdateRun(runId, s);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });

  step('downloading');
  const api = (await getJson(ctx.fetch, `https://api.github.com/repos/${cfg.repo}/releases/tags/v${version}`, ctx.agent)) as ApiRelease;
  const deb = `mk-nas_${version}_amd64.deb`;
  const hashes = new Map<string, string>();
  for (const name of ['SHA256SUMS', 'SHA256SUMS.sig', 'release.json', deb]) {
    const url = assetUrl(api, cfg.repo, name);
    if (!url) throw new Error(`release ${version} has no ${name}`);
    hashes.set(name, await download(ctx.fetch, url, join(dir, name), ctx.agent, name === deb ? MAX_PACKAGE : MAX_SMALL));
  }

  step('verifying');
  const sums = await readFile(join(dir, 'SHA256SUMS'), 'utf8');
  // nothing downloaded is believed before this: the maintainer's key, shipped in the installed package, signed SHA256SUMS
  await must(run, ['ssh-keygen', '-Y', 'verify', '-f', cfg.signers, '-I', SIGNER, '-n', NAMESPACE, '-s', join(dir, 'SHA256SUMS.sig')], { input: sums });
  const listed = parseSums(sums);
  for (const name of ['release.json', deb]) if (listed.get(name) !== hashes.get(name)) throw new Error(`${name} does not match SHA256SUMS`);
  const meta = parseReleaseMeta(JSON.parse(await readFile(join(dir, 'release.json'), 'utf8')));
  if (meta.agent !== version) throw new Error(`release.json says ${meta.agent}, not ${version}`);
  if (!meta.driveImageSha256) throw new Error(`release ${version} names no drive image checksum`);

  const image = `${cfg.driveImage}:${meta.drive}`;
  if (!(await verifiedImageOnBox(run, cfg, image))) {
    step(`downloading mk-drive ${meta.drive}`);
    const tgz = join(dir, `mk-drive-${meta.drive}.tgz`);
    const sha = await download(
      ctx.fetch,
      `https://github.com/${cfg.driveRepo}/releases/download/v${meta.drive}/mk-drive-${meta.drive}.tgz`,
      tgz,
      ctx.agent,
      MAX_IMAGE,
    );
    if (sha !== meta.driveImageSha256) throw new Error(`mk-drive-${meta.drive}.tgz does not match the signed release`);
    // mk-drive.service loads it before compose up, so the restart the package triggers finds the image here
    await copyFile(tgz, cfg.driveImageFile);
  }

  if (ctx.backup) {
    step('backing up the settings');
    await ctx.backup();
  }

  step(`installing mk-nas ${version}`);
  await must(run, ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '-q', join(dir, deb)], { timeout: 30 * 60_000 });
  // when the pin did not change the drive was not restarted: load a waiting image anyway
  if (
    await stat(cfg.driveImageFile).then(
      () => true,
      () => false,
    )
  )
    await must(run, [cfg.loadImage], { timeout: 10 * 60_000 });

  step('waiting for the agent');
  const until = Date.now() + (ctx.settle ?? 120_000);
  for (;;) {
    const installed = JSON.parse(await readFile(cfg.agentPackage, 'utf8').catch(() => '{}')).version;
    const active = (await run(['systemctl', 'is-active', '--quiet', 'mk-nasd'])).exitCode === 0;
    if (installed === version && active) break;
    if (Date.now() > until) throw new Error(`the package installed, but mk-nasd ${installed ?? '?'} is ${active ? 'running' : 'not running'}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  return `mk-nas ${version} with mk-drive ${meta.drive}`;
}
