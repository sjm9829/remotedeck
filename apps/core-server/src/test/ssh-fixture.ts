// Test-only, in-process ssh2 loopback server + app harness for the SSH REST ->
// SSH -> WebSocket boundary tests. Host/user keys are generated at runtime; nothing
// is written to disk and no secret or external/operational credential is used.
//
// The server authenticates:
//   - password  : alice / correct-pw
//   - publickey : only the fixture user key (compared by ssh wire blob)
// It opens an interactive shell that echoes "ECHO:<data>" and reports window-change
// (resize) as "RESIZE:<rows>x<cols>".
import { createHash, generateKeyPairSync, type JsonWebKey, type KeyObject } from 'node:crypto';
import ssh2 from 'ssh2';
import type { AddressInfo } from 'node:net';
// cjs-module-lexer exposes Client (used by the transport) but not Server as a named
// ESM export; the default export (module.exports) carries both.
const { Server } = ssh2;
import { MemoryStore } from '@remotedeck/core/store';
import { FakeSftpTransport } from '@remotedeck/core/session/sftp-transport';
import { Ssh2Transport } from '../transport-ssh2.js';
import { createApp, type AppHandle } from '../app.js';
import { resolveConfig } from '../config.js';

export const PW_USER = 'alice';
export const PW = 'correct-pw';

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
    { modulusLength: 2048, publicKeyExponent: 0x10001 } as any,
  ) as unknown as { privateKey: KeyObject; publicKey: KeyObject };
}

export interface SshFixture {
  server: InstanceType<typeof Server>;
  port: number;
  hostFingerprint: string;
  userKeyPem: string;
  userPubBlob: Buffer;
  stop(): Promise<void>;
}

export async function startSshFixture(): Promise<SshFixture> {
  const host = genRsaKey();
  const hostKeyPem = host.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
  const user = genRsaKey();
  const userKeyPem = user.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
  const userPubBlob = rsaWireBlob(toJwk(user.publicKey));
  // Independent OpenSSH fingerprint: base64(SHA256(wireBlob)), unpadded.
  const hostFingerprint =
    'SHA256:' + createHash('sha256').update(rsaWireBlob(toJwk(host.publicKey))).digest('base64').replace(/=+$/g, '');

  const server = new Server({ hostKeys: [hostKeyPem] }, (client: any) => {
    client.on('authentication', (ctx: any) => {
      if (ctx.method === 'password') {
        ctx.username === PW_USER && ctx.password === PW ? ctx.accept() : ctx.reject();
      } else if (ctx.method === 'publickey') {
        const ok = ctx.key.algo === 'ssh-rsa' && Buffer.compare(Buffer.from(ctx.key.data), userPubBlob) === 0;
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
        session.on('window-change', (_acc: any, _rej: any, info: any) => {
          if (shellStream) shellStream.write('RESIZE:' + info.rows + 'x' + info.cols);
        });
      });
    });
    client.on('error', () => { /* connection-level error; nothing to clean per connection */ });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server, port, hostFingerprint, userKeyPem, userPubBlob,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---- App harness -----------------------------------------------------------
export interface AppHarness {
  handle: AppHandle;
  store: MemoryStore;
  transport: Ssh2Transport;
  baseUrl: string;
  token: string;
  masterKey: string;
  port: number;
  authHeaders(): Record<string, string>;
  close(): Promise<void>;
}

export const TEST_MASTER_KEY = 'a'.repeat(64);
export const TEST_API_TOKEN = 'b'.repeat(40);

export async function startAppHarness(fixturePort?: number): Promise<AppHarness> {
  void fixturePort;
  const store = new MemoryStore(TEST_MASTER_KEY);
  const transport = new Ssh2Transport();
  const sftpTransport = new FakeSftpTransport();
  const config = resolveConfig({
    REMOTEDECK_MASTER_KEY: TEST_MASTER_KEY,
    REMOTEDECK_API_TOKEN: TEST_API_TOKEN,
    REMOTEDECK_ALLOWED_ORIGINS: '',
    PORT: '0',
    DATABASE_PATH: ':memory:',
  });
  const handle = createApp({ store, transport, sftpTransport, config }, { logger: false });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = handle.app.server.address() as AddressInfo;
  return {
    handle, store, transport,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    token: TEST_API_TOKEN,
    masterKey: TEST_MASTER_KEY,
    authHeaders: () => ({ authorization: `Bearer ${TEST_API_TOKEN}`, 'content-type': 'application/json' }),
    close: async () => {
      try { handle.manager.dispose(); } catch { /* */ }
      try { handle.sftpManager.dispose(); } catch { /* */ }
      await handle.app.close();
    },
  };
}

// Small REST helper for the tests (real HTTP against the listening app).
export interface RestResult { status: number; body: any; }
export async function rest(h: AppHarness, method: string, path: string, body?: unknown): Promise<RestResult> {
  const hasBody = body !== undefined;
  const headers: Record<string, string> = { authorization: `Bearer ${h.token}` };
  if (hasBody) headers['content-type'] = 'application/json';
  const res = await fetch(h.baseUrl + path, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}
