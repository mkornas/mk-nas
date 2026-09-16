# mk-nas

Turn an old PC into a small, quiet NAS. Boot it from a USB stick, open a
browser, and mk-drive is there: the files you know, plus a **Storage**
section — disks, pools, datasets, snapshots, shares, replication, health.
Not a TrueNAS. A thin, opinionated layer over Ubuntu Server and OpenZFS.

**Status: phases 1–6 done, 0.3.0.** From mk-drive's Storage pages, or the
`mk-nas` command on the box, you can make a pool from free disks, make
datasets with quotas and destroy them (name typed, children and shares
refused, snapshots only when you say so), take snapshots, roll back, give a
dataset an automatic snapshot policy that a timer keeps, and hand a dataset
out over SMB (with Time Machine) and NFS; each SMB share has its own list of
who may open it (read, or read and write), prefilled from the drive's grants,
and everyone with a drive account sets an SMB password on their account page. A dataset can be copied to another
ZFS machine over ssh on a schedule, incrementally and resumably, with the
result on the Copies page. A failed disk is replaced from the Pools page and
the pool rebuilds; a pool from another box or an earlier install is imported
with one click. Every pool is scrubbed monthly (or weekly, or not) by the
same timer; scrubs and rebuilds are jobs with progress and history; every
disk gets a long SMART self-test monthly, at night, and you can start one any time.
The agent follows `zpool events`, so a faulted disk or a checksum error is
known as it happens and shows on the overview with when; the overview also
shows the box at a glance (CPU, memory, network, disk rates, temperatures).
The box's name and address are set from the Network page — an address
change reverts by itself unless you confirm it from the new address — and
`<hostname>.local` answers. The box's settings — shares, schedules, copies, SMB
passwords, the drive's accounts, the ssh key — are kept in a dataset of
your choosing once a day and snapshotted there, so a dead OS disk is the
stick, a pool import and one restore. A degraded pool, a failing disk or an
unreachable agent reach mk-dashboard as alerts. The agent ships as one
`.deb` with Node inside (`make deb`), upgrades are `apt install
./mk-nas_<version>_amd64.deb`, the drive asks for an upgrade when its agent
is too old, and `mk-nas` completes in bash and zsh. `make iso` builds the
installer stick, `make vm` tries the whole thing in QEMU (`docs/vm.md`), and
a nightly workflow does the same on a KVM runner. `PLAN.md` is the design,
`board.md` the working list, `docs/` the decisions as they are made.

**Installing it:** [`docs/first-install.md`](docs/first-install.md) takes a
bare PC to files on the network, step by step.

## The idea

mk-drive is the one interface. On a laptop, a VPS or a NAS you do not own,
it is a web drive over directories. On a machine that runs mk-nas, the same
app also becomes the NAS console, the way TrueNAS has one UI for storage and
files — except the files part is the good part here, and the storage part
never invents anything ZFS already does.

```
  browser ──HTTPS──▶ mk-drive (container, unprivileged; accounts, SSO,
                        │        files, and the Storage section when the
                        │        socket below is mounted in)
                        │ JSON over /run/mk-nas.sock
                     mk-nasd  (root service: an allow-list of verbs over
                        │      zpool, zfs, smartctl, smb.conf, exports,
                        │      systemd timers — argv arrays, never a shell)
                     Ubuntu Server LTS + OpenZFS + Samba + NFS
```

This repo holds the agent, the installer and the bootable image. The Storage
pages live in mk-drive and light up only when the socket is there.

## What it will do

- **Storage** — see the disks, make a pool (mirror or raidz), make datasets
  with quotas, take and schedule snapshots, replicate a dataset to another
  machine over SSH.
- **Shares** — hand a dataset out over SMB (Finder, Explorer, Time Machine)
  and NFS, to the people who have an account on the drive.
- **Health** — disk SMART and self-tests, scrub results and schedules, pool
  state, ZFS events as they happen, free space, the box's vitals.
- **Alerts** — the box says when something is wrong (a pool degraded or
  filling up, a disk failing or hot, a scrub, copy or backup that failed, an
  update waiting) and says when it is over; `sudo mk-nas alerts`, or the drive
  shows them (`docs/alerts.md`).
- **Network** — the box's name (with mDNS) and address, changed from the
  drive with a revert that protects you from locking yourself out.
- **Install** — a USB stick that asks for a hostname, an admin email and the
  OS disk, and comes back as a NAS.

## What it will not do

Virtual machines, Kubernetes, a plugin marketplace, anything but ZFS, or
parity with a product that has a company behind it. Simple enough to
understand in an evening is the whole point.

## License

AGPL-3.0-only — see LICENSE. © 2026 Mateusz Kornaś. A commercial license (use without the AGPL's obligations) is available: hi@mateuszkornas.com.
