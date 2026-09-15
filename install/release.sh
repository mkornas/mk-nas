#!/usr/bin/env bash
# Cut an mk-nas release: install/release.sh 0.4.0   (or: make release VERSION=0.4.0)
#
# Checks that the mk-drive version pinned in install/mk-drive/version is released (its image exists) and speaks a
# NAS contract this agent knows, sets agent/package.json, commits, tags vX.Y.Z and pushes. The release workflow
# tests, builds the .deb and publishes the GitHub Release; then install/sign-release.sh signs it with the release key,
# without which no box installs it. Needs gh, signed in, and the key (~/.config/mk-nas/release-signing-key).
set -euo pipefail
v=${1:?usage: install/release.sh X.Y.Z}
[[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "release.sh: $v is not X.Y.Z" >&2; exit 2; }
cd "$(dirname "${BASH_SOURCE[0]}")/.."
die() { echo "release.sh: $*" >&2; exit 1; }
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

node -e "const fs=require('fs');for(const f of ['agent/package.json','agent/package-lock.json']){const p=JSON.parse(fs.readFileSync(f));p.version='$v';if(p.packages&&p.packages['']){p.packages[''].version='$v'}fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')}"
git add agent/package.json agent/package-lock.json
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
