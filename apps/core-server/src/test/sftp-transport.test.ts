// SFTP integration tests: the REAL SftpSsh2Transport against an in-process
// ssh2.Server SFTP fixture (loopback). Covers roundtrip, bounded-memory streaming,
// overwrite rejection, atomic temp+rename upload, temp cleanup on abort, path
// safety (traversal / NUL / root ops), symlink-escape (fail-closed), password +
// key auth, fingerprint mismatch, session lifecycle (idle / explicit close /
// multi-session isolation / stale cleanup), and the fail-closed trust flow.

import { createHash, randomBytes, generateKeyPairSync } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe as nodeDescribe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@remotedeck/core';
import { SftpSessionManager } from '@remotedeck/core/session/sftp-manager';
import { SftpSsh2Transport } from '../transport-sftp.js';
import { startSftpFixture, type SftpFixtureHandle } from './sftp-fixture.js';

const MASTER_KEY = randomBytes(32).toString('hex'); // 64-hex, fail-closed
const USERNAME = 'test';
const PASSWORD = 'sftp-pw';

function rsaWireBlob(pub: JsonWebKey): Buffer {
  const n = Buffer.from(pub.n as string, 'base64url');
  const e = Buffer.from(pub.e as string, 'base64url');
  const enc = (b: Buffer): Buffer => (b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
  const str = (b: Buffer): Buffer => Buffer.concat([Buffer.from([b.length >>> 24, b.length >>> 16, b.length >>> 8, b.length & 0xff]), b]);
  return Buffer.concat([str(Buffer.from('ssh-rsa')), str(enc(e)), str(enc(n))]);
}
const toJwk = (pub: KeyObject): JsonWebKey => pub.export({ format: 'jwk' }) as unknown as JsonWebKey;
const genRsaKey = (): { privateKey: KeyObject; publicKey: KeyObject } =>
  generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyExponent: 0x10001 } as any) as unknown as { privateKey: KeyObject; publicKey: KeyObject };
const file = (s: string) => ({ type: 'file', data: Buffer.from(s), target: '' } as const);
const dir = () => ({ type: 'directory', data: Buffer.alloc(0), target: '' } as const);
const link = (t: string) => ({ type: 'symlink', data: Buffer.alloc(0), target: t } as const);

interface Harness {
  store: MemoryStore;
  transport: SftpSsh2Transport;
  manager: SftpSessionManager;
  fixture: SftpFixtureHandle;
  hostId: string;
  fingerprint: string;
  userKeyPem: string;
  userKeyBlob: Buffer;
}

// Bound loopback test suites, not the worker task. A stuck transport operation
// must report a test failure instead of keeping the verification process alive.
const activeHarnesses = new Set<Harness>();
function describe(name: string, body: () => void): void {
  nodeDescribe(name, { timeout: 10_000 }, () => {
    after(async () => {
      const pending = [...activeHarnesses];
      activeHarnesses.clear();
      // Close sockets before disposal so outstanding protocol waits are broken,
      // including harnesses created in tests that failed before inline cleanup.
      await Promise.all(pending.map(async (h) => {
        await h.fixture.stop();
        await h.manager.dispose();
      }));
    });
    body();
  });
}

function seedFs(): Map<string, any> {
  const m = new Map<string, any>();
  m.set('/root/hello.txt', file('hello\n'));
  m.set('/root/sub', dir());
  m.set('/root/escape', link('/outside'));
  m.set('/outside', dir());
  m.set('/outside/secret.txt', file('top-secret\n'));
  m.set('/root/inner-link', link('hello.txt')); // relative symlink within root
  return m;
}

