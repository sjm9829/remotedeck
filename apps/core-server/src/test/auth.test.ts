import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { resolveConfig, MIN_API_TOKEN_LENGTH, type ResolvedConfig } from '../config.js';
import { constantTimeTokenEquals, extractBearer } from '../auth.js';
import { createApp, type AppHandle } from '../app.js';
import { MemoryStore } from '@remotedeck/core/store';
import { FakeTransport } from '@remotedeck/core/session/transport';
import { FakeSftpTransport } from '@remotedeck/core/session/sftp-transport';
import { WS_SUBPROTOCOL_PREFIX } from '@remotedeck/protocol';

const MK = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const VALID_TOKEN = 'a'.repeat(MIN_API_TOKEN_LENGTH + 8);

function buildDeps(config: ResolvedConfig) {
  return { store: new MemoryStore(MK), transport: new FakeTransport(), sftpTransport: new FakeSftpTransport(), config };
}
async function buildApp(config: ResolvedConfig): Promise<{ handle: AppHandle; close: () => Promise<void> }> {
  const handle = createApp(buildDeps(config), { logger: false });
  await handle.app.ready();
  return { handle, close: () => handle.app.close() };
}

describe('config fail-closed validation', () => {
  it('throws when master key is missing', () => { assert.throws(() => resolveConfig({ REMOTEDECK_API_TOKEN: VALID_TOKEN })); });
  it('throws when master key is not 64 hex', () => { assert.throws(() => resolveConfig({ REMOTEDECK_MASTER_KEY: 'deadbeef', REMOTEDECK_API_TOKEN: VALID_TOKEN })); });
  it('throws when api token is missing', () => { assert.throws(() => resolveConfig({ REMOTEDECK_MASTER_KEY: MK })); });
  it('throws when api token is too short', () => { assert.throws(() => resolveConfig({ REMOTEDECK_MASTER_KEY: MK, REMOTEDECK_API_TOKEN: 'short-token' })); });
  it('accepts a valid master key + token, default same-origin CORS', () => {
    const c = resolveConfig({ REMOTEDECK_MASTER_KEY: MK, REMOTEDECK_API_TOKEN: VALID_TOKEN });
    assert.equal(c.masterKey, MK); assert.equal(c.apiToken, VALID_TOKEN); assert.deepEqual(c.allowedOrigins, []);
  });
  it('parses explicit allowed origins list', () => {
    const c = resolveConfig({ REMOTEDECK_MASTER_KEY: MK, REMOTEDECK_API_TOKEN: VALID_TOKEN, REMOTEDECK_ALLOWED_ORIGINS: 'http://localhost:5173, https://deck.example.com' });
    assert.deepEqual(c.allowedOrigins, ['http://localhost:5173', 'https://deck.example.com']);
  });
  it('defaults listen host to loopback when unset', () => {
    const c = resolveConfig({ REMOTEDECK_MASTER_KEY: MK, REMOTEDECK_API_TOKEN: VALID_TOKEN });
    assert.equal(c.listenHost, '127.0.0.1');
  });
  it('treats empty/whitespace listen host as loopback default', () => {
    const c = resolveConfig({ REMOTEDECK_MASTER_KEY: MK, REMOTEDECK_API_TOKEN: VALID_TOKEN, REMOTEDECK_LISTEN_HOST: '   ' });
    assert.equal(c.listenHost, '127.0.0.1');
  });
  it('accepts an explicit loopback IPv4 listen host', () => {
    const c = resolveConfig({ REMOTEDECK_MASTER_KEY: MK, REMOTEDECK_API_TOKEN: VALID_TOKEN, REMOTEDECK_LISTEN_HOST: '127.0.0.1' });
    assert.equal(c.listenHost, '127.0.0.1');
  });
  it('accepts an explicit all-interfaces IPv4 listen host (Docker/compose)', () => {
    const c = resolveConfig({ REMOTEDECK_MASTER_KEY: MK, REMOTEDECK_API_TOKEN: VALID_TOKEN, REMOTEDECK_LISTEN_HOST: '0.0.0.0' });
    assert.equal(c.listenHost, '0.0.0.0');
  });
  it('accepts an explicit IPv6 listen host', () => {
    const c = resolveConfig({ REMOTEDECK_MASTER_KEY: MK, REMOTEDECK_API_TOKEN: VALID_TOKEN, REMOTEDECK_LISTEN_HOST: '::' });
    assert.equal(c.listenHost, '::');
  });
  it('rejects a hostname as listen host (fail closed)', () => {
    assert.throws(() => resolveConfig({ REMOTEDECK_MASTER_KEY: MK, REMOTEDECK_API_TOKEN: VALID_TOKEN, REMOTEDECK_LISTEN_HOST: 'localhost' }));
  });
  it('rejects a malformed listen host (fail closed)', () => {
    assert.throws(() => resolveConfig({ REMOTEDECK_MASTER_KEY: MK, REMOTEDECK_API_TOKEN: VALID_TOKEN, REMOTEDECK_LISTEN_HOST: '999.1.1.1' }));
  });
  it('rejects a listen host with an embedded port (fail closed)', () => {
    assert.throws(() => resolveConfig({ REMOTEDECK_MASTER_KEY: MK, REMOTEDECK_API_TOKEN: VALID_TOKEN, REMOTEDECK_LISTEN_HOST: '127.0.0.1:4100' }));
  });
});

