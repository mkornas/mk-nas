# Decision: a root agent behind a Unix socket, with an allow-list of verbs

Proposed in `PLAN.md` §2 and §4, adopted 2026-09-12 when `agent/` was started
on it. Amend this file if the author decides otherwise.

- `mk-nasd` runs as root as a systemd service and listens on
  `/run/mk-nas.sock`. The socket is owned by root, group `mk-nas`, mode 0660.
  The mk-drive container runs with that group and mounts the socket. That
  mount is the only privilege it ever has.
- The socket belongs to systemd (`mk-nasd.socket`), which hands it to the
  agent on every start. The file, and its inode, therefore stay the same while
  the agent restarts, and the container, which has that one file
  bind-mounted, keeps reaching it: an agent-only update does not restart the
  drive, and a call made in between waits for the next agent instead of
  failing. The price is that a stopped agent is started again by the next
  call; to keep it down, stop `mk-nasd.socket` as well (the drive must then
  be restarted afterwards, since the file is made anew). Started by hand or
  in tests, with no socket handed over, the agent makes the socket itself.
- The protocol is newline-delimited JSON: `{ id, verb, args }` in,
  `{ id, ok, result }` or `{ id, ok: false, error: { code, message } }` out.
  One connection may carry many requests; answers carry the request's `id`.
- **Verbs are an allow-list.** `agent/src/verbs.ts` is the complete set. A
  request for a verb not in it is refused with `unknown-verb`. There is no
  generic "run this" verb and never will be.
- **No shell, anywhere.** Every verb builds an argv array and hands it to
  `execFile`. Every argument that comes from the caller is validated against
  a strict shape first (pool and dataset names, snapshot names, device paths
  under `/dev/disk/by-id/`) and may never start with `-`. An argument that
  does not match is refused before any command is built.
- **Every call is audited**: one JSON line per request with time, verb, args,
  outcome and duration, to `/var/log/mk-nas/audit.jsonl` (or stderr in dev).
- **Destructive verbs need the name typed.** A verb that destroys or rewrites
  data takes a `confirm` argument that must equal the pool or dataset name,
  and is refused without it. `pool.destroy` does not exist in v1.
- **ZFS is the truth.** The agent keeps in its SQLite database only what the
  system cannot hold: share definitions, snapshot policies, job history, SMB
  users. Nothing that `zpool` or `zfs` can answer is ever cached in it.
- The contract (verb names, argument and result types) lives in `shared/`
  and is what mk-drive's `routes/nas.ts` types against.
