# November check of the box and the code

- 2026-11-11 14:05 — Released as mk-nas 0.9.4 (same mk-drive 0.9.1), signed; docs/upgrading.md has the list. Not on the pilot box yet. Signing first refused: on this machine /tmp is tmpfs and du there gave another Installed-Size than CI's; signed with TMPDIR on ext4, CI's package byte-identical. — main @ dba6f73 mk-nas 0.9.4 (pins mk-drive 0.9.1)
- 2026-11-11 15:25 — 2026-11-11: 0.9.4 installed on the pilot box from its System page and the box restarted: agent 0.9.4 from systemd's socket, kernel 6.8.0-147, no restart waiting, pool healthy, no failed units, drive 0.9.1 answering.
