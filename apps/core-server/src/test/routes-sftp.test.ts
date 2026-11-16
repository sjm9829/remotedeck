// SFTP REST error-mapping tests: verify the corrected stable 403/404/409 mapping
// for representative SFTP file operations, end-to-end through the HTTP layer
// (createApp + fastify inject) using the in-memory FakeSftpTransport.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { resolveConfig, MIN_API_TOKEN_LENGTH } from '../config.js';
import { createApp, type AppHandle } from '../app.js';
import { MemoryStore } from '@remotedeck/core/store';
import { FakeTransport } from '@remotedeck/core/session/transport';
import { FakeSftpTransport } from '@remotedeck/core/session/sftp-transport';

const MK = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const VALID_TOKEN = 'a'.repeat(MIN_API_TOKEN_LENGTH + 8);
const AUTH = { authorization: `Bearer ${VALID_TOKEN}` };
const FP = 'SHA256:FakeFingerprint';

interface Ctx { app: FastifyInstance; close: () => Promise<void>; transport: FakeSftpTransport; store: MemoryStore; hostId: string; sessionId: string; }

async function build(): Promise<Ctx> {
  const store = new MemoryStore(MK);
  const transport = new FakeSftpTransport({ fingerprint: FP });
  const config = resolveConfig({ REMOTEDECK_MASTER_KEY: MK, REMOTEDECK_API_TOKEN: VALID_TOKEN });
  const handle: AppHandle = createApp({ store, transport: new FakeTransport(), sftpTransport: transport, config }, { logger: false });
  await handle.app.ready();
  const cred = store.createCredential({ name: 'pw', type: 'password', secret: 'pw', keyPath: null });
  const host = store.createHost({
    name: 'sftp-host', hostname: '127.0.0.1', port: 22, username: 'test',
    credentialId: cred.id, tags: [], hostKeyFingerprint: FP, hostKeyTrusted: true,
  });
  // Seed a file so the overwrite (409) case has an existing destination.
  transport.fs.set('/root/a.txt', { type: 'file', data: Buffer.from('x'), target: '' });
  // Create a ready session.
  const created = await handle.sftpManager.create({ hostId: host.id, rootPath: '/root' });
  assert.equal(created.requiresTrust, false, 'expected a ready session');
  assert.equal(created.session.status, 'ready');
  return { app: handle.app, close: () => handle.app.close(), transport, store, hostId: host.id, sessionId: created.session.id };
}

describe('sftp REST error mapping (403 / 404 / 409)', () => {
  let ctx: Ctx;
  before(async () => { ctx = await build(); });
  after(async () => { await ctx.close(); });

  it('stat of a path escaping the root returns 403 (outside_root)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/sftp/sessions/${ctx.sessionId}/stat?path=..%2Foutside`, headers: AUTH });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'outside_root');
  });

  it('stat of a missing path returns 404 (no_such_file)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/sftp/sessions/${ctx.sessionId}/stat?path=does-not-exist`, headers: AUTH });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'no_such_file');
  });

  it('list of a missing directory returns 404 (no_such_file)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/sftp/sessions/${ctx.sessionId}/list?path=no-such-dir`, headers: AUTH });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'no_such_file');
  });

  it('upload over an existing path without overwrite returns 409 (exists)', async () => {
    const res = await ctx.app.inject({
      method: 'PUT', url: `/api/sftp/sessions/${ctx.sessionId}/upload?path=a.txt`,
      headers: { ...AUTH, 'content-type': 'text/plain' }, payload: 'overwrite-attempt',
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'exists');
    // Content is unchanged.
    const st = await ctx.app.inject({ method: 'GET', url: `/api/sftp/sessions/${ctx.sessionId}/stat?path=a.txt`, headers: AUTH });
    assert.equal(st.statusCode, 200);
    assert.equal(st.json().stat.size, 1);
  });

  it('upload with overwrite=true succeeds (200) and the destination remains a file', async () => {
    // Note: fastify's inject (light-my-request) does not stream the body into
    // req.raw, so the written byte count is not asserted here (upload content is
    // covered by the real-fixture sftp-transport tests). This asserts the HTTP
    // contract: overwrite=true yields 200 and the destination is a file.
    const res = await ctx.app.inject({
      method: 'PUT', url: `/api/sftp/sessions/${ctx.sessionId}/upload?path=a.txt&overwrite=true`,
      headers: { ...AUTH, 'content-type': 'text/plain' }, payload: 'brand-new',
    });
    assert.equal(res.statusCode, 200);
    const st = await ctx.app.inject({ method: 'GET', url: `/api/sftp/sessions/${ctx.sessionId}/stat?path=a.txt`, headers: AUTH });
    assert.equal(st.statusCode, 200);
    assert.equal(st.json().stat.type, 'file');
  });

  it('unauthenticated SFTP operation returns 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/sftp/sessions/${ctx.sessionId}/stat?path=a.txt` });
    assert.equal(res.statusCode, 401);
  });
});

describe('sftp upload over real HTTP (body reaches the file whatever its Content-Type)', () => {
  let ctx: Ctx; let base = '';
  before(async () => { ctx = await build(); base = await ctx.app.listen({ port: 0, host: '127.0.0.1' }); });
  after(async () => { await ctx.close(); });

  for (const type of ['image/png', 'text/plain', 'application/json', 'application/octet-stream', '']) {
    it(`uploads a body sent as ${type || '(no content-type)'}`, async () => {
      const name = `up-${type.replace(/\W/g, '') || 'none'}.bin`;
      const body = Buffer.from(type === 'application/json' ? '{"a":1}' : `payload for ${type}`);
      const res = await fetch(`${base}/api/sftp/sessions/${ctx.sessionId}/upload?path=${name}`, {
        method: 'PUT', headers: { ...AUTH, ...(type ? { 'content-type': type } : {}) }, body,
      });
      assert.equal(res.status, 200, await res.text());
      const stored = ctx.transport.fs.get(`/root/${name}`);
      assert.ok(stored, 'file must exist');
      assert.deepEqual(Buffer.from(stored!.data), body, 'the whole body must be written');
    });
  }

  it('still requires authentication', async () => {
    const res = await fetch(`${base}/api/sftp/sessions/${ctx.sessionId}/upload?path=nope.bin`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.from('x') });
    assert.equal(res.status, 401);
    assert.equal(ctx.transport.fs.has('/root/nope.bin'), false);
  });

  it('JSON routes still parse JSON after the upload scope was added', async () => {
    // A parsed body reaches path validation (403 outside_root); an unparsed one would be 400 "path is required".
    const res = await fetch(`${base}/api/sftp/sessions/${ctx.sessionId}/mkdir`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ path: '../escape' }) });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as any).error.code, 'outside_root');
  });
});
