# install/ — the stick, the script, the VM

Putting mk-nas on a real box for the first time: [`docs/first-install.md`](../docs/first-install.md).
Releases and updating a box (`release.sh`, `upgrade.sh`, the pinned drive version in `mk-drive/version`): [`docs/releasing.md`](../docs/releasing.md).

- `install.sh` — mk-nas on a stock Ubuntu Server 24.04: packages (ZFS,
  smartmontools, Samba, NFS, Docker), Node 24 in `/opt/node`, the agent in
  `/opt/mk-nas` as `mk-nasd.service`, and mk-drive as a compose stack in
  `/opt/mk-drive` with the agent's socket mounted in. Idempotent; run it again
  after a `git pull`. `sudo ./install/install.sh` from a checkout.
- `make iso` (`iso.sh`) — the bootable stick: the newest Ubuntu Server 24.04
  ISO, checksum-verified and cached in `cache/`, remastered with xorriso so it
  boots into autoinstall with this repo on it. Two questions on the box: who
  you are (the identity screen: name, hostname, password) and which disk is
  the OS disk (the storage screen). The data disks are never touched. The
  mk-drive admin is created on the first visit of `http://<nas>:8810`, with
  the setup code the package makes (`DRIVE_SETUP_TOKEN` in
  `/opt/mk-drive/.env`; on the box's screen above the login prompt, and
  `sudo mk-nas setup-code`).
- The stick carries the mk-drive image of the pinned version: the release's
  `mk-drive-X.Y.Z.tgz`, checked against `install/mk-drive/sha256` before it
  goes on the stick, so the first boot needs no registry. The box never pulls
  the drive by tag (`pull_policy: never`); `load-image.sh` loads only an image
  file whose sha256 matches the pin. Updating later: System → Updates on the
  drive, or `make upgrade HOST=…` (`docs/releasing.md`).
- `make vm` (`vm.sh`) — the same install, hands-free, into a QEMU VM: one OS
  disk and two data disks with by-id serials, UEFI, mk-drive on
  `http://localhost:8810`, ssh on port 2222 (`nasadmin` / `mk-nas`). `make vm-boot`
  boots it again, `make vm-clean` removes it. Needs `qemu-system-x86 ovmf`.
  Headless use, upgrading the agent or the drive inside it without a
  reinstall, and driving it from a script: `docs/vm.md`.
- `autoinstall/user-data` is the stick's seed; `user-data.vm` the unattended
  one for the VM. `mk-drive/docker-compose.yml` and `mk-drive.service` are
  what lands in `/opt/mk-drive` and `/etc/systemd/system`.
