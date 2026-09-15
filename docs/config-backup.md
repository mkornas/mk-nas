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

The dataset must be one only root can write to at its top (a plain
dataset, not a location: a location belongs to the drive's container).
The backup holds the ssh key and Samba's passwords, and is written by
path; where someone else can rename entries, a link could be swapped in
under the agent. `backup.set` and every run refuse such a dataset.

**Restore** (`backup.restore`, the dataset name typed) puts the files
back. The ssh key, known_hosts and the netplan file are copied at once.
Every file is taken from the backup only if it is a regular file on the
dataset itself (not a link, not through a linked directory), all of them
opened before anything is written; each lands as a fresh file renamed
over its destination, so a link left at a destination (the drive's data
directory is the container's) is replaced, never written through.

The drive's `.env` is not copied over this box's: the file stays, and
from the backup only these keys are taken, each value checked —
`DRIVE_UID`, `DRIVE_GID` (digits), `TZ` (a zone name),
`DRIVE_PASSWORD_LOGIN` (empty, `on`, `local`, `lan`, `off`), `DRIVE_OIDC_ISSUER` (an
http(s) URL), `DRIVE_OIDC_CLIENT_ID`, `DRIVE_OIDC_CLIENT_SECRET`,
`DRIVE_OIDC_NAME` (one line, no quotes, `$`, backslash or control
characters inside), `CLOUDFLARE_TUNNEL_TOKEN` (a tunnel token) and
`DRIVE_NAS_MONITOR_TOKEN` (32 to 256 token characters). Each
replaces this box's line for the key, or is added. Nothing else comes
back: not `MK_NAS_GID` (this box's group), and not `DRIVE_IMAGE`, since
a restored file must not choose the image the drive runs — set it again
by hand if the old box ran something other than the pinned version. A
key whose value fails its check keeps this box's value and gets a
comment line in the `.env` saying it was not restored (the value is not
written), so one odd line does not stop a restore.

The two live databases cannot be replaced from inside
the agent that has one of them open, so they land next to the live files
as `.restore` (Samba's passwords wait in `/var/lib/mk-nas`, out of the
dataset) and a finisher (`restore-finish.ts`, in its own transient
systemd unit so stopping the agent does not stop it) stops the
agent and the drive, moves them into place (owner kept; a `.restore` or a
live database that is not a regular file stops it), imports the Samba
passwords with `pdbedit -i`, regenerates `smb.conf` and the exports from
the restored database, and starts both services again — the verb's answer
arrives before that. If any step fails the services are started anyway
and the audit says what stopped.

A restored database is whatever the dataset held, so what it names is
checked where it matters: a copy's datasets, host, user and port go
through the same checks as `replication.set` before each run (a row
that fails them fails its job), and the SMB user verbs change or delete
only accounts mk-nas made, whatever `smb_users` lists.

A dead OS disk is then: boot the stick, `pool.import` from the Pools
page, Copies → This box's settings → Restore. The pool's data was never
at risk; this closes the gap for everything around it.

Not included: the drive's thumbnail cache (rebuilt on demand) and the
audit log.
