# The box's settings, kept where the data is

Everything a NAS is, apart from the files, lives on the OS disk: the
agent's database (policies, shares, copies, SMB users), Samba's password
database, the ssh key the copies sign in with, the netplan file, the
drive's `.env` and the drive's own database (its accounts). The OS disk is
the one disk without redundancy, so those go into a dataset of the
person's choosing — `backup.set` — once a day from the timer's tick and on
demand with `backup.run`.

What one backup does: build `<dataset>/mk-nas-config.new` (a consistent
`VACUUM INTO` copy of each SQLite file, `pdbedit -e` for Samba's
passwords, plain copies of the rest, a `manifest.json` with the time, the
hostname and the file list), swap it in whole for the previous directory,
then `zfs snapshot <dataset>@config-<stamp>` and prune beyond the last 30.
The history is ZFS's; the dataset replicates like any other, so the
settings travel with the data.

**Restore** (`backup.restore`, the dataset name typed) puts the files
back. The ssh key, known_hosts, the netplan file and the drive's `.env`
are copied at once. The two live databases cannot be replaced from inside
the agent that has one of them open, so they land next to the live files
as `.restore` and a finisher (`restore-finish.ts`, in its own transient
systemd unit so stopping the agent does not stop it) stops the
agent and the drive, moves them into place (owner kept), imports the Samba
passwords with `pdbedit -i`, regenerates `smb.conf` and the exports from
the restored database, and starts both services again — the verb's answer
arrives before that. If any step fails the services are started anyway
and the audit says what stopped.

A dead OS disk is then: boot the stick, `pool.import` from the Pools
page, Copies → This box's settings → Restore. The pool's data was never
at risk; this closes the gap for everything around it.

Not included: the drive's thumbnail cache (rebuilt on demand) and the
audit log.
