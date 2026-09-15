import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inStandby, longTestDue, parseLsblk, parseSelfTests, pickId, selfTestSupported, summarizeSmart, useOf } from '../src/disks.ts';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('lsblk: whole disks only, no loop or zvol', () => {
  const d = parseLsblk(fx('lsblk.json'));
  assert.deepEqual(
    d.map((x) => x.name),
    ['sda', 'sdb', 'nvme0n1'],
  );
});

test('use: pool from a partition label, os from the root mount, free otherwise', () => {
  const [sda, sdb, nvme] = parseLsblk(fx('lsblk.json'));
  assert.deepEqual(useOf(sda), { kind: 'pool', pool: 'tank', imported: false }, 'a label no pool here uses: from another system');
  assert.deepEqual(useOf(sda, new Set(['/dev/sda1'])), { kind: 'pool', pool: 'tank', imported: true }, 'a member of a pool imported here');
  assert.deepEqual(useOf(sdb), { kind: 'free' });
  assert.deepEqual(useOf(nvme), { kind: 'os' });
});

test('by-id: prefer the readable id over wwn and eui', () => {
  assert.equal(pickId(['wwn-0x50014ee2b5a1c2d3', 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA']), 'ata-WDC_WD20EFRX-68EUZN0_WD-AAAAAAAAAAAA');
  assert.equal(
    pickId(['nvme-eui.0025385b91b1c2d3', 'nvme-Samsung_SSD_970_EVO_250GB_S4EWNX0N000000', 'nvme-Samsung_SSD_970_EVO_250GB_S4EWNX0N000000_1']),
    'nvme-Samsung_SSD_970_EVO_250GB_S4EWNX0N000000',
  );
  assert.equal(pickId(['wwn-0x50014ee2b5a1c2d3']), 'wwn-0x50014ee2b5a1c2d3');
});

test('smart summary: ata attributes and nvme log', () => {
  assert.deepEqual(summarizeSmart(JSON.parse(fx('smartctl-ata.json'))), {
    passed: true,
    temperature: 34,
    powerOnHours: 41234,
    reallocated: 0,
    pending: 2,
    wear: null,
  });
  assert.deepEqual(summarizeSmart(JSON.parse(fx('smartctl-nvme.json'))), {
    passed: true,
    temperature: 41,
    powerOnHours: 9001,
    reallocated: null,
    pending: null,
    wear: 3,
  });
  assert.deepEqual(summarizeSmart({}), { passed: null, temperature: null, powerOnHours: null, reallocated: null, pending: null, wear: null });
});

test('self-tests: ata status and log, nvme log; a long test is due after 720 power-on hours without one, never while one runs', () => {
  const ata = JSON.parse(fx('smartctl-ata-selftest.json'));
  assert.deepEqual(parseSelfTests(ata), {
    running: { kind: 'long', percentDone: 10 },
    tests: [
      { kind: 'long', passed: true, result: 'Completed without error', hours: 40500 },
      { kind: 'short', passed: true, result: 'Completed without error', hours: 40012 },
      { kind: 'long', passed: false, result: 'Completed: read failure', hours: 39000 },
    ],
    supported: null,
  });
  assert.equal(longTestDue(ata), false, 'one is running');
  delete ata.ata_smart_data;
  assert.equal(longTestDue(ata), true, '41234 − 40500 = 734 h since the last long test');
  ata.power_on_time.hours = 41000;
  assert.equal(longTestDue(ata), false, '500 h: not yet');
  const nvme = JSON.parse(fx('smartctl-nvme-selftest.json'));
  assert.deepEqual(parseSelfTests(nvme), {
    running: null,
    tests: [{ kind: 'short', passed: true, result: 'Completed without error', hours: 8990 }],
    supported: true,
  });
  assert.equal(longTestDue(nvme), true, 'never had a long one');
  assert.deepEqual(parseSelfTests({}), { running: null, tests: [], supported: null });
  assert.equal(longTestDue({}), true);
});

test('self-test support: ATA capabilities; an NVMe drive without the command gets no self-test log; never due when unsupported', () => {
  const nvme = JSON.parse(fx('smartctl-nvme-selftest.json'));
  delete nvme.nvme_self_test_log;
  assert.equal(selfTestSupported(nvme), false, 'asked -l selftest, got no log: the controller cannot');
  assert.equal(longTestDue(nvme), false, 'the Kingston OS disk case: skipped, not failed every tick');
  const ata = JSON.parse(fx('smartctl-ata-selftest.json'));
  delete ata.ata_smart_data.self_test.status;
  ata.ata_smart_data.capabilities = { self_tests_supported: false };
  assert.equal(selfTestSupported(ata), false);
  assert.equal(longTestDue(ata), false);
  ata.ata_smart_data.capabilities.self_tests_supported = true;
  assert.equal(longTestDue(ata), true);
});

test('standby: smartctl -n standby says so in its messages', () => {
  const asleep = { smartctl: { exit_status: 2, messages: [{ string: 'Device is in STANDBY mode, exit(2)', severity: 'information' }] } };
  assert.equal(inStandby(asleep), true);
  assert.equal(inStandby({ smartctl: { messages: [{ string: 'Device is in STANDBY (OS) mode, exit(2)' }] } }), true);
  assert.equal(inStandby({ smartctl: { messages: [{ string: 'Smartctl open device: /dev/sdb failed: No such device' }] } }), false);
  assert.equal(inStandby({}), false);
});
