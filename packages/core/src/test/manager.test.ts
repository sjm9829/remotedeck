import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store.js';
import { FakeTransport } from '../session/transport.js';
import { RingBuffer } from '../session/ringbuffer.js';
import { TicketStore } from '../ticket.js';
import { SessionManager, type Attachment } from '../session/manager.js';

const MK = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Protocol contract: every server->client WS message carries an ISO-8601 ts.
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function assertWireTs(ts: unknown, what: string): void {
  assert.equal(typeof ts, 'string', `${what} ts must be a string`);
  const iso = ts as string;
  assert.match(iso, ISO_TS, `${what} ts must be ISO-8601`);
  assert.ok(!Number.isNaN(Date.parse(iso)), `${what} ts must parse`);
}
function fakeAttachment(id: string, role: 'writer' | 'viewer'): { att: Attachment; inbox: any[] } {
  const inbox: any[] = [];
  return { inbox, att: { id, role, send: (m) => inbox.push(m), close: () => {} } };
}

describe('session state machine (deterministic, fake transport)', () => {
  it('untrusted host: create returns awaiting-trust + observed fingerprint (no connect)', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    transport.setFingerprint({ host: 'h1', port: 22, username: 'u' }, 'SHA256:aaa');
    const host = store.createHost({ name: 'h1', hostname: 'h1', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: null, hostKeyTrusted: false });
    const res = await mgr.createSession({ hostId: host.id });
    assert.equal(res.requiresTrust, true);
    assert.equal(res.fingerprint, 'SHA256:aaa');
    assert.equal(res.session.state, 'awaiting-trust');
    assert.equal(transport.shells.size, 0, 'must not open a shell before trust');
    // explicit trust then connect
    await mgr.trustHost(host.id, 'SHA256:aaa');
    assert.equal(mgr.getState(res.session.id), 'active');
  });

  it('trusted host connects immediately to active', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    transport.setFingerprint({ host: 'h2', port: 22, username: 'u' }, 'SHA256:bbb');
    const host = store.createHost({ name: 'h2', hostname: 'h2', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:bbb', hostKeyTrusted: true });
    const res = await mgr.createSession({ hostId: host.id });
    assert.equal(res.requiresTrust, false);
    assert.equal(mgr.getState(res.session.id), 'active');
  });

  it('fingerprint mismatch rejects connect (fail closed)', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    transport.setFingerprint({ host: 'h3', port: 22, username: 'u' }, 'SHA256:aaa');
    const host = store.createHost({ name: 'h3', hostname: 'h3', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:WRONG', hostKeyTrusted: true });
    await assert.rejects(() => mgr.createSession({ hostId: host.id }), /fingerprint_mismatch/);
  });
});

describe('writer lease + viewers', () => {
  it('single writer; viewer cannot input; transfer works', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    transport.setFingerprint({ host: 'h', port: 22, username: 'u' }, 'SHA256:x');
    const host = store.createHost({ name: 'h', hostname: 'h', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:x', hostKeyTrusted: true });
    const sid = (await mgr.createSession({ hostId: host.id })).session.id;
    const w = fakeAttachment('w', 'writer'); mgr.attach(sid, w.att);
    assert.equal(mgr.writerOf(sid), 'w');
    assert.equal(store.getSession(sid)?.writerId, 'w', 'writer lease must be durable');
    mgr.input('w', 'ls\r');
    assert.deepEqual(transport.shells.get('h:22:u')!.writes, ['ls\r']);
    mgr.resize('w', 40, 120);
    assert.deepEqual(transport.shells.get('h:22:u')!.resizes, [{ rows: 40, cols: 120 }]);
    const v = fakeAttachment('v', 'viewer'); mgr.attach(sid, v.att);
    assert.throws(() => mgr.input('v', 'x'), (e: any) => e.code === 'forbidden'); // viewer cannot write
    assert.throws(() => mgr.attach(sid, fakeAttachment('w2', 'writer').att), (e: any) => e.code === 'conflict'); // single writer lease
    mgr.transferWriter(sid, 'w', 'v');
    assert.equal(mgr.writerOf(sid), 'v');
    assert.equal(store.getSession(sid)?.writerId, 'v', 'writer transfer must be durable');
    mgr.input('v', 'y');
    assert.deepEqual(transport.shells.get('h:22:u')!.writes, ['ls\r', 'y']);
  });

  it('output fans out to writer and viewers', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    transport.setFingerprint({ host: 'h', port: 22, username: 'u' }, 'SHA256:x');
    const host = store.createHost({ name: 'h', hostname: 'h', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:x', hostKeyTrusted: true });
    const sid = (await mgr.createSession({ hostId: host.id })).session.id;
    const w = fakeAttachment('w', 'writer'); mgr.attach(sid, w.att);
    const v = fakeAttachment('v', 'viewer'); mgr.attach(sid, v.att);
    transport.shells.get('h:22:u')!.emitOutput('hello');
    assert.ok(w.inbox.some((m) => m.type === 'output' && m.data?.data === 'hello'));
    assert.ok(v.inbox.some((m) => m.type === 'output' && m.data?.data === 'hello'));
  });
});

describe('detach / reattach / idle timeout / close', () => {
  it('writer detach keeps SSH alive; reattach returns active; idle timeout closes', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 150 });
    transport.setFingerprint({ host: 'h', port: 22, username: 'u' }, 'SHA256:x');
    const host = store.createHost({ name: 'h', hostname: 'h', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:x', hostKeyTrusted: true });
    const sid = (await mgr.createSession({ hostId: host.id })).session.id;
    const w = fakeAttachment('w', 'writer'); mgr.attach(sid, w.att);
    mgr.detach('w');
    assert.equal(mgr.getState(sid), 'detached');
    assert.equal(store.getSession(sid)?.writerId, null, 'detached writer lease must be cleared durably');
    assert.equal(transport.shells.get('h:22:u')!.closed, false, 'SSH kept alive while detached');
    // reattach
    const w2 = fakeAttachment('w2', 'writer'); mgr.attach(sid, w2.att);
    assert.equal(mgr.getState(sid), 'active');
    mgr.detach('w2');
    assert.equal(mgr.getState(sid), 'detached');
    await sleep(300);
    assert.equal(mgr.getState(sid), 'closed');
    assert.equal(transport.shells.get('h:22:u')!.closed, true);
  });

  it('explicit close transitions to closed and closes the shell', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    transport.setFingerprint({ host: 'h', port: 22, username: 'u' }, 'SHA256:x');
    const host = store.createHost({ name: 'h', hostname: 'h', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:x', hostKeyTrusted: true });
    const sid = (await mgr.createSession({ hostId: host.id })).session.id;
    await mgr.closeSession(sid);
    assert.equal(mgr.getState(sid), 'closed');
    assert.equal(transport.shells.get('h:22:u')!.closed, true);
    assert.ok(store.getSession(sid)?.closedAt);
  });

  it('restart recovery closes stale durable sessions without inventing live runtimes', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const oldManager = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    transport.setFingerprint({ host: 'h', port: 22, username: 'u' }, 'SHA256:x');
    const host = store.createHost({ name: 'h', hostname: 'h', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:x', hostKeyTrusted: true });
    const sid = (await oldManager.createSession({ hostId: host.id })).session.id;
    oldManager.attach(sid, fakeAttachment('writer-before-restart', 'writer').att);

    const restarted = new SessionManager({store, transport: new FakeTransport(), idleTimeoutMs: 5000, autoReconnect: false});
    const stale = await restarted.recover();

    assert.deepEqual(stale.map((session) => session.id), [sid]);
    assert.equal(store.getSession(sid)?.state, 'closed');
    assert.equal(store.getSession(sid)?.writerId, null);
    assert.ok(store.getSession(sid)?.closedAt);
    assert.equal(restarted.getState(sid), null);
    oldManager.dispose();
  });

  it('restart recovery with auto-reconnect reopens a stale trusted session to a detached runtime', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const oldManager = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    transport.setFingerprint({ host: 'h', port: 22, username: 'u' }, 'SHA256:x');
    const host = store.createHost({ name: 'h', hostname: 'h', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:x', hostKeyTrusted: true });
    const sid = (await oldManager.createSession({ hostId: host.id })).session.id;
    oldManager.attach(sid, fakeAttachment('writer-before-restart', 'writer').att);

    // Simulate a server restart: a new manager with a new transport (no runtimes), auto-reconnect ON (default).
    const restartedTransport = new FakeTransport();
    restartedTransport.setFingerprint({ host: 'h', port: 22, username: 'u' }, 'SHA256:x');
    const restarted = new SessionManager({ store, transport: restartedTransport, idleTimeoutMs: 5000 });
    const stale = await restarted.recover();

    assert.deepEqual(stale.map((s) => s.id), [sid], 'the active session should be reported as stale');
    assert.equal(restarted.getState(sid), 'detached', 'reconnected session is detached (a fresh shell, awaiting reattach)');
    assert.equal(store.getSession(sid)?.writerId, null, 'the dead writer lease must be cleared on reconnect');
    // A client can reattach by id and become the writer (active).
    const w = fakeAttachment('writer-after-restart', 'writer');
    restarted.attach(sid, w.att);
    assert.equal(restarted.getState(sid), 'active');
    oldManager.dispose();
    restarted.dispose();
  });

  it('restart recovery closes a stale session whose host is untrusted (cannot auto-reconnect)', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const oldManager = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    transport.setFingerprint({ host: 'h', port: 22, username: 'u' }, 'SHA256:x');
    const host = store.createHost({ name: 'h', hostname: 'h', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:x', hostKeyTrusted: true });
    const sid = (await oldManager.createSession({ hostId: host.id })).session.id;

    // Host key trust was revoked before the restart (e.g. host re-added untrusted).
    store.setHostTrust(host.id, 'SHA256:x');
    store.updateHost(host.id, { hostKeyTrusted: false });

    const restarted = new SessionManager({ store, transport: new FakeTransport(), idleTimeoutMs: 5000 });
    const stale = await restarted.recover();

    assert.deepEqual(stale.map((s) => s.id), [sid]);
    assert.equal(store.getSession(sid)?.state, 'closed', 'an untrusted host must not be auto-reconnected (fail closed)');
    assert.equal(restarted.getState(sid), null);
    oldManager.dispose();
    restarted.dispose();
  });
});

describe('multi-session isolation', () => {
  it('two sessions have independent buffers and shells', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    transport.setFingerprint({ host: 'a', port: 22, username: 'u' }, 'SHA256:a');
    transport.setFingerprint({ host: 'b', port: 22, username: 'u' }, 'SHA256:b');
    const ha = store.createHost({ name: 'a', hostname: 'a', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:a', hostKeyTrusted: true });
    const hb = store.createHost({ name: 'b', hostname: 'b', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:b', hostKeyTrusted: true });
    const sa = (await mgr.createSession({ hostId: ha.id })).session.id;
    const sb = (await mgr.createSession({ hostId: hb.id })).session.id;
    const wa = fakeAttachment('wa', 'writer'); mgr.attach(sa, wa.att);
    const wb = fakeAttachment('wb', 'writer'); mgr.attach(sb, wb.att);
    transport.shells.get('a:22:u')!.emitOutput('A');
    assert.ok(wa.inbox.some((m) => m.type === 'output' && m.data?.data === 'A'));
    assert.ok(!wb.inbox.some((m) => m.type === 'output' && m.data?.data === 'A'), 'session b must not receive session a output');
  });
});

describe('server->client WS wire contract (type, ISO ts, data shape)', () => {
  it('output, scrollback, status all follow the protocol contract', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    transport.setFingerprint({ host: 'h', port: 22, username: 'u' }, 'SHA256:x');
    const host = store.createHost({ name: 'h', hostname: 'h', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:x', hostKeyTrusted: true });
    const sid = (await mgr.createSession({ hostId: host.id })).session.id;
    const w = fakeAttachment('w', 'writer');
    mgr.attach(sid, w.att);

    // status on attach: {type:'status', ts, data:{status}}
    const st = w.inbox.find((m) => m.type === 'status');
    assert.ok(st, 'attach must send status');
    assertWireTs(st.ts, 'status');
    assert.deepEqual(st.data, { status: 'active' });

    // output: {type:'output', ts, data:{data:string}}
    transport.shells.get('h:22:u')!.emitOutput('hello');
    const out = w.inbox.find((m) => m.type === 'output');
    assert.ok(out, 'output must reach attachments');
    assertWireTs(out.ts, 'output');
    assert.deepEqual(out.data, { data: 'hello' });

    // scrollback replay + status on second attach
    const v = fakeAttachment('v', 'viewer');
    mgr.attach(sid, v.att);
    const st2 = v.inbox.find((m) => m.type === 'status');
    assert.ok(st2, 'second attach must send status');
    assertWireTs(st2.ts, 'status');
    assert.equal(st2.data.status, 'active');
    const sb = v.inbox.find((m) => m.type === 'scrollback');
    assert.ok(sb, 'scrollback replay must be sent');
    assertWireTs(sb.ts, 'scrollback');
    assert.equal(typeof sb.data.data, 'string');
    assert.ok(sb.data.data.includes('hello'), 'scrollback must carry buffered output');
  });

  it('status transitions broadcast the contract shape to live attachments', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    transport.setFingerprint({ host: 'h', port: 22, username: 'u' }, 'SHA256:x');
    const host = store.createHost({ name: 'h', hostname: 'h', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:x', hostKeyTrusted: true });
    const sid = (await mgr.createSession({ hostId: host.id })).session.id;
    const w = fakeAttachment('w', 'writer');
    mgr.attach(sid, w.att);
    const v = fakeAttachment('v', 'viewer');
    mgr.attach(sid, v.att);
    v.inbox.length = 0; // only observe transition broadcasts
    mgr.detach('w');
    const msgs = v.inbox.filter((m) => m.type === 'status');
    assert.ok(msgs.some((m) => m.data.status === 'detached'), 'detach must broadcast status to surviving attachments');
    for (const m of msgs) { assertWireTs(m.ts, 'status'); assert.equal(typeof m.data.status, 'string'); }
  });
});

describe('byte-limited scrollback ring buffer', () => {
  it('evicts oldest bytes beyond the limit', () => {
    const rb = new RingBuffer(64);
    for (let i = 0; i < 20; i++) rb.push('0123456789');
    assert.ok(rb.byteLength <= 64);
    assert.ok(rb.toString().endsWith('0123456789'));
  });
  it('single oversized chunk keeps only the tail', () => {
    const rb = new RingBuffer(8);
    rb.push('ABCDEFGHIJKLMNOP'); // 16 bytes
    assert.equal(rb.byteLength, 8);
    assert.equal(rb.toString(), 'IJKLMNOP');
  });
});

describe('single-use + expiring WS ticket', () => {
  it('redeem once, reject reuse, reject expired', () => {
    const t = new TicketStore(30000);
    const ok = t.issue('sess1', 'writer');
    assert.ok(t.redeem(ok.value), 'first redeem ok');
    assert.equal(t.redeem(ok.value), null, 'reuse rejected');
    const exp = t.issue('sess2', 'viewer', 0);
    assert.equal(t.redeem(exp.value), null, 'expired rejected');
    assert.equal(t.redeem('unknown'), null);
  });
});

describe('credential mapping + session failed transitions', () => {
  it('password credential maps to target.password (not privateKey)', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    const cred = store.createCredential({ name: 'pw', type: 'password', secret: 's3cret-pw', keyPath: null });
    transport.setFingerprint({ host: 'hp', port: 22, username: 'u' }, 'SHA256:fp');
    const host = store.createHost({ name: 'hp', hostname: 'hp', port: 22, username: 'u', credentialId: cred.id, tags: [], hostKeyFingerprint: 'SHA256:fp', hostKeyTrusted: true });
    const res = await mgr.createSession({ hostId: host.id });
    assert.equal(res.session.state, 'active');
    const t = transport.lastConnectTarget!;
    assert.equal(t.password, 's3cret-pw');
    assert.equal(t.privateKey, undefined);
  });

  it('key credential maps to target.privateKey (not password)', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    const cred = store.createCredential({ name: 'key', type: 'key', secret: 'PEMKEYDATA', keyPath: null });
    transport.setFingerprint({ host: 'hk', port: 22, username: 'u' }, 'SHA256:fp');
    const host = store.createHost({ name: 'hk', hostname: 'hk', port: 22, username: 'u', credentialId: cred.id, tags: [], hostKeyFingerprint: 'SHA256:fp', hostKeyTrusted: true });
    await mgr.createSession({ hostId: host.id });
    const t = transport.lastConnectTarget!;
    assert.equal(t.privateKey, 'PEMKEYDATA');
    assert.equal(t.password, undefined);
  });

  it('session-level credentialId overrides the host credential', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    const credA = store.createCredential({ name: 'a', type: 'password', secret: 'pwA', keyPath: null });
    const credB = store.createCredential({ name: 'b', type: 'password', secret: 'pwB', keyPath: null });
    transport.setFingerprint({ host: 'ho', port: 22, username: 'u' }, 'SHA256:fp');
    const host = store.createHost({ name: 'ho', hostname: 'ho', port: 22, username: 'u', credentialId: credA.id, tags: [], hostKeyFingerprint: 'SHA256:fp', hostKeyTrusted: true });
    await mgr.createSession({ hostId: host.id, credentialId: credB.id });
    assert.equal(transport.lastConnectTarget!.password, 'pwB', 'session credential must win over host default');
  });

  it('connect error -> session transitions to failed', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    transport.setFingerprint({ host: 'hf', port: 22, username: 'u' }, 'SHA256:fp');
    const host = store.createHost({ name: 'hf', hostname: 'hf', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:fp', hostKeyTrusted: true });
    transport.failConnect = true;
    await assert.rejects(() => mgr.createSession({ hostId: host.id }), /fake_connect_error/);
    const sid = store.listSessions()[0].id;
    assert.equal(mgr.getState(sid), 'failed');
    assert.equal(store.getSession(sid)!.state, 'failed');
  });

  it('observe error on untrusted host -> session transitions to failed', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 5000 });
    transport.setFingerprint({ host: 'ho2', port: 22, username: 'u' }, 'SHA256:fp');
    const host = store.createHost({ name: 'ho2', hostname: 'ho2', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: null, hostKeyTrusted: false });
    transport.failObserve = true;
    await assert.rejects(() => mgr.createSession({ hostId: host.id }), /fake_observe_error/);
    const sid = store.listSessions()[0].id;
    assert.equal(mgr.getState(sid), 'failed');
  });
});

describe('idleTimeoutMs = 0 (unlimited keep-alive)', () => {
  it('detached session is never idle-closed and keeps the SSH shell alive', async () => {
    const store = new MemoryStore(MK); const transport = new FakeTransport();
    const mgr = new SessionManager({ store, transport, idleTimeoutMs: 0 });
    transport.setFingerprint({ host: 'h', port: 22, username: 'u' }, 'SHA256:x');
    const host = store.createHost({ name: 'h', hostname: 'h', port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: 'SHA256:x', hostKeyTrusted: true });
    const sid = (await mgr.createSession({ hostId: host.id })).session.id;
    const w = fakeAttachment('w', 'writer'); mgr.attach(sid, w.att);
    mgr.detach('w');
    assert.equal(mgr.getState(sid), 'detached');
    await sleep(400);
    assert.equal(mgr.getState(sid), 'detached', 'must NOT close on idle when idleTimeoutMs <= 0');
    assert.equal(transport.shells.get('h:22:u')!.closed, false, 'SSH shell must stay alive indefinitely');
  });
});
