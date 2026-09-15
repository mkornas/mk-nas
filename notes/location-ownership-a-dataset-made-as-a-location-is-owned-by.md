# *Location ownership** a dataset made as a location is owned by uid 1000; make the uid/gid configurable in install.sh (.env) for a container that runs as someone else

- 2026-09-13 08:51 — DRIVE_UID/DRIVE_GID in .env drive the compose user, postinst's chown and the agent's owner (EnvironmentFile on the unit); createDataset chowns to it; defaults 1000 — main @ d0c4c13 Location ownership follows the container's user
