import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { resolveConfig, MIN_API_TOKEN_LENGTH, type ResolvedConfig } from '../config.js';
import { constantTimeTokenEquals, extractBearer } from '../auth.js';
import { createApp } from '../app.js';
import type { Db } from '../dbtypes.js';

const VALID_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const VALID_TOKEN = 'a'.repeat(MIN_API_TOKEN_LENGTH + 8); // comfortably above the minimum

// Structural stub satisfying the Db interface used by the routes (avoids loading the
// better-sqlite3 native addon in this Fastify-inject test process).
function stubDb(): Db {
  return {
    prepare() {
      return {
        get: () => ({ total: 0, active: 0, detached: 0 }),
        all: () => [],
        run: () => ({ changes: 0 }),
      };
    },
  };
}

async function buildApp(config: ResolvedConfig): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const { app } = createApp(stubDb(), config, { logger: false });
  await app.ready();
  return { app, close: () => app.close() };
}

describe('config fail-closed validation', () => {
  it('throws when master key is missing', () => {
    assert.throws(() => resolveConfig({ REMOTEDECK_API_TOKEN: VALID_TOKEN }));
  });
  it('throws when master key is not 64 hex', () => {
    assert.throws(() => resolveConfig({ REMOTEDECK_MASTER_KEY: 'deadbeef', REMOTEDECK_API_TOKEN: VALID_TOKEN }));
  });
  it('throws when api token is missing', () => {
    assert.throws(() => resolveConfig({ REMOTEDECK_MASTER_KEY: VALID_MASTER_KEY }));
  });
  it('throws when api token is too short', () => {
    assert.throws(() =>
      resolveConfig({ REMOTEDECK_MASTER_KEY: VALID_MASTER_KEY, REMOTEDECK_API_TOKEN: 'short-token' }),
    );
  });
  it('accepts a valid master key + token, default same-origin CORS', () => {
    const c = resolveConfig({ REMOTEDECK_MASTER_KEY: VALID_MASTER_KEY, REMOTEDECK_API_TOKEN: VALID_TOKEN });
    assert.equal(c.masterKey, VALID_MASTER_KEY);
    assert.equal(c.apiToken, VALID_TOKEN);
    assert.deepEqual(c.allowedOrigins, []);
  });
  it('parses explicit allowed origins list', () => {
    const c = resolveConfig({
      REMOTEDECK_MASTER_KEY: VALID_MASTER_KEY,
      REMOTEDECK_API_TOKEN: VALID_TOKEN,
      REMOTEDECK_ALLOWED_ORIGINS: 'http://localhost:5173, https://deck.example.com',
    });
    assert.deepEqual(c.allowedOrigins, ['http://localhost:5173', 'https://deck.example.com']);
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

describe('HTTP auth via Fastify inject', () => {
  let ctx: { app: FastifyInstance; close: () => Promise<void> };

  before(async () => {
    ctx = await buildApp(resolveConfig({ REMOTEDECK_MASTER_KEY: VALID_MASTER_KEY, REMOTEDECK_API_TOKEN: VALID_TOKEN }));
  });
  after(async () => { await ctx.close(); });

  it('/healthz is allowed without auth (200)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'ok');
  });

  it('/api/status without auth is rejected (401)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/status' });
    assert.equal(res.statusCode, 401);
  });

  it('/api/status with wrong token is rejected (401)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { authorization: 'Bearer totally-wrong-token-value-xxxxxx' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('/api/status with correct token is accepted (200)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'ok');
  });
});

describe('WebSocket auth on upgrade', () => {
  let ctx: { app: FastifyInstance; close: () => Promise<void>; port: number };

  before(async () => {
    const cfg = resolveConfig({ REMOTEDECK_MASTER_KEY: VALID_MASTER_KEY, REMOTEDECK_API_TOKEN: VALID_TOKEN });
    const { app, attachWebSocketServer } = createApp(stubDb(), cfg, { logger: false });
    attachWebSocketServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    ctx = { app, port, close: () => app.close() };
  });
  after(async () => { await ctx.close(); });

  it('rejects a WebSocket upgrade without a token', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws/v1/sessions/x`);
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('ws handshake did not reject')); }, 4000);
      ws.on('open', () => { clearTimeout(timer); ws.close(); reject(new Error('ws opened without token')); });
      ws.on('error', () => { clearTimeout(timer); resolve(); });
      ws.on('close', () => { clearTimeout(timer); resolve(); });
    });
  });

  it('accepts a WebSocket upgrade with a valid token', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws/v1/sessions/x?token=${VALID_TOKEN}`);
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('no status message')); }, 4000);
      ws.on('message', (data) => {
        clearTimeout(timer);
        const msg = JSON.parse(data.toString());
        assert.equal(msg.type, 'status');
        ws.close();
        resolve();
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  });
});
