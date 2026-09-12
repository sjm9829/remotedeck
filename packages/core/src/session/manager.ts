import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Store, SessionState, SessionRow, CredentialType } from '../store.js';
import type { SshTransport, ShellHandle, TransportTarget } from './transport.js';
import { RingBuffer } from './ringbuffer.js';
import type { WsOutputMessage, WsScrollbackMessage, WsStatusMessage } from '@remotedeck/protocol';

export interface Attachment {
  id: string;
  role: 'writer' | 'viewer';
  send(msg: unknown): void;
  close?(code?: number, reason?: string): void;
}

export interface ManagerOptions {
  store: Store;
  transport: SshTransport;
  scrollbackBytes?: number;
  idleTimeoutMs?: number;
  /**
   * Reconnect stale sessions on startup recovery when their host is still trusted
   * and their credential resolves. Default true. When false, recovery only closes
   * stale sessions (the pre-reconnect behavior).
   */
  autoReconnect?: boolean;
}

interface Runtime {
  id: string;
  hostId: string;
  credentialId: string | null;
  state: SessionState;
  shell: ShellHandle | null;
  writerId: string | null;
  viewers: Map<string, Attachment>;
  attachments: Map<string, Attachment>;
  buffer: RingBuffer;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_SCROLLBACK_BYTES = 256 * 1024;

export class SessionManager extends EventEmitter {
  private runtimes = new Map<string, Runtime>();
  private scrollbackBytes: number;
  private idleTimeoutMs: number;
  private readonly autoReconnect: boolean;

  constructor(private readonly opts: ManagerOptions) {
    super();
    this.scrollbackBytes = opts.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 300_000;
    this.autoReconnect = opts.autoReconnect ?? true;
  }

  getState(id: string): SessionState | null { return this.runtimes.get(id)?.state ?? null; }
  getShell(id: string): ShellHandle | null { return this.runtimes.get(id)?.shell ?? null; }
  getBuffer(id: string): RingBuffer | null { return this.runtimes.get(id)?.buffer ?? null; }
  writerOf(id: string): string | null { return this.runtimes.get(id)?.writerId ?? null; }
  viewersOf(id: string): string[] { return [...(this.runtimes.get(id)?.viewers.keys() ?? [])]; }

  /**
   * Server-restart recovery.
   *
   * A restarted process cannot reattach its in-memory SSH handles, so every
   * non-terminal session row is stale. With auto-reconnect (default), each stale
   * session whose host is still trusted and whose credential resolves is reopened
   * to a detached runtime (a fresh shell; scrollback is not replayed because the
   * prior connection is gone), so a client can reattach by session id. Sessions
   * that cannot be safely reopened (host gone, untrusted now, credential removed,
   * or connect failure) are closed. With auto-reconnect disabled, all stale
   * sessions are simply closed. Returns the stale rows that were examined.
   */
  async recover(): Promise<SessionRow[]> {
    const stale = this.opts.store.listSessions().filter((session) => !['closed', 'failed'].includes(session.state));
    const closeStale = (id: string): void =>
      this.opts.store.updateSession(id, { state: 'closed', writerId: null, closedAt: new Date().toISOString() });
    await Promise.all(stale.map(async (session) => {
      const host = this.opts.store.getHost(session.hostId);
      const reconnectable = this.autoReconnect && !!host && host.hostKeyTrusted === true && !!host.hostKeyFingerprint;
      if (!reconnectable) { closeStale(session.id); return; }
      const rt: Runtime = {
        id: session.id, hostId: session.hostId, credentialId: session.credentialId ?? null, state: 'creating',
        shell: null, writerId: null, viewers: new Map(), attachments: new Map(),
        buffer: new RingBuffer(this.scrollbackBytes), idleTimer: null,
      };
      this.runtimes.set(session.id, rt);
      try {
        await this.connect(rt, host!.hostKeyFingerprint!); // sets active; rethrows & fails on error
        rt.writerId = null; // the previous writer's WS is gone; a reattaching client claims the lease
        this.opts.store.updateSession(session.id, { writerId: null });
        this.setState(rt, 'detached'); // no client attached yet: await reattach, or idle-close
        this.startIdle(rt);
      } catch {
        this.runtimes.delete(session.id);
        closeStale(session.id);
      }
    }));
    return stale;
  }

