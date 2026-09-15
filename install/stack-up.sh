#!/usr/bin/env bash
# Brings the drive's stack up (mk-drive.service runs this): the drive always, and the Cloudflare Tunnel only when
# /opt/mk-drive/.env has a CLOUDFLARE_TUNNEL_TOKEN. Remove the token and restart, and the tunnel container goes.
#   sudo systemctl restart mk-drive
set -euo pipefail
cd /opt/mk-drive
env_value() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env 2>/dev/null | tail -1 | tr -d "\"' \r"; }
# the drive's image is never pulled (pull_policy in the stack file): it is on the box, or waiting as a verified tgz, or
# the operator is told where it comes from instead of compose failing on a missing image
image=$(docker compose config --images mk-drive)
policy=$(env_value DRIVE_PULL_POLICY)
if [[ -z $policy || $policy == never ]] && ! docker image inspect "$image" >/dev/null 2>&1; then
  [[ -f /opt/mk-nas/mk-drive-image.tgz ]] && /opt/mk-nas/install/load-image.sh >/dev/null
  docker image inspect "$image" >/dev/null 2>&1 || {
    echo "stack-up.sh: the drive image $image is not on this box, and it is never pulled. Bring it with the release:" \
      "install/upgrade.sh <user>@<box> from another machine, or Install for a newer release (mk-nas update)," \
      "or put mk-drive-X.Y.Z.tgz from mk-drive's release at /opt/mk-nas/mk-drive-image.tgz and restart mk-drive" >&2
    exit 1
  }
fi
token=$(env_value CLOUDFLARE_TUNNEL_TOKEN)
if [[ -n $token ]]; then
  docker compose --profile tunnel up -d --remove-orphans
else
  # a service of an inactive profile is not an orphan to compose: take the tunnel down by name
  docker compose --profile tunnel rm --stop --force cloudflared >/dev/null 2>&1 || true
  docker compose up -d --remove-orphans
fi