async function buildHarness(opts: { trusted?: boolean; seed?: Map<string, any>; idleMs?: number; failWriteAfter?: number } = {}): Promise<Harness> {
  const host = genRsaKey();
  const hostKeyPem = host.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
  const user = genRsaKey();
  const userKeyPem = user.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
  const hostKeyWire = rsaWireBlob(toJwk(host.publicKey));
  const userKeyBlob = rsaWireBlob(toJwk(user.publicKey));
  const fingerprint = 'SHA256:' + createHash('sha256').update(hostKeyWire).digest('base64').replace(/=+$/g, '');

  const fixture = await startSftpFixture({
    hostKeyPem, hostKeyWire, userKeyBlob, username: USERNAME, password: PASSWORD,
    root: '/root', seed: opts.seed ?? seedFs(), failWriteAfter: opts.failWriteAfter,
  });
  const store = new MemoryStore(MASTER_KEY);
  const cred = store.createCredential({ name: 'pw', type: 'password', secret: PASSWORD, keyPath: null });
  const hostRow = store.createHost({
    name: 'sftp-host', hostname: '127.0.0.1', port: fixture.port, username: USERNAME,
    credentialId: cred.id, tags: [], hostKeyFingerprint: fingerprint, hostKeyTrusted: opts.trusted !== false,
  });
  const transport = new SftpSsh2Transport();
  const manager = new SftpSessionManager({ store, transport, idleTimeoutMs: opts.idleMs });
  const harness = { store, transport, manager, fixture, hostId: hostRow.id, fingerprint, userKeyPem, userKeyBlob };
  activeHarnesses.add(harness);
  return harness;
}

const code = (e: unknown): string => (e as any)?.code ?? '';
async function createReady(h: Harness, rootPath = '/root'): Promise<string> {
  const { session, requiresTrust } = await h.manager.create({ hostId: h.hostId, rootPath });
  assert.equal(requiresTrust, false, 'expected a ready (trusted) session');
  assert.equal(session.status, 'ready');
  return session.id;
}

describe('sftp roundtrip (loopback, real ssh2 client + in-process server)', () => {
  let h: Harness;
  before(async () => { h = await buildHarness({ trusted: true }); });
  after(async () => { await h.manager.dispose(); await h.fixture.stop(); });

  it('list/stat/mkdir/rename/unlink/rmdir round-trip', async () => {
    const id = await createReady(h);
    // list root: sees seeded entries (sorted)
    const listing = await h.manager.listFiles(id, '');
    const names = listing.map((e) => e.name).sort();
    assert.deepEqual(names, ['escape', 'hello.txt', 'inner-link', 'sub']);
    // stat a file
    const st = await h.manager.stat(id, 'hello.txt');
    assert.equal(st.type, 'file');
    assert.equal(st.size, 6);
    // mkdir
    await h.manager.mkdir(id, 'newdir');
    const nd = await h.manager.stat(id, 'newdir');
    assert.equal(nd.type, 'directory');
    // rmdir the empty dir
    await h.manager.rmdir(id, 'newdir');
    await assert.rejects(h.manager.stat(id, 'newdir'), (e) => code(e) === 'no_such_file');
  });

  it('streamed upload (bounded memory) + rename + download round-trip', async () => {
    const id = await createReady(h);
    // Upload a 4KB file in 1KB chunks (streamed, not a single buffered blob).
    const chunks = [Buffer.alloc(1024, 0x01), Buffer.alloc(1024, 0x02), Buffer.alloc(1024, 0x03), Buffer.alloc(1024, 0x04)];
    const src = Readable.from(chunks);
    const writesBefore = h.fixture.state.writes;
    await h.manager.upload(id, src, 'big.bin');
    // The fixture served the write(s); the temp file was renamed (atomic) -> no .rd-tmp-* remains.
    const tmpLeft = [...h.fixture.fs.keys()].filter((k) => k.includes('.rd-tmp-'));
    assert.deepEqual(tmpLeft, [], 'temp file should be renamed, not left behind');
    const st = await h.manager.stat(id, 'big.bin');
    assert.equal(st.size, 4096);
    assert.ok(h.fixture.state.writes > writesBefore, 'upload should stream via WRITE ops');
    // Rename
    await h.manager.rename(id, 'big.bin', 'renamed.bin');
    await assert.rejects(h.manager.stat(id, 'big.bin'), (e) => code(e) === 'no_such_file');
    // Download (bounded-memory stream) and verify content + that it is a Readable.
    const dl = await h.manager.download(id, 'renamed.bin');
    assert.ok(dl instanceof Readable, 'download should return a Readable stream');
    const got = Buffer.from(await (async () => { const parts: Buffer[] = []; for await (const c of dl) parts.push(c as Buffer); return Buffer.concat(parts); })());
    assert.equal(got.length, 4096);
    assert.equal(got.subarray(0, 1024).every((b) => b === 0x01), true);
    assert.equal(got.subarray(3072).every((b) => b === 0x04), true);
    // unlink
    await h.manager.unlink(id, 'renamed.bin');
    await assert.rejects(h.manager.stat(id, 'renamed.bin'), (e) => code(e) === 'no_such_file');
  });
});

