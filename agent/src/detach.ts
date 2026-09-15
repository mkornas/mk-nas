/**
 * Long jobs the agent starts and forgets — a replication send, the second half of a settings restore — must outlive
 * the agent: an upgrade restarts it, and a restore stops it on purpose. A child of mk-nasd.service is killed with the
 * service (systemd kills the whole unit), so as root the job runs in a transient unit of its own through systemd-run,
 * with the environment it needs passed explicitly. Without root (development) it is a plain detached child.
 */
import { basename } from 'node:path';

export function detachedArgv(argv: string[], env: Record<string, string>, root: boolean, now = Date.now()): string[] {
  if (!root) return argv;
  const job = basename(argv[1] ?? argv[0])
    .replace(/\.ts$/, '')
    .replace(/[^A-Za-z0-9-]/g, '-');
  return ['systemd-run', '--quiet', '--collect', `--unit=mk-nas-${job}-${now}`, ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), ...argv];
}
