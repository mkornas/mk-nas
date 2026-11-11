# A copy with nothing new still writes

- 2026-11-11 18:54 — Built on feat/november-ideas (not committed): the target is looked at before the snapshot, so an unreachable target leaves nothing; an idle non-recursive copy takes no snapshot. Recursive copies still snapshot every run.
- 2026-11-11 19:28 — Released in 0.10.0: the target is asked before the snapshot; an idle non-recursive copy takes none. — main @ 34eb5d2 mk-nas 0.10.0 (pins mk-drive 0.10.0)