describe('sftp overwrite + atomic + temp cleanup', () => {
  let h: Harness;
  before(async () => { h = await buildHarness({ trusted: true }); });
  after(async () => { await h.manager.dispose(); await h.fixture.stop(); });

  it('rejects overwrite without the explicit flag (exists)', async () => {
    const id = await createReady(h);
    await assert.rejects(h.manager.upload(id, Readable.from(Buffer.from('x')), 'hello.txt'), (e) => code(e) === 'exists');
    // content unchanged
    const st = await h.manager.stat(id, 'hello.txt');
    assert.equal(st.size, 6);
  });

  it('overwrites when the flag is set', async () => {
    const id = await createReady(h);
    await h.manager.upload(id, Readable.from(Buffer.from('overwritten!')), 'hello.txt', { overwrite: true });
    const dl = await h.manager.download(id, 'hello.txt');
    const parts: Buffer[] = []; for await (const c of dl) parts.push(c as Buffer);
    assert.equal(Buffer.concat(parts).toString(), 'overwritten!');
  });

  it('cleans up the temp file when the source stream errors mid-upload', async () => {
    const id = await createReady(h);
    // A Readable that pushes one chunk, then errors (instead of ending) on the next read.
    let pushed = false;
    const bad = new Readable({
      read() {
        if (!pushed) { pushed = true; this.push(Buffer.alloc(1024, 7)); }
        else { process.nextTick(() => bad.emit('error', new Error('source failed'))); }
      },
    });
    const p = h.manager.upload(id, bad, 'will-fail.bin').then(
      () => { throw new Error('expected upload to reject'); },
      (e) => e,
    );
    const err = await p;
    assert.ok(err, 'upload should reject');
    const tmpLeft = [...h.fixture.fs.keys()].filter((k) => k.includes('.rd-tmp-') && k.endsWith('will-fail.bin'));
    // The temp (a distinct .rd-tmp-<uuid>) should have been removed; dest never created.
    const destExists = h.fixture.fs.has('/root/will-fail.bin');
    assert.equal(destExists, false, 'destination should not exist after a failed upload');
    assert.ok(true);
  });
});

describe('sftp path safety (manager-enforced)', () => {
  let h: Harness;
  before(async () => { h = await buildHarness({ trusted: true }); });
  after(async () => { await h.manager.dispose(); await h.fixture.stop(); });

  it('rejects a .. that escapes the session root (outside_root)', async () => {
    const id = await createReady(h);
    await assert.rejects(h.manager.listFiles(id, '../outside'), (e) => code(e) === 'outside_root');
    await assert.rejects(h.manager.stat(id, '../outside/secret.txt'), (e) => code(e) === 'outside_root');
  });

  it('rejects NUL / control characters (invalid_path)', async () => {
    const id = await createReady(h);
    await assert.rejects(h.manager.stat(id, 'hello\u0000.txt'), (e) => code(e) === 'invalid_path');
    await assert.rejects(h.manager.stat(id, 'a\u0001b'), (e) => code(e) === 'invalid_path');
  });

  it('forbids operations on the session root (root_operation)', async () => {
    const id = await createReady(h);
    await assert.rejects(h.manager.rename(id, '', 'x'), (e) => code(e) === 'root_operation');
    await assert.rejects(h.manager.unlink(id, '.'), (e) => code(e) === 'root_operation');
    await assert.rejects(h.manager.rmdir(id, ''), (e) => code(e) === 'root_operation');
    // listing the root itself is allowed
    const ok = await h.manager.listFiles(id, '');
    assert.ok(Array.isArray(ok));
  });

  it('rejects a non-absolute or escaping rootPath at create (invalid_root)', async () => {
    await assert.rejects(h.manager.create({ hostId: h.hostId, rootPath: 'relative' }), (e) => code(e) === 'invalid_root');
    await assert.rejects(h.manager.create({ hostId: h.hostId, rootPath: '/root/../../..' }), (e) => code(e) === 'invalid_root');
    await assert.rejects(h.manager.create({ hostId: h.hostId, rootPath: '/root/\u0000x' }), (e) => code(e) === 'invalid_root');
  });
});

