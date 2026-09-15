# Scrubs, resilvers, and what is written down

**ZFS is the truth for the live scan.** `zpool status` says whether a scrub
or resilver runs and how far it is; the agent parses that line
(`parseScan`) and never stores it.

**The schedule** is a per-pool interval in SQLite (`scrub_policies`:
`off`, `weekly`, `monthly`); a pool without a row is scrubbed monthly. The
snapshot timer's tick (`tick.ts`, every 15 minutes) decides from the scan
line alone (`scrubDue` in `policy.ts`): never while a scan runs; after a
scrub, once the interval has passed; at once when the pool was never
scrubbed or the last scan was a resilver (a scrub right after a rebuild is
good practice); a canceled scrub waits the interval like a finished one.
Pools that are not ONLINE or DEGRADED are skipped so a broken pool does not
fail the tick every 15 minutes.

**Jobs** are what is left afterwards — the history ZFS does not keep. A
scrub started by the verb, by the timer, or a resilver started by
`disk.replace` writes a running job (`jobs` table, `pool` column, kind
`scrub` or `resilver`). `reconcileScans` (in `scans.ts`) brings every
running scan job up to date from its pool's scan line: progress while it
runs; once the line says it is over, `done`, or `failed` with the line when
errors were found, it was canceled, or nothing is running any more. It runs
inside the `jobs` verb, in the tick, and within seconds of a
`scrub_finish`/`resilver_finish` event. `jobs` takes `pool` to narrow to a
pool's scans; the Pools page follows the running one from its job and lists
the last five that ended.

The replication runner's dead-job sweep only touches replication jobs:
scans live in ZFS, not in a process, and would otherwise have been marked
interrupted on every runner start. Jobs of the same millisecond order by
id.

A resilver ZFS starts on its own (a disk came back) shows on the scan line
but not in the history.
