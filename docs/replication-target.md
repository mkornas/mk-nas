# Decision: another ZFS host is the replication target

Decided 2026-09-12: another ZFS host (TrueNAS, another mk-nas, …) is the
replication target.

- Replication is `zfs send | ssh | zfs receive` to any host with ZFS and
  sshd. An existing TrueNAS box, a second mk-nas or anything else with ZFS
  works the same way, so nothing in the agent knows it is TrueNAS.
- The NAS pushes with its own SSH key (`mk-nas replication key` shows it;
  it goes into the target user's authorized keys). On TrueNAS that user is
  `root`, or a user delegated with `zfs allow` on the target dataset.
- Sends are incremental from the newest snapshot both sides have, resumable
  with the receive token, never rolling the target back (no `-F`): a target
  that diverged is reported, not overwritten.
- The target keeps the replicated snapshots; the job prunes only the
  `repl-*` snapshots it made itself, on both sides, beyond a count.
