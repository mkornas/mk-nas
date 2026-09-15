#!/usr/bin/env bash
# The mk-nas stick: the newest Ubuntu Server 24.04 ISO, remastered with
# xorriso so it boots straight into autoinstall with this repo on it.
#
#   install/iso.sh                                  → install/out/mk-nas-<date>.iso
#   install/iso.sh --unattended user-data --out x.iso  (a fully hands-free variant, for the VM test)
#
# Needs: xorriso, wget, gpgv, sha256sum, dpkg-deb, fakeroot. The stick carries the mk-drive image: mk-drive-<version>.tgz
# from mk-drive's release (the version in install/mk-drive/version), checked against install/mk-drive/sha256. The Ubuntu
# ISO and the image are cached in install/cache/.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/.." && pwd)
cache=$here/cache
out=$here/out/mk-nas-$(date +%Y%m%d).iso
userdata=$here/autoinstall/user-data
mirror=https://releases.ubuntu.com/24.04

while [[ $# -gt 0 ]]; do
  case $1 in
    --unattended) userdata=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    *) echo "iso.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
for t in xorriso wget gpgv sha256sum; do command -v $t >/dev/null || { echo "iso.sh: needs $t" >&2; exit 1; }; done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
mkdir -p "$cache" "$(dirname "$out")"

say "the newest Ubuntu Server 24.04"
wget -q -O "$cache/SHA256SUMS" "$mirror/SHA256SUMS"
wget -q -O "$cache/SHA256SUMS.gpg" "$mirror/SHA256SUMS.gpg"
# keys/ubuntu-cdimage.gpg is "Ubuntu CD Image Automatic Signing Key (2012) <cdimage@ubuntu.com>", fingerprint
# 8439 38DF 228D 22F7 B374 2BC0 D94A A3F0 EFE2 1092, exported from a throwaway keyring:
#   GNUPGHOME=$(mktemp -d) gpg --keyserver hkps://keyserver.ubuntu.com --recv-keys 843938DF228D22F7B3742BC0D94AA3F0EFE21092
#   gpg --export 843938DF228D22F7B3742BC0D94AA3F0EFE21092 > install/keys/ubuntu-cdimage.gpg   (same GNUPGHOME)
# the keyring holds that key alone, so a good signature is Ubuntu's
gpgv --keyring "$here/keys/ubuntu-cdimage.gpg" "$cache/SHA256SUMS.gpg" "$cache/SHA256SUMS" 2>/dev/null ||
  { echo "iso.sh: $mirror/SHA256SUMS is not signed by Ubuntu's CD image key" >&2; exit 1; }
iso_name=$(awk '/live-server-amd64.iso/ {print $2}' "$cache/SHA256SUMS" | tr -d '*' | sort -V | tail -1)
[[ -n $iso_name ]] || { echo "iso.sh: no live-server ISO listed at $mirror" >&2; exit 1; }
wget -q -c -O "$cache/$iso_name" "$mirror/$iso_name"
(cd "$cache" && grep " \*$iso_name\$" SHA256SUMS | sha256sum -c --quiet -) || { echo "iso.sh: checksum mismatch for $iso_name" >&2; exit 1; }
say "$iso_name verified"

say "staging"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/nocloud" "$stage/mk-nas"
cp "$userdata" "$stage/nocloud/user-data"
: > "$stage/nocloud/meta-data"
# the package, built from this checkout, and the thin installer that puts it in
"$here/deb.sh" >/dev/null
mkdir -p "$stage/mk-nas/install/out"
cp "$(ls -t "$here"/out/mk-nas_*_amd64.deb | head -1)" "$stage/mk-nas/install/out/"
cp -a "$here/install.sh" "$stage/mk-nas/install/"
# the mk-drive image on the stick, as mk-drive released it and release.sh checked it: the box never pulls it from a
# registry, and load-image.sh there loads only this very file (the package carries the same checksum)
drive=$(tr -d '[:space:]' < "$here/mk-drive/version")
tgz=$cache/mk-drive-$drive.tgz
want=$(awk -v f="mk-drive-$drive.tgz" '$2 == f {print $1}' "$here/mk-drive/sha256")
[[ -n $want ]] || { echo "iso.sh: install/mk-drive/sha256 does not name mk-drive-$drive.tgz" >&2; exit 1; }
checked() { [[ -f $tgz && $(sha256sum "$tgz" | cut -d' ' -f1) == "$want" ]]; }
checked || wget -q -O "$tgz" "https://github.com/mkornas/mk-drive/releases/download/v$drive/mk-drive-$drive.tgz" || rm -f "$tgz"
checked || { echo "iso.sh: no mk-drive-$drive.tgz from mk-drive's release that matches install/mk-drive/sha256" >&2; exit 1; }
say "mk-drive $drive on the stick"
cp "$tgz" "$stage/mk-nas/install/mk-drive-image.tgz"
# grub: boot into autoinstall with the nocloud seed on the stick; a short timeout, no menu to read
xorriso -osirrox on -indev "$cache/$iso_name" -extract /boot/grub/grub.cfg "$stage/grub.cfg" 2>/dev/null
chmod u+w "$stage/grub.cfg"
python3 - "$stage/grub.cfg" <<'PY'
# grub needs the ';' escaped as backslash-';' or it ends the command there
import re, sys
p = sys.argv[1]
s = open(p).read()
seed = 'autoinstall ds=nocloud' + chr(92) + ';s=/cdrom/nocloud/ '
s = s.replace('/casper/vmlinuz ', '/casper/vmlinuz ' + seed, 1)
s = re.sub(r'^set timeout=.*$', 'set timeout=3', s, flags=re.M)
open(p, 'w').write(s)
PY
grep -q 'autoinstall ds=nocloud.;s=/cdrom/nocloud/' "$stage/grub.cfg" || { echo "iso.sh: could not patch grub.cfg (ISO layout changed?)" >&2; exit 1; }

say "writing $out"
rm -f "$out"
xorriso -indev "$cache/$iso_name" -outdev "$out" \
  -overwrite on \
  -map "$stage/nocloud" /nocloud \
  -map "$stage/mk-nas" /mk-nas \
  -map "$stage/grub.cfg" /boot/grub/grub.cfg \
  -boot_image any replay \
  2>&1 | grep -v -e '^xorriso : UPDATE' -e '^xorriso : NOTE' || true
ls -l "$out"
cat <<MSG
Write it to a stick (everything on the stick is erased):
  sudo dd if=$out of=/dev/sdX bs=4M status=progress oflag=sync
MSG
