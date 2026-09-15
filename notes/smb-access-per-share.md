# SMB access per share

- 2026-09-15 15:11 — 84c670e: per-share smbAccess in the agent (valid users / read only / write list, nobody = not offered, pre-list shares keep the group until the drive sets a list, removed users dropped from lists); checked with smbclient in the VM. Drive side in mk-drive 77e1b7e. — main @ 8213b87 Settings restore brings back the drive's monitor token