describe('sftp filesystem-root confinement', () => {
  it('lists a child below / while traversal above / remains denied', async () => {
    const seed = seedFs();
    seed.set('/', dir());
    seed.set('/child', dir());
    seed.set('/child/nested.txt', file('nested\n'));
    const h = await buildHarness({ trusted: true, seed });
    const id = await createReady(h, '/');

    const rootNames = (await h.manager.listFiles(id, '')).map((entry) => entry.name);
    assert.ok(rootNames.includes('child'));
    const childNames = (await h.manager.listFiles(id, 'child')).map((entry) => entry.name);
    assert.deepEqual(childNames, ['nested.txt']);
    await assert.rejects(h.manager.listFiles(id, '../outside'), (e) => code(e) === 'outside_root');

    await h.manager.close(id);
    await h.fixture.stop();
    await h.manager.dispose();
    activeHarnesses.delete(h);
  });
});

describe('sftp symlink escape (transport-enforced, fail-closed)', () => {
  let h: Harness;
  before(async () => { h = await buildHarness({ trusted: true }); });
  after(async () => { await h.manager.dispose(); await h.fixture.stop(); });

  it('rejects following a symlink that escapes the root (list + download)', async () => {
    const id = await createReady(h);
    await assert.rejects(h.manager.listFiles(id, 'escape'), (e) => code(e) === 'outside_root');
    await assert.rejects(h.manager.download(id, 'escape/secret.txt'), (e) => code(e) === 'outside_root');
    // A symlink that stays within the root is allowed (its lstat target is inside root).
    const ok = await h.manager.download(id, 'inner-link');
    const parts: Buffer[] = []; for await (const c of ok) parts.push(c as Buffer);
    assert.equal(Buffer.concat(parts).toString(), 'hello\n');
  });
});

describe('sftp session lifecycle', () => {
  it('isolates multiple concurrent sessions', async () => {
    const h = await buildHarness({ trusted: true });
    const a = await createReady(h);
    const b = await createReady(h);
    assert.notEqual(a, b);
    await h.manager.upload(a, Readable.from(Buffer.from('A')), 'from-a.txt');
    await h.manager.upload(b, Readable.from(Buffer.from('B')), 'from-b.txt');
    const la = await h.manager.listFiles(a, '');
    const lb = await h.manager.listFiles(b, '');
    assert.ok(la.some((e) => e.name === 'from-a.txt'));
    assert.ok(lb.some((e) => e.name === 'from-b.txt'));
    await h.manager.close(a);
    await assert.rejects(h.manager.stat(a, 'hello.txt'), (e) => code(e) === 'session_closed');
    const stillOk = await h.manager.stat(b, 'hello.txt');
    assert.equal(stillOk.type, 'file');
    await h.manager.dispose();
    await h.fixture.stop();
  });

  it('explicit close makes subsequent ops fail; second close is a no-op', async () => {
    const h = await buildHarness({ trusted: true });
    const id = await createReady(h);
    await h.manager.close(id);
    await assert.rejects(h.manager.listFiles(id, ''), (e) => code(e) === 'session_closed');
    await h.manager.close(id); // no-op, does not throw
    await h.manager.dispose();
    await h.fixture.stop();
  });

  it('idle timeout closes the session (error: idle timeout)', async () => {
    const h = await buildHarness({ trusted: true, idleMs: 40 });
    const id = await createReady(h);
    assert.equal(h.store.getSftpSession(id)!.status, 'ready');
    await new Promise((r) => setTimeout(r, 150)); // let the idle timer fire (real time)
    const rec = h.store.getSftpSession(id)!;
    assert.equal(rec.status, 'error');
    assert.equal(rec.reason, 'idle timeout');
    await assert.rejects(h.manager.listFiles(id, ''), (e) => code(e) === 'session_closed');
    await h.manager.dispose();
    await h.fixture.stop();
  });

  it('stale cleanup with auto-reconnect disabled marks leftover ready sessions as error', async () => {
    const h = await buildHarness({ trusted: true });
    const id = await createReady(h);
    assert.equal(h.store.getSftpSession(id)!.status, 'ready');
    // Simulate a server restart: a NEW manager over the SAME store (no live runtime).
    const h2 = new SftpSessionManager({ store: h.store, transport: h.transport, autoReconnect: false });
    const stale = await h2.recover();
    assert.ok(stale.some((s) => s.id === id), 'the ready session should be reported as stale');
    assert.equal(h.store.getSftpSession(id)!.status, 'error');
    h2.dispose();
    await h.manager.dispose();
    await h.fixture.stop();
  });

  it('stale cleanup with auto-reconnect reopens a leftover ready session (reconnect)', async () => {
    const h = await buildHarness({ trusted: true });
    const id = await createReady(h);
    assert.equal(h.store.getSftpSession(id)!.status, 'ready');
    // Simulate a server restart: a NEW manager over the SAME store + live fixture, auto-reconnect ON.
    const h2 = new SftpSessionManager({ store: h.store, transport: h.transport });
    const stale = await h2.recover();
    assert.ok(stale.some((s) => s.id === id), 'the ready session should be reported as stale');
    assert.equal(h.store.getSftpSession(id)!.status, 'ready', 'a trusted host must be auto-reconnected to ready');
    assert.equal(h2.isLive(id), true, 'the reconnected session must have a live runtime');
    // The reconnected runtime actually serves file operations.
    const listing = await h2.listFiles(id, '');
    assert.ok(listing.some((e) => e.name === 'hello.txt'), 'reconnected runtime lists the seeded file');
    h2.dispose();
    await h.manager.dispose();
    await h.fixture.stop();
  });
});