describe('auth helpers', () => {
  it('extractBearer parses header', () => {
    assert.equal(extractBearer('Bearer abc123'), 'abc123');
    assert.equal(extractBearer('Basic xyz'), null);
    assert.equal(extractBearer(undefined), null);
  });
  it('constantTimeTokenEquals matches only equal tokens', () => {
    assert.equal(constantTimeTokenEquals('secret-token', 'secret-token'), true);
    assert.equal(constantTimeTokenEquals('secret-token', 'secret-tokeX'), false);
    assert.equal(constantTimeTokenEquals('short', 'short-but-longer'), false);
  });
});

describe('HTTP auth + validation + redaction + trust via inject', () => {
  let ctx: { handle: AppHandle; close: () => Promise<void> };
  let app: FastifyInstance;
  const auth = { authorization: `Bearer ${VALID_TOKEN}` };

  before(async () => { ctx = await buildApp(resolveConfig({ REMOTEDECK_MASTER_KEY: MK, REMOTEDECK_API_TOKEN: VALID_TOKEN })); app = ctx.handle.app; });
  after(async () => { await ctx.close(); });

  it('/healthz allowed without auth (200)', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.statusCode, 200); assert.equal(res.json().status, 'ok');
  });
  it('/api/status without auth is 401', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/status' })).statusCode, 401);
  });
  it('/api/status with wrong token is 401', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: 'Bearer wrong-token-value-xxxxxxxxxxxxxxxx' } })).statusCode, 401);
  });
  it('/api/status with correct token is 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status', headers: auth });
    assert.equal(res.statusCode, 200); assert.equal(res.json().status, 'ok');
  });

  it('creates host, rejects missing fields (400)', async () => {
    const ok = await app.inject({ method: 'POST', url: '/api/hosts', headers: auth, payload: { name: 'h', hostname: 'h.example', user: 'root' } });
    assert.equal(ok.statusCode, 201); assert.equal(ok.json().data.hostKeyTrusted, false);
    const bad = await app.inject({ method: 'POST', url: '/api/hosts', headers: auth, payload: { name: 'x' } });
    assert.equal(bad.statusCode, 400); assert.equal(bad.json().error.code, 'bad_request');
  });

  it('creates credential and never returns the secret', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/credentials', headers: auth, payload: { name: 'c1', type: 'password', secret: 'super-secret-value' } });
    assert.equal(res.statusCode, 201);
    const body = JSON.stringify(res.json());
    assert.ok(!body.includes('super-secret-value'), 'response leaked the secret');
    assert.equal(res.json().data.hasSecret, true);
    const badType = await app.inject({ method: 'POST', url: '/api/credentials', headers: auth, payload: { name: 'c2', type: 'bogus' } });
    assert.equal(badType.statusCode, 400);
  });

  it('rejects invalid fingerprint format (400)', async () => {
    const host = (await app.inject({ method: 'POST', url: '/api/hosts', headers: auth, payload: { name: 'h2', hostname: 'h2.example', user: 'root' } })).json().data;
    const bad = await app.inject({ method: 'POST', url: `/api/hosts/${host.id}/trust`, headers: auth, payload: { fingerprint: 'not-a-fingerprint' } });
    assert.equal(bad.statusCode, 400);
    const good = await app.inject({ method: 'POST', url: `/api/hosts/${host.id}/trust`, headers: auth, payload: { fingerprint: 'SHA256:abc123def456' } });
    assert.equal(good.statusCode, 200); assert.equal(good.json().data.hostKeyTrusted, true);
  });

  it('PATCH host: maps user→username, validates port, revokes trust on endpoint change', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/hosts', headers: auth,
      payload: { name: 'hp', hostname: 'hp.example', user: 'alice', port: 2222 } })).json().data;
    assert.equal(created.username, 'alice');
    assert.equal(created.port, 2222);
    // trust it first so we can observe the revocation
    await app.inject({ method: 'POST', url: `/api/hosts/${created.id}/trust`, headers: auth,
      payload: { fingerprint: 'SHA256:hpfp12345' } });
    const trusted = (await app.inject({ method: 'GET', url: `/api/hosts/${created.id}`, headers: auth })).json().data;
    assert.equal(trusted.hostKeyTrusted, true);

    // non-endpoint field update: user maps to username, trust preserved
    const patchUser = await app.inject({ method: 'PATCH', url: `/api/hosts/${created.id}`, headers: auth,
      payload: { user: 'bob' } });
    assert.equal(patchUser.statusCode, 200);
    assert.equal(patchUser.json().data.username, 'bob');
    assert.equal(patchUser.json().data.hostKeyTrusted, true, 'non-endpoint PATCH must not revoke trust');

    // endpoint change (port) reflects new port AND revokes trust + clears fingerprint
    const patchPort = await app.inject({ method: 'PATCH', url: `/api/hosts/${created.id}`, headers: auth,
      payload: { port: 3333 } });
    assert.equal(patchPort.statusCode, 200);
    assert.equal(patchPort.json().data.port, 3333);
    assert.equal(patchPort.json().data.hostKeyTrusted, false, 'endpoint change must revoke trust');
    assert.equal(patchPort.json().data.hostKeyFingerprint, null, 'endpoint change must clear fingerprint');

    // invalid port rejected
    const badPort = await app.inject({ method: 'PATCH', url: `/api/hosts/${created.id}`, headers: auth,
      payload: { port: 99999 } });
    assert.equal(badPort.statusCode, 400);
    assert.equal(badPort.json().error.code, 'bad_request');
  });

  it('issues a single-use ws-ticket via authenticated REST', async () => {
    const host = (await app.inject({ method: 'POST', url: '/api/hosts', headers: auth, payload: { name: 'h3', hostname: 'h3.example', user: 'root' } })).json().data;
    (ctx.handle.transport as FakeTransport).setFingerprint({ host: 'h3.example', port: 22, username: 'root' }, 'SHA256:cafe');
    await app.inject({ method: 'POST', url: `/api/hosts/${host.id}/trust`, headers: auth, payload: { fingerprint: 'SHA256:cafe' } });
    const s = await app.inject({ method: 'POST', url: '/api/sessions', headers: auth, payload: { hostId: host.id } });
    assert.equal(s.statusCode, 201);
    const ticketRes = await app.inject({ method: 'POST', url: `/api/sessions/${s.json().data.id}/ws-ticket`, headers: auth, payload: { role: 'writer' } });
    assert.equal(ticketRes.statusCode, 200);
    const t = ticketRes.json().data;
    assert.ok(t.ticket && t.role === 'writer');
    // single use: redeem through the internal store
    const ctx2 = ctx.handle.ticketStore.redeem(t.ticket);
    assert.ok(ctx2, 'first redeem should succeed');
    assert.equal(ctx.handle.ticketStore.redeem(t.ticket), null, 'ticket must be single-use');
  });

  it('unauthorized ws-ticket endpoint without token is 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sessions/x/ws-ticket', payload: { role: 'writer' } });
    assert.equal(res.statusCode, 401);
  });
});

