# A copy with nothing new still writes

- 2026-11-11 18:54 — Built on feat/november-ideas (not committed): the target is looked at before the snapshot, so an unreachable target leaves nothing; an idle non-recursive copy takes no snapshot. Recursive copies still snapshot every run.