  /**
   * Resolve the transport target for a session. The session-level credentialId
   * (override) takes priority over the host's default credential. The credential
   * TYPE decides which field the secret populates: password -> target.password,
   * key -> target.privateKey. Unsupported shapes (agent, keyPath-only, missing
   * secret) are rejected fail-closed with a clear error.
   */
  private buildTarget(rt: Runtime): TransportTarget {
    const host = this.opts.store.getHost(rt.hostId);
    if (!host) { const e = new Error('host_not_found'); (e as any).code = 'not_found'; throw e; }
    const base: TransportTarget = { host: host.hostname, port: host.port, username: host.username };
    const credId = rt.credentialId ?? host.credentialId ?? null; // session override first
    if (!credId) return base; // no credential resolved; the transport fails closed at connect (no auth material)
    const cred = this.opts.store.getCredential(credId);
    if (!cred) { const e = new Error('credential_not_found'); (e as any).code = 'not_found'; throw e; }
    const secret = this.opts.store.decryptCredentialSecret(credId); // string | null
    const target: TransportTarget = { ...base };
    switch (cred.type) {
      case 'password':
        if (secret) target.password = secret;
        else { const e = new Error('password credential has no secret'); (e as any).code = 'not_supported'; throw e; }
        break;
      case 'key':
        if (secret) target.privateKey = secret;
        else if (cred.keyPath) {
          const e = new Error('keyPath-only key credential not supported; store the private key as the secret');
          (e as any).code = 'not_supported'; throw e;
        } else {
          const e = new Error('key credential has no secret');
          (e as any).code = 'not_supported'; throw e;
        }
        break;
      case 'agent': {
        const e = new Error('agent credential not supported by the ssh2 transport');
        (e as any).code = 'not_supported'; throw e;
      }
      default: {
        const e = new Error(`unsupported credential type: ${cred.type}`);
        (e as any).code = 'not_supported'; throw e;
      }
    }
    return target;
  }

  /** Create a session. Fail-closed on untrusted host: observe fingerprint, do not connect. */
  async createSession(params: { hostId: string; credentialId?: string | null; writerId?: string | null }): Promise<{ session: SessionRow; requiresTrust: boolean; fingerprint?: string }> {
    const host = this.opts.store.getHost(params.hostId);
    if (!host) { const e = new Error('host_not_found'); (e as any).code = 'not_found'; throw e; }
    const credentialId = params.credentialId ?? host.credentialId ?? null;
    const row = this.opts.store.createSession({ hostId: host.id, credentialId, state: 'creating', writerId: params.writerId ?? null });
    const rt: Runtime = { id: row.id, hostId: host.id, credentialId, state: 'creating', shell: null, writerId: params.writerId ?? null,
      viewers: new Map(), attachments: new Map(), buffer: new RingBuffer(this.scrollbackBytes), idleTimer: null };
    this.runtimes.set(row.id, rt);

    if (!host.hostKeyTrusted) {
      // Observe the fingerprint but DO NOT connect (fail closed until trusted).
      let fingerprint: string;
      try {
        fingerprint = await this.opts.transport.observeFingerprint(this.buildTarget(rt));
      } catch (e) {
        this.failSession(rt); // connection/observe error -> session failed
        throw e;
      }
      this.opts.store.updateHost(host.id, { hostKeyFingerprint: fingerprint });
      this.setState(rt, 'awaiting-trust');
      return { session: this.opts.store.getSession(row.id)!, requiresTrust: true, fingerprint };
    }
    await this.connect(rt, host.hostKeyFingerprint!); // connect fails the session on error
    return { session: this.opts.store.getSession(row.id)!, requiresTrust: false };
  }

