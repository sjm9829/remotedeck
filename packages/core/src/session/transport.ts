import { EventEmitter } from 'node:events';

export interface TransportTarget {
  host: string;
  port: number;
  username: string;
  // exactly one credential kind is supplied by the caller
  privateKey?: string;
  password?: string;
}

export interface ShellHandle extends EventEmitter {
  write(data: string): void;
  resize(rows: number, cols: number): void;
  close(): void;
  readonly closed: boolean;
}

/**
 * Injectable SSH transport. The real adapter uses ssh2 (in core-server); tests
 * use FakeTransport for deterministic, in-process behavior with no real SSH.
 */
export interface SshTransport {
  /** Observe the host key fingerprint without trusting it (no shell opened). */
  observeFingerprint(target: TransportTarget): Promise<string>;
  /** Connect and open an interactive shell; rejects if fingerprint != expected. */
  connectShell(target: TransportTarget, expectedFingerprint: string): Promise<ShellHandle>;
}

export class FakeShellHandle extends EventEmitter implements ShellHandle {
  writes: string[] = [];
  resizes: Array<{ rows: number; cols: number }> = [];
  closed = false;
  constructor(private readonly key: string, private readonly registry: FakeTransport) { super(); }
  write(data: string): void { if (this.closed) throw new Error('shell closed'); this.writes.push(data); }
  resize(rows: number, cols: number): void { this.resizes.push({ rows, cols }); }
  close(): void { if (!this.closed) { this.closed = true; this.emit('close'); } }
  /** Test helper: simulate output from the remote shell. */
  emitOutput(data: string): void { this.emit('output', data); }
  /** Test helper: simulate remote close. */
  emitClose(): void { if (!this.closed) { this.closed = true; this.emit('close'); } }
  _key(): string { return this.key; }
}

export class FakeTransport implements SshTransport {
  /** key = host:port:username -> configured fingerprint */
  fingerprints = new Map<string, string>();
  shells = new Map<string, FakeShellHandle>();
  /** Set to true to make observeFingerprint/connectShell reject (tests connection failure). */
  failObserve = false;
  failConnect = false;
  /** Records the most recent target handed to the transport (tests credential mapping). */
  lastObserveTarget: TransportTarget | null = null;
  lastConnectTarget: TransportTarget | null = null;

  setFingerprint(target: TransportTarget, fp: string): void { this.fingerprints.set(this.key(target), fp); }
  private key(t: TransportTarget): string { return `${t.host}:${t.port}:${t.username}`; }

  async observeFingerprint(target: TransportTarget): Promise<string> {
    this.lastObserveTarget = target;
    if (this.failObserve) throw new Error('fake_observe_error');
    const fp = this.fingerprints.get(this.key(target));
    if (!fp) throw new Error('no_host_key');
    return fp;
  }
  async connectShell(target: TransportTarget, expectedFingerprint: string): Promise<ShellHandle> {
    this.lastConnectTarget = target;
    if (this.failConnect) throw new Error('fake_connect_error');
    const fp = this.fingerprints.get(this.key(target));
    if (!fp) throw new Error('no_host_key');
    if (fp !== expectedFingerprint) throw new Error('fingerprint_mismatch');
    const h = new FakeShellHandle(this.key(target), this);
    this.shells.set(this.key(target), h);
    return h;
  }
}

/**
 * Normalize a host-key fingerprint to the OpenSSH canonical form: keep the
 * "SHA256:" prefix and strip any base64 padding ('='). OpenSSH (e.g.
 * `ssh-keygen -lf`) reports the fingerprint WITHOUT padding, so this is how
 * observed and stored values are compared safely (legacy stored values may
 * still carry padding).
 */
export function normalizeFingerprint(fp: string): string {
  if (typeof fp !== 'string') return '';
  const colon = fp.indexOf(':');
  const prefix = colon >= 0 ? fp.slice(0, colon + 1) : '';
  const b64 = colon >= 0 ? fp.slice(colon + 1) : fp;
  return prefix + b64.replace(/=+$/g, '');
}

/** Constant-value fingerprint equality on normalized forms (padding-insensitive). */
export function fingerprintsEqual(a: string, b: string): boolean {
  return normalizeFingerprint(a) === normalizeFingerprint(b);
}
