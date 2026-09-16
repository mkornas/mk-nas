# Upgrading mk-nas

mk-nas is one Debian package, `mk-nas_<version>_amd64.deb`, with the agent,
its timers, the `mk-nas` command, the mk-drive stack files and Node inside.
Ubuntu itself moves with `apt upgrade`, kernel and ZFS together.

## The agent and the drive, together

A box runs one mk-nas release and the mk-drive version it pins
(`docs/releasing.md`). From a laptop with this repository and `gh` signed in:

```
make upgrade HOST=<user>@<box>.local
```

That takes a settings backup, installs the newest release's package, and
brings the drive up on the image that release pins — downloaded from the
releases and copied over, so the box needs no registry login.

By hand on the box it is the same package:

```
sudo apt install ./mk-nas_<version>_amd64.deb
```

The postinst restarts `mk-nasd`, keeps the timers' schedule, leaves
`/opt/mk-drive/.env` alone, and does not touch the pools, datasets,
shares, the database under `/var/lib/mk-nas` or the ssh key. It replaces
`/opt/mk-drive/docker-compose.yml`, which names the pinned drive image,
and restarts the drive when that changed; the image must then be on the
box or waiting at `/opt/mk-nas/mk-drive-image.tgz` (`mk-drive-<version>.tgz`
from mk-drive's release, loaded only when it matches the checksum the
package carries). The box never pulls the drive from a registry. A copy that was
mid-send when the agent restarted is marked interrupted and resumes on its
next run.

**Running another drive on purpose** (a test build): set
`DRIVE_IMAGE=ghcr.io/mkornas/mk-drive:<tag>` or a local image in
`/opt/mk-drive/.env` and `sudo systemctl restart mk-drive`. A local image
must be loaded first; for one compose should pull from a registry, add
`DRIVE_PULL_POLICY=missing` (and `sudo docker login ghcr.io` for a private
package). The pin applies
again once that line is removed. Boxes installed before 0.4.1 had
`DRIVE_IMAGE=…:latest` there; 0.4.1's postinst comments that exact line out,
since `:latest` follows every push to mk-drive's main.

## When the two disagree

Every agent reports the verb contract it speaks; the drive knows the one it
was built for. A drive newer than its agent shows a banner on every page
asking for the upgrade above, and the Storage pages may misbehave until
then. An agent newer than its drive is fine: verbs are only ever added.

## What 0.9.0 changes on a box

- **The box says when something is wrong.** The agent keeps a list of
  conditions that are true right now — a pool not ONLINE or filling up, a
  disk failing or hot, a scrub, copy or settings backup that failed, an
  update waiting — with the time each started, and clears them when they
  stop (`docs/alerts.md`). `sudo mk-nas alerts` lists them; the drive shows
  them on Storage → Overview and pushes them to a phone
  (Settings → Notifications there). Nothing is sent by the agent itself.
- The list is checked every five minutes (`MK_NAS_ALERTS_EVERY`) and at once
  when ZFS reports a disk failing or coming back. A sleeping disk is never
  woken for it.
- New verbs `alerts` and `alert.ack`; the contract stays 2, so an older drive
  keeps working and simply does not show them.

## What 0.8.2 changes on a box

- The drive's stack passes `DRIVE_PASSWORD_LOGIN` only when
  `/opt/mk-drive/.env` sets it (it was `on` when unset), so a drive that
  knows it (mk-drive after 0.7.1) lets an admin choose password sign-in on
  **Settings → Sign-in**: everywhere, the local network only, or off. A line
  already in `.env` keeps winning; remove it to choose on the page. Pin a
  drive with that page in the same release: an older drive reads the
  empty value as `on`, as before.
- A settings restore also takes `DRIVE_PASSWORD_LOGIN` empty or `local`.

## What 0.8.1 changes on a box

- **The drive's image is never pulled.** The stack file sets
  `pull_policy: never` for mk-drive: the image comes only from
  `mk-drive-<version>.tgz`, which the drive's start loads only when its
  sha256 is the one the package carries (`/opt/mk-nas/install/mk-drive/sha256`).
  When the image is missing, `mk-drive.service` fails with a message saying
  to install the release again (`install/upgrade.sh`) instead of pulling it
  from ghcr.io. Your own `DRIVE_IMAGE` from a registry needs
  `DRIVE_PULL_POLICY=missing` next to it in `/opt/mk-drive/.env`.
- The image ID a verified load gives is written to
  `/opt/mk-nas/mk-drive-image.id`. An update skips downloading the drive
  image only when the image on the box has that ID, so the first update
  after this one downloads the image once more even when the pin is the
  same.
- **Both containers are hardened**: no capabilities (`cap_drop: ALL`) and
  `no-new-privileges`. The drive runs as its unprivileged uid as before and
  needs none; cloudflared is pinned by digest. Compose recreates both
  containers once.
- The drive gets `DRIVE_SETUP_TOKEN` from `/opt/mk-drive/.env`: the setup
  code the first visit asks for before it creates the admin account, on a
  drive that knows it (`docs/first-install.md`).