  /** Trust a host fingerprint and connect any session waiting on it. */
  async trustHost(hostId: string, fingerprint: string): Promise<void> {
    const host = this.opts.store.getHost(hostId);
    if (!host) { const e = new Error('host_not_found'); (e as any).code = 'not_found'; throw e; }
    this.opts.store.setHostTrust(hostId, fingerprint);
    for (const rt of this.runtimes.values()) {
      if (rt.hostId === hostId && rt.state === 'awaiting-trust') await this.connect(rt, fingerprint);
    }
  }

  private async connect(rt: Runtime, expectedFingerprint: string): Promise<void> {
    this.setState(rt, 'connecting');
    const target = this.buildTarget(rt);
    let shell: ShellHandle;
    try {
      shell = await this.opts.transport.connectShell(target, expectedFingerprint); // may throw fingerprint_mismatch
    } catch (e) {
      this.failSession(rt); // connect/observe error -> session failed + cleanup
      throw e;
    }
    rt.shell = shell;
    shell.on('output', (data: string) => {
      rt.buffer.push(data);
      const msg: WsOutputMessage = { type: 'output', ts: new Date().toISOString(), data: { data } };
      for (const a of rt.attachments.values()) a.send(msg);
    });
    shell.on('close', () => {
      if (rt.state !== 'closing') { this.clearIdle(rt); this.setState(rt, 'closed'); }
    });
    this.setState(rt, 'active');
  }

  // --- attachment / lease -------------------------------------------------

  attach(sessionId: string, attachment: Attachment): { role: 'writer' | 'viewer' } {
    const rt = this.runtimes.get(sessionId);
    if (!rt) { const e = new Error('session_not_found'); (e as any).code = 'not_found'; throw e; }
    if (rt.state === 'closed' || rt.state === 'failed' || rt.state === 'awaiting-trust' || rt.state === 'creating') {
      const e = new Error('not_attachable'); (e as any).code = 'invalid_state'; throw e;
    }
    rt.attachments.set(attachment.id, attachment);
    if (attachment.role === 'writer') {
      if (rt.writerId && rt.writerId !== attachment.id) {
        rt.attachments.delete(attachment.id);
        const e = new Error('writer_lease_taken'); (e as any).code = 'conflict'; throw e;
      }
      rt.writerId = attachment.id;
      this.opts.store.updateSession(rt.id, {writerId: attachment.id});
      if (rt.state === 'detached') { this.clearIdle(rt); this.setState(rt, 'active'); }
    } else {
      rt.viewers.set(attachment.id, attachment);
      this.emit('viewer_joined', sessionId, attachment.id);
    }
    // Confirm attachment state, then replay scrollback to the new client.
    const status: WsStatusMessage = { type: 'status', ts: new Date().toISOString(), data: { status: rt.state } };
    attachment.send(status);
    const scrollback = rt.buffer.toString();
    if (scrollback) {
      const msg: WsScrollbackMessage = { type: 'scrollback', ts: new Date().toISOString(), data: { data: scrollback } };
      attachment.send(msg);
    }
    return { role: attachment.role };
  }

  input(attachmentId: string, data: string): void {
    const { rt, att } = this.resolveAttachment(attachmentId);
    if (rt.writerId !== att.id) { const e = new Error('writer_only'); (e as any).code = 'forbidden'; throw e; }
    rt.shell?.write(data);
  }

  resize(attachmentId: string, rows: number, cols: number): void {
    const { rt, att } = this.resolveAttachment(attachmentId);
    if (rt.writerId !== att.id) { const e = new Error('writer_only'); (e as any).code = 'forbidden'; throw e; }
    rt.shell?.resize(rows, cols);
  }

