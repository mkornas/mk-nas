# mk-dashboard on the NAS

- 2026-09-15 14:07 — 2026-09-15: a dashboard on another machine can check the box from outside (the drive on the LAN and through its tunnel, ssh, SMB). Pool, disk and scrub alerts still need a dashboard that can reach /run/mk-nas.sock, i.e. running on the box: the image is private on GHCR, so either make the mk-dashboard package public or docker login on the box once.