- **An NFS share names who may mount it.** Before, a share with NFS on and
  no hosts listed was exported to every private network (10/8, 172.16/12,
  192.168/16). Now it is exported to nobody until hosts or networks are
  added on its Shares page, and the drive asks for at least one when NFS is
  turned on. The agent rewrites smb.conf and the exports once when it starts
  on the new version, so this applies right after the upgrade.
- The package no longer adds the first user (uid 1000) to the `docker`
  group; a box that already has it keeps it (`sudo gpasswd -d <user> docker`
  removes it: membership is root on the box).
- `install/upgrade.sh` no longer reads `UNSIGNED=1`; `--unsigned` asks you to
  type `unsigned`. It refuses a release whose `release.json` names no drive
  image checksum.
- A release's `release.json` and `SHA256SUMS` are now written by the
  maintainer's machine from a package it built and compared with CI's
  (`docs/releasing.md`); nothing changes in how a box checks them.

## What 0.8.0 changes on a box

- **SMB access per share.** Each SMB share has its own list of who may open
  it, Read or Read and write, set in the share dialog and prefilled from
  the drive's grants on that folder. Samba gets exactly that list; a share
  nobody may open is not offered at all. Existing shares become admins-only
  (read and write) when the drive first starts on this version — add others
  in the share dialog. The CLI's `mk-nas shares` shows who can open each one.
- Disabling an account in the drive takes it off every share list, and
  deleting one removes its SMB user on the box.
- The drive has an optional read-only monitor route for a dashboard on
  another machine: set `DRIVE_NAS_MONITOR_TOKEN` (32 characters or more) in
  `/opt/mk-drive/.env`; empty leaves it off. A settings restore brings it
  back.
- Pins mk-drive 0.7.0.

## What 0.7.1 changes on a box

Security fixes from the audit of 2026-09-15. Install it.

- The agent no longer loads `/opt/mk-drive/.env` into its environment; it
  reads `DRIVE_UID` and `DRIVE_GID` from it and nothing else.
- A settings restore brings back only known keys of the drive's `.env`
  (sign-in, tunnel token, owner, time zone, password sign-in), never
  `DRIVE_IMAGE` or anything else, and copies no symlinks in either
  direction.
- The settings backup refuses a dataset that anyone but root can write to,
  such as a location: pick or create a plain dataset for it.
- `user.set`, `user.smbPassword` and `user.remove` act only on accounts
  mk-nas created (comment `mk-nas SMB user`, primary group `mk-nas-smb`).
- Shares, snapshot policies, the backup dataset and copies read from the
  database are checked again before they reach a config file or a command.
- The drive's Docker network has a fixed subnet (172.31.88.0/24), and the
  drive believes client addresses only from the box itself
  (`DRIVE_TRUSTED_PROXIES`); the stack's network is recreated once.
- Pins mk-drive 0.6.1: uploaded HTML, SVG and XML can no longer run as a
  page; WebDAV takes only app passwords; session ids are no longer sent to
  the browser; single sign-on requires a verified email; symlinks inside a
  location are not followed; upload links have size, count and rate limits;
  login and share-password guessing is throttled properly.

## What 0.7.0 changes on a box

- **Storage → Network → Reach the drive from outside**: paste a Cloudflare
  Tunnel token and the box starts the tunnel; the card shows whether it is
  connected, the public hostnames Cloudflare gives it and the last error.
  New verbs `tunnel`, `tunnel.set` and `tunnel.remove`; the contract stays 2.
  A token already in `/opt/mk-drive/.env` shows up there as it is. The page
  refuses to change the tunnel when it is opened through that tunnel.
- cloudflared's metrics and readiness now listen on `127.0.0.1:20241` only.
  Before, they were open on every address of the box, the LAN included; the
  tunnel container is recreated once by this upgrade when a token is set.
- A tunnel token passed to the agent is redacted in its audit log.
- Pins mk-drive 0.6.0, which has the tunnel card and shows the mk-nas
  version in the sidebar.

## What 0.6.2 changes on a box

- Pins mk-drive 0.5.0:
  - **Settings → Sign-in**: an admin sets single sign-on with their own
    OpenID Connect provider (Pocket ID, Authentik, Keycloak, …) on the page
    instead of `DRIVE_OIDC_*` in `/opt/mk-drive/.env`. Those lines, when
    present, still win and show read-only. The client secret lives in the
    drive's database, which the settings backup includes.
  - The Shares page, the share dialog and the account page show
    `smb://<box>.local/<share>` instead of the bare hostname, which only
    resolved where the network's DNS knew it.
- Nothing changes in the agent.

## What 0.6.1 changes on a box

- A disk that cannot run SMART self-tests (an NVMe drive without the
  command) is skipped by the monthly self-test instead of failing the timer
  every 15 minutes; **Long test** says so instead of trying.
- Long self-tests start only between 01:00 and 05:00, the box's local time.
- A scheduled snapshot is skipped when nothing was written to the dataset
  since its newest snapshot: an idle pool is no longer written to every
  hour, and the kept snapshots reach further back.
- The disk listing (Disks, Overview, `health`) no longer wakes a sleeping
  disk: it shows "asleep" with the last reading. A running self-test shows
  on the disk. Pins mk-drive 0.4.1, which shows this.
