import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { connect } from 'node:net';
import { test } from 'node:test';
import ssh2 from 'ssh2';
import { startSftpFixture } from './sftp-fixture.js';

const hostKeyPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const fixture = () => startSftpFixture({
  hostKeyPem, hostKeyWire: Buffer.alloc(0), root: '/root',
  username: 'fixture-user', password: 'fixture-password',
});

test('fixture stop completes with no connections and is idempotent', { timeout: 5000 }, async () => {
  const server = await fixture();
  const first = server.stop();
  assert.strictEqual(server.stop(), first);
  await first;
  await server.stop();
});

test('fixture stop closes an authenticated live SSH client', { timeout: 5000 }, async (t) => {
  const server = await fixture();
  const client = new ssh2.Client();
  // Cleanup remains available when an assertion or readiness check fails.
  t.after(async () => { client.destroy(); await server.stop(); });
  const ready = once(client, 'ready');
  client.connect({ host: '127.0.0.1', port: server.port,
    username: 'fixture-user', password: 'fixture-password', readyTimeout: 2000 });
  await ready;
  const closed = once(client, 'close');
  await Promise.all([server.stop(), server.stop(), closed]);
  await server.stop();
});

test('fixture stop closes a TCP client stalled before SSH handshake', { timeout: 5000 }, async (t) => {
  const server = await fixture();
  const socket = connect(server.port, '127.0.0.1');
  t.after(async () => { socket.destroy(); await server.stop(); });
  await once(socket, 'connect');
  // Reading the SSH banner proves the server accepted this connection.
  await once(socket, 'data');
  const closed = once(socket, 'close');
  await Promise.all([server.stop(), closed]);
  await server.stop();
});
