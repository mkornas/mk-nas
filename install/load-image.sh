#!/usr/bin/env bash
# Before the first `docker compose up`: load the mk-drive image the stick
# carried, so a private ghcr package needs no login on the NAS. Runs from
# mk-drive.service; a missing file is fine (the image is pulled instead).
set -euo pipefail
img=/opt/mk-nas/mk-drive-image.tgz
[[ -f $img ]] || exit 0
docker load -i "$img"
rm -f "$img"
