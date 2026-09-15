# mk-nas — plan

Written 2026-09-12, reshaped the same day: **mk-drive is the UI.** A NAS for
one household, built by one person, on an old PC. The bet: everything a small
NAS needs already exists as a Linux command; the work is a safe, plain web
page over those commands and the operational surface around them — disks
that die, upgrades that must not lose a pool.

## 1. Why, and why not something that exists

The usual choices are TrueNAS, OpenMediaVault, or a server with Cockpit.
TrueNAS SCALE does far more than a home needs and every year moves further
from "a NAS". OpenMediaVault is Debian plus a large PHP UI. Cockpit with
45Drives' plugins is close in spirit but three products stitched together
with three looks and no shared identity.

mk-nas is the small answer: one app (mk-drive), one identity (its accounts,
with SSO when you have it), one look (`@mk-kit/ui`), one opinion about
how a home NAS should be laid out, and nothing invented where ZFS, Samba and
systemd already have the answer.

**Baseline first (phase 0).** Before writing the agent, install Ubuntu
Server on a small PC with Cockpit and the 45Drives ZFS and file-sharing
plugins, mount the datasets into mk-drive, and live with it for a couple of
weeks. What is still missing after that is the honest scope of mk-nas, and
which Storage pages get opened tells the order to build them.

## 2. The shape

Two pieces, one boundary:

- **`mk-nasd`** (this repo) — a root service on the host, listening on
  `/run/mk-nas.sock`, exposing an **allow-list of verbs**. Every verb builds
  an argument array for `zpool`, `zfs`, `smartctl`, `zfs send`, Samba, NFS
  or `systemctl`; there is no shell anywhere and no free-form parameter
  reaches a command line. Every call is audited. It has no UI.
- **mk-drive** (its own repo) — the unprivileged container everyone already
  uses. Started with the socket mounted in, its server proxies an
  admin-only `/api/nas/*` to the agent and the app shows a **Storage**
  section. Without the socket, nothing changes: same app, no NAS.

Why not a separate NAS web app: it would need its own login, shell and look,
and mk-drive already has accounts, password login, app passwords and
optional SSO — a NAS works without an identity provider and uses one when
there is one. Why not NAS code inside the container: managing pools
needs root on the host; the container must stay unprivileged and portable.
The socket is the whole privilege boundary, and it is one small file of
verbs.

Alongside: mk-dashboard for alerts (it already has the pipeline), mk-drive's
versions from `.zfs/snapshot` (already built), Immich or whatever else as
compose stacks later.

## 3. Decisions (proposed; each becomes a note in `docs/` when confirmed)

| Topic | Decision | Why |
| --- | --- | --- |
| Base | Ubuntu Server LTS (24.04) | ZFS in the kernel tree, `autoinstall` for the USB stick, five years of updates; no DKMS lottery |
| Storage | OpenZFS only: mirror, raidz1/2, single disk for scratch | Snapshots, send/receive, scrub, quotas, checksums come free; no mdadm, no btrfs, no LVM |
| Agent | `mk-nasd`, Node 24 (type stripping, like the other mk apps), root, Unix socket, JSON, allow-listed argv verbs | Same language as the ecosystem; the privilege boundary is a socket with an explicit verb list, auditable in one file |
| UI | The Storage section of mk-drive, admins only, shown when the socket is mounted; `DRIVE_NAS_SOCKET` names it | One app, one login, one look; portable mk-drive stays untouched elsewhere |
| Shares | Samba and the kernel NFS server; config files generated from the agent's database, `reload` after every change | Boring and universal; Time Machine is a few Samba lines |
| SMB users | Local Unix users created by the agent for mk-drive accounts, with an "SMB password" set on the account page (like app passwords) | Samba keeps its own hashes; passkeys cannot help here |
| Snapshots | Per-dataset policy (hourly, daily, weekly, monthly counts), a systemd timer runs the agent's `snapshot-tick` | The sanoid idea without sanoid |
| Replication | `zfs send -I | ssh | zfs receive` to another mk-nas or any ZFS host, resumable, on a timer, last result shown | The one thing that makes a second old PC worth having |
| Health | SMART, scrub, pool state and free space from the agent; mk-drive shows them, mk-dashboard alerts on them | Already built |
| Install | Ubuntu `autoinstall` embedded in a remastered ISO: hostname, admin email, OS disk; installs the agent, Docker and the mk-drive stack | Ubuntu did the hard part; a `make iso` in this repo |
| Upgrades | `apt` for the OS, the agent as a `.deb` with a version the drive checks; the agent refuses a pool it does not understand | Kernel and ZFS move together on Ubuntu |
| Storage safety | Disks addressed by `/dev/disk/by-id`; every destructive verb needs the pool or dataset name typed; `pool.destroy` does not exist in v1 | The only unforgivable bug is data loss |
| Data | `node:sqlite` in the agent for shares, policies, job history, SMB users; ZFS is the truth for everything it owns | Same rule as mk-drive: never mirror the system's state in a database |

