# *Security: user verbs touch any Unix account** user.remove runs userdel on any existing account (system users, the admin login); user.set/smbPassword modify existing accounts: only accounts mk-nas recorded

- 2026-09-15 14:45 — Fixed in a72fe01 (mk-nas 0.7.1), with tests; verified in the VM: no EnvironmentFile, user.remove www-data refused, backup.set to a location refused, SMB password for our account still works. — main @ a72fe01 Security fixes from the 2026-09-15 audit
