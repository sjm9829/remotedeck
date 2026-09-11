// REST -> SSH -> WebSocket terminal roundtrip test. Exercises the real boundary:
// a real in-process ssh2 loopback server, real Fastify REST, the real WS upgrade
// path (single-use ticket via Sec-WebSocket-Protocol), and the real Ssh2Transport
// shell. Covers host/credential creation, fingerprint observation, explicit trust,
// session creation, WS ticket, writer attach, shell input/output, resize, detach
// (SSH connection survives), re-attach with scrollback replay, and session close.
// No external server or operational credential is used.
// Wire shape: every server->client message follows the public protocol
// contract {type, ts (ISO-8601), data} — output/scrollback carry
// data:{data:string}, status carries data:{status, message?}, matching
// @remotedeck/protocol (WsOutputMessage / WsScrollbackMessage / WsStatusMessage).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { WS_SUBPROTOCOL_PREFIX } from '@remotedeck/protocol';
import { startSshFixture, startAppHarness, rest, PW_USER, PW } from './ssh-fixture.js';
import type { SshFixture, AppHarness } from './ssh-fixture.js';

let fixture: SshFixture;
let harness: AppHarness;

const MSG_TIMEOUT_MS = 10_000;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function assertWireTs(msg: any, what: string): void {
  assert.equal(typeof msg.ts, 'string', `${what}: ts must be a string on the wire`);
  assert.match(msg.ts, ISO_TS, `${what}: ts must be ISO-8601`);
  assert.ok(!Number.isNaN(Date.parse(msg.ts)), `${what}: ts must parse`);
}

before(async () => {
  fixture = await startSshFixture();
  harness = await startAppHarness();
  harness.handle.attachWebSocketServer(); // register the real WS upgrade handler
});
after(async () => {
  await harness.close();
  await fixture.stop();
});

