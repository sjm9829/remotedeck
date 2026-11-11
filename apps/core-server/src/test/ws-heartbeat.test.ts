// Unit test for the server-side WebSocket liveness check (no network, fake timers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startWsHeartbeat } from '../ws.js';

class FakeSocket extends EventEmitter {
  pings = 0; terminated = 0;
  ping(): void { this.pings++; }
  terminate(): void { this.terminated++; this.emit('close'); }
}

test('keeps a socket that answers pings and drops one that goes silent', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const live = new FakeSocket(); const dead = new FakeSocket();
  startWsHeartbeat(live, 100); startWsHeartbeat(dead, 100);
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(100); live.emit('pong'); }
  assert.equal(live.terminated, 0);
  assert.equal(live.pings, 4);
  // `dead` never answered: pinged once, terminated on the second tick, then left alone.
  assert.equal(dead.pings, 1);
  assert.equal(dead.terminated, 1);
  t.mock.timers.tick(1000);
  assert.equal(dead.pings, 1);
  assert.equal(dead.terminated, 1);
});

test('stops pinging after the socket closes', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const sock = new FakeSocket();
  startWsHeartbeat(sock, 100);
  t.mock.timers.tick(100);
  sock.emit('close');
  t.mock.timers.tick(1000);
  assert.equal(sock.pings, 1);
  assert.equal(sock.terminated, 0);
});

test('a throwing ping does not crash the timer', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const sock = new FakeSocket();
  sock.ping = () => { throw new Error('not writable'); };
  startWsHeartbeat(sock, 100);
  assert.doesNotThrow(() => t.mock.timers.tick(100));
  t.mock.timers.tick(100);
  assert.equal(sock.terminated, 1);
});
