// SFTP session manager: owns the lifecycle of SFTP file sessions and delegates
// file operations to a live SftpHandle. Sessions are rooted at a per-session
// rootPath; multi-session isolation, idle close, explicit close, and stale
// cleanup are managed here. File ops are validated against the session root
// (path safety) before reaching the transport.

import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { resolveTransportTarget } from './target.js';
import { resolveWithinRoot, isRemoteRoot, RemotePathError } from './path.js';
import { normalizeFingerprint, fingerprintsEqual } from './transport.js';
import type { TransportTarget } from './transport.js';
import type { SftpTransport, SftpHandle, DirEntry, FileStat, SftpUploadOptions } from './sftp-transport.js';
import type { Store, SftpSession, SftpSessionStatus } from '../store.js';

export interface CreateSftpSessionInput {
  hostId: string;
  credentialId?: string | null;
  rootPath: string;
}

export interface SftpManagerDeps {
  store: Store;
  transport: SftpTransport;
  clock?: () => number;
  logger?: (event: string, data?: Record<string, unknown>) => void;
  idleTimeoutMs?: number;
  /**
   * Reconnect stale SFTP sessions on startup recovery when their host is still
   * trusted (the transport re-validates the stored host key on connect). Default
   * true. When false, recovery only marks stale sessions as error (pre-reconnect).
   */
  autoReconnect?: boolean;
  onCleanup?: (fn: () => void) => void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 300_000; // 5 min
const MAX_ROOT_SEGMENT = 255;

class SftpRuntime {
  readonly input: CreateSftpSessionInput;
  readonly target: TransportTarget;
  readonly rootPath: string;
  fingerprint: string | null = null;
  handle: SftpHandle | null = null;
  status: SftpSessionStatus = 'starting';
  reason: string | null = null;
  lastActiveAt: number;
  idleTimer?: NodeJS.Timeout;
  closed = false;
  constructor(input: CreateSftpSessionInput, target: TransportTarget, rootPath: string, lastActiveAt: number) {
    this.input = input;
    this.target = target;
    this.rootPath = rootPath;
    this.lastActiveAt = lastActiveAt;
  }
}

function sftpErr(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

export class SftpSessionManager extends EventEmitter {
  readonly store: Store;
  readonly transport: SftpTransport;
  private readonly deps: SftpManagerDeps;
  private readonly clock: () => number;
  private readonly logger: (event: string, data?: Record<string, unknown>) => void;
  private readonly idleTimeoutMs: number;
  private readonly autoReconnect: boolean;
  private readonly runtimes = new Map<string, SftpRuntime>();

  constructor(deps: SftpManagerDeps) {
    super();
    this.deps = deps;
    this.store = deps.store;
    this.transport = deps.transport;
    this.clock = deps.clock ?? (() => Date.now());
    this.logger = deps.logger ?? (() => undefined);
    this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.autoReconnect = deps.autoReconnect ?? true;
    deps.onCleanup?.(() => this.dispose());
  }

  private iso(ms: number): string { return new Date(ms).toISOString(); }

  /**
   * Server-restart recovery for stale DB SFTP sessions (no live runtime).
   *
   * With auto-reconnect (default), each stale session whose host is still trusted
   * and whose credential resolves is reopened: connectSftp re-validates the stored
   * host key, so a host-key change makes the reconnect fail (fail closed) rather
   * than silently reattaching to a different server. Sessions that cannot be
   * reopened, and all sessions when auto-reconnect is disabled, are marked error.
   * Returns the stale rows that were examined.
   */
  async recover(): Promise<SftpSession[]> {
    const nowMs = this.clock();
    const stale = this.store.listSftpSessions().filter((s) => s.status !== 'error' && !this.runtimes.has(s.id));
    const markStale = (s: SftpSession): void => {
      const t = this.iso(this.clock());
      this.store.updateSftpSession(s.id, { status: 'error', reason: 'sftp server restarted (stale session)', lastActiveAt: t, closedAt: t });
    };
    await Promise.all(stale.map(async (s) => {
      const host = this.store.getHost(s.hostId);
      const reconnectable = this.autoReconnect && !!host && host.hostKeyTrusted === true && !!host.hostKeyFingerprint;
      if (!reconnectable) { markStale(s); return; }
      let rt: SftpRuntime;
      try {
        const target = resolveTransportTarget(this.store, s.hostId, s.credentialId ?? null);
        rt = new SftpRuntime({ hostId: s.hostId, credentialId: s.credentialId ?? null, rootPath: s.rootPath }, target, s.rootPath, this.clock());
      } catch { markStale(s); return; } // host/credential no longer resolvable
      this.runtimes.set(s.id, rt);
      try {
        await this.doConnect(rt, s.id, host!.hostKeyFingerprint!); // transport re-validates the host key
        this.logger('sftp_session_reconnected', { id: s.id, hostId: s.hostId });
      } catch (err: any) {
        rt.closed = true; rt.handle?.close?.(); rt.handle = null; this.runtimes.delete(s.id);
        markStale(s);
        this.logger('sftp_session_reconnect_failed', { id: s.id, hostId: s.hostId, reason: String(err?.code ?? err?.message ?? 'connect_failed') });
      }
    }));
    return stale;
  }

  private validateRoot(rootPath: string): string {
    if (typeof rootPath !== 'string' || rootPath.length === 0)
      throw sftpErr('rootPath must be a non-empty POSIX absolute path', 'invalid_root');
    for (let i = 0; i < rootPath.length; i++) {
      const c = rootPath.charCodeAt(i);
      if (c === 0x00 || c < 0x20 || c === 0x7f) throw sftpErr('rootPath contains a NUL or control character', 'invalid_root');
    }
    if (!rootPath.startsWith('/')) throw sftpErr('rootPath must be an absolute POSIX path', 'invalid_root');
    for (const seg of rootPath.split('/'))
      if (seg.length > MAX_ROOT_SEGMENT) throw sftpErr('rootPath segment too long', 'invalid_root');
    const parts = rootPath.split('/').filter((p) => p !== '' && p !== '.');
    const stack: string[] = [];
    for (const p of parts) {
      if (p === '..') { if (stack.length) stack.pop(); else throw sftpErr('rootPath escapes the filesystem root', 'invalid_root'); }
      else stack.push(p);
    }
    return '/' + stack.join('/');
  }

  /**
   * Create an SFTP session with fail-closed trust:
   *   1. resolve host/credential target, 2. observe the host-key fingerprint,
   *   3. if the host is trusted and the fingerprint matches -> connect (ready);
   *      otherwise the session enters `awaiting-trust` and requires explicit trust
   *      (via trustSession) before connecting. A fingerprint mismatch is an error.
   */
  async create(input: CreateSftpSessionInput): Promise<{ session: SftpSession; requiresTrust: boolean; fingerprint: string }> {
    const hostId = input.hostId;
    if (!hostId) throw sftpErr('hostId is required', 'invalid_host');
    const credentialId = input.credentialId ?? null;
    const rootPath = this.validateRoot(input.rootPath);

    let target: TransportTarget;
    try {
      target = resolveTransportTarget(this.store, hostId, credentialId);
    } catch (err: any) {
      throw sftpErr(`cannot resolve host/credential: ${err?.code ?? err?.message ?? 'error'}`, err?.code === 'not_found' ? 'host_not_found' : 'invalid_credential');
    }

    const now = this.clock();
    const record = this.store.createSftpSession({
      hostId, credentialId, rootPath, fingerprint: '', status: 'starting',
      lastActiveAt: this.iso(now), createdAt: this.iso(now), updatedAt: this.iso(now),
    });
    const rt = new SftpRuntime(input, target, rootPath, now);
    this.runtimes.set(record.id, rt); // registered before observe so close() can clean up

    try {
      const observed = normalizeFingerprint(await this.transport.observeFingerprint(target));
      const host = this.store.getHost(hostId);
      const trusted = !!host && host.hostKeyTrusted === true && fingerprintsEqual(host.hostKeyFingerprint ?? '', observed);
      if (trusted) {
        await this.doConnect(rt, record.id, observed);
        return { session: this.get(record.id)!, requiresTrust: false, fingerprint: observed };
      }
      // Untrusted (or first observation): fail closed, enter awaiting-trust.
      if (host && host.hostKeyFingerprint && !fingerprintsEqual(host.hostKeyFingerprint, observed)) {
        rt.status = 'error';
        rt.reason = 'fingerprint_mismatch';
        this.runtimes.delete(record.id);
        const t = this.iso(this.clock());
        this.store.updateSftpSession(record.id, { status: 'error', reason: 'fingerprint_mismatch', lastActiveAt: t, closedAt: t });
        this.emit('session.error', { id: record.id, reason: 'fingerprint_mismatch' });
        throw sftpErr('host key fingerprint changed (mismatch)', 'fingerprint_mismatch');
      }
      // First observation: record the observed fingerprint on the host (untrusted).
      if (host) this.store.updateHost(hostId, { hostKeyFingerprint: observed });
      rt.status = 'awaiting-trust';
      rt.fingerprint = observed;
      const t = this.iso(this.clock());
      this.store.updateSftpSession(record.id, { status: 'awaiting-trust', reason: null, fingerprint: observed, lastActiveAt: t, updatedAt: t });
      this.emit('session.created', { id: record.id, status: 'awaiting-trust', hostId });
      this.logger('sftp_session_awaiting_trust', { id: record.id, hostId });
      return { session: this.get(record.id)!, requiresTrust: true, fingerprint: observed };
    } catch (err: any) {
      if (rt.status === 'error') throw err; // mismatch already handled
      const reason = String(err?.code ?? err?.message ?? 'unknown_error');
      rt.status = 'error';
      rt.reason = reason;
      rt.handle?.close?.();
      this.runtimes.delete(record.id);
      const t = this.iso(this.clock());
      this.store.updateSftpSession(record.id, { status: 'error', reason, lastActiveAt: t, closedAt: t });
      this.emit('session.error', { id: record.id, reason });
      this.logger('sftp_session_failed', { id: record.id, hostId, reason });
      throw sftpErr(`failed to create sftp session: ${reason}`, 'sftp_connect_failed');
    }
  }

  /** Establish the SFTP handle for a ready-to-connect runtime. */
  private async doConnect(rt: SftpRuntime, id: string, expectedFingerprint: string): Promise<void> {
    rt.handle = await this.transport.connectSftp(rt.target, expectedFingerprint, rt.rootPath);
    rt.handle.on('close', () => {
      if (!rt.closed) {
        rt.closed = true;
        rt.status = 'error';
        rt.reason = 'connection closed';
        this.clearIdleTimer(rt);
        const t = this.iso(this.clock());
        this.store.updateSftpSession(id, { status: 'error', reason: 'connection closed', lastActiveAt: t, closedAt: t });
        this.emit('session.error', { id, reason: 'connection closed' });
      }
    });
    rt.status = 'ready';
    const readyAt = this.iso(this.clock());
    this.store.updateSftpSession(id, { status: 'ready', reason: null, lastActiveAt: readyAt, updatedAt: readyAt });
    this.startIdleTimer(rt, id);
    this.emit('session.ready', { id });
  }

  /** Explicitly trust a session's observed fingerprint and connect it. */
  async trustSession(id: string): Promise<SftpSession> {
    const rt = this.runtimes.get(id);
    const rec = this.store.getSftpSession(id);
    if (!rec) throw sftpErr('sftp session not found', 'session_not_found');
    if (!rt || rt.status !== 'awaiting-trust' || !rt.fingerprint)
      throw sftpErr('session is not awaiting trust', 'invalid_state');
    const observed = rt.fingerprint;
    // Trust the host fingerprint (shared with shell sessions) and connect.
    this.store.setHostTrust(rec.hostId, observed);
    await this.doConnect(rt, id, observed);
    return this.get(id)!;
  }

  get(id: string): SftpSession | null { return this.store.getSftpSession(id); }  list(): SftpSession[] { return this.store.listSftpSessions(); }

  /** True when the session has a live, ready runtime usable for file ops. */
  isLive(id: string): boolean {
    const rt = this.runtimes.get(id);
    return !!rt && !rt.closed && rt.status === 'ready' && !!rt.handle;
  }

  private requireLive(id: string): SftpRuntime {
    const rt = this.runtimes.get(id);
    if (!rt || rt.closed || rt.status !== 'ready' || !rt.handle)
      throw sftpErr('session is not active (closed or not ready)', 'session_closed');
    return rt;
  }

  private touch(rt: SftpRuntime, id: string): void {
    rt.lastActiveAt = this.clock();
    const t = this.iso(rt.lastActiveAt);
    this.store.updateSftpSession(id, { lastActiveAt: t, updatedAt: t });
  }

  private resolve(id: string, relPath: string): string {
    const rt = this.runtimes.get(id);
    if (!rt) throw sftpErr('session not found', 'session_not_found');
    return resolveWithinRoot(rt.rootPath, relPath);
  }

  private resolveNotRoot(id: string, relPath: string): string {
    const abs = this.resolve(id, relPath);
    const rt = this.runtimes.get(id)!;
    if (isRemoteRoot(abs, rt.rootPath)) throw sftpErr('operation on the session root is not allowed', 'root_operation');
    return abs;
  }

  async listFiles(id: string, dir: string): Promise<DirEntry[]> {
    const rt = this.requireLive(id);
    const out = await rt.handle!.list(this.resolve(id, dir));
    this.touch(rt, id);
    return out;
  }
  async stat(id: string, path: string): Promise<FileStat> {
    const rt = this.requireLive(id);
    const out = await rt.handle!.stat(this.resolve(id, path));
    this.touch(rt, id);
    return out;
  }
  async mkdir(id: string, path: string): Promise<void> {
    const rt = this.requireLive(id);
    await rt.handle!.mkdir(this.resolveNotRoot(id, path));
    this.touch(rt, id);
  }
  async rename(id: string, from: string, to: string): Promise<void> {
    const rt = this.requireLive(id);
    await rt.handle!.rename(this.resolveNotRoot(id, from), this.resolveNotRoot(id, to));
    this.touch(rt, id);
  }
  async unlink(id: string, path: string): Promise<void> {
    const rt = this.requireLive(id);
    await rt.handle!.unlink(this.resolveNotRoot(id, path));
    this.touch(rt, id);
  }
  async rmdir(id: string, path: string): Promise<void> {
    const rt = this.requireLive(id);
    await rt.handle!.rmdir(this.resolveNotRoot(id, path));
    this.touch(rt, id);
  }

  async upload(id: string, src: Readable, dest: string, opts?: SftpUploadOptions): Promise<void> {
    const rt = this.requireLive(id);
    await rt.handle!.upload(src, this.resolveNotRoot(id, dest), opts);
    this.touch(rt, id);
  }
  async download(id: string, path: string): Promise<Readable> {
    const rt = this.requireLive(id);
    const stream = await rt.handle!.download(this.resolveNotRoot(id, path));
    this.touch(rt, id);
    return stream;
  }

  /** Explicitly close a session. */
  async close(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) {
      const rec = this.store.getSftpSession(id);
      if (rec && !rec.closedAt) this.store.updateSftpSession(id, { closedAt: this.iso(this.clock()), lastActiveAt: this.iso(this.clock()) });
      return;
    }
    this.clearIdleTimer(rt);
    if (!rt.closed) {
      rt.closed = true;
      rt.handle?.close?.();
      rt.handle = null;
      this.runtimes.delete(id);
      const t = this.iso(this.clock());
      this.store.updateSftpSession(id, { lastActiveAt: t, closedAt: t });
      this.emit('session.closed', { id });
      this.logger('sftp_session_closed', { id });
    }
  }

  private startIdleTimer(rt: SftpRuntime, id: string): void {
    this.clearIdleTimer(rt);
    // idleTimeoutMs <= 0 disables idle close: keep the detached SFTP session open indefinitely.
    if (this.idleTimeoutMs <= 0) return;
    const timer = setTimeout(() => {
      const current = this.runtimes.get(id);
      if (!current || current.closed || current.status !== 'ready') return;
      current.closed = true;
      current.status = 'error';
      current.reason = 'idle timeout';
      current.handle?.close?.();
      current.handle = null;
      this.runtimes.delete(id);
      const t = this.iso(this.clock());
      this.store.updateSftpSession(id, { status: 'error', reason: 'idle timeout', lastActiveAt: t, closedAt: t });
      this.emit('session.closed', { id, reason: 'idle timeout' });
      this.logger('sftp_session_idle_closed', { id });
    }, this.idleTimeoutMs);
    timer.unref?.();
    rt.idleTimer = timer;
  }

  private clearIdleTimer(rt: SftpRuntime): void {
    if (rt.idleTimer) { clearTimeout(rt.idleTimer); rt.idleTimer = undefined; }
  }

  dispose(): void {
    for (const rt of this.runtimes.values()) { this.clearIdleTimer(rt); rt.handle?.close?.(); }
    this.runtimes.clear();
    this.removeAllListeners();
  }
}