  detach(attachmentId: string): void {
    const { rt, att } = this.resolveAttachment(attachmentId);
    rt.attachments.delete(attachmentId);
    if (att.role === 'writer') rt.viewers.delete(attachmentId);
    if (rt.writerId === attachmentId) {
      rt.writerId = null;
      this.opts.store.updateSession(rt.id, {writerId: null});
      this.setState(rt, 'detached');
      this.startIdle(rt); // SSH connection is kept alive during detachment
    }
  }

  transferWriter(sessionId: string, fromAttachmentId: string, toAttachmentId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) { const e = new Error('session_not_found'); (e as any).code = 'not_found'; throw e; }
    if (rt.writerId !== fromAttachmentId) { const e = new Error('not_current_writer'); (e as any).code = 'forbidden'; throw e; }
    if (!rt.attachments.has(toAttachmentId)) { const e = new Error('target_not_attached'); (e as any).code = 'not_found'; throw e; }
    const from = rt.attachments.get(fromAttachmentId)!;
    const to = rt.attachments.get(toAttachmentId)!;
    rt.writerId = to.id;
    this.opts.store.updateSession(rt.id, {writerId: to.id});
    // former writer becomes a viewer
    rt.viewers.set(from.id, from);
    this.emit('writer_transferred', sessionId, from.id, to.id);
  }

  async closeSession(sessionId: string): Promise<void> {
    const rt = this.runtimes.get(sessionId);
    if (!rt) { const e = new Error('session_not_found'); (e as any).code = 'not_found'; throw e; }
    this.clearIdle(rt);
    this.setState(rt, 'closing');
    rt.shell?.close();
    for (const a of rt.attachments.values()) a.close?.(1000, 'closed');
    rt.attachments.clear(); rt.viewers.clear();
    rt.writerId = null;
    this.setState(rt, 'closed');
  }

  // --- internal -----------------------------------------------------------

  private resolveAttachment(attachmentId: string): { rt: Runtime; att: Attachment } {
    for (const rt of this.runtimes.values()) {
      const att = rt.attachments.get(attachmentId);
      if (att) return { rt, att };
    }
    const e = new Error('attachment_not_found'); (e as any).code = 'not_found'; throw e;
  }

  /** Transition a session to failed and clean up any connection objects. */
  private failSession(rt: Runtime): void {
    this.clearIdle(rt);
    if (rt.shell) { try { rt.shell.close(); } catch {} rt.shell = null; }
    if (rt.state !== 'failed') this.setState(rt, 'failed');
  }

  private startIdle(rt: Runtime): void {
    this.clearIdle(rt);
    if (this.idleTimeoutMs <= 0) return;
    rt.idleTimer = setTimeout(() => { void this.closeSession(rt.id); }, this.idleTimeoutMs);
    rt.idleTimer.unref?.();
  }
  private clearIdle(rt: Runtime): void { if (rt.idleTimer) { clearTimeout(rt.idleTimer); rt.idleTimer = null; } }
  private setState(rt: Runtime, state: SessionState): void {
    rt.state = state;
    const terminal = state === 'closed' || state === 'failed';
    this.opts.store.updateSession(rt.id, {
      state,
      ...(terminal ? {writerId: null, closedAt: new Date().toISOString()} : {}),
    });
    this.emit('state', rt.id, state);
    const status: WsStatusMessage = { type: 'status', ts: new Date().toISOString(), data: { status: state } };
    for (const a of rt.attachments.values()) a.send(status);
  }

  dispose(): void {
    for (const rt of this.runtimes.values()) {
      this.clearIdle(rt);
      try { rt.shell?.close(); } catch {}
      for (const attachment of rt.attachments.values()) attachment.close?.(1001, 'server shutdown');
      rt.attachments.clear();
      rt.viewers.clear();
      rt.writerId = null;
      if (rt.state !== 'closed' && rt.state !== 'failed') this.setState(rt, 'closed');
    }
    this.runtimes.clear();
    this.removeAllListeners();
  }
}
