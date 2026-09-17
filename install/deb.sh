#!/usr/bin/env bash
# The mk-nas package: everything the agent needs, Node included, as one .deb.
#
#   install/deb.sh            → install/out/mk-nas_<version>_amd64.deb
#
# Needs: dpkg-deb, curl, sha256sum. The Node tarball is cached in install/cache/.
set -euo pipefail

NODE_VERSION=v24.21.0
NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/.." && pwd)
cache=$here/cache
version=$(node -e "console.log(require('$repo/agent/package.json').version)" 2>/dev/null || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$repo/agent/package.json" | head -1)
out=$here/out/mk-nas_${version}_amd64.deb
for t in dpkg-deb curl sha256sum fakeroot; do command -v $t >/dev/null || { echo "deb.sh: needs $t" >&2; exit 1; }; done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
mkdir -p "$cache" "$here/out"

say "node $NODE_VERSION"
tarball=$cache/node-$NODE_VERSION-linux-x64.tar.xz
if [[ ! -f $tarball ]] || ! echo "$NODE_SHA256  $tarball" | sha256sum -c --quiet - 2>/dev/null; then
  curl -fsSL -o "$tarball" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
  echo "$NODE_SHA256  $tarball" | sha256sum -c --quiet - || { echo "deb.sh: node tarball checksum mismatch" >&2; exit 1; }
fi

say "staging mk-nas $version"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/DEBIAN" "$stage/opt/mk-nas/node" "$stage/opt/mk-nas/install/mk-drive" "$stage/lib/systemd/system" "$stage/usr/bin" "$stage/etc/logrotate.d" "$stage/usr/share/bash-completion/completions" "$stage/usr/share/zsh/vendor-completions"
cp -a "$repo/agent" "$repo/shared" "$stage/opt/mk-nas/"
rm -rf "$stage/opt/mk-nas/agent/node_modules" "$stage/opt/mk-nas/agent/test" "$stage/opt/mk-nas/agent/"*.service "$stage/opt/mk-nas/agent/"*.socket "$stage/opt/mk-nas/agent/"*.timer
tar -xJf "$tarball" -C "$stage/opt/mk-nas/node" --strip-components=1
rm -rf "$stage/opt/mk-nas/node/include" "$stage/opt/mk-nas/node/share" "$stage/opt/mk-nas/node/lib/node_modules/npm/docs"
cp "$here/load-image.sh" "$here/stack-up.sh" "$here/release-signers" "$stage/opt/mk-nas/install/"
drive_version=$(tr -d '[:space:]' < "$here/mk-drive/version")
[[ $drive_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "deb.sh: install/mk-drive/version must be X.Y.Z (found '$drive_version')" >&2; exit 1; }
sed "s/@DRIVE_VERSION@/$drive_version/" "$here/mk-drive/docker-compose.yml" > "$stage/opt/mk-nas/install/mk-drive/docker-compose.yml"
echo "$drive_version" > "$stage/opt/mk-nas/install/mk-drive/version"
# the image's checksum, verified by release.sh when the pin was set: load-image.sh on the box loads only a tgz that matches it
grep -qE "^[0-9a-f]{64}  mk-drive-$drive_version\.tgz\$" "$here/mk-drive/sha256" 2>/dev/null ||
  { echo "deb.sh: install/mk-drive/sha256 does not name mk-drive-$drive_version.tgz; install/release.sh --drive $drive_version writes it" >&2; exit 1; }
cp "$here/mk-drive/sha256" "$stage/opt/mk-nas/install/mk-drive/sha256"
cp "$repo/agent/mk-nasd.service" "$repo/agent/mk-nasd.socket" "$repo/agent/mk-nas-snapshot.service" "$repo/agent/mk-nas-snapshot.timer" "$repo/agent/mk-nas-replication.service" "$repo/agent/mk-nas-replication.timer" "$here/mk-drive.service" "$stage/lib/systemd/system/"
ln -s /opt/mk-nas/agent/src/cli.ts "$stage/usr/bin/mk-nas"
cp "$here/deb/mk-nas.logrotate" "$stage/etc/logrotate.d/mk-nas"
cp "$here/completion/mk-nas.bash" "$stage/usr/share/bash-completion/completions/mk-nas"
cp "$here/completion/mk-nas.zsh" "$stage/usr/share/zsh/vendor-completions/_mk-nas"
cp "$here/deb/postinst" "$here/deb/prerm" "$stage/DEBIAN/"
echo /etc/logrotate.d/mk-nas > "$stage/DEBIAN/conffiles"
chmod 0755 "$stage/DEBIAN/postinst" "$stage/DEBIAN/prerm"
size=$(du -sk "$stage/opt" "$stage/lib" | awk '{s+=$1} END {print s}')
cat > "$stage/DEBIAN/control" <<CTL
Package: mk-nas
Version: $version
Section: admin
Priority: optional
Architecture: amd64
Installed-Size: $size
Depends: zfsutils-linux, smartmontools, samba, nfs-kernel-server, avahi-daemon, docker.io, docker-compose-v2, openssh-client, ca-certificates, xz-utils
Maintainer: Mateusz Kornaś <hi@mateuszkornas.com>
Homepage: https://github.com/mkornas/mk-nas
Description: the mk-nas agent: ZFS, shares and copies for mk-drive
 A root service on /run/mk-nas.sock with an allow-list of verbs over zpool,
 zfs, smartctl, Samba, NFS and ssh, its timers, the mk-nas command, and the
 mk-drive stack that shows it all. Node is included.
CTL
# a checkout made with umask 002 has group-writable files: nothing in the package is writable by anyone but root
chmod -R go-w "$stage"
say "writing $out (mk-drive $drive_version pinned)"
rm -f "$out"
# tar mtimes clamped to the commit's time, so the same tag builds the same package here and in CI (sign-release.sh compares)
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$repo" log -1 --format=%ct 2>/dev/null || date +%s)} \
  fakeroot dpkg-deb --build --root-owner-group -Zxz "$stage" "$out" >/dev/null
ls -l "$out"
