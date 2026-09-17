# Security: what a fresh box leaves open

- 2026-09-17 15:26 — e742336: autoinstall masks lxd-installer.socket (user-data and user-data.vm), postinst disables rpcbind on a first install, first-install.md documents both for older boxes. The pilot box was hardened by hand the same day (ssh keys only, first user out of docker and lxd, rpcbind off) and verified from outside. The mask line has not run in a VM yet. — main @ ad67d62 mk-nas 0.9.1 (pins mk-drive 0.9.1)