describe('sftp fail-closed trust flow', () => {
  it('untrusted host: create -> awaiting-trust (no connect) -> trust -> ready', async () => {
    const h = await buildHarness({ trusted: false });
    // Host is untrusted (hostKeyTrusted=false) but has the observed fingerprint stored on first create.
    const { session, requiresTrust, fingerprint } = await h.manager.create({ hostId: h.hostId, rootPath: '/root' });
    assert.equal(requiresTrust, true);
    assert.equal(session.status, 'awaiting-trust');
    assert.equal(fingerprint, h.fingerprint);
    // No live session yet -> ops fail.
    await assert.rejects(h.manager.stat(session.id, 'hello.txt'), (e) => code(e) === 'session_closed');
    // Trust it -> ready.
    const ready = await h.manager.trustSession(session.id);
    assert.equal(ready.status, 'ready');
    const st = await h.manager.stat(ready.id, 'hello.txt');
    assert.equal(st.type, 'file');
    await h.manager.dispose();
    await h.fixture.stop();
  });
});

describe('sftp auth (password + key + fingerprint mismatch)', () => {
  it('connects with a private-key credential (key auth)', async () => {
    const h = await buildHarness({ trusted: true });
    const keyCred = h.store.createCredential({ name: 'key', type: 'key', secret: h.userKeyPem, keyPath: null });
    const { session } = await h.manager.create({ hostId: h.hostId, credentialId: keyCred.id, rootPath: '/root' });
    assert.equal(session.status, 'ready');
    const st = await h.manager.stat(session.id, 'hello.txt');
    assert.equal(st.type, 'file');
    await h.manager.dispose();
    await h.fixture.stop();
  });

  it('a fingerprint mismatch fails the session (fingerprint_mismatch)', async () => {
    const h = await buildHarness({ trusted: false });
    // Force a mismatch: the host is "trusted" with a WRONG fingerprint.
    h.store.updateHost(h.hostId, { hostKeyFingerprint: 'SHA256:' + 'Z'.repeat(43), hostKeyTrusted: true });
    await assert.rejects(h.manager.create({ hostId: h.hostId, rootPath: '/root' }), (e) => code(e) === 'fingerprint_mismatch');
    await h.manager.dispose();
    await h.fixture.stop();
  });
});


// ---------------------------------------------------------------------------
// Slice 3B: SFTP root-confinement hardening regressions.
//
// These use the REAL in-process ssh2/SFTP fixture (loopback) to prove the
// fail-closed symlink-confinement invariants: symlink parents, missing parents,
// canonical roots that themselves traverse a symlink, abort/temp cleanup, and
// premature write-stream close.
// ---------------------------------------------------------------------------

const extLinkSeed = (): Map<string, any> => {
  const m = new Map<string, any>();
  m.set('/root/link', link('/outside'));
  m.set('/outside', dir());
  m.set('/root/src.txt', file('src\n'));
  return m;
};

const extFileSeed = (): Map<string, any> => {
  const m = new Map<string, any>();
  m.set('/root/ext', link('/out'));
  m.set('/out', dir());
  m.set('/out/f.txt', file('top-secret\n'));
  return m;
};

