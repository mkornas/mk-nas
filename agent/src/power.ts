/**
 * Reboot and shut down, and what a person should know before either: whether
 * Ubuntu's own updates asked for a restart, and what is running that a
 * restart interrupts (a scrub or resilver resumes, a replication send resumes
 * from its token, a SMART self-test is simply cut short). The agent answers
 * first and acts a few seconds later, from a transient systemd timer, so the
 * reply reaches the drive before the box goes.
 */
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import type { Power, PowerAction, PowerScheduled } from '../../shared/types.ts';
import type { Db } from './db.ts';
import { LSBLK_ARGV, parseLsblk, parseSelfTests, readSmart, smartQuietArgv, useOf } from './disks.ts';
import { BadArgs } from './names.ts';
import { must, type Runner } from './run.ts';
import { confirmed } from './write.ts';
import { getPool, listPools } from './zfs.ts';

export const REBOOT_REQUIRED = '/run/reboot-required';
/** The unit that carries the delayed reboot or shutdown; one at a time. */
export const POWER_UNIT = 'mk-nas-power';
export const POWER_DELAY_S = 5;

/** The packages that asked for the restart (update-notifier writes one per line, repeats included). */
export function parsePackages(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

export async function readPower(run: Runner, db: Db, rebootRequired = REBOOT_REQUIRED): Promise<Power> {
  const restartNeeded = await readFile(rebootRequired, 'utf8').then(
    () => true,
    () => false,
  );
  const packages = restartNeeded ? parsePackages(await readFile(`${rebootRequired}.pkgs`, 'utf8').catch(() => '')) : [];
  const busy: string[] = [];

  for (const p of await listPools(run)) {
    const scan = (await getPool(run, p.name)).scrub;
    if (scan?.state === 'running')
      busy.push(`${scan.kind === 'resilver' ? 'Rebuild' : 'Scrub'} of ${p.name}${scan.percent === null ? '' : `, ${scan.percent}%`}`);
  }
  for (const j of db.jobs()) {
    if (j.kind === 'replication' && j.state === 'running') busy.push(`Copy of ${j.target}${j.progress === null ? '' : `, ${j.progress}%`}`);
  }
  // self-tests run on pool disks; a disk in standby is not testing and is left asleep
  for (const d of parseLsblk(await must(run, LSBLK_ARGV))) {
    if (useOf(d).kind !== 'pool') continue;
    const running = parseSelfTests(await readSmart(run, d.path, smartQuietArgv(d.path))).running;
    if (running)
      busy.push(`${running.kind === 'long' ? 'Long' : 'Short'} SMART test on ${d.name}${running.percentDone === null ? '' : `, ${running.percentDone}%`}`);
  }
  return { restartNeeded, packages, busy };
}

/** Checks the typed name, then leaves the reboot or poweroff to a timer a few seconds out. */
export async function schedulePower(run: Runner, action: PowerAction, confirm: unknown, now = Date.now()): Promise<PowerScheduled> {
  confirmed(confirm, hostname());
  if ((await run(['systemctl', 'is-active', '--quiet', `${POWER_UNIT}.timer`])).exitCode === 0) throw new BadArgs('a reboot or shutdown is already on its way');
  await must(run, [
    'systemd-run',
    '--quiet',
    '--collect',
    `--unit=${POWER_UNIT}`,
    `--on-active=${POWER_DELAY_S}`,
    'systemctl',
    action === 'reboot' ? 'reboot' : 'poweroff',
  ]);
  return { action, at: new Date(now + POWER_DELAY_S * 1000).toISOString() };
}
