# mk-nas — Project Guide

## Think before coding

State assumptions; if two readings exist, name them. Prefer the simpler
approach and say so. Every changed line should trace to the request; do not
refactor neighbours. Match the existing style.

## What this is

The NAS side of mk-drive: a root agent (`mk-nasd`) over Ubuntu Server and
OpenZFS — pools, datasets, snapshots, SMB/NFS shares, replication, health —
plus the installer and the bootable image. **It has no UI of its own**: the
Storage section of mk-drive appears when the agent's socket is mounted into
the container. **ZFS is the truth**: the agent never mirrors the system's
state in its database; the database holds only what the system cannot
(share definitions, snapshot policies, job history, SMB users).
`PLAN.md` is the design; the live backlog is `board.md` (mk-board format,
worked with the `mk-board` CLI, notes in `notes/`); confirmed decisions go
to `docs/` as one file each.

## Layout

- `agent/` — `mk-nasd`: Node 24 type-stripping (`import './x.ts'`, no build),
  runs as root as a systemd service, listens on `/run/mk-nas.sock`, exposes
  an allow-list of verbs as newline-delimited JSON. `src/verbs.ts` is the
  allow-list, `src/names.ts` the only way a caller's value becomes an argv
  element, `src/run.ts` the only way a command runs (execFile, no shell),
  `src/write.ts` the verbs that change something (look before leaping,
  `confirm` = the name typed for anything destructive), `src/db.ts` the
  SQLite for what ZFS cannot hold (policies), `src/updates.ts` +
  `src/update.ts` the updates from the box (a daily check, a signed release
  installed by its own process, `docs/updates.md`), `src/alerts.ts` what is
  wrong with the box right now (pure condition rules + raise/clear, kept in
  SQLite so `since` survives a restart; the agent never sends anything itself,
  mk-drive delivers — `docs/alerts.md`), `src/policy.ts` +
  `src/tick.ts` the snapshot timer (pure planner, run by `mk-nas-snapshot.timer`),
  `src/shares.ts` the SMB/NFS shares and SMB users (smb.conf and the exports
  file written whole from the db on every change, then reloaded; a password
  only ever travels on stdin and is redacted in the audit), `src/replication.ts`
  + `src/replicate.ts` the copies to other hosts (a pure plan over both sides'
  snapshots; `zfs send | ssh zfs receive` as two processes joined by a pipe in
  Node, never -F; the runner is its own process so a send survives an agent
  restart, run by `replication.run` and `mk-nas-replication.timer`; jobs in
  SQLite), `src/cli.ts` the `mk-nas` command over the same socket. Every call
  is audited. The unit must not use ProtectHome/PrivateTmp: a mount namespace
  would hide the agent's mounts from the host. `npm test` runs the fixture
  tests anywhere; the file-vdev pool test needs root and zfs (`sudo npm
  test`, or CI).
- `shared/types.ts` — the verb contract; mk-drive's `routes/nas.ts` types
  against it.
- `install/` — `make deb` (`deb.sh`: the package with the agent, the units,
  `/usr/bin/mk-nas`, the mk-drive stack files and Node under
  `/opt/mk-nas/node`; `deb/postinst` does what a first install needs and is
  idempotent), `install.sh` (a stock Ubuntu Server: build the package, then
  `apt install` it; the stick runs the same with the `.deb` it carries),
  `make iso` (`iso.sh`: Ubuntu autoinstall remastered with xorriso,
  `autoinstall/user-data` the seed) and `make vm` (`vm.sh`: the unattended
  variant into QEMU). Releases go through `make release VERSION=X.Y.Z`
  (never hand-edit the version); `install/mk-drive/version` pins the drive a
  release ships with; boxes update with `make upgrade HOST=…`
  (`docs/releasing.md`). Bump `CONTRACT` in `agent/src/verbs.ts` only when a
  verb changes shape.
  `cache/` and `out/` are ignored.
- The Storage pages live in the mk-drive repo (`client/src/app/pages/storage`,
  `server/src/routes/nas.ts`), behind `DRIVE_NAS_SOCKET`.

## Conventions

- Commits: plain `git commit -s` as Mateusz Kornaś, no AI co-author trailers
  (the repo may go public as the mk-kit family's NAS).
- Nothing about the author's network, hosts, addresses or disks in tracked
  files; that stays out of the repo.
- Tokens only in styles; the Momentum preset like mk-drive.
- Destructive verbs need the pool or dataset name typed in the UI and are
  refused by the agent without it. `pool.destroy` does not exist in v1.
- Tests run against a file-backed ZFS pool on a loop device in CI (or skip
  when ZFS is absent), never against a real disk.
