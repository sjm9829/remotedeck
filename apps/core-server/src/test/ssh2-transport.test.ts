import { createHash } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, type JsonWebKey, type KeyObject } from 'node:crypto';
import ssh2 from 'ssh2';

// cjs-module-lexer exposes Client (used by the transport) but not Server as a named
// ESM export; the default export (module.exports) carries both.
const { Server } = ssh2;
import { Ssh2Transport, toOpenSshFingerprint } from '../transport-ssh2.js';
import type { TransportTarget, ShellHandle } from '@remotedeck/core/session/transport';

const PW_USER = 'alice';
const PW = 'correct-pw';

/**
 * Build the SSH wire-format RSA public-key blob (string('ssh-rsa') + string(e) + string(n)).
 * Multi-precision integers are signed big-endian: a leading 0x00 byte is prepended when the
 * most-significant bit is set, so the value is not interpreted as negative.
 */
function rsaWireBlob(pub: JsonWebKey): Buffer {
  const n = Buffer.from(pub.n as string, 'base64url');
  const e = Buffer.from(pub.e as string, 'base64url');
  const enc = (b: Buffer): Buffer => (b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
  const str = (b: Buffer): Buffer =>
    Buffer.concat([Buffer.from([b.length >>> 24, b.length >>> 16, b.length >>> 8, b.length & 0xff]), b]);
  return Buffer.concat([str(Buffer.from('ssh-rsa')), str(enc(e)), str(enc(n))]);
}

function toJwk(pub: KeyObject): JsonWebKey {
  return pub.export({ format: 'jwk' }) as unknown as JsonWebKey;
}

function genRsaKey(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync(
    'rsa',
    { modulusLength: 2048, publicKeyExponent: 0x10001 } as any, // @types/node 24 RSA options shape differs from runtime field names
  ) as unknown as { privateKey: KeyObject; publicKey: KeyObject };
}

interface Fixture {
  server: InstanceType<typeof Server>;
  port: number;
  hostFingerprint: string;
  userKeyPem: string;
  userPubBlob: Buffer;
}

/**
 * In-memory loopback ssh2.Server fixture. Host key + user key are generated at runtime;
 * nothing is written to disk and no secret is embedded. The server authenticates:
 *   - password : alice / correct-pw
 *   - publickey: only the fixture user key (compared by wire blob)
 * It opens a shell that echoes "ECHO:<data>" and reports window-change as "RESIZE:<rows>x<cols>".
 */
function startFixture(): Promise<Fixture> {
  const host = genRsaKey();
  const hostKeyPem = host.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
  const user = genRsaKey();
  const userKeyPem = user.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
  const userPubBlob = rsaWireBlob(toJwk(user.publicKey));
  // Independent OpenSSH fingerprint (not via toOpenSshFingerprint): base64(SHA256(wireBlob)), unpadded.
  const hostFingerprint = 'SHA256:' + createHash('sha256').update(rsaWireBlob(toJwk(host.publicKey))).digest('base64').replace(/=+$/g, '');

  const server = new Server({ hostKeys: [hostKeyPem] }, (client: any) => {
    client.on('authentication', (ctx: any) => {
      if (ctx.method === 'password') {
        const ok = ctx.username === PW_USER && ctx.password === PW;
        ok ? ctx.accept() : ctx.reject();
      } else if (ctx.method === 'publickey') {
        const ok =
          ctx.key.algo === 'ssh-rsa' && Buffer.compare(Buffer.from(ctx.key.data), userPubBlob) === 0;
        ok ? ctx.accept() : ctx.reject();
      } else {
        ctx.reject();
      }
    });
    client.on('ready', () => {
      let shellStream: any = null;
      client.on('session', (accept: any) => {
        const session = accept();
        session.on('pty', (acc: any) => { acc(); });
        session.on('shell', (acc: any) => {
          shellStream = acc();
          shellStream.on('data', (d: Buffer) => shellStream.write('ECHO:' + d.toString()));
        });
        // window-change is a notification-only channel request: accept/reject are undefined
        // at runtime (ssh2 auto-accepts it); only `info` is meaningful.
        session.on('window-change', (_acc: any, _rej: any, info: any) => {
          if (shellStream) shellStream.write('RESIZE:' + info.rows + 'x' + info.cols);
        });
      });
    });
    client.on('error', () => { /* connection-level error; nothing to clean per connection */ });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port, hostFingerprint, userKeyPem, userPubBlob });
    });
  });
}

