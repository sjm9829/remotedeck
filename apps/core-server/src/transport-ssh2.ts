import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import { EventEmitter } from 'node:events';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { SshTransport, ShellHandle, TransportTarget } from '@remotedeck/core/session/transport';
import { connectSsh } from './ssh-connect.js';

class SshShellHandle extends EventEmitter implements ShellHandle {
  closed = false;
  constructor(private readonly conn: Client, private readonly stream: any) { super(); }
  write(data: string): void { if (!this.closed) this.stream.write(data); }
  resize(rows: number, cols: number): void { if (!this.closed) this.stream.setWindow(rows, cols, 0, 0); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.stream.end(); } catch { /* already ended */ }
    try { this.conn.end(); } catch { /* already ended */ }
    this.emit('close');
  }
}

/**
 * OpenSSH-style host-key fingerprint: "SHA256:" + base64(SHA256(rawHostKey)).
 * Matches what `ssh-keygen -lf` reports for the raw server host key.
 */
export function toOpenSshFingerprint(rawHostKey: Buffer | string): string {
  const key = Buffer.isBuffer(rawHostKey) ? rawHostKey : Buffer.from(rawHostKey);
  // OpenSSH canonical form: base64 WITHOUT trailing '=' padding (ssh-keygen -lf).
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/g, '');
}

/** Constant-time string comparison (length-normalized via SHA-256 to avoid leaks). */
export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function buildAuth(target: TransportTarget): Partial<ConnectConfig> {
  if (target.password) return { password: target.password };
  if (target.privateKey) return { privateKey: target.privateKey };
  const e = new Error('no_credential: target has neither password nor privateKey');
  (e as any).code = 'not_supported';
  throw e;
}

export class Ssh2Transport implements SshTransport {
  private readonly readyTimeout = 10_000;

  async observeFingerprint(target: TransportTarget): Promise<string> {
    const conn = new Client();
    let fp: string | null = null;
    let settled = false;
    const cleanup = (): void => { try { conn.destroy(); } catch { /* already destroyed */ } };
    return await new Promise<string>((resolve, reject) => {
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (ok && fp) resolve(fp);
        else reject(new Error('ssh_observe_failed'));
      };
      conn.on('ready', () => finish(true));
      conn.on('close', () => finish(true));
      conn.on('error', (err: Error) => {
        // Without credentials, authentication fails after the key is exchanged;
        // if we already observed the key that is success, else it is a real error.
        if (fp) finish(true);
        else { settled = true; cleanup(); reject(err); }
      });
      const config: ConnectConfig = {
        host: target.host,
        port: target.port,
        username: target.username,
        readyTimeout: this.readyTimeout,
        keepaliveInterval: 0,
        keepaliveCountMax: 0,
        hostVerifier: (key: Buffer) => {
          fp = toOpenSshFingerprint(key);
          return true;
        },
      };
      try {
        conn.connect(config);
      } catch (err) {
        finish(false);
      }
    });
  }

  async connectShell(target: TransportTarget, expectedFingerprint: string): Promise<ShellHandle> {
    // Shared connect: auth + host-key-verify (fail-closed on mismatch) via connectSsh.
    const conn = await connectSsh(target, { expectedFingerprint, keepaliveInterval: 10_000, keepaliveCountMax: 3 });
    const stream: any = await new Promise((resolve, reject) => {
      conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err: any, s: any) => (err ? reject(err) : resolve(s)));
    });
    const handle = new SshShellHandle(conn, stream);
    stream.on('data', (d: Buffer) => handle.emit('output', d.toString('utf8')));
    stream.on('error', () => handle.close());
    stream.on('close', () => handle.close());
    conn.on('close', () => handle.close());
    return handle;
  }
}