#!/usr/bin/env bash
# Cut an mk-nas release: install/release.sh 0.4.0   (or: make release VERSION=0.4.0)
# Pin a drive first:     install/release.sh --drive 0.3.0   (writes install/mk-drive/version and sha256; commit them)
#
# Checks that the mk-drive version pinned in install/mk-drive/version is released and speaks a NAS contract this agent
# knows, and that install/mk-drive/sha256 still names its image as mk-drive's release lists it (writing it when the pin
# is new: the image downloaded and checked here, see pin_drive), sets agent/package.json, commits, tags vX.Y.Z and
# pushes. The release workflow tests, builds the .deb and publishes the GitHub Release; then install/sign-release.sh
# builds the same package here, compares it with CI's and signs what it verified, without which no box installs it.
# Needs gh, signed in, and the key (~/.config/mk-nas/release-signing-key); docker to look inside a newly pinned image.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
die() { echo "release.sh: $*" >&2; exit 1; }

# The image of mk-drive $1, from its GitHub release: its checksum against that release's SHA256SUMS and, with docker
# here, what it is — loaded, and asked for the drive version it carries (no network; the image is removed again unless
# it was here before). Writes install/mk-drive/sha256, which deb.sh stamps into the package and every box checks the
# image against; sign-release.sh puts it into release.json.
pin_drive() {
  local drive=$1 tmp sha ref loaded had='' version
  tmp=$(mktemp -d)
  gh release download "v$drive" -R mkornas/mk-drive -D "$tmp" -p "mk-drive-$drive.tgz" -p SHA256SUMS ||
    { rm -rf "$tmp"; die "mk-drive v$drive has no release with mk-drive-$drive.tgz"; }
  (cd "$tmp" && grep -E "^[0-9a-f]{64}  mk-drive-$drive\.tgz\$" SHA256SUMS | sha256sum -c --quiet -) ||
    { rm -rf "$tmp"; die "mk-drive-$drive.tgz does not match the SHA256SUMS of its release"; }
  sha=$(sha256sum "$tmp/mk-drive-$drive.tgz" | cut -d' ' -f1)
  ref=ghcr.io/mkornas/mk-drive:$drive
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    docker image inspect "$ref" >/dev/null 2>&1 && had=1
    loaded=$(docker load -q -i "$tmp/mk-drive-$drive.tgz")
    version=$(docker run --rm --network none --entrypoint node "$ref" -p "require('/app/server/package.json').version" 2>/dev/null || true)
    [[ -n $had ]] || docker image rm "$ref" >/dev/null 2>&1 || true
    [[ $loaded == "Loaded image: $ref" ]] || { rm -rf "$tmp"; die "mk-drive-$drive.tgz holds '$loaded', not $ref alone"; }
    [[ $version == "$drive" ]] || { rm -rf "$tmp"; die "the image in mk-drive-$drive.tgz says it is mk-drive '${version:-?}', not $drive"; }
    echo "mk-drive-$drive.tgz: $ref, mk-drive $version inside"
  else
    echo "release.sh: no docker here — only the checksum of mk-drive-$drive.tgz is checked, not what the image carries" >&2
  fi
  rm -rf "$tmp"
  printf '%s  mk-drive-%s.tgz\n' "$sha" "$drive" > install/mk-drive/sha256
}

if [[ ${1:-} == --drive ]]; then
  drive=${2:?usage: install/release.sh --drive X.Y.Z}
  [[ $drive =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$drive is not X.Y.Z"
  pin_drive "$drive"
  echo "$drive" > install/mk-drive/version
  echo "pinned mk-drive $drive; commit install/mk-drive/version and install/mk-drive/sha256"
  exit 0
fi

v=${1:?usage: install/release.sh X.Y.Z | --drive X.Y.Z}
[[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "release.sh: $v is not X.Y.Z" >&2; exit 2; }
[[ $(git branch --show-current) == main ]] || die "not on main"
[[ -f ${MK_NAS_SIGNING_KEY:-$HOME/.config/mk-nas/release-signing-key} ]] || die "no release signing key (install/sign-release.sh --new-key makes one)"
[[ -z $(git status --porcelain) ]] || die "the tree has changes; commit or stash them first"
git fetch -q origin --tags
[[ $(git rev-parse HEAD) == $(git rev-parse origin/main) ]] || die "main is not the same as origin/main; pull or push first"
git rev-parse -q --verify "refs/tags/v$v" >/dev/null && die "v$v exists already"

drive=$(tr -d '[:space:]' < install/mk-drive/version)
gh release view "v$drive" -R mkornas/mk-drive --json tagName >/dev/null 2>&1 ||
  die "mk-drive v$drive has no release yet (install/mk-drive/version); release it first: tools/release.sh $drive in mk-drive"
drive_contract=$(gh api "repos/mkornas/mk-drive/contents/server/src/nas.ts?ref=v$drive" -H 'Accept: application/vnd.github.raw' | grep -o 'NAS_CONTRACT = [0-9]*' | grep -o '[0-9]*$')
agent_contract=$(grep -o 'export const CONTRACT = [0-9]*' agent/src/verbs.ts | grep -o '[0-9]*$')
[[ -n $drive_contract && $drive_contract -le $agent_contract ]] ||
  die "mk-drive v$drive needs NAS contract ${drive_contract:-?}, this agent speaks $agent_contract"

# the drive image this release pins, as checked when it was pinned; a release whose image changed since is refused
pinned=$(awk -v f="mk-drive-$drive.tgz" '$2 == f {print $1}' install/mk-drive/sha256 2>/dev/null || true)
if [[ -z $pinned ]]; then
  pin_drive "$drive"
else
  listed=$(gh release download "v$drive" -R mkornas/mk-drive -p SHA256SUMS -O - | awk -v f="mk-drive-$drive.tgz" '$2 == f {print $1}')
  [[ $listed == "$pinned" ]] ||
    die "mk-drive v$drive's release lists sha256 ${listed:-none} for mk-drive-$drive.tgz, install/mk-drive/sha256 has $pinned: the release changed since it was pinned; find out why (install/release.sh --drive $drive checks it again)"
fi

node -e "const fs=require('fs');for(const f of ['agent/package.json','agent/package-lock.json']){const p=JSON.parse(fs.readFileSync(f));p.version='$v';if(p.packages&&p.packages['']){p.packages[''].version='$v'}fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')}"
git add agent/package.json agent/package-lock.json install/mk-drive/sha256
git commit -q -s -m "mk-nas $v (pins mk-drive $drive)"
git tag -a "v$v" -m "mk-nas $v, pins mk-drive $drive"
git push -q origin main "v$v"
echo "pushed v$v (mk-drive $drive, contract $agent_contract); waiting for the release workflow, then signing"
run=
for _ in $(seq 1 30); do
  run=$(gh run list --workflow release.yml --branch "v$v" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null) && [[ -n $run ]] && break
  sleep 5
done
[[ -n $run ]] || die "no release workflow run for v$v; when it is done: install/sign-release.sh $v"
gh run watch "$run" --exit-status >/dev/null || die "the release workflow failed: gh run view $run --log-failed"
install/sign-release.sh "$v"