/** Resolve the shell output buffer once it contains `pattern`; reject on timeout or close. */
function collectUntil(handle: ShellHandle, pattern: string, ms = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const cleanup = (): void => { clearTimeout(timer); handle.off('output', onData); handle.off('close', onClose); };
    const timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); reject(new Error('timeout waiting for ' + pattern)); }, ms);
    const onData = (s: string): void => { buf += s; if (!settled && buf.includes(pattern)) { settled = true; cleanup(); resolve(buf); } };
    const onClose = (): void => { if (settled) return; settled = true; cleanup(); reject(new Error('handle closed before ' + pattern)); };
    handle.on('output', onData);
    handle.on('close', onClose);
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_res, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

describe('ssh2 transport (loopback integration)', () => {
  let fx: Fixture;
  let transport: Ssh2Transport;

  before(async () => {
    fx = await startFixture();
    transport = new Ssh2Transport();
  });
  after(async () => { await new Promise<void>((r) => fx.server.close(() => r())); });

  const target = (over: Partial<TransportTarget> = {}): TransportTarget => ({
    host: '127.0.0.1',
    port: fx.port,
    username: PW_USER,
    ...over,
  });

  it('observed fingerprint equals the OpenSSH fingerprint computed from the host key', async () => {
    const fp = await transport.observeFingerprint(target({ username: PW_USER }));
    assert.match(fp, /^SHA256:/);
    assert.equal(fp, fx.hostFingerprint);
  });

  it('observeFingerprint rejects on a connection error (closed port)', async () => {
    await assert.rejects(transport.observeFingerprint(target({ port: 1, username: PW_USER })));
  });

  it('shell I/O round-trips with the correct fingerprint + password', async () => {
    const h = await transport.connectShell(target({ password: PW }), fx.hostFingerprint);
    try {
      const p = collectUntil(h, 'ECHO:ping');
      h.write('ping');
      const out = await p;
      assert.ok(out.includes('ECHO:ping'), 'expected echoed ping, got: ' + JSON.stringify(out));
    } finally { h.close(); }
  });

  it('resize sends a window-change to the server', async () => {
    const h = await transport.connectShell(target({ password: PW }), fx.hostFingerprint);
    try {
      const p = collectUntil(h, 'RESIZE:30x120');
      h.resize(30, 120);
      const out = await p;
      assert.ok(out.includes('RESIZE:30x120'), 'expected resize echo, got: ' + JSON.stringify(out));
    } finally { h.close(); }
  });

  it('close ends the shell and the connection', async () => {
    const h = await transport.connectShell(target({ password: PW }), fx.hostFingerprint);
    const closed = new Promise<void>((r) => h.on('close', () => r()));
    h.close();
    await withTimeout(closed, 3000);
    assert.equal(h.closed, true);
  });

  it('private-key auth succeeds and opens a shell', async () => {
    const h = await transport.connectShell(target({ username: 'bob', privateKey: fx.userKeyPem }), fx.hostFingerprint);
    try {
      const p = collectUntil(h, 'ECHO:hi');
      h.write('hi');
      const out = await p;
      assert.ok(out.includes('ECHO:hi'), 'expected echoed hi, got: ' + JSON.stringify(out));
    } finally { h.close(); }
  });

  it('a mismatched host-key fingerprint fails closed (no shell)', async () => {
    await assert.rejects(
      transport.connectShell(target({ password: PW }), 'SHA256:' + 'x'.repeat(43)),
    );
  });

  it('a wrong password fails authentication', async () => {
    await assert.rejects(transport.connectShell(target({ password: 'wrong-pw' }), fx.hostFingerprint));
  });

  it('a target with neither password nor key rejects not_supported', async () => {
    await assert.rejects(
      transport.connectShell(target({ username: PW_USER }), fx.hostFingerprint),
      (e: Error) => (e as NodeJS.ErrnoException).code === 'not_supported',
    );
  });
});
