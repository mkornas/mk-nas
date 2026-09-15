#!/usr/bin/env bash
# mk-nas on a stock Ubuntu Server 24.04, from a checkout: builds the package
# (or takes one given as the argument) and installs it with apt, which pulls
# ZFS, Samba, NFS, smartmontools and Docker along. Idempotent: run it again
# after a `git pull` to upgrade. The bootable stick installs the same .deb.
#
#   sudo ./install/install.sh                    # build from this checkout, then install
#   sudo ./install/install.sh mk-nas_0.2.0_amd64.deb
#
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo)"
[[ -r /etc/os-release ]] && . /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || die "this is for Ubuntu Server 24.04 (found ${PRETTY_NAME:-unknown})"

deb=${1:-}
if [[ -z $deb ]]; then
  deb=$(ls -t "$here"/out/mk-nas_*_amd64.deb 2>/dev/null | head -1 || true)
  if [[ -z $deb || $here/../agent -nt $deb ]]; then
    say "building the package"
    apt-get install -y -q --no-install-recommends dpkg-dev fakeroot curl >/dev/null
    "$here/deb.sh" >/dev/null
    deb=$(ls -t "$here"/out/mk-nas_*_amd64.deb | head -1)
  fi
fi
[[ -f $deb ]] || die "no package at $deb"

# the stick may carry the mk-drive image (a private ghcr package needs no login then); loaded on the first start
if [[ -f $here/mk-drive-image.tgz ]]; then
  mkdir -p /opt/mk-nas
  cp "$here/mk-drive-image.tgz" /opt/mk-nas/mk-drive-image.tgz
fi

# a first install shows the drive's setup code at the end; an upgrade leaves it where it is (sudo mk-nas setup-code)
first=1
[[ $(dpkg-query -W -f='${Status}' mk-nas 2>/dev/null || true) == 'install ok installed' ]] && first=0

say "installing $(basename "$deb")"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends "$(readlink -f "$deb")"

say "done"
cat <<MSG
  agent    mk-nasd on /run/mk-nas.sock   (journalctl -u mk-nasd, audit in /var/log/mk-nas/audit.jsonl)
  cli      mk-nas health | pools | datasets | … (mk-nas --help)
  timers   mk-nas-snapshot.timer and mk-nas-replication.timer every 15 min (systemctl list-timers)
  drive    http://$(hostname -I 2>/dev/null | awk '{print $1}'):8810   (first visit creates the admin account; it asks for the setup code)
  stack    /opt/mk-drive/docker-compose.yml + .env; systemctl status mk-drive
  upgrade  sudo apt install ./mk-nas_<version>_amd64.deb   (docs/upgrading.md)
MSG
code=$(sed -n 's/^[[:space:]]*DRIVE_SETUP_TOKEN[[:space:]]*=[[:space:]]*//p' /opt/mk-drive/.env 2>/dev/null | tail -1 || true)
if [[ $first == 1 && -n $code ]]; then
  printf '\n  setup code  \033[1m%s\033[0m   (the drive asks for it once, to create the admin account; sudo mk-nas setup-code shows it again)\n' "$code"
fi
