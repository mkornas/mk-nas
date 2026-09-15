# *Security: installer defaults** postinst adds the first user to docker (root without a password) on every upgrade; the stick allows ssh password login: drop the docker group, keys-only or document

- 2026-09-15 16:08 — no more docker group for uid 1000 (existing membership documented in upgrading.md); seed sets PermitRootLogin no; keys-only documented in first-install.md — main @ f46e739 Security fixes, second batch from the 2026-09-15 audit
