/** The drive stack's .env as the agent reads it: DRIVE_UID and DRIVE_GID, nothing else. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveId } from '../src/config.ts';

test('driveId: the last line for the key, digits only, anything else is no answer', () => {
  assert.equal(driveId('TZ=UTC\nDRIVE_UID=1001\nDRIVE_GID=1002\n', 'DRIVE_UID'), 1001);
  assert.equal(driveId('TZ=UTC\nDRIVE_UID=1001\nDRIVE_GID=1002\n', 'DRIVE_GID'), 1002);
  assert.equal(driveId('DRIVE_UID=1001\nDRIVE_UID=1003\n', 'DRIVE_UID'), 1003, 'the last line wins');
  assert.equal(driveId(' DRIVE_UID = "1004"\r\n', 'DRIVE_UID'), 1004, 'spaces, quotes and CRLF as compose takes them');
  assert.equal(driveId('DRIVE_UID=1001\nDRIVE_UID=abc\n', 'DRIVE_UID'), null, 'the last line is not a number: no answer, not an earlier line');
  for (const bad of ['', 'DRIVE_UID=', 'DRIVE_UID=-1', 'DRIVE_UID=1000 # me', 'DRIVE_UID=$(id -u)', '# DRIVE_UID=1001', 'XDRIVE_UID=1001', 'DRIVE_UIDX=1001'])
    assert.equal(driveId(bad, 'DRIVE_UID'), null, bad);
  assert.equal(driveId('NODE_OPTIONS=--import=/tmp/evil.mjs\nDRIVE_GID=1000\n', 'DRIVE_UID'), null);
});