- A failed install from the box no longer leaves its downloads behind.

## What 0.6.0 changes on a box

- The box looks for new releases once a day and shows a newer, signed one
  under Storage → Overview → System, with its notes and **Install**
  (`docs/updates.md`); `mk-nas update` does the same over ssh. The install
  checks the maintainer's signature against `/opt/mk-nas/install/release-signers`,
  which this package ships, before anything else. New verbs `update`,
  `update.check` and `update.install`; the contract stays 2.
- The agent now reaches `api.github.com` and `github.com` over HTTPS: once
  a day for the check, and when a person installs a release.
- `install/upgrade.sh` refuses an unsigned release unless `UNSIGNED=1`.
  Releases before 0.6.0 are unsigned.
- Pins mk-drive 0.4.0, which shows all this.

## What 0.5.0 changes on a box

- Storage → Overview has a System section: the mk-nas and mk-drive
  versions, "A restart is needed" when Ubuntu's updates ask for one, and
  Reboot and Shut down, confirmed by typing the box's hostname
  (`docs/power.md`). New verbs `power`, `system.reboot` and
  `system.shutdown`; the contract stays 2. Pins mk-drive 0.3.0, which shows
  this and says on the Shares page when nobody can connect over SMB yet.
- mk-nas and mk-drive are licensed AGPL-3.0-only from this release on.

## What 0.4.4 changes on a box

- Disks that carry a ZFS pool from another system (an old TrueNAS pool, a
  disk replaced out of a pool) are no longer treated as in use: the Disks
  page shows them as "old pool X, not imported" with **Wipe**, which clears
  the ZFS labels and the partition table. A disk used by a pool imported on
  the box is still refused. Pins mk-drive 0.2.2, which shows this.

## What 0.4.3 changes on a box

- The drive's stack has a Cloudflare Tunnel service, `mk-drive-tunnel`
  (`cloudflare/cloudflared`, pinned), off until `/opt/mk-drive/.env` has
  `CLOUDFLARE_TUNNEL_TOKEN=<token>`; `mk-drive.service` starts the stack
  through `/opt/mk-nas/install/stack-up.sh`, which turns the tunnel on or
  removes it according to that line (`docs/first-install.md`, "Reach the
  drive from outside").
- `/opt/mk-drive/.env` is made root-only (0600) on every install: it holds
  the tunnel token and single sign-on's client secret.
- A `cloudflared` you installed by hand as a system service keeps running
  and does not conflict; remove one of the two (`sudo cloudflared service
  uninstall`) so the hostname is served by a single connector.

## What 0.4.1 and 0.4.2 change on a box

- 0.4.2: the long jobs the agent starts — a replication send, the second
  half of a settings restore — run in their own transient systemd unit
  (`mk-nas-replicate-*`, `mk-nas-restore-finish-*`), so restarting or
  upgrading the agent no longer kills them. Before, a restore stopped the
  agent and was killed with it, leaving the agent and the drive down.

- The drive runs the version mk-nas pins (`ghcr.io/mkornas/mk-drive:0.2.1`
  for 0.4.1) instead of `:latest`; an old `DRIVE_IMAGE=…:latest` line in
  `/opt/mk-drive/.env` is commented out.
- The verb contract is 2 (`snapshot.rollback` returns no `saved`): a drive
  older than 0.2.1 works but its rollback toast breaks, and drive 0.2.1 asks
  for the upgrade when it meets an older agent — update both together.
- The settings backup (`docs/config-backup.md`) and rollback as ZFS does it
  (`docs/destroy.md`).

## What 0.3.0 added to the box

- `/etc/netplan/90-mk-nas.yaml` when an address was set from the drive, and
  `/var/lib/mk-nas/netplan-pending.json` while a change waits to be kept
  (`docs/network.md`); avahi-daemon as a dependency.
- `/etc/logrotate.d/mk-nas` (weekly, keep 12) for the audit log — a
  conffile, yours once edited.
- bash and zsh completion for `mk-nas` under `/usr/share`.
- `DRIVE_UID` / `DRIVE_GID` in `/opt/mk-drive/.env` (written on a fresh
  install, 1000 when absent): who the container runs as, who owns new
  locations and files written over the network. The agent reads those two
  lines from that `.env` when it starts (only those: the unit no longer
  loads the file into its environment), so `systemctl restart mk-nasd`
  after changing them.
- the `jobs` table gained a `pool` column and a `scrub_policies` table
  appeared — added in place, an older agent ignores both.

## Downgrading

`make upgrade HOST=<box> VERSION=<older>` rolls back, drive and all; by
hand, `sudo apt install --allow-downgrades ./mk-nas_<older>_amd64.deb`. The
database schema only ever gains tables and columns, so an older agent
ignores what it does not know.

## Reinstalling the OS

The OS disk is disposable: boot the stick, pick the OS disk again, and when
the drive is back, import the pool from the Pools page ("Pools from
elsewhere"). Shares, policies and copies live in `/var/lib/mk-nas/mk-nas.db`
and the ssh key next to it; keep a copy of that directory somewhere (a
config backup that replicates is on the board).
