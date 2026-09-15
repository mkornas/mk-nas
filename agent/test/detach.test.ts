/** The detached jobs' command line: its own systemd unit as root, the environment passed explicitly; plain otherwise. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detachedArgv } from '../src/detach.ts';

test('detachedArgv: as root a transient unit named after the job, with the environment; without root the argv as it is', () => {
  const argv = ['/opt/mk-nas/node/bin/node', '/opt/mk-nas/agent/src/restore-finish.ts', '/tank/settings/mk-nas-config/passdb.tdb'];
  const env = { MK_NAS_DB: '/var/lib/mk-nas/mk-nas.db', NODE_NO_WARNINGS: '1' };
  assert.deepEqual(detachedArgv(argv, env, true, 1789000000000), [
    'systemd-run',
    '--quiet',
    '--collect',
    '--unit=mk-nas-restore-finish-1789000000000',
    '--setenv=MK_NAS_DB=/var/lib/mk-nas/mk-nas.db',
    '--setenv=NODE_NO_WARNINGS=1',
    ...argv,
  ]);
  assert.equal(detachedArgv(['node', 'src/replicate.ts', '3'], {}, true, 5)[3], '--unit=mk-nas-replicate-5');
  assert.deepEqual(detachedArgv(argv, env, false), argv);
});
