#!/usr/bin/env bash
# Brings the drive's stack up (mk-drive.service runs this): the drive always, and the Cloudflare Tunnel only when
# /opt/mk-drive/.env has a CLOUDFLARE_TUNNEL_TOKEN. Remove the token and restart, and the tunnel container goes.
#   sudo systemctl restart mk-drive
set -euo pipefail
cd /opt/mk-drive
token=$(sed -n 's/^[[:space:]]*CLOUDFLARE_TUNNEL_TOKEN[[:space:]]*=[[:space:]]*//p' .env 2>/dev/null | tail -1 | tr -d "\"' \r")
if [[ -n $token ]]; then
  docker compose --profile tunnel up -d --remove-orphans
else
  # a service of an inactive profile is not an orphan to compose: take the tunnel down by name
  docker compose --profile tunnel rm --stop --force cloudflared >/dev/null 2>&1 || true
  docker compose up -d --remove-orphans
fi