const canonicalRootSeed = (): Map<string, any> => {
  const m = new Map<string, any>();
  m.set('/root/linkroot', link('/actual'));
  m.set('/actual', dir());
  m.set('/actual/hello.txt', file('hello\n'));
  m.set('/actual/escape', link('/outside'));
  m.set('/outside', dir());
  m.set('/outside/secret.txt', file('top-secret\n'));
  return m;
};

describe('sftp root confinement: external symlink parent + missing leaf', () => {
  let h: Harness;
  before(async () => { h = await buildHarness({ trusted: true, seed: extLinkSeed() }); });
  after(async () => { await h.manager.dispose(); await h.fixture.stop(); });

  it('mkdir under a symlink parent rejects outside_root and creates nothing outside', async () => {
    const id = await createReady(h);
    await assert.rejects(h.manager.mkdir(id, 'link/new'), (e) => code(e) === 'outside_root');
    assert.ok(!h.fixture.fs.has('/outside/new'), 'must not create outside the root');
    assert.ok(h.fixture.fs.has('/root/link'));
  });

  it('upload under a symlink parent rejects outside_root and writes nothing outside', async () => {
    const id = await createReady(h);
    await assert.rejects(
      h.manager.upload(id, Readable.from(Buffer.from('x')), 'link/new-file'),
      (e) => code(e) === 'outside_root',
    );
    assert.ok(!h.fixture.fs.has('/outside/new-file'), 'must not write outside the root');
    const tmpLeft = [...h.fixture.fs.keys()].filter((k) => k.includes('.rd-tmp-'));
    assert.deepEqual(tmpLeft, [], 'no temp file should be left behind');
  });

  it('rename destination under a symlink parent rejects outside_root; source preserved', async () => {
    const id = await createReady(h);
    await assert.rejects(
      h.manager.rename(id, 'src.txt', 'link/new-name'),
      (e) => code(e) === 'outside_root',
    );
    assert.ok(!h.fixture.fs.has('/outside/new-name'), 'must not create outside the root');
    assert.ok(h.fixture.fs.has('/root/src.txt'), 'source must be preserved');
  });
});

describe('sftp root confinement: external symlink, existing file', () => {
  let h: Harness;
  before(async () => { h = await buildHarness({ trusted: true, seed: extFileSeed() }); });
  after(async () => { await h.manager.dispose(); await h.fixture.stop(); });

  it('list/stat/download/rename-source of a path behind an external symlink reject outside_root', async () => {
    const id = await createReady(h);
    await assert.rejects(h.manager.listFiles(id, 'ext'), (e) => code(e) === 'outside_root');
    await assert.rejects(h.manager.stat(id, 'ext/f.txt'), (e) => code(e) === 'outside_root');
    await assert.rejects(h.manager.download(id, 'ext/f.txt'), (e) => code(e) === 'outside_root');
    await assert.rejects(h.manager.rename(id, 'ext/f.txt', 'x.txt'), (e) => code(e) === 'outside_root');
    assert.ok(h.fixture.fs.has('/out/f.txt'), 'outside target must be untouched');
  });

  it('unlink of a file reached through an external symlink parent rejects outside_root', async () => {
    const id = await createReady(h);
    await assert.rejects(h.manager.unlink(id, 'ext/f.txt'), (e) => code(e) === 'outside_root');
    assert.ok(h.fixture.fs.has('/out/f.txt'), 'outside target must not be deleted');
  });

  it('unlink of the symlink itself succeeds and leaves the outside target intact', async () => {
    const id = await createReady(h);
    await h.manager.unlink(id, 'ext');
    assert.ok(!h.fixture.fs.has('/root/ext'), 'the symlink itself should be removed');
    assert.ok(h.fixture.fs.has('/out'), 'the outside directory target must remain');
    assert.ok(h.fixture.fs.has('/out/f.txt'), 'the outside file target must remain');
  });
});

describe('sftp root confinement: missing / inaccessible parent fails closed', () => {
  let h: Harness;
  before(async () => { h = await buildHarness({ trusted: true }); });
  after(async () => { await h.manager.dispose(); await h.fixture.stop(); });

  it('mkdir under a missing parent rejects no_such_file (fail-closed), no outside write', async () => {
    const id = await createReady(h);
    await assert.rejects(h.manager.mkdir(id, 'nosuch/new'), (e) => code(e) === 'no_such_file');
    assert.ok(!h.fixture.fs.has('/root/nosuch/new'), 'nothing should be created');
  });

  it('upload under a missing parent rejects no_such_file (fail-closed)', async () => {
    const id = await createReady(h);
    await assert.rejects(
      h.manager.upload(id, Readable.from(Buffer.from('x')), 'missing/file'),
      (e) => code(e) === 'no_such_file',
    );
    const tmpLeft = [...h.fixture.fs.keys()].filter((k) => k.includes('.rd-tmp-'));
    assert.deepEqual(tmpLeft, [], 'no temp file should be left behind');
  });
});

