# *Security: first boot on the LAN** port 8810 on all interfaces before an admin exists: a one-time setup token printed on the console / by mk-nas

- 2026-09-15 16:08 — postinst writes DRIVE_SETUP_TOKEN, /etc/issue.d on first install, mk-nas setup-code; drive asks for it (case/dash-insensitive, throttled). VM: fresh drive setupCodeRequired, wrong code 403 — main @ f46e739 Security fixes, second batch from the 2026-09-15 audit
