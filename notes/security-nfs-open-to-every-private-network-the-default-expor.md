# *Security: NFS open to every private network** the default exports rw to 10/8, 172.16/12, 192.168/16 with no auth: no default clients, ask for them

- 2026-09-15 16:08 — no default clients; share.set requires a list when NFS changes; agent rewrites share files on start (VM: old export to private ranges → not exported, nfs-server down) — main @ f46e739 Security fixes, second batch from the 2026-09-15 audit
