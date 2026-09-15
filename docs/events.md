# Events: what ZFS says happened

The kernel keeps a list of ZFS events since boot (`zpool events`) with a
running id. The agent polls `zpool events -v -H` every 5 seconds
(`MK_NAS_EVENTS_EVERY`) from inside its own process — no zedlet, no new
privilege path, `run.ts` as it is — keeps everything newer than the last id
it saw, and holds the last 500 in memory. Nothing on disk: the kernel is the
store until reboot, and the agent re-reads it on start.

The `events` verb lists them newest first, the ones that matter unless
`all`. "Matters" is: a `statechange` to anything but ONLINE, the
`io`, `checksum`, `data`, `probe_failure`, `io_failure` and `delay`
ereports, and `removed`. Config syncs, history entries and scan starts are
routine. Repeats on the same disk (a run of checksum errors) fold into one
line with a count.

`health` carries the last day's events that matter (`events`, up to 20), so
the Storage overview and mk-dashboard can say *since when* a pool has been
degraded, not only that it is. A `scrub_finish` or `resilver_finish` event
triggers `reconcileScans`, so a scan's job row closes within seconds.

The verbose format is parsed leniently: a `TIME CLASS` line, then indented
`key = value` lines, states either spelled out (`"FAULTED" (0x5)`) or as a
hex vdev state, the time as two hex words. The disk is the by-id name with
the `-partN` suffix stripped, so it matches what `disks` lists.
