# Decision: the UI is mk-drive, not a second app

Decided 2026-09-12: mk-drive runs on the NAS and works like the TrueNAS UI —
a NAS UI when it is mounted on a NAS, the plain mk-drive app when it is not.

- mk-nas ships the root agent, the installer and the bootable image. No web app.
- mk-drive gains a Storage section (admins only) that appears when
  `DRIVE_NAS_SOCKET` points at a mounted `/run/mk-nas.sock`; its server
  proxies `/api/nas/*` to the agent. Without the socket, mk-drive is unchanged.
- Identity comes from mk-drive's accounts (password, app passwords, SSO when
  configured), so a NAS without an identity provider still works.
- The privilege boundary is the socket and its allow-list of verbs; the
  container stays unprivileged.