describe('WebSocket auth via ticket subprotocol', () => {
  let ctx: { handle: AppHandle; close: () => Promise<void>; port: number };
  let sessionId: string;

  before(async () => {
    const handle = createApp(buildDeps(resolveConfig({ REMOTEDECK_MASTER_KEY: MK, REMOTEDECK_API_TOKEN: VALID_TOKEN })), { logger: false });
    handle.attachWebSocketServer();
    await handle.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = handle.app.server.address();
    ctx = { handle, port: typeof addr === 'object' && addr ? addr.port : 0, close: () => handle.app.close() };
    // Set up a trusted host + active session for the ticket flow.
    const store = handle.store as MemoryStore;
    const transport = handle.transport as FakeTransport;
    const host = store.createHost({ name: 'ws-h', hostname: 'ws.example', port: 22, username: 'root', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:aaa', hostKeyTrusted: true });
    transport.setFingerprint({ host: 'ws.example', port: 22, username: 'root' }, 'SHA256:aaa');
    const res = await handle.manager.createSession({ hostId: host.id });
    sessionId = res.session.id;
  });
  after(async () => { await ctx.close(); });

  function connect(ticket: string | null): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const protocols = ticket ? [WS_SUBPROTOCOL_PREFIX + ticket] : undefined;
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws/sessions/${sessionId}`, protocols);
      const timer = setTimeout(() => { ws.terminate(); resolve(null); }, 3000);
      ws.on('message', (d) => { clearTimeout(timer); try { const m = JSON.parse(d.toString()); ws.close(); resolve(m.type); } catch (e) { reject(e); } });
      ws.on('error', () => { clearTimeout(timer); resolve(null); });
      ws.on('close', () => { clearTimeout(timer); resolve(null); });
    });
  }

  it('accepts a valid ticket via subprotocol (status received)', async () => {
    const t = ctx.handle.ticketStore.issue(sessionId, 'writer');
    const msg = await connect(t.value);
    assert.equal(msg, 'status');
  });

  it('rejects a reused ticket', async () => {
    const t = ctx.handle.ticketStore.issue(sessionId, 'writer');
    assert.ok(ctx.handle.ticketStore.redeem(t.value)); // burn it
    const msg = await connect(t.value);
    assert.equal(msg, null, 'reused ticket must be rejected');
  });

  it('rejects an expired ticket', async () => {
    const t = ctx.handle.ticketStore.issue(sessionId, 'writer', 0); // already expired
    const msg = await connect(t.value);
    assert.equal(msg, null, 'expired ticket must be rejected');
  });

  it('rejects a connection with no ticket', async () => {
    const msg = await connect(null);
    assert.equal(msg, null, 'no ticket must be rejected');
  });
});
