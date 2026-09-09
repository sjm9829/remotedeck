import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store.js';
import { FakeTransport } from '../session/transport.js';
import { RingBuffer } from '../session/ringbuffer.js';
import { TicketStore } from '../ticket.js';
import { SessionManager, type Attachment } from '../session/manager.js';

const MK = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
    mgr.input('w', 'ls\r');
    assert.deepEqual(transport.shells.get('h:22:u')!.writes, ['ls\r']);
    mgr.resize('w', 40, 120);
    assert.deepEqual(transport.shells.get('h:22:u')!.resizes, [{ rows: 40, cols: 120 }]);
    const v = fakeAttachment('v', 'viewer'); mgr.attach(sid, v.att);
    assert.throws(() => mgr.input('v', 'x'), (e: any) => e.code === 'forbidden'); // viewer cannot write
    assert.throws(() => mgr.attach(sid, fakeAttachment('w2', 'writer').att), (e: any) => e.code === 'conflict'); // single writer lease
    mgr.transferWriter(sid, 'w', 'v');
    assert.equal(mgr.writerOf(sid), 'v');
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
    assert.ok(w.inbox.some((m) => m.type === 'output' && m.data === 'hello'));
    assert.ok(v.inbox.some((m) => m.type === 'output' && m.data === 'hello'));
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
    assert.ok(wa.inbox.some((m) => m.data === 'A'));
    assert.ok(!wb.inbox.some((m) => m.data === 'A'), 'session b must not receive session a output');
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
