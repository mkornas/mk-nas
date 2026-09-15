#!/usr/bin/env bash
# Sign a published mk-nas release: install/sign-release.sh 0.6.0   (release.sh runs it once the workflow is done)
#
# Signs only what this machine verified, never CI's word. It builds the package itself from the tag (a temporary
# worktree of vX.Y.Z, install/deb.sh there with the same pinned Node tarball), requires CI's package to be the same
# package (below), then writes release.json from the tag (the agent version, install/mk-drive/version,
# CONTRACT in agent/src/verbs.ts, install/mk-drive/sha256 as driveImageSha256) and SHA256SUMS over CI's package and
# that release.json, signs SHA256SUMS with the release key (ssh-keygen -Y sign, namespace mk-nas-release), checks the
# signature against install/release-signers — the file every package ships and every box verifies with — and uploads
# release.json, SHA256SUMS and SHA256SUMS.sig over the workflow's. A box installs only a signed release. The key:
# MK_NAS_SIGNING_KEY, default ~/.config/mk-nas/release-signing-key (make one with install/sign-release.sh --new-key).
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
for t in gh git python3 sha256sum ssh-keygen dpkg-deb fakeroot curl; do command -v $t >/dev/null || die "needs $t"; done
deb=mk-nas_${v}_amd64.deb
tmp=$(mktemp -d)
src=$tmp/src
trap 'git worktree remove --force "$src" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

# the tag as this machine knows it (release.sh made it here; fetch never moves an existing local tag), and CI built the same
git fetch -q origin --tags || true
commit=$(git rev-parse -q --verify "refs/tags/v$v^{commit}") || die "no tag v$v here"
[[ $(git ls-remote origin "refs/tags/v$v" "refs/tags/v$v^{}" | tail -1 | cut -f1) == "$commit" ]] || die "v$v on GitHub is not the v$v here ($commit)"

echo "building mk-nas $v from v$v"
git worktree add -q --detach "$src" "v$v"
# the same Node tarball; deb.sh checks it against the checksum pinned at the tag either way
mkdir -p "$src/install/cache"
cp install/cache/node-*-linux-x64.tar.xz "$src/install/cache/" 2>/dev/null || true
(cd "$src" && install/deb.sh >/dev/null) || die "install/deb.sh failed at v$v"
[[ -f $src/install/out/$deb ]] || die "the build at v$v made no $deb (agent/package.json there?)"

mkdir -p "$tmp/ci" "$tmp/out"
gh release download "v$v" -R mkornas/mk-nas -D "$tmp/ci" -p "$deb"
# CI's package must be the one built here. deb.sh clamps tar mtimes to the commit's time, so with the same dpkg-deb and
# xz as CI's runner (ubuntu-24.04) the two are byte-identical, and that is checked first. Another dpkg or xz here
# compresses differently, so the check that decides is the file tree: both packages unpacked by dpkg-deb itself (what
# the box's dpkg does), every member of the control and data archives compared by type, mode, owner, size, sha256 and
# link target, mtimes ignored; a duplicate member is refused.
if cmp -s "$src/install/out/$deb" "$tmp/ci/$deb"; then
  echo "CI's $deb is byte-identical to the one built here"
else
  python3 - "$src/install/out/$deb" "$tmp/ci/$deb" <<'PY' || die "CI's $deb is not the package v$v builds here; not signed"
import hashlib, io, subprocess, sys, tarfile

def tree(deb, part):
    raw = subprocess.run(['dpkg-deb', part, deb], check=True, capture_output=True).stdout
    out = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as t:
        for m in t:
            if m.name in out:
                sys.exit(f'{deb}: {m.name} twice in {part}')
            body = hashlib.sha256(t.extractfile(m).read()).hexdigest() if m.isfile() else m.linkname
            out[m.name] = (m.type, oct(m.mode), m.uid, m.gid, m.uname, m.gname, m.size, m.devmajor, m.devminor, body)
    return out

bad = 0
for part in ('--ctrl-tarfile', '--fsys-tarfile'):
    here, ci = tree(sys.argv[1], part), tree(sys.argv[2], part)
    for name in sorted(set(here) | set(ci)):
        if here.get(name) != ci.get(name):
            bad += 1
            print(f'  {name}: here {here.get(name)}, CI {ci.get(name)}', file=sys.stderr)
sys.exit(1 if bad else 0)
PY
  echo "CI's $deb has the same files as the one built here (not byte-identical: another dpkg-deb or xz)"
fi

# release.json from the tag, not from the workflow
drive=$(tr -d '[:space:]' < "$src/install/mk-drive/version")
[[ $drive =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "install/mk-drive/version at v$v is not X.Y.Z"
contract=$(grep -o 'export const CONTRACT = [0-9]*' "$src/agent/src/verbs.ts" | grep -o '[0-9]*$')
[[ -n $contract ]] || die "no CONTRACT in agent/src/verbs.ts at v$v"
image_sha=$(awk -v f="mk-drive-$drive.tgz" '$2 == f {print $1}' "$src/install/mk-drive/sha256" 2>/dev/null || true)
[[ $image_sha =~ ^[0-9a-f]{64}$ ]] || die "install/mk-drive/sha256 at v$v names no checksum for mk-drive-$drive.tgz"
printf '{"agent":"%s","drive":"%s","contract":%s,"driveImageSha256":"%s"}\n' "$v" "$drive" "$contract" "$image_sha" > "$tmp/out/release.json"
cp "$tmp/ci/$deb" "$tmp/out/"
(cd "$tmp/out" && sha256sum "$deb" release.json > SHA256SUMS)

ssh-keygen -Y sign -q -f "$key" -n mk-nas-release "$tmp/out/SHA256SUMS"
ssh-keygen -Y verify -f install/release-signers -I releases@mk-nas -n mk-nas-release -s "$tmp/out/SHA256SUMS.sig" < "$tmp/out/SHA256SUMS" >/dev/null ||
  die "the signature does not verify against install/release-signers: wrong key?"
gh release upload "v$v" -R mkornas/mk-nas "$tmp/out/release.json" "$tmp/out/SHA256SUMS" "$tmp/out/SHA256SUMS.sig" --clobber
echo "signed v$v: mk-drive $drive, contract $contract"
