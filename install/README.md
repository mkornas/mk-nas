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
  mk-drive admin is created on the first visit of `http://<nas>:8810`.
- The stick carries the mk-drive image when docker is on the build machine
  (`docker save` of `ghcr.io/mkornas/mk-drive:latest`, or `DRIVE_IMAGE=…`), so
  the ghcr package can stay private and the first boot needs no registry.
  Updating later on the NAS: `docker login ghcr.io` once with a read-only
  token, then `cd /opt/mk-drive && docker compose pull && systemctl restart mk-drive`.
- `make vm` (`vm.sh`) — the same install, hands-free, into a QEMU VM: one OS
  disk and two data disks with by-id serials, UEFI, mk-drive on
  `http://localhost:8810`, ssh on port 2222 (`nasadmin` / `mk-nas`). `make vm-boot`
  boots it again, `make vm-clean` removes it. Needs `qemu-system-x86 ovmf`.
  Headless use, upgrading the agent or the drive inside it without a
  reinstall, and driving it from a script: `docs/vm.md`.
- `autoinstall/user-data` is the stick's seed; `user-data.vm` the unattended
  one for the VM. `mk-drive/docker-compose.yml` and `mk-drive.service` are
  what lands in `/opt/mk-drive` and `/etc/systemd/system`.
