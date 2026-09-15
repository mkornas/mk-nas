/** The tunnel: the token, the one .env line, what cloudflared's log and readiness say, and a secret that never leaves. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner } from '../src/run.ts';
import { handle } from '../src/server.ts';
import { parseTunnelLog, readToken, tokenOf, withToken } from '../src/tunnel.ts';
import type { Deps } from '../src/verbs.ts';
import { Db } from '../src/db.ts';

const TUNNEL_ID = '11111111-2222-3333-4444-555555555555';
const TOKEN = Buffer.from(
  JSON.stringify({ a: '0123456789abcdef0123456789abcdef', t: TUNNEL_ID, s: 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3JldA==' }),
).toString('base64');

test('token: the string after --token, decoded for its tunnel id; anything else is refused', () => {
  assert.deepEqual(tokenOf(TOKEN), { token: TOKEN, tunnelId: TUNNEL_ID });
  assert.equal(tokenOf(`  docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${TOKEN} `).token, TOKEN, 'the whole command pasted');
  for (const bad of ['', 'abc', 'x'.repeat(60), `${TOKEN}; rm -rf /`, Buffer.from('{"a":"x","s":"y","t":"not-a-uuid"}').toString('base64'), 42])
    assert.throws(() => tokenOf(bad), /not a tunnel token|paste/);
});

test('.env: only the token line changes; the last line wins as stack-up.sh reads it', () => {
  const env = 'DRIVE_UID=1000\n# a comment\nCLOUDFLARE_TUNNEL_TOKEN=old\nDRIVE_OIDC_NAME="Home ID"\n';
  assert.equal(readToken(env), 'old');
  assert.equal(readToken('CLOUDFLARE_TUNNEL_TOKEN = "a"\nCLOUDFLARE_TUNNEL_TOKEN=\n'), null, 'an emptied last line is off');
  assert.equal(withToken(env, 'new'), 'DRIVE_UID=1000\n# a comment\nDRIVE_OIDC_NAME="Home ID"\nCLOUDFLARE_TUNNEL_TOKEN=new\n');
  assert.equal(withToken(env, null), 'DRIVE_UID=1000\n# a comment\nDRIVE_OIDC_NAME="Home ID"\n');
  assert.equal(withToken('', 'x'), 'CLOUDFLARE_TUNNEL_TOKEN=x\n');
});

test('log: hostnames from the newest configuration, the last connection, the last error, never a line with the token', () => {
  const log = [
    '2026-09-15T11:29:28Z INF Starting tunnel tunnelID=11111111-2222-3333-4444-555555555555',
    '2026-09-15T11:29:28Z ERR Register tunnel error from server side error="Failed to get tunnel" connIndex=0 event=0 ip=198.41.200.23',
    '2026-09-15T11:30:01Z INF Registered tunnel connection connIndex=0 connection=abc event=0 ip=198.41.200.23 location=waw01 protocol=quic',
    '2026-09-15T11:30:02Z INF Updated to new configuration config="{\\"ingress\\":[{\\"hostname\\":\\"old.example.com\\", \\"service\\":\\"http://localhost:8810\\"}, {\\"service\\":\\"http_status:404\\"}]}" version=1',
    '2026-09-15T11:31:02Z INF Updated to new configuration config="{\\"ingress\\":[{\\"hostname\\":\\"drive.example.com\\", \\"service\\":\\"http://localhost:8810\\"}, {\\"hostname\\":\\"photos.example.com\\", \\"service\\":\\"http://localhost:8810\\"}, {\\"service\\":\\"http_status:404\\"}]}" version=2',
    `2026-09-15T11:32:00Z ERR something echoed the token ${TOKEN}`,
  ].join('\n');
  assert.deepEqual(parseTunnelLog(log, TOKEN), {
    hostnames: ['drive.example.com', 'photos.example.com'],
    lastConnectedAt: '2026-09-15T11:30:01Z',
    lastError: '2026-09-15 11:29 Register tunnel error from server side error="Failed to get tunnel"',
  });
});

test('verbs: set writes the line root-only and brings the stack up; status reads container, readiness and log; the audit never sees the token; remove takes it out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-nas-tunnel-'));
  const envFile = join(dir, '.env');
  await writeFile(envFile, 'DRIVE_UID=1000\n', { mode: 0o600 });
  let running = false;
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    if (argv[0] === '/opt/stack-up.sh') {
      running = readToken(await readFile(envFile, 'utf8')) !== null;
      return { argv, exitCode: 0, stdout: '', stderr: '' };
    }
    if (argv[1] === 'inspect')
      return running
        ? { argv, exitCode: 0, stdout: `{"Status":"running","Running":true,"StartedAt":"2026-09-15T11:00:00.1Z"}|2\n`, stderr: '' }
        : { argv, exitCode: 1, stdout: '', stderr: 'Error: No such object' };
    if (argv[1] === 'logs') return { argv, exitCode: 0, stdout: '', stderr: '2026-09-15T11:00:05Z INF Registered tunnel connection connIndex=0\n' };
    return { argv, exitCode: 1, stdout: '', stderr: 'fake' };
  };
  const fetchFn = (async () => new Response(JSON.stringify({ status: 200, readyConnections: 4 }))) as unknown as typeof fetch;
  const audits: Record<string, unknown>[] = [];
  const deps = {
    run,
    version: 't',
    db: new Db(':memory:'),
    locationsDir: '',
    shares: {} as Deps['shares'],
    replication: {} as Deps['replication'],
    spawn: () => {},
    network: {} as Deps['network'],
    backup: {} as Deps['backup'],
    fetch: fetchFn,
    tunnel: { envFile, stackUp: '/opt/stack-up.sh', container: 'mk-drive-tunnel', readyUrl: 'http://127.0.0.1:20241/ready' },
  } as Deps;
  const call = (verb: string, args?: Record<string, unknown>) =>
    handle({ id: 1, verb: verb as never, args }, deps, async (l) => void audits.push(l as unknown as Record<string, unknown>));
  try {
    let res = await call('tunnel');
    assert.equal(res.ok && (res.result as { state: string }).state, 'off');
    res = await call('tunnel.set', { token: 'nope' });
    assert.equal(!res.ok && res.error.code, 'bad-args');
    assert.ok(!calls.some((c) => c[0] === '/opt/stack-up.sh'), 'nothing written or started for a bad token');

    res = await call('tunnel.set', { token: TOKEN });
    assert.equal(res.ok, true, JSON.stringify(res));
    const t = res.ok ? (res.result as Record<string, unknown>) : {};
    assert.deepEqual(
      [t.configured, t.tunnelId, t.state, t.connections, t.restarts, t.lastConnectedAt],
      [true, TUNNEL_ID, 'connected', 4, 2, '2026-09-15T11:00:05Z'],
    );
    assert.ok(!JSON.stringify(t).includes(TOKEN), 'the token is not in the answer');
    assert.equal(await readFile(envFile, 'utf8'), `DRIVE_UID=1000\nCLOUDFLARE_TUNNEL_TOKEN=${TOKEN}\n`);
    assert.equal((await stat(envFile)).mode & 0o777, 0o600, 'root-only');
    assert.ok(!JSON.stringify(audits).includes(TOKEN), 'the token is not in the audit log');
    assert.ok(audits.some((a) => a.verb === 'tunnel.set' && (a.args as { token: string }).token === '[redacted]'));

    res = await call('tunnel.remove');
    assert.equal(res.ok && (res.result as { state: string }).state, 'off');
    assert.equal(await readFile(envFile, 'utf8'), 'DRIVE_UID=1000\n');
    res = await call('tunnel.remove');
    assert.match(!res.ok ? res.error.message : '', /no tunnel/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
