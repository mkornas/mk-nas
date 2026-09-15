# Decision: Ubuntu Server LTS and OpenZFS, nothing else

Proposed in `PLAN.md` §3, adopted 2026-09-12 when the agent was started on it.
Amend this file if the author decides otherwise.

- The base is **Ubuntu Server 24.04 LTS**. ZFS ships in Ubuntu's kernel tree
  (`zfsutils-linux`), `autoinstall` gives the USB stick for free, and the LTS
  gets five years of updates. No DKMS, no third-party kernel.
- Storage is **OpenZFS only**: mirror, raidz1, raidz2, or a single disk for
  scratch. No mdadm, btrfs or LVM, and nothing in the agent knows about them.
- The OS lives on its own small disk (an NVMe or SATA SSD). The pool must
  survive losing it: reinstall from the stick, `pool.import`, done.
- Samba and the kernel NFS server for shares, systemd timers for schedules,
  `smartctl` for disk health. Every one of them is a stock Ubuntu package.
- Ubuntu moves kernel and ZFS together, so an `apt upgrade` is the whole OS
  upgrade story. The agent refuses a pool with features it does not know.
