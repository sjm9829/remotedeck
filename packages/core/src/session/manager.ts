import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Store, SessionState, SessionRow, CredentialType } from '../store.js';
import type { SshTransport, ShellHandle, TransportTarget } from './transport.js';
import { RingBuffer } from './ringbuffer.js';

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
}

interface Runtime {
  id: string;
  hostId: string;
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

  constructor(private readonly opts: ManagerOptions) {
    super();
    this.scrollbackBytes = opts.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 300_000;
  }

  getState(id: string): SessionState | null { return this.runtimes.get(id)?.state ?? null; }
  getShell(id: string): ShellHandle | null { return this.runtimes.get(id)?.shell ?? null; }
  getBuffer(id: string): RingBuffer | null { return this.runtimes.get(id)?.buffer ?? null; }
  writerOf(id: string): string | null { return this.runtimes.get(id)?.writerId ?? null; }
  viewersOf(id: string): string[] { return [...(this.runtimes.get(id)?.viewers.keys() ?? [])]; }

  private targetForHost(hostId: string): TransportTarget {
    const host = this.opts.store.getHost(hostId);
    if (!host) throw new Error('host_not_found');
    const cred = host.credentialId ? this.opts.store.decryptCredentialSecret(host.credentialId) : null;
    return { host: host.hostname, port: host.port, username: host.username, privateKey: cred ?? undefined };
  }

  /** Create a session. Fail-closed on untrusted host: observe fingerprint, do not connect. */
  async createSession(params: { hostId: string; credentialId?: string | null; writerId?: string | null }): Promise<{ session: SessionRow; requiresTrust: boolean; fingerprint?: string }> {
    const host = this.opts.store.getHost(params.hostId);
    if (!host) { const e = new Error('host_not_found'); (e as any).code = 'not_found'; throw e; }
    const credentialId = params.credentialId ?? host.credentialId ?? null;
    const row = this.opts.store.createSession({ hostId: host.id, credentialId, state: 'creating', writerId: params.writerId ?? null });
    const rt: Runtime = { id: row.id, hostId: host.id, state: 'creating', shell: null, writerId: params.writerId ?? null,
      viewers: new Map(), attachments: new Map(), buffer: new RingBuffer(this.scrollbackBytes), idleTimer: null };
    this.runtimes.set(row.id, rt);

    if (!host.hostKeyTrusted) {
      // Observe the fingerprint but DO NOT connect (fail closed until trusted).
      const fingerprint = await this.opts.transport.observeFingerprint(this.targetForHost(host.id));
      this.opts.store.updateHost(host.id, { hostKeyFingerprint: fingerprint });
      this.setState(rt, 'awaiting-trust');
      return { session: this.opts.store.getSession(row.id)!, requiresTrust: true, fingerprint };
    }
    await this.connect(rt, host.hostKeyFingerprint!);
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
    const target = this.targetForHost(rt.hostId);
    const shell = await this.opts.transport.connectShell(target, expectedFingerprint); // may throw fingerprint_mismatch
    rt.shell = shell;
    shell.on('output', (data: string) => {
      rt.buffer.push(data);
      for (const a of rt.attachments.values()) a.send({ type: 'output', data });
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
      if (rt.state === 'detached') { this.clearIdle(rt); this.setState(rt, 'active'); }
    } else {
      rt.viewers.set(attachment.id, attachment);
      this.emit('viewer_joined', sessionId, attachment.id);
    }
    // Confirm attachment state, then replay scrollback to the new client.
    attachment.send({ type: 'status', data: { status: rt.state } });
    const scrollback = rt.buffer.toString();
    if (scrollback) attachment.send({ type: 'scrollback', data: scrollback });
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

  private startIdle(rt: Runtime): void {
    this.clearIdle(rt);
    if (this.idleTimeoutMs <= 0) return;
    rt.idleTimer = setTimeout(() => { void this.closeSession(rt.id); }, this.idleTimeoutMs);
    rt.idleTimer.unref?.();
  }
  private clearIdle(rt: Runtime): void { if (rt.idleTimer) { clearTimeout(rt.idleTimer); rt.idleTimer = null; } }
  private setState(rt: Runtime, state: SessionState): void {
    rt.state = state;
    this.opts.store.updateSession(rt.id, { state });
    this.emit('state', rt.id, state);
    for (const a of rt.attachments.values()) a.send({ type: 'status', data: { status: state } });
  }
}
