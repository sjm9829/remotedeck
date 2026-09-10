// REST -> SSH error-mapping tests. Verifies that the shared classifier preserves
// distinct, non-sensitive causes (fingerprint_mismatch, auth_failed, timeout,
// unreachable, not_supported) and that the session-creation / trust routes map them
// to consistent HTTP statuses (instead of squashing everything to 409 conflict),
// matching the SFTP contract.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mapConnectError } from '../ssh-errors.js';
import { SshFixture, startSshFixture, AppHarness, startAppHarness, rest, PW_USER, PW } from './ssh-fixture.js';

let fixture: SshFixture;
let harness: AppHarness;

before(async () => {
  fixture = await startSshFixture();
  harness = await startAppHarness();
});
after(async () => {
  await harness.close();
  await fixture.stop();
});

// ---- Unit: the classifier maps each raw cause to a stable code --------------
test('mapConnectError: fingerprint_mismatch (handshake / host-denied)', () => {
  const a = mapConnectError(Object.assign(new Error('Host denied (verification failed)'), { level: 'handshake' }));
  assert.equal(a.code, 'fingerprint_mismatch');
  const b = mapConnectError(new Error('host key mismatch'));
  assert.equal(b.code, 'fingerprint_mismatch');
  assert.ok(!/denied|verification/i.test(a.message)); // no sensitive detail leaked
});
test('mapConnectError: auth_failed (client-authentication)', () => {
  const e = mapConnectError(Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }));
  assert.equal(e.code, 'auth_failed');
});
test('mapConnectError: not_supported (no usable credential)', () => {
  const e = mapConnectError(Object.assign(new Error('no password or private key'), { code: 'not_supported' }));
  assert.equal(e.code, 'not_supported');
});
test('mapConnectError: timeout (ssh_connect_timeout / ETIMEDOUT)', () => {
  assert.equal(mapConnectError(new Error('ssh_connect_timeout')).code, 'timeout');
  assert.equal(mapConnectError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })).code, 'timeout');
});
test('mapConnectError: unreachable (default socket failure)', () => {
  assert.equal(mapConnectError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' })).code, 'unreachable');
});

// ---- REST: the routes surface the distinct codes (not a blanket 409) --------
// A closed port on loopback for the "unreachable" scenario.
async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}
// A TCP server that accepts connections but never speaks SSH (blackhole) for the
// "timeout" scenario.
async function blackholePort(): Promise<{ port: number; close: () => Promise<void> }> {
  // Track accepted sockets. If a client sends bytes before closing (ssh2 writes its
  // "SSH-2.0-ssh2js" ident string immediately after connect), the unread data stays
  // buffered in the paused server socket and its 'end' event is held until the data
  // is consumed. Without a consumer that never happens, so srv.close() would wait
  // for the socket forever. Destroying tracked sockets makes close() deterministic.
  const accepted = new Set<net.Socket>();
  const srv = net.createServer((s) => {
    accepted.add(s);
    s.on('close', () => accepted.delete(s));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return {
    port: (srv.address() as net.AddressInfo).port,
    close: async () => {
      for (const s of accepted) s.destroy();
      await new Promise<void>((r) => srv.close(() => r()));
    },
  };
}
// A valid-format fingerprint that is definitely different from `fp`.
function otherFingerprint(fp: string): string {
  const last = fp.endsWith('A') ? 'B' : 'A';
  return fp.slice(0, -1) + last;
}

test('POST /api/sessions maps a closed host port to 502 unreachable', async () => {
  const cred = (await rest(harness, 'POST', '/api/credentials', { name: 'e-unreach', type: 'password', secret: PW })).body.data;
  const port = await closedPort();
  const host = (await rest(harness, 'POST', '/api/hosts', { name: 'h-unreach', hostname: '127.0.0.1', port, user: PW_USER, credentialId: cred.id })).body.data;
  const r = await rest(harness, 'POST', '/api/sessions', { hostId: host.id });
  assert.equal(r.status, 502);
  assert.equal(r.body.error?.code, 'unreachable');
});

test('POST /api/sessions maps a trusted-but-wrong host key to 409 fingerprint_mismatch', async () => {
  const cred = (await rest(harness, 'POST', '/api/credentials', { name: 'e-fp', type: 'password', secret: PW })).body.data;
  const host = (await rest(harness, 'POST', '/api/hosts', { name: 'h-fp', hostname: '127.0.0.1', port: fixture.port, user: PW_USER, credentialId: cred.id })).body.data;
  // Trust the host with a valid-format but WRONG fingerprint (no session awaiting yet).
  const t = await rest(harness, 'POST', `/api/hosts/${host.id}/trust`, { fingerprint: otherFingerprint(fixture.hostFingerprint) });
  assert.equal(t.status, 200);
  const r = await rest(harness, 'POST', '/api/sessions', { hostId: host.id });
  assert.equal(r.status, 409);
  assert.equal(r.body.error?.code, 'fingerprint_mismatch');
});

test('POST /api/sessions maps a wrong password to 502 auth_failed', async () => {
  const wrong = (await rest(harness, 'POST', '/api/credentials', { name: 'e-auth', type: 'password', secret: 'wrong-pw' })).body.data;
  const host = (await rest(harness, 'POST', '/api/hosts', { name: 'h-auth', hostname: '127.0.0.1', port: fixture.port, user: PW_USER, credentialId: wrong.id })).body.data;
  // Observe succeeds (no auth in observe); the fingerprint is the real one.
  const s1 = await rest(harness, 'POST', '/api/sessions', { hostId: host.id });
  assert.equal(s1.status, 202);
  const fp = s1.body.data.fingerprint;
  assert.equal(fp, fixture.hostFingerprint);
  // Trusting with the correct fingerprint triggers a full connect, which fails auth.
  const t = await rest(harness, 'POST', `/api/hosts/${host.id}/trust`, { fingerprint: fp });
  assert.equal(t.status, 502);
  assert.equal(t.body.error?.code, 'auth_failed');
  // A subsequent session creation (host now trusted) also fails auth.
  const r = await rest(harness, 'POST', '/api/sessions', { hostId: host.id });
  assert.equal(r.status, 502);
  assert.equal(r.body.error?.code, 'auth_failed');
});

test('POST /api/sessions maps a missing credential to 400 not_supported', async () => {
  // No credentialId on the host -> observe still works, but connect has no credential.
  const host = (await rest(harness, 'POST', '/api/hosts', { name: 'h-nosup', hostname: '127.0.0.1', port: fixture.port, user: PW_USER })).body.data;
  const s1 = await rest(harness, 'POST', '/api/sessions', { hostId: host.id });
  assert.equal(s1.status, 202);
  const fp = s1.body.data.fingerprint;
  const t = await rest(harness, 'POST', `/api/hosts/${host.id}/trust`, { fingerprint: fp });
  assert.equal(t.status, 400);
  assert.equal(t.body.error?.code, 'not_supported');
  const r = await rest(harness, 'POST', '/api/sessions', { hostId: host.id });
  assert.equal(r.status, 400);
  assert.equal(r.body.error?.code, 'not_supported');
});

test('POST /api/sessions maps a stalled handshake to 502 timeout', async () => {
  const bh = await blackholePort();
  try {
    const cred = (await rest(harness, 'POST', '/api/credentials', { name: 'e-timeout', type: 'password', secret: PW })).body.data;
    const host = (await rest(harness, 'POST', '/api/hosts', { name: 'h-timeout', hostname: '127.0.0.1', port: bh.port, user: PW_USER, credentialId: cred.id })).body.data;
    const r = await rest(harness, 'POST', '/api/sessions', { hostId: host.id });
    assert.equal(r.status, 502);
    assert.equal(r.body.error?.code, 'timeout');
  } finally {
    await bh.close();
  }
});
