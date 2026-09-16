# Decisions

One file per confirmed decision, named by topic (`base-os.md`, `agent-boundary.md`, …).
Proposed decisions live in `PLAN.md` §2 until they are confirmed.

| File | Decides |
| --- | --- |
| `base-os.md` | Ubuntu LTS + OpenZFS, nothing else |
| `agent-boundary.md` | the root agent behind a Unix socket, allow-listed argv verbs |
| `ui-lives-in-mk-drive.md` | no UI of its own |
| `pool-layout.md` | mirror by default, the answers to the open questions |
| `replication-target.md` | copies to another ZFS host, never `-F` |
| `releasing.md` | releases as a pinned pair (mk-nas + mk-drive), cutting one, putting one on a box |
| `upgrading.md` | one `.deb`, the contract the drive checks, what an upgrade touches |
| `destroy.md` | what may be destroyed and what must be typed first |
| `scrubs-and-scan-jobs.md` | the scrub schedule; scrubs and resilvers as jobs, ZFS still the truth |
| `alerts.md` | what is wrong with the box right now: conditions raised, confirmed, acknowledged, cleared |
| `events.md` | the `zpool events` tail: polled, in memory, what matters |
| `network.md` | hostname and address, the netplan file, the timed revert |
| `vitals.md` | the box at a glance from /proc, nothing on disk |
| `updates.md` | updates from the box: a daily check, releases signed off CI, a verified install in its own unit |
| `power.md` | reboot and shut down: the typed hostname, a timer a few seconds out, what is running first |
| `first-install.md` | the hands-on guide: stick, BIOS, install, pool, datasets, shares, settings backup, living with it |
| `config-backup.md` | the box's settings kept in a dataset, daily; one restore after a dead OS disk |
| `vm.md` | the QEMU test VM: make, reach, upgrade in place, drive by script |
