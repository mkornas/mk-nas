#!/usr/bin/env bash
# Sign a published mk-nas release: install/sign-release.sh 0.6.0   (release.sh runs it once the workflow is done)
#
# Downloads the release's SHA256SUMS, checks that it lists the package and release.json and that release.json names
# the drive image's checksum, signs it with the release key (ssh-keygen -Y sign, namespace mk-nas-release), checks the
# signature against install/release-signers — the file every package ships and every box verifies with — and uploads
# SHA256SUMS.sig. A box installs only a signed release. The key: MK_NAS_SIGNING_KEY, default
# ~/.config/mk-nas/release-signing-key (make one with install/sign-release.sh --new-key).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
die() { echo "sign-release.sh: $*" >&2; exit 1; }
key=${MK_NAS_SIGNING_KEY:-$HOME/.config/mk-nas/release-signing-key}
if [[ ${1:-} == --new-key ]]; then
  [[ -e $key ]] && die "$key exists; move it away first (every box trusts the key in install/release-signers)"
  mkdir -p "$(dirname "$key")" && chmod 700 "$(dirname "$key")"
  ssh-keygen -q -t ed25519 -C 'mk-nas releases' -f "$key"
  printf 'releases@mk-nas namespaces="mk-nas-release" %s\n' "$(cut -d' ' -f1,2 "$key.pub")" > install/release-signers
  echo "new key in $key; install/release-signers updated — commit it, and back the key up"
  exit 0
fi
v=${1:?usage: install/sign-release.sh X.Y.Z | --new-key}
[[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$v is not X.Y.Z"
[[ -f $key ]] || die "no signing key at $key (MK_NAS_SIGNING_KEY)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
gh release download "v$v" -R mkornas/mk-nas -D "$tmp" -p SHA256SUMS -p release.json
(cd "$tmp" && grep -q " mk-nas_${v}_amd64.deb\$" SHA256SUMS && grep -q ' release.json$' SHA256SUMS && sha256sum -c --quiet --ignore-missing SHA256SUMS) ||
  die "SHA256SUMS of v$v does not list the package and release.json, or release.json does not match it"
grep -q '"driveImageSha256": *"[0-9a-f]\{64\}"' "$tmp/release.json" || die "release.json of v$v names no drive image checksum"
ssh-keygen -Y sign -q -f "$key" -n mk-nas-release "$tmp/SHA256SUMS"
ssh-keygen -Y verify -f install/release-signers -I releases@mk-nas -n mk-nas-release -s "$tmp/SHA256SUMS.sig" < "$tmp/SHA256SUMS" >/dev/null ||
  die "the signature does not verify against install/release-signers: wrong key?"
gh release upload "v$v" -R mkornas/mk-nas "$tmp/SHA256SUMS.sig" --clobber
echo "signed v$v"
