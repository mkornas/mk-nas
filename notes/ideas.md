# Ideas

Features and ideas for mk-nas that are not on the board yet. Promote one with `mk-board add <column> "..."`.

- 2026-09-12 21:04 — USB drive backup: an external disk plugged in becomes a one-disk pool the NAS replicates to on a schedule, then exports so it can be unplugged and kept elsewhere (the offline copy in 3-2-1); the drive shows up on the Disks page as 'backup drive', with 'last backup' on the overview
- 2026-09-12 21:04 — UPS: apcupsd or NUT on the NAS; on battery → close shares, on low battery → clean shutdown; battery state on the overview and an alert through mk-dashboard
- 2026-09-12 21:04 — Remote power signal: the NAS as a NUT client of a UPS on another machine (or a small HTTP 'power is going' endpoint the agent listens on), so one UPS protects several boxes; the same clean-shutdown path as the local UPS
- 2026-09-12 21:04 — Ransomware-proof target: the replication key may only receive, never destroy (zfs allow without destroy on the target); the target keeps its own retention; a diverged target is reported, not rolled back
- 2026-09-12 21:04 — Restore drill: a monthly job mounts the newest replicated snapshot on the target read-only and checks a marker file, so a backup that cannot be restored is noticed before it matters
- 2026-09-12 21:04 — Encryption at rest: native ZFS encryption per dataset with the key in the agent's db (unlocked at boot) or asked for on the drive after a reboot; the pool survives theft of a disk
- 2026-09-12 21:04 — Notifications for the things that must not go unnoticed: replication failed, scrub found errors, disk SMART failed, pool degraded, target unreachable — through mk-dashboard, and an email fallback when it is not there
- 2026-09-12 21:04 — Second replication target later: an off-site mk-nas; the same verb, a second job