type Pred = (m: any) => boolean;
interface Waiter { pred: Pred; resolve: (m: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; }

// Client helper that buffers server messages from construction time: the 101
// response and the first frame can arrive in one TCP segment, so a listener
// attached only after the 'open' await would race and drop early messages.
class WsTerm {
  readonly ws: WebSocket;
  private pending: any[] = [];
  private waiters: Waiter[] = [];
  private dead: Error | null = null;
  constructor(sessionId: string, ticket: string) {
    const url = `ws://127.0.0.1:${harness.port}/ws/sessions/${sessionId}`;
    this.ws = new WebSocket(url, [WS_SUBPROTOCOL_PREFIX + ticket]);
    this.ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let m: any; try { m = JSON.parse((raw as Buffer).toString()); } catch { return; }
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(m);
      } else {
        this.pending.push(m); // no waiter yet: keep for a later next()
      }
    });
    this.ws.on('error', (e: Error) => {
      this.dead = e;
      for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(e); }
    });
  }
  open(): Promise<void> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (e) => reject(e));
    });
  }
  send(o: unknown): void { this.ws.send(JSON.stringify(o)); }
  next(pred: Pred, what: string): Promise<any> {
    if (this.dead) return Promise.reject(this.dead);
    const hit = this.pending.findIndex(pred);
    if (hit >= 0) return Promise.resolve(this.pending.splice(hit, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timed out waiting for ${what}`));
      }, MSG_TIMEOUT_MS);
      const w: Waiter = { pred, resolve, reject, timer };
      this.waiters.push(w);
    });
  }
  closed(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === this.ws.CLOSED) return resolve();
      const t = setTimeout(() => reject(new Error('timed out waiting for ws close')), MSG_TIMEOUT_MS);
      this.ws.once('close', () => { clearTimeout(t); resolve(); });
    });
  }
}

async function wsTerm(sessionId: string, ticket: string): Promise<WsTerm> {
  const term = new WsTerm(sessionId, ticket);
  await term.open();
  return term;
}

test('REST -> SSH -> WS terminal roundtrip', async () => {
  // 1. credential + untrusted host (password auth against the fixture).
  const cred = await rest(harness, 'POST', '/api/credentials', { name: 'loopback-pw', type: 'password', secret: PW });
  assert.equal(cred.status, 201);
  const credId = cred.body.data.id;
  const host = await rest(harness, 'POST', '/api/hosts', {
    name: 'loopback', hostname: '127.0.0.1', port: fixture.port, user: PW_USER, credentialId: credId,
  });
  assert.equal(host.status, 201);
  const hostId = host.body.data.id;

  // 2. session creation observes the fingerprint over real KEX and waits for trust.
  const sess = await rest(harness, 'POST', '/api/sessions', { hostId, credentialId: credId });
  assert.equal(sess.status, 202);
  assert.equal(sess.body.data.requiresTrust, true);
  assert.equal(sess.body.data.fingerprint, fixture.hostFingerprint); // observed, not hardcoded
  const sessionId: string = sess.body.data.id;

  // 3. explicit trust connects the waiting session over the real SSH transport.
  const trust = await rest(harness, 'POST', `/api/hosts/${hostId}/trust`, { fingerprint: fixture.hostFingerprint });
  assert.equal(trust.status, 200);
  const active = await rest(harness, 'GET', `/api/sessions/${sessionId}`);
  assert.equal(active.status, 200);
  assert.equal(active.body.data.state, 'active');

  // 4. single-use WS ticket; the writer attaches through the real upgrade path.
  const tk = await rest(harness, 'POST', `/api/sessions/${sessionId}/ws-ticket`, { role: 'writer' });
  assert.equal(tk.status, 200);
  const ticket: string = tk.body.data.ticket;
  let term = await wsTerm(sessionId, ticket);
  const st = await term.next((m) => m.type === 'status', 'status');
  assertWireTs(st, 'status');
  assert.equal(st.data.status, 'active');
  assert.equal(typeof (st.data as any).message, 'undefined');

  // 5. shell input roundtrips through the real SSH shell.
  term.send({ type: 'input', data: { data: 'hello' } });
  const out = await term.next((m) => m.type === 'output' && typeof m.data?.data === 'string' && m.data.data.includes('ECHO:hello'), 'ECHO output');
  assertWireTs(out, 'output');
  assert.ok(out.data.data.startsWith('ECHO:hello'));

  // 6. resize reaches the SSH window-change path.
  term.send({ type: 'resize', data: { rows: 40, cols: 120 } });
  const rz = await term.next((m) => m.type === 'output' && typeof m.data?.data === 'string' && m.data.data.includes('RESIZE:40x120'), 'RESIZE output');
  assertWireTs(rz, 'output');
  assert.ok(rz.data.data.startsWith('RESIZE:40x120'));

  // 7. detach keeps the SSH connection alive (session -> detached).
  term.send({ type: 'detach', data: {} });
  await new Promise((r) => setTimeout(r, 200));
  const det = await rest(harness, 'GET', `/api/sessions/${sessionId}`);
  assert.equal(det.body.data.state, 'detached');
  term.ws.close(1000);
  await term.closed();

  // 8. re-attach with a fresh ticket: shell survived, scrollback replays.
  const tk2 = await rest(harness, 'POST', `/api/sessions/${sessionId}/ws-ticket`, { role: 'writer' });
  assert.equal(tk2.status, 200);
  term = await wsTerm(sessionId, tk2.body.data.ticket);
  const st2 = await term.next((m) => m.type === 'status', 're-attach status');
  assertWireTs(st2, 'status');
  assert.equal(st2.data.status, 'active');
  const sb = await term.next((m) => m.type === 'scrollback' && typeof m.data?.data === 'string' && m.data.data.includes('ECHO:hello'), 'scrollback');
  assertWireTs(sb, 'scrollback');
  assert.ok(sb.data.data.includes('RESIZE:40x120'));

  // 9. tickets are single-use: the redeemed ticket is rejected on a new upgrade.
  const stale = new WsTerm(sessionId, ticket);
  await assert.rejects(stale.open());

  // 10. closing the session tears the socket down.
  const cl = await rest(harness, 'POST', `/api/sessions/${sessionId}/close`);
  assert.equal(cl.status, 200);
  assert.equal(cl.body.data.state, 'closed');
  await term.closed();
});
