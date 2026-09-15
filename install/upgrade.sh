#!/usr/bin/env bash
# Put an mk-nas release on a box, from a laptop:
#
#   install/upgrade.sh nasadmin@nas.local            the newest release
#   install/upgrade.sh nasadmin@nas.local 0.4.0      that one (an older one rolls back)
#   install/upgrade.sh -p 2222 nasadmin@localhost    the test VM (docs/vm.md)
#
# Downloads the release's .deb and the mk-drive image it pins (both from GitHub Releases, checksums verified; gh
# must be signed in here — the box needs no GitHub or registry login), copies them over ssh,
# and on the box: takes a settings backup when one is set up, installs the package (the drive restarts on the
# pinned image), and waits for the agent and the drive to answer. sudo asks for the box's password once.
set -euo pipefail
port=22
while getopts "p:" o; do case $o in p) port=$OPTARG ;; *) exit 2 ;; esac; done
shift $((OPTIND - 1))
host=${1:?usage: install/upgrade.sh [-p port] user@host [X.Y.Z]}
want=${2:-}
say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { echo "upgrade.sh: $*" >&2; exit 1; }
for t in gh ssh scp sha256sum ssh-keygen; do command -v $t >/dev/null || die "needs $t"; done
ssh_opts=(-p "$port" -o ConnectTimeout=10)
scp_opts=(-P "$port" -o ConnectTimeout=10)

tag=${want:+v$want}
[[ -n $tag ]] || tag=$(gh release view -R mkornas/mk-nas --json tagName -q .tagName) || die "no mk-nas release found (gh signed in?)"
v=${tag#v}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

say "mk-nas $v"
mkdir -p "$tmp/nas" "$tmp/drive"
gh release download "$tag" -R mkornas/mk-nas -D "$tmp/nas" -p "mk-nas_${v}_amd64.deb" -p release.json -p SHA256SUMS
# the maintainer's signature, checked against the key in this checkout, the same one every package ships
if gh release view "$tag" -R mkornas/mk-nas --json assets -q '.assets[].name' | grep -qx SHA256SUMS.sig; then
  gh release download "$tag" -R mkornas/mk-nas -D "$tmp/nas" -p SHA256SUMS.sig
  ssh-keygen -Y verify -f "$(dirname "${BASH_SOURCE[0]}")/release-signers" -I releases@mk-nas -n mk-nas-release -s "$tmp/nas/SHA256SUMS.sig" < "$tmp/nas/SHA256SUMS" >/dev/null ||
    die "the signature of mk-nas $v does not verify"
  say "signature verified"
else
  [[ ${UNSIGNED:-} == 1 ]] || die "mk-nas $v is not signed (yet: install/sign-release.sh $v); UNSIGNED=1 installs it anyway"
fi
(cd "$tmp/nas" && sha256sum -c --quiet SHA256SUMS) || die "checksum mismatch in the mk-nas $v release"
drive=$(grep -o '"drive": *"[^"]*"' "$tmp/nas/release.json" | grep -o '[0-9][0-9.]*')
[[ -n $drive ]] || die "release.json names no drive version"

have_nas=$(ssh "${ssh_opts[@]}" "$host" "dpkg-query -W -f='\${Version}' mk-nas 2>/dev/null || true")
have_drive=$(ssh "${ssh_opts[@]}" "$host" "docker image inspect ghcr.io/mkornas/mk-drive:$drive >/dev/null 2>&1 && echo yes || echo no")
say "the box has mk-nas ${have_nas:-none}; this release pins mk-drive $drive (on the box already: $have_drive)"

files=("$tmp/nas/mk-nas_${v}_amd64.deb")
if [[ $have_drive != yes ]]; then
  say "mk-drive $drive"
  gh release download "v$drive" -R mkornas/mk-drive -D "$tmp/drive" -p "mk-drive-$drive.tgz" -p SHA256SUMS
  (cd "$tmp/drive" && sha256sum -c --quiet SHA256SUMS) || die "checksum mismatch in the mk-drive $drive release"
  image_sha=$(grep -o '"driveImageSha256": *"[0-9a-f]*"' "$tmp/nas/release.json" | grep -o '[0-9a-f]\{64\}' || true)
  [[ -z $image_sha || $image_sha == $(sha256sum "$tmp/drive/mk-drive-$drive.tgz" | cut -d' ' -f1) ]] || die "mk-drive-$drive.tgz does not match the signed mk-nas $v release"
  files+=("$tmp/drive/mk-drive-$drive.tgz")
fi

# the steps on the box, as a file: sudo needs the terminal for its password, so they cannot come over stdin
cat > "$tmp/apply.sh" <<REMOTE
#!/bin/bash
set -euo pipefail
d=/tmp/mk-nas-upgrade
if mk-nas backup now >/dev/null 2>&1; then echo "settings backed up"; else echo "no settings backup taken (none set up, or an agent without it)"; fi
# the pinned image goes where mk-drive.service loads it from before compose up, so no registry login is needed
if [ -f \$d/mk-drive-$drive.tgz ]; then cp \$d/mk-drive-$drive.tgz /opt/mk-nas/mk-drive-image.tgz; fi
DEBIAN_FRONTEND=noninteractive apt-get install -y -q --allow-downgrades \$d/mk-nas_${v}_amd64.deb
# when the pin did not change the drive was not restarted: load the image anyway rather than leave the file behind
if [ -f /opt/mk-nas/mk-drive-image.tgz ]; then /opt/mk-nas/install/load-image.sh >/dev/null; fi
for i in \$(seq 1 60); do mk-nas version >/dev/null 2>&1 && break; sleep 2; done
mk-nas version
meta=
for i in \$(seq 1 90); do meta=\$(curl -fsS http://127.0.0.1:8810/api/meta 2>/dev/null) && break; sleep 2; done
echo "drive: \${meta:-did not answer on 8810 — journalctl -u mk-drive}" | cut -c1-160
rm -rf \$d
REMOTE

say "copying to $host"
ssh "${ssh_opts[@]}" "$host" "rm -rf /tmp/mk-nas-upgrade && mkdir -p /tmp/mk-nas-upgrade"
scp -q "${scp_opts[@]}" "${files[@]}" "$tmp/apply.sh" "$host:/tmp/mk-nas-upgrade/"

say "installing on $host"
ssh -t "${ssh_opts[@]}" "$host" "sudo bash /tmp/mk-nas-upgrade/apply.sh"
say "done: mk-nas $v with mk-drive $drive on $host"
