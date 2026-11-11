# The data itself, off the box

Replication (`replication-target.md`) copies a dataset to another ZFS
host. Most homes have no second ZFS host, and a mirror in one case does
not survive a fire, a theft or a power surge. So the box can also send
chosen datasets to storage that is somewhere else: object storage (S3 or
anything that speaks it, Backblaze B2) or a path (a USB disk taken away
afterwards). `agent/src/offsite.ts`, run by `agent/src/offsite-run.ts`.

**restic does the work.** It encrypts on the box before anything leaves,
deduplicates, keeps a history, and is in Ubuntu's own archive — nothing
from a third-party repository. The package recommends it rather than
depending on it, so an install without a network (the stick) is not held
up; without it the `offsite` verb answers `available: false` and the page
says `sudo apt install restic`.

**One repository, chosen datasets, a schedule** (`offsite.set`): daily,
weekly or only when asked. The repository is one of three kinds and
nothing else reaches restic's command line:

- `s3:https://host/bucket[/prefix]` with `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY`;
- `b2:bucket[:prefix]` with `B2_ACCOUNT_ID` and `B2_ACCOUNT_KEY`;
- an absolute path, with no keys.

`offsite.set` opens the repository with what it was given before it
stores anything: one that is not there is made (`restic init`), one that
is there must take the password.

**The secrets.** The storage keys and the repository password live in
`/var/lib/mk-nas/offsite-secrets.json`, root-only, and reach restic only
through its environment — never an argument, never the audit (`password`
and `credentials` are redacted), never the answer to a verb. One
exception, once: when the agent makes the password of a new repository,
the answer to that `offsite.set` carries it, and the page shows it until
the person says it is written down. Without the password nothing in the
repository can be read, and the box that knows it is what the backup is
for losing. The settings backup (`config-backup.md`) includes the file, so
a new OS disk carries on with the same repository; a new box after a
total loss is `offsite.set` with the old repository and
`password` (`mk-nas offsite set … --existing`).

**A run** (`offsite.run`, or the replication timer when the schedule says
so) is its own process in its own unit, like a replication: an upload of
hours survives an agent restart. Per dataset it

1. takes `<dataset>@mk-nas-offsite` (destroying one left by a run that
   was cut short);
2. runs `restic backup` on `<mountpoint>/.zfs/snapshot/mk-nas-offsite`,
   tagged `mk-nas` and with the dataset's name — one moment of the
   dataset, and the same path every time, so restic compares against the
   last run instead of reading every file again;
3. destroys the snapshot.

When every dataset arrived, `restic forget --prune` thins the history to
seven days, four weeks and twelve months per dataset. A run where
anything failed leaves the history alone, fails the job with restic's own
words, and raises the `offsite:backup` alert (`alerts.md`). Progress is a
row in `jobs` (kind `offsite`).

**Bringing it back** (`offsite.snapshots`, `offsite.restore`): a snapshot
is restored into a new directory, `restored-<stamp>`, at the top of a
mounted dataset. Nothing that exists is written over — a directory of
that name already there is a refusal, not a merge — and the person moves
what they need out of it. The test suite does this for real: it backs up
through restic into a repository on a path, changes a file, backs up
again, and restores (`agent/test/offsite.test.ts`; only zfs is faked).

**What it is not.** Not a second copy of the snapshots: the repository
holds files as they were at each run, not ZFS history. Not a place for
volumes. And a path on the same pool protects against nothing; the page
says so.
