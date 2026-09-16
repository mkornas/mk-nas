# mk-nas

[![Licence: AGPL-3.0-only](https://img.shields.io/badge/licence-AGPL--3.0--only-blue)](LICENSE)
[![Tests](https://github.com/mkornas/mk-nas/actions/workflows/test.yml/badge.svg)](https://github.com/mkornas/mk-nas/actions/workflows/test.yml)

Turn a spare PC into a small, quiet NAS for one household. Boot it from a USB
stick, answer two questions, and it comes back as a box with a ZFS pool, SMB
and NFS shares, snapshots on a schedule, copies to another machine, and
[mk-drive](https://github.com/mkornas/mk-drive) in the browser as the whole
interface.

It is a thin, opinionated layer over Ubuntu Server and OpenZFS, not another
TrueNAS: a root agent (`mk-nasd`) exposing an allow-list of verbs over a Unix
socket, an installer, and the bootable image. **ZFS is the truth** — the agent
never keeps a second copy of the system's state; its database holds only what
the system cannot (share definitions, snapshot policies, job history, SMB
users).

Version 0.9.0, pinned to mk-drive 0.9.0. Part of
[mkapps.dev](https://mkapps.dev).

## Try it

mk-nas wants a machine of its own — it installs an operating system, takes
whole disks and runs Samba, NFS and Docker as root. So the honest way to try it
is a virtual one:

```bash
git clone https://github.com/mkornas/mk-nas && cd mk-nas
make vm
```

That builds the installer image, installs it unattended into QEMU with one OS
disk and two data disks, and leaves mk-drive on <http://localhost:8810> and ssh
on port 2222. Make a pool from the two disks, make a dataset, share it, take a
snapshot — the whole flow, with nothing of yours at risk. Needs
`qemu-system-x86`, `ovmf`, `xorriso`, `wget`, `gpgv`, `dpkg-deb` and
`fakeroot`; details in [`docs/vm.md`](docs/vm.md).

On real hardware: `make iso` writes a ~4 GB image to
`install/out/mk-nas-<date>.iso`; write it to a stick raw. Booting it asks two
things — who you are (name, the box's hostname, a password) and which disk is
the OS disk. The data disks are never touched. It installs Ubuntu Server 24.04,
ZFS, Samba, NFS, Docker and mk-nas, and reboots into a NAS at
`http://<hostname>.local:8810`. The box's own console then shows a setup code
above the login prompt; the first browser visit asks for it before it will
create the drive's admin account, so a fresh box on the network does not belong
to whoever opens it first. The step-by-step walk-through, from BIOS settings to
the first share, is [`docs/first-install.md`](docs/first-install.md).

On a machine that already runs stock Ubuntu Server 24.04,
`sudo ./install/install.sh` from a checkout does the same work without the
stick, and is safe to run again after a `git pull`.

## What it does

All of it from mk-drive's Storage pages, or from `mk-nas` on the box (which
completes in bash and zsh). Every call goes through the same allow-list and
lands in an audit log.

**Pools and datasets.** Make a pool from the free disks (mirror, raidz1,
raidz2, or a single disk for scratch), or import one from another box or an
earlier install with a click. Make datasets with quotas, use one as a location
in the drive, destroy one with its name typed — children and shares are
refused, snapshots only when you say so. Replace a failed disk from the Pools
page and watch the pool rebuild. There is no `pool.destroy`, on purpose.

**Snapshots and copies.** Take a snapshot, roll one back, or give a dataset a
policy (so many hourly, daily, weekly, monthly) that a systemd timer keeps.
Copy a dataset to another ZFS machine over ssh on a schedule: incremental from
the newest common snapshot, resumable from an interrupted receive, never `-F`
— two diverged sides are a refusal, not a rollback. Progress and history are on
the Copies page.

**Shares.** Hand a dataset out over SMB — Finder, Explorer, phones, and Time
Machine if you tick it — with its own list of who may open it, read or read and
write, prefilled from the drive's grants. There is no guest access: everyone
signs in with their drive account and the SMB password they set on their
account page. NFS is for machines without accounts, so the list of hosts and
networks *is* the access control and a share with an empty list is exported to
nobody. `smb.conf` and the exports file are written whole from the database on
every change and reloaded; they are never edited in place.

**Health.** Disk SMART with self-tests (one long test per disk a month, at
night, sleeping disks left asleep), scrub schedules per pool (monthly by
default, or weekly, or off), scrubs and rebuilds as jobs with progress and
history, and the `zpool events` tail, so a faulted disk or a checksum error is
known as it happens. The overview also shows the box at a glance: CPU, memory,
network, disk rates, temperatures.

**Alerts.** The box decides what is wrong and says when it is over: a pool not
ONLINE or filling up, a disk that failed SMART or is running hot, a scrub that
did not come back clean, a copy or a settings backup that failed, an update
waiting. Each one is held for a minute before it counts, has hysteresis so it
cannot flap, can be acknowledged without being hidden, and is kept for thirty
days after it clears. `sudo mk-nas alerts` on the box; the drive shows them on
Storage → Overview and can push them to a phone. The agent itself sends
nothing — no mail, no webhooks from the root process.
[`docs/alerts.md`](docs/alerts.md).

**The box itself.** Set the hostname (so `<hostname>.local` answers) and the
address from the Network page; an address change reverts itself after a couple
of minutes unless you confirm it from the new address, so you cannot lock
yourself out. Reboot or shut down with the hostname typed, after being told
what a restart would interrupt. Publish the drive through a Cloudflare Tunnel
from the same pages, without opening a port.

**Settings backup.** Once a day, and on demand, the box's settings — shares,
schedules, copies, SMB passwords, the drive's accounts, the ssh key, the
network file — are written into a dataset you choose and snapshotted there. A
dead OS disk is then the stick, a pool import and one restore.
[`docs/config-backup.md`](docs/config-backup.md).

**Updates from the box.** A daily check against the project's releases; an
update appears on Storage → Overview → System with a button. Installing is
always your decision, never automatic. What it installs is verified first: the
release's checksums are signed with an ssh key whose public half ships in the
package, the `.deb` and the pinned mk-drive image are checked against those
checksums, a settings backup is taken (and a failed one aborts the install),
and the whole thing runs in its own unit so it survives restarting the agent it
is replacing. [`docs/updates.md`](docs/updates.md).

## How it fits together

```
  browser ──HTTPS──▶ mk-drive (container, unprivileged; accounts, SSO, files,
                        │       and the Storage section when the socket is in)
                        │ newline-delimited JSON over /run/mk-nas.sock
                     mk-nasd  (root service: an allow-list of verbs over
                        │      zpool, zfs, smartctl, smb.conf, exports,
                        │      netplan, systemd timers — argv arrays, no shell)
                     Ubuntu Server 24.04 LTS + OpenZFS + Samba + NFS
```

This repository holds the agent, the installer and the image. **The Storage
pages live in mk-drive** and light up only when `DRIVE_NAS_SOCKET` names the
agent's socket; mk-nas has no UI of its own
([`docs/ui-lives-in-mk-drive.md`](docs/ui-lives-in-mk-drive.md)).

The two are released as a pair: an mk-nas release names the mk-drive version it
ships with, and `shared/types.ts` is the contract both sides compile against.
The agent reports a contract number (currently 2); the drive asks for an
upgrade when the agent it finds speaks an older one.

## On the box

One `.deb` with Node inside, installed to `/opt/mk-nas` and running as
`mk-nasd.service`, with two timers beside it: one for snapshots, scrubs, SMART
tests and the daily update check, one for replication. Nothing to configure by
hand in the normal case — the agent's paths are fixed and the installer sets
everything up.

| Where | What |
| --- | --- |
| `/run/mk-nas.sock` | The agent's socket, group `mk-nas`, mode 0660 |
| `/var/lib/mk-nas/mk-nas.db` | Shares, policies, jobs, alerts, SMB users |
| `/var/log/mk-nas/audit.jsonl` | Every call, rotated weekly ×12 (passwords redacted) |
| `/var/lib/mk-nas/ssh/` | The replication key and its own `known_hosts` |
| `/srv/locations/` | Datasets made as drive locations, bound into the container |
| `/opt/mk-drive/` | The drive's compose stack, its data and its `.env` |
| `/opt/mk-nas/install/release-signers` | The public keys a release must be signed with |

The operator-facing settings live in `/opt/mk-drive/.env` (mode 0600, parsed by
the agent, never sourced):

| Variable | What |
| --- | --- |
| `DRIVE_SETUP_TOKEN` | The setup code the drive asks for before creating the first admin. Generated once on install, shown on the console and by `sudo mk-nas setup-code`; ignored once an account exists |
| `DRIVE_UID` / `DRIVE_GID` | The uid and gid that own the files; the agent uses the same for `force user` on SMB shares |
| `MK_NAS_GID` | The `mk-nas` group, added to the container so it may open the socket — its only privilege |
| `DRIVE_IMAGE` / `DRIVE_PULL_POLICY` | The pinned drive image and `never`: the box never pulls by tag |
| `DRIVE_PASSWORD_LOGIN` / `DRIVE_OIDC_*` | Passed through to mk-drive — single sign-on, and where the password form is offered |
| `DRIVE_NAS_MONITOR_TOKEN` | Lets an outside monitor read the drive's health-only `/api/nas/monitor` |
| `CLOUDFLARE_TUNNEL_TOKEN` | Set it (from the drive's tunnel card) and the `cloudflared` service joins the stack |
| `TZ` | The box's timezone |

The agent's own paths all have `MK_NAS_*` overrides — `MK_NAS_SOCKET`,
`MK_NAS_DB`, `MK_NAS_AUDIT`, `MK_NAS_SMB_CONF`, `MK_NAS_EXPORTS`,
`MK_NAS_NETPLAN`, `MK_NAS_LOCATIONS`, and the poll intervals — but they exist
so the tests can run against a sandbox, not because a box needs them.

## Requirements

- **A machine of its own.** A 6th-generation Core i3 or better, 8 GB of RAM
  (16 GB is comfortable), wired Ethernet, UEFI with SATA in AHCI mode.
- **An OS disk** of its own — a 128 GB or larger SSD, wiped by the installer.
  The data never depends on it.
- **Two data disks of the same size** for a mirror (raidz1 and raidz2 also
  work). Prefer CMR; an SMR disk works but a rebuild onto one can crawl for
  days.
- **Ubuntu Server 24.04 LTS and OpenZFS**, nothing else: the installer refuses
  any other release, and there is no support for mdadm, btrfs or LVM
  ([`docs/base-os.md`](docs/base-os.md)).
- Node 24 ships inside the package; there is no build step and no runtime
  dependency to install.
- To build a package or a stick yourself: `dpkg-deb`, `fakeroot`, `curl`, and
  for the ISO also `xorriso`, `wget` and `gpgv`. Both the Ubuntu image and the
  mk-drive image are fetched and verified for you.

## Security

The privilege boundary is one file. `agent/src/verbs.ts` is the entire
allow-list; `agent/src/names.ts` is the only way a caller's value becomes an
argv element; `agent/src/run.ts` is the only way a command runs, always
`execFile` with an argv array and never a shell. Destructive verbs refuse to
act unless the pool or dataset name is typed back. Passwords travel on stdin
and are redacted in the audit log. The agent creates and touches only the SMB
system accounts it made itself, never one it found. Every stored row is
re-validated before it reaches an argv, because a restored database could
contain anything.

mk-drive runs on the box as an unprivileged container with `cap_drop: ALL`,
`no-new-privileges`, a memory limit and no capability beyond membership of the
`mk-nas` group so it can open the socket. It is never pulled by tag: the image
arrives as a tarball whose sha256 must match the one shipped in the package, or
it is deleted and the stack refuses to start. `cloudflared`, when you use it, is
pinned by digest.

Releases are signed on the maintainer's machine with an ssh key, never in CI.
Before signing, the CI-built package is rebuilt from the same tag locally and
compared with it — byte for byte, or file tree by file tree if the toolchains
differ — and anything else aborts. A box installs only a signed release.
[`docs/releasing.md`](docs/releasing.md).

`mk-nasd.service` deliberately does **not** use `ProtectHome` or `PrivateTmp`:
a private mount namespace would hide the pools and datasets the agent mounts
from the host and from the container.

## What it will not do

Virtual machines, containers as a product, Kubernetes, a plugin marketplace,
anything but ZFS, or parity with a product that has a company behind it.
Simple enough to understand in an evening is the whole point.

## Develop

`cd agent && npm test` runs the fixture tests anywhere. The integration test
makes a real pool on file vdevs, so it needs root and ZFS: `sudo npm test`, or
let CI do it. `npm run typecheck` type-checks the agent (Node 24 runs the
TypeScript directly, there is nothing to build). `make deb` builds the package,
`make iso` the stick, `make vm` the QEMU box,
`make release VERSION=X.Y.Z` cuts a release and `make upgrade HOST=user@box`
puts one on a machine. Never hand-edit the version. Bump `CONTRACT` in
`agent/src/verbs.ts` only when a verb changes shape.

## Documentation

[`docs/`](docs/) holds one file per confirmed decision — the agent boundary,
what may be destroyed, alerts, updates, the network revert, the scrub
schedule, the release chain, the first install, the test VM — with an index in
[`docs/README.md`](docs/README.md). [`PLAN.md`](PLAN.md) is the design, and
`board.md` the working list.

## Licence

AGPL-3.0-only — see [LICENSE](LICENSE). © 2026 Mateusz Kornaś. A commercial
licence (use without the AGPL's obligations) is available: hi@mateuszkornas.com.