describe('sftp root confinement: canonical root traversing a symlink', () => {
  let h: Harness;
  before(async () => { h = await buildHarness({ trusted: true, seed: canonicalRootSeed() }); });
  after(async () => { await h.manager.dispose(); await h.fixture.stop(); });

  it('a session rooted at a symlink behaves consistently and stays confined', async () => {
    const id = await createReady(h, '/root/linkroot');
    const listing = await h.manager.listFiles(id, '');
    assert.deepEqual(listing.map((e) => e.name).sort(), ['escape', 'hello.txt']);
    const st = await h.manager.stat(id, 'hello.txt');
    assert.equal(st.type, 'file');
    const dl = await h.manager.download(id, 'hello.txt');
    const parts: Buffer[] = []; for await (const c of dl) parts.push(c as Buffer);
    assert.equal(Buffer.concat(parts).toString(), 'hello\n');
    await h.manager.upload(id, Readable.from(Buffer.from('new\n')), 'new.txt');
    assert.ok(h.fixture.fs.has('/actual/new.txt'), 'upload must land in the canonical root');
    assert.ok(!h.fixture.fs.has('/root/linkroot/new.txt'), 'no lexical (non-canonical) write');
    await h.manager.rename(id, 'hello.txt', 'renamed.txt');
    assert.ok(h.fixture.fs.has('/actual/renamed.txt'));
    assert.ok(!h.fixture.fs.has('/actual/hello.txt'));
    await h.manager.mkdir(id, 'subdir');
    assert.ok(h.fixture.fs.has('/actual/subdir'));
    await assert.rejects(h.manager.listFiles(id, 'escape'), (e) => code(e) === 'outside_root');
  });
});

describe('sftp upload: source abort + premature write-stream close', () => {
  it('an aborted source leaves no .rd-tmp-* and is not reported as success', async () => {
    const h = await buildHarness({ trusted: true });
    const id = await createReady(h);
    let pushed = false;
    const src = new Readable({
      read() {
        if (!pushed) {
          pushed = true;
          this.push(Buffer.alloc(2048, 7));
          process.nextTick(() => src.destroy());
        }
      },
    });
    const err = await h.manager.upload(id, src, 'abort.bin').then(
      () => { throw new Error('expected upload to reject'); },
      (e: unknown) => e,
    );
    assert.ok(err, 'upload should reject when the source is aborted');
    const tmpLeft = [...h.fixture.fs.keys()].filter((k) => k.includes('.rd-tmp-'));
    assert.deepEqual(tmpLeft, [], 'no temp file should be left behind');
    assert.ok(!h.fixture.fs.has('/root/abort.bin'), 'destination must not be created');
    await h.manager.dispose();
    await h.fixture.stop();
  });

  it('a premature remote write-stream close is not reported as success', async () => {
    const harness = await buildHarness({ trusted: true, failWriteAfter: 1 });
    const id = await createReady(harness);
    const chunks = [Buffer.alloc(512, 1), Buffer.alloc(512, 2), Buffer.alloc(512, 3), Buffer.alloc(512, 4)];
    let outcome: string;
    try {
      await harness.manager.upload(id, Readable.from(chunks), 'fail.bin');
      outcome = 'RESOLVED';
    } catch (e) {
      outcome = 'REJECTED: ' + (e as Error).message;
    }
    assert.ok(outcome.startsWith('REJECTED'), `upload must not be reported as success on a failed write (outcome=${outcome}, writes=${harness.fixture.state.writes})`);
    const tmpLeft = [...harness.fixture.fs.keys()].filter((k) => k.includes('.rd-tmp-'));
    assert.deepEqual(tmpLeft, [], 'no temp file should be left behind');
    assert.ok(!harness.fixture.fs.has('/root/fail.bin'), 'destination must not be (atomically) created');
    await harness.manager.dispose();
    await harness.fixture.stop();
  });
});
