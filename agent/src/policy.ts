/**
 * Automatic snapshots without sanoid: every policy names how many hourly,
 * daily, weekly and monthly snapshots to keep. `plan` is pure — given the
 * time, the policy and the snapshots that exist, it says what to take and
 * what to destroy — so the timer's tick is one call and a loop.
 */
import type { Policy, Scrub, ScrubInterval, Snapshot } from '../../shared/types.ts';

export type Period = 'hourly' | 'daily' | 'weekly' | 'monthly';
export const PERIODS: Period[] = ['hourly', 'daily', 'weekly', 'monthly'];
const LENGTH: Record<Period, number> = { hourly: 3_600_000, daily: 86_400_000, weekly: 7 * 86_400_000, monthly: 30 * 86_400_000 };
/** A snapshot due at 10:00 taken at 10:07 by a 15-minute timer must not push the next one to 11:07 forever: a little slack. */
const SLACK = 10 * 60_000;

export const stamp = (t: Date): string => t.toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
export const autoName = (period: Period, t: Date): string => `auto-${period}-${stamp(t)}`;

export interface Plan {
  take: { dataset: string; name: string }[];
  destroy: string[];
}

/**
 * `changed` is false when the dataset has not been written to since its newest snapshot (ZFS's `written` is 0): nothing
 * is taken then, so an idle dataset costs the pool no write every hour, and what is kept simply reaches further back.
 */
export function plan(policy: Policy, existing: Snapshot[], now: Date, changed = true): Plan {
  const out: Plan = { take: [], destroy: [] };
  for (const period of PERIODS) {
    const keep = policy[period];
    const mine = existing
      .filter((s) => s.dataset === policy.dataset && s.snapshot.startsWith(`auto-${period}-`))
      .sort((a, b) => Date.parse(a.creation) - Date.parse(b.creation));
    if (keep <= 0) {
      // the period was switched off: its automatic snapshots go, manual ones are never touched
      out.destroy.push(...mine.map((s) => s.name));
      continue;
    }
    const newest = mine.at(-1);
    const due = changed && (!newest || now.getTime() - Date.parse(newest.creation) >= LENGTH[period] - SLACK);
    if (due) out.take.push({ dataset: policy.dataset, name: autoName(period, now) });
    const total = mine.length + (due ? 1 : 0);
    if (total > keep) out.destroy.push(...mine.slice(0, total - keep).map((s) => s.name));
  }
  return out;
}

export const SCRUB_INTERVALS: ScrubInterval[] = ['off', 'weekly', 'monthly'];

/** Long SMART self-tests start only in these local hours: hours of full-surface reads belong to the night. */
export const SELF_TEST_HOURS = { from: 1, to: 5 };
export const selfTestWindow = (now: Date): boolean => now.getHours() >= SELF_TEST_HOURS.from && now.getHours() < SELF_TEST_HOURS.to;

/**
 * Whether the timer should start a scrub now, from the pool's scan line alone
 * (ZFS keeps the last result; nothing is written down). Never while a scan
 * runs; after a scrub, when the interval has passed; right away when the
 * pool was never scrubbed or the last scan was a resilver.
 */
export function scrubDue(interval: ScrubInterval, last: Scrub | null, now: Date): boolean {
  if (interval === 'off') return false;
  if (last?.state === 'running') return false;
  if (last && last.kind === 'scrub' && last.state !== 'none' && last.finishedAt) return now.getTime() - Date.parse(last.finishedAt) >= LENGTH[interval] - SLACK;
  return true;
}
