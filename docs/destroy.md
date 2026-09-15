# Destroying things

`pool.destroy` does not exist. `dataset.destroy` does, since 0.3.0, and it
is the only verb that makes data go away for good, so every reason to stop
is checked before anything runs:

- the name typed (`confirm` equal to the dataset name), and never a pool's
  root dataset;
- no children — destroy them first, one by one;
- no share on it — `share.remove` first;
- no replication from it — `replication.remove` first;
- snapshots only when the caller says `snapshots: true`; the UI states the
  count in the confirmation, so typing the name means them too.

`zfs destroy` is never called with `-r`: the snapshots go as one comma list
(`zfs destroy pool/ds@a,b,c`), then the dataset alone. The snapshot policy
row goes with it.

A dataset made as a location was given its mountpoint by hand, so ZFS
leaves the (now empty) directory under the locations dir behind; the agent
removes it and names the location in the result, and the drive's
`Locations.rescan` drops it from the sidebar at once (rescan now removes
vanished discovered locations as well as adding new ones).

Snapshots: `snapshot.destroy` takes the full `dataset@name` typed.
`snapshot.rollback` takes it typed too and goes back only to the dataset's
**newest** snapshot, the way ZFS allows without `-r`: every change made
since is gone, and that is what typing the name agrees to. When newer
snapshots exist the refusal names them; destroying them is a separate,
typed step, never `-r` here. Nothing is saved first — before 0.4.1 the
agent took a "before-rollback" snapshot, which was itself newer than the
target, so ZFS refused every rollback (verb contract 2 drops its `saved`
field). Getting single files back without losing anything is not a
rollback: the drive's file versions and `.zfs/snapshot/<name>` read them
out of the same snapshots.