## 4. The agent's verbs (first cut)

Read: `disks`, `pools`, `pool`, `datasets`, `snapshots`, `smart`, `scrubs`,
`jobs`, `events` (the tail of `zpool events`, read every few seconds),
`system` (the box at a glance, sampled every few seconds, half an hour in
memory), `network`, `shares`, `health`, `version`.
Write: `pool.create`, `pool.scrub`, `dataset.create`, `dataset.set`
(quota, compression, atime), `dataset.destroy` (typed name; refused with
children, a share or a copy; its snapshots only when asked),
`snapshot.create`, `snapshot.destroy`,
`snapshot.rollback` (with a fresh snapshot first), `policy.set`,
`scrub.policy.set` (monthly unless told otherwise, run by the snapshot timer),
`network.set` (hostname at once; an address through one netplan file of
our own, with a revert unless `network.confirm` arrives in time),
`replication.set`, `replication.run`, `share.set`, `share.remove`,
`user.set`, `user.smbPassword`, `disk.replace`, `pool.import`.
Not in v1: `pool.destroy`, destroying a dataset that still has children,
anything that formats a disk that is part of a pool.

Transport: newline-delimited JSON over the socket, `{ id, verb, args }` →
`{ id, ok, result | error }`, long verbs (scrub, replication) report
progress as `jobs`. The socket is owned by root with group `mk-nas`; the
mk-drive container runs with that group.

## 5. Phases

| # | Phase | Delivers | Size |
| --- | --- | --- | --- |
| 0 | Baseline | Ubuntu + Cockpit + 45Drives plugins on a small PC, mk-drive on the datasets, two weeks of use, `notes/missing.md` | 1 evening + waiting |
| 1 | See | `mk-nasd` read-only verbs with tests on a loop-device pool; mk-drive: `DRIVE_NAS_SOCKET`, `/api/nas` proxy, Storage → Disks, Pools, Datasets, Snapshots, Health (read-only) | 1 week |
| 1b | Stick | `make iso`: autoinstall with hostname, admin email, OS disk; installs the agent, Docker and the mk-drive stack; reinstalling the box becomes a coffee break | 2 days |
| 2 | Make | pool create (mirror/raidz), datasets with quotas, snapshot now, policies on a timer; a new dataset offers itself as a location | 1 week |
| 3 | Share | SMB and NFS shares, SMB passwords on the account page, Time Machine | 1 week |
| 4 | Copy | replication jobs to another host, resumable, with history | 1 week |
| 5 | Survive | degraded pool, replace disk, resilver progress, import a foreign pool, alerts in mk-dashboard | 1–2 weeks |
| 6 | Keep | the agent as a `.deb`, version check in the drive, upgrade notes | 3 days |
| later | Apps | compose stacks from a list (Immich, …), UPS, encryption keys, S3 backup target, root-on-ZFS mirror | — |

Each phase ends running on a real box. Phase 1 alone is already a better
"what is on my NAS" page than a stock Ubuntu Server gives.

## 6. Risks

- **Destructive flows.** Mitigated by the allow-list, by-id names, typed
  confirmations, and no destroy in v1.
- **The degraded path** is the least fun and most important code; phase 5
  is budgeted as the largest.
- **Root agent.** Socket permissions, verbs as argv arrays, every call
  audited, no free-form parameters reaching a command line. A bug in
  mk-drive can call a verb, never run a command.
- **Boot disk.** v1 says: a small SSD, and the pool survives its loss; a
  reinstall from the stick plus `pool.import` gets everything back.
- **Scope creep.** It is a NAS. Anything not in the tables is a card, not a
  detour.

## 7. Open questions

1. A small PC: how many SATA ports, and is there an SSD for the OS?
2. Mirror of two big disks (simple, half the space) or raidz1 of three or
   four (more space, one disk of safety)? v1 supports both; the default in the
   UI is the mirror.
3. Is an existing ZFS host (TrueNAS, say) the replication target (it can
   receive `zfs send` today), or another mk-nas?
