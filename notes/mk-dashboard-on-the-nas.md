# mk-dashboard on the NAS

- 2026-09-15 14:07 — 2026-09-15: the homelab dashboard now checks the box from outside (drive on the LAN and through drive.kornas.cloud, ssh, SMB; infra-homelab 2e53f6e). Pool, disk and scrub alerts still need a dashboard that can reach /run/mk-nas.sock, i.e. running on the box: the image is private on GHCR, so either make the mk-dashboard package public or docker login on the box once.
