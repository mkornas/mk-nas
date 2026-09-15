#!/usr/bin/env bash
# Before `docker compose up`: load the mk-drive image waiting at /opt/mk-nas/mk-drive-image.tgz (put there by the
# stick, install/upgrade.sh or an install from the box), so the box needs no registry. Runs from mk-drive.service;
# a missing file is fine (stack-up.sh refuses to start without the image).
#
# Only a file whose sha256 is the one this package pins is loaded (install/mk-drive/sha256, verified by release.sh
# and covered by the release signature). The ID the loaded image gets here is written to
# /opt/mk-nas/mk-drive-image.id; an upgrade skips downloading the image only when the one on the box has that ID.
set -euo pipefail
img=/opt/mk-nas/mk-drive-image.tgz
pin=/opt/mk-nas/install/mk-drive
[[ -f $img ]] || exit 0
drive=$(tr -d '[:space:]' < "$pin/version")
want=$(awk -v f="mk-drive-$drive.tgz" '$2 == f {print $1}' "$pin/sha256" 2>/dev/null || true)
have=$(sha256sum "$img" | cut -d' ' -f1)
if [[ -z $want || $have != "$want" ]]; then
  rm -f "$img"
  echo "load-image.sh: $img is not mk-drive-$drive.tgz as this release pins it (sha256 $have); removed without loading" >&2
  exit 1
fi
ref=ghcr.io/mkornas/mk-drive:$drive
docker load -i "$img"
id=$(docker image inspect -f '{{.Id}}' "$ref") || { echo "load-image.sh: mk-drive-$drive.tgz did not contain $ref" >&2; exit 1; }
printf '%s %s\n' "$ref" "$id" > /opt/mk-nas/mk-drive-image.id
chmod 0644 /opt/mk-nas/mk-drive-image.id
rm -f "$img"
