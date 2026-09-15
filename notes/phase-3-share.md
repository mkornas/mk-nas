# Phase 3 — share

- 2026-09-12 20:59 — Agent: share.set/remove writing smb.conf + exports whole, SMB users with the password on stdin, redacted audit; mk-nas CLI share/unshare/user. Verified in the VM: smbclient login with the account's SMB password, a file written over SMB owned by uid 1000 and visible in the container, NFS export listed. Fixed on the way: Samba refuses a numeric force group. mk-drive: Shares page, share dialog on Datasets, the SMB password card on the account page. — main @ 99d2eae Phase 3: shares over SMB and NFS, SMB users for drive accounts
