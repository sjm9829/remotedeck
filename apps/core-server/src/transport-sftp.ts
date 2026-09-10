// Real ssh2-based SFTP transport. Uses the shared `connectSsh` factory (same
// auth + host-key-verify as the shell transport) and wraps the SFTP client with
// per-session path safety: rootPath (manager), symlink-escape checks, atomic
// temp+rename upload, and bounded-memory streams.
//
// Root confinement (fail-closed):
//   - The session root is canonicalized once at connect time via remote realpath
//     (rootCanonical). Every subsequent check compares against rootCanonical.
//   - Reads/deletes/rename-sources require successful canonical resolution of the
//     exact existing object and prove containment in rootCanonical.
//   - Create/upload/rename-destinations canonicalize the closest required existing
//     parent directory, prove it is inside rootCanonical, then operate on the final
//     basename under the canonical parent (so a symlinked parent cannot escape).
//   - Arbitrary realpath failures are NEVER treated as safe (fail-closed).

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { SftpTransport, SftpHandle, DirEntry, FileStat, SftpUploadOptions, RemoteFileType, TransportTarget } from '@remotedeck/core';
import { parentPath } from '@remotedeck/core';
import { connectSsh } from './ssh-connect.js';

const STATUS_NO_SUCH_FILE = 2;
const STATUS_PERMISSION_DENIED = 3;

function mapSftpStatus(code: number, fallback: string): Error {
  switch (code) {
    case STATUS_NO_SUCH_FILE: return Object.assign(new Error(fallback + ': no such file'), { code: 'no_such_file' });
    case STATUS_PERMISSION_DENIED: return Object.assign(new Error(fallback + ': permission denied'), { code: 'permission_denied' });
    default: return Object.assign(new Error(fallback || 'sftp_failure'), { code: 'sftp_failure' });
  }
}

function typeFromPerms(perms: number): RemoteFileType {
  switch (perms & 0o170000) {
    case 0o40000: return 'directory';
    case 0o120000: return 'symlink';
    case 0o100000: return 'file';
    default: return 'other';
  }
}

/**
 * Map a raw ssh2/Node connection error to a stable, meaningful code.
 * `fingerprint_mismatch` is only used when the host-key verifier actually rejected
 * the host key; bad credentials, unreachable hosts, and timeouts keep distinct codes.
 */
function mapConnectError(err: unknown): Error {
  const e = err as any;
  const msg: string = typeof e?.message === 'string' ? e.message : String(e?.message ?? 'connection failed');
  const level: string | undefined = e?.level;
  const code: string | undefined = e?.code;
  // Host key rejected by the verifier (ssh2 fatal handshake error).
  if (level === 'handshake' || /^host denied/i.test(msg))
    return Object.assign(new Error(msg || 'fingerprint_mismatch'), { code: 'fingerprint_mismatch' });
  // Authentication failed (wrong password / key / no acceptable method).
  if (level === 'client-authentication' || /authentication.*failed/i.test(msg))
    return Object.assign(new Error('authentication failed'), { code: 'auth_failed' });
  // No usable credential (thrown by buildAuth before the socket opens).
  if (code === 'not_supported')
    return Object.assign(new Error(msg), { code: 'not_supported' });
  // Our own ready-timeout guard (or a socket-level TCP timeout).
  if (msg === 'ssh_connect_timeout' || code === 'ETIMEDOUT')
    return Object.assign(new Error('connection timed out'), { code: 'timeout' });
  // Everything else at connect time is a network/socket-level failure.
  return Object.assign(new Error(msg || 'host unreachable'), { code: 'unreachable' });
}

class SftpHandleImpl extends EventEmitter implements SftpHandle {
  private sftp: SFTPWrapper;
  private root: string; // configured (lexical) root path
  private rootCanonical: string | null = null; // canonicalized root (set by ensureRoot)
  private onClose: () => void;
  private isClosed = false;

  constructor(opts: { sftp: SFTPWrapper; root: string; onClose: () => void }) {
    super();
    this.sftp = opts.sftp;
    this.root = opts.root;
    this.onClose = opts.onClose;
  }

  get closed(): boolean { return this.isClosed; }

  private assertOpen(): void {
    if (this.isClosed) throw Object.assign(new Error('sftp handle closed'), { code: 'session_closed' });
  }

  private errCode(err: any): number {
    return typeof err?.code === 'number' ? err.code : 4; // 4 = SFTP_FAILURE
  }

  // ---- raw SFTP wrappers (promise) ----------------------------------------
  private lstatRaw(path: string): Promise<Stats> {
    return new Promise((res, rej) => {
      this.sftp.lstat(path, (err, st) => (err ? rej(mapSftpStatus(this.errCode(err), 'lstat')) : res(st as Stats)));
    });
  }
  private readlinkRaw(path: string): Promise<string> {
    return new Promise((res, rej) => {
      this.sftp.readlink(path, (err, t) => (err ? rej(mapSftpStatus(this.errCode(err), 'readlink')) : res(t as string)));
    });
  }
  private realpathRaw(path: string): Promise<string> {
    return new Promise((res, rej) => {
      this.sftp.realpath(path, (err, rp) => (err ? rej(mapSftpStatus(this.errCode(err), 'realpath')) : res(rp as string)));
    });
  }

  // ---- root confinement ----------------------------------------------------
  private isWithinRoot(canonical: string): boolean {
    const root = this.rootCanonical;
    return root !== null && (canonical === root || canonical.startsWith(root + '/'));
  }

  /** Canonicalize the session root once; fail-closed if it is not an accessible directory. */
  async ensureRoot(): Promise<void> {
    this.assertOpen();
    let canonical: string;
    try { canonical = await this.realpathRaw(this.root); }
    catch (err: any) {
      throw Object.assign(new Error('session root is not an accessible directory'), { code: 'invalid_root', cause: err });
    }
    let st: Stats;
    try { st = await this.lstatRaw(canonical); }
    catch (err: any) {
      throw Object.assign(new Error('session root is not an accessible directory'), { code: 'invalid_root', cause: err });
    }
    if (typeFromPerms(st.mode ?? 0) !== 'directory')
      throw Object.assign(new Error('session root is not a directory'), { code: 'invalid_root' });
    this.rootCanonical = canonical;
  }

  /** Fail-closed: the exact existing object must resolve to a path inside the canonical root. */
  private async requireExistingWithinRoot(path: string): Promise<string> {
    const canonical = await this.realpathRaw(path); // throws no_such_file / permission_denied / sftp_failure
    if (!this.isWithinRoot(canonical))
      throw Object.assign(new Error('path escapes the session root'), { code: 'outside_root' });
    return canonical;
  }

  /**
   * Fail-closed for create/upload/rename destinations: canonicalize the closest
   * required existing parent, prove it is inside the canonical root, and return it
   * so the operation can be applied to the final basename under the canonical parent.
   */
  private async requireParentWithinRoot(dest: string): Promise<string> {
    const parent = parentPath(dest);
    const canonical = await this.realpathRaw(parent); // throws no_such_file / permission_denied / sftp_failure
    if (!this.isWithinRoot(canonical))
      throw Object.assign(new Error('destination escapes the session root'), { code: 'outside_root' });
    return canonical;
  }

  /**
   * lstat a path for its type and (for symlinks) target. Returns null when the
   * object does not exist (ENOENT); other SFTP errors propagate.
   */
  private async lstatOrNull(path: string): Promise<Stats | null> {
    try { return await this.lstatRaw(path); }
    catch (err: any) {
      if (err?.code === 'no_such_file') return null;
      throw err;
    }
  }

  // ---- SftpHandle API ------------------------------------------------------
  async list(dir: string): Promise<DirEntry[]> {
    this.assertOpen();
    const canonical = await this.requireExistingWithinRoot(dir);
    const st = await this.lstatRaw(canonical);
    if (typeFromPerms(st.mode ?? 0) !== 'directory')
      throw Object.assign(new Error('path is not a directory'), { code: 'not_a_directory' });
    const entries = await new Promise<any[]>((res, rej) => {
      this.sftp.readdir(canonical, (err, list) => (err ? rej(mapSftpStatus(this.errCode(err), 'readdir')) : res(list as any[])));
    });
    return entries.map((e: any) => {
      const attrs = e.attrs ?? {};
      const perms: number = attrs.mode ?? attrs.permissions ?? 0;
      return { name: String(e.filename), type: typeFromPerms(perms), size: attrs.size ?? 0, mtime: attrs.mtime ?? 0 };
    });
  }

  async stat(path: string): Promise<FileStat> {
    this.assertOpen();
    // lstat first so a missing leaf yields no_such_file (fail-closed), then
    // canonicalize the existing object to prove it stays inside the canonical root.
    const st = await this.lstatRaw(path);
    await this.requireExistingWithinRoot(path);
    const perms: number = st.mode ?? 0;
    const type = typeFromPerms(perms);
    const out: FileStat = { type, size: st.size ?? 0, mtime: st.mtime ?? 0, permissions: perms };
    if (type === 'symlink') { try { out.target = await this.readlinkRaw(path); } catch { /* best effort */ } }
    return out;
  }

  async mkdir(path: string): Promise<void> {
    this.assertOpen();
    const canonicalParent = await this.requireParentWithinRoot(path);
    const base = basenameOf(path);
    const target = canonicalParent + (base === '' ? '' : '/' + base);
    // Re-check the destination: if it already exists as a symlink escaping the root,
    // reject rather than create underneath it.
    const existing = await this.lstatOrNull(target);
    if (existing) {
      if (typeFromPerms(existing.mode ?? 0) === 'symlink')
        await this.requireExistingWithinRoot(target);
      else throw Object.assign(new Error('destination already exists'), { code: 'exists' });
    }
    await new Promise<void>((res, rej) => {
      this.sftp.mkdir(target, {}, (err) => (err ? rej(mapSftpStatus(this.errCode(err), 'mkdir')) : res()));
    });
  }

  async rename(from: string, to: string): Promise<void> {
    this.assertOpen();
    // Source: the exact existing object must resolve inside the canonical root.
    await this.requireExistingWithinRoot(from);
    // Destination: canonicalize the closest existing parent; operate on the basename.
    const canonicalDestParent = await this.requireParentWithinRoot(to);
    const destBase = basenameOf(to);
    const canonicalDest = canonicalDestParent + (destBase === '' ? '' : '/' + destBase);
    const destExisting = await this.lstatOrNull(canonicalDest);
    if (destExisting) {
      // A symlink destination must itself stay inside the root; a regular
      // directory/file destination is a same-directory move (allowed).
      if (typeFromPerms(destExisting.mode ?? 0) === 'symlink')
        await this.requireExistingWithinRoot(canonicalDest);
      else if (typeFromPerms(destExisting.mode ?? 0) === 'directory')
        throw Object.assign(new Error('destination directory already exists'), { code: 'exists' });
    }
    const source = await this.realpathRaw(from);
    await new Promise<void>((res, rej) => {
      this.sftp.rename(source, canonicalDest, (err) => (err ? rej(mapSftpStatus(this.errCode(err), 'rename')) : res()));
    });
  }

  async unlink(path: string): Promise<void> {
    this.assertOpen();
    // lstat first: a missing object is no_such_file (fail-closed).
    const st = await this.lstatRaw(path);
    if (typeFromPerms(st.mode ?? 0) === 'symlink') {
      // Deleting a symlink itself: the link's own location must be inside the root
      // (its TARGET may point outside; unlink removes the link, not the target).
      await this.requireParentWithinRoot(path);
    } else {
      // Deleting a regular file/directory: the object must resolve inside the root.
      await this.requireExistingWithinRoot(path);
    }
    await new Promise<void>((res, rej) => {
      this.sftp.unlink(path, (err) => (err ? rej(mapSftpStatus(this.errCode(err), 'unlink')) : res()));
    });
  }

  async rmdir(path: string): Promise<void> {
    this.assertOpen();
    const st = await this.lstatRaw(path);
    if (typeFromPerms(st.mode ?? 0) === 'symlink') {
      // A symlink is not a directory; rmdir on it should fail (not a directory).
      throw Object.assign(new Error('path is not a directory'), { code: 'not_a_directory' });
    }
    await this.requireExistingWithinRoot(path);
    await new Promise<void>((res, rej) => {
      this.sftp.rmdir(path, (err) => (err ? rej(mapSftpStatus(this.errCode(err), 'rmdir')) : res()));
    });
  }

  async upload(src: Readable, dest: string, opts?: SftpUploadOptions): Promise<void> {
    this.assertOpen();
    // Canonicalize the closest existing parent; operate on the basename.
    const canonicalParent = await this.requireParentWithinRoot(dest);
    const base = basenameOf(dest);
    if (base === '') throw Object.assign(new Error('destination is the session root'), { code: 'root_operation' });
    const canonicalDest = canonicalParent + '/' + base;
    const destSt = await this.lstatOrNull(canonicalDest);
    if (destSt) {
      if (!opts?.overwrite) throw Object.assign(new Error('destination already exists (use overwrite)'), { code: 'exists' });
      if (typeFromPerms(destSt.mode ?? 0) === 'directory')
        throw Object.assign(new Error('destination is a directory'), { code: 'not_a_file' });
      // Overwriting a symlink that escapes the root: reject (do not write through it).
      if (typeFromPerms(destSt.mode ?? 0) === 'symlink') await this.requireExistingWithinRoot(canonicalDest);
    }
    const temp = canonicalParent + '/.rd-tmp-' + randomUUID();
    try {
      await this.writeAll(temp, src);
      await new Promise<void>((res, rej) => {
        this.sftp.rename(temp, canonicalDest, (err) => (err ? rej(mapSftpStatus(this.errCode(err), 'rename')) : res()));
      });
    } catch (err) {
      // The temp file is created on the first write, so it may exist even when
      // writeAll fails mid-stream (e.g. the source is aborted). Await best-effort
      // cleanup (no .rd-tmp-* left behind) before surfacing the error.
      try { await new Promise<void>((res) => this.sftp.unlink(temp, () => res())); } catch { /* ignore */ }
      throw err;
    }
  }

  private writeAll(path: string, src: Readable): Promise<void> {
    return new Promise<void>((res, rej) => {
      const ws: any = this.sftp.createWriteStream(path);
      let settled = false;
      let srcEnded = false;
      const cleanup = (): void => {
        try { ws.removeListener('open', onOpen); } catch { /* */ }
        try { ws.removeListener('finish', onOk); } catch { /* */ }
        try { ws.removeListener('close', onClose); } catch { /* */ }
        try { src.removeListener('end', onSrcEnd); } catch { /* */ }
        try { src.removeListener('close', onSrcClose); } catch { /* */ }
        // Keep the 'error' listeners (onErr) attached on both streams: a
        // connection-level error can arrive AFTER the upload settles (during
        // teardown) and must not become an uncaught exception. onErr is a
        // no-op once settled.
      };
      const ok = (): void => { if (settled) return; settled = true; cleanup(); res(); };
      const fail = (e: Error): void => {
        if (settled) return; settled = true; cleanup();
        try { ws.destroy?.(); } catch { /* */ }
        rej(e);
      };
      const onOpen = (): void => { try { src.pipe(ws); } catch (e) { fail(e as Error); } };
      // 'finish' (if the ssh2 version emits it) is unambiguous success.
      const onOk = (): void => { ok(); };
      // ssh2's SFTP write stream signals normal completion via 'close' (it does
      // NOT emit 'finish'), and a SFTP write failure also surfaces as 'close'
      // (with the Writable's state marked errored) rather than an 'error' event.
      // So a 'close' is success only when (a) no write error was recorded and
      // (b) the source fully ended (end() was propagated). Any other close is a
      // premature/failed close and must not be treated as success.
      const onClose = (): void => {
        if (settled) return;
        const wsErr = ws._writableState?.errored;
        if (wsErr) {
          fail(wsErr instanceof Error ? wsErr : Object.assign(new Error('write failed'), { code: 'sftp_failure' }));
          return;
        }
        if (srcEnded || ws._writableState?.ended) { ok(); return; }
        fail(Object.assign(new Error('write stream closed before completion'), { code: 'sftp_failure' }));
      };
      const onErr = (e: Error): void => { fail(e); };
      const onSrcEnd = (): void => { srcEnded = true; };
      // A source 'close' without a preceding 'end' means it was aborted/destroyed
      // before the upload completed.
      const onSrcClose = (): void => {
        if (!srcEnded && !settled)
          fail(Object.assign(new Error('source stream aborted before completion'), { code: 'sftp_failure' }));
      };
      ws.on('open', onOpen);
      ws.on('finish', onOk);
      ws.on('close', onClose);
      ws.on('error', onErr);
      src.on('end', onSrcEnd);
      src.on('close', onSrcClose);
      src.on('error', onErr);
    });
  }

  async download(path: string): Promise<Readable> {
    this.assertOpen();
    // Canonical resolution of the exact existing object (fail-closed), then lstat.
    await this.requireExistingWithinRoot(path);
    const st = await this.lstatRaw(path);
    const type = typeFromPerms(st.mode ?? 0);
    if (type === 'directory')
      throw Object.assign(new Error('path is a directory'), { code: 'not_a_file' });
    const canonical = await this.realpathRaw(path);
    const rs = this.sftp.createReadStream(canonical) as unknown as Readable;
    // The consumer (for-await) drives the stream; a connection-level error
    // (e.g. "No response from server") after the handle closes must not surface
    // as an unhandled 'error' once the consumer is done.
    rs.on('error', () => undefined);
    return rs;
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    try { this.sftp.end(); } catch { /* ignore */ }
    this.onClose();
    this.emit('close');
  }
}

/** Final basename of an absolute POSIX path (empty for a bare directory root). */
function basenameOf(p: string): string {
  const n = p.replace(/\/+$/, '');
  const i = n.lastIndexOf('/');
  return i < 0 ? n : n.slice(i + 1);
}

export class SftpSsh2Transport implements SftpTransport {
  private readonly readyTimeoutMs: number;

  constructor(opts: { readyTimeoutMs?: number } = {}) {
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 20_000;
  }

  async observeFingerprint(target: TransportTarget): Promise<string> {
    let fp: string | null = null;
    const client = await connectSsh(target, {
      skipAuth: true,
      resolveOnClose: true,
      keepaliveInterval: 0,
      keepaliveCountMax: 0,
      readyTimeoutMs: this.readyTimeoutMs,
      onFingerprint: (f) => { fp = f; },
    });
    try { client.end(); } catch { /* ignore */ }
    if (!fp) { const e = new Error('ssh_observe_failed'); (e as any).code = 'unreachable'; throw e; }
    return fp;
  }

  async connectSftp(target: TransportTarget, expectedFingerprint: string, rootPath: string): Promise<SftpHandle> {
    let client;
    try {
      client = await connectSsh(target, {
        expectedFingerprint,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        readyTimeoutMs: this.readyTimeoutMs,
      });
    } catch (err) {
      throw mapConnectError(err);
    }
    let sftp: SFTPWrapper;
    try {
      sftp = await new Promise<SFTPWrapper>((res, rej) => {
        client.sftp((err, s) => (err ? rej(err) : res(s as SFTPWrapper)));
      });
    } catch (err) {
      try { client.end(); } catch { /* ignore */ }
      const e = new Error('sftp subsystem failed to open');
      (e as any).code = 'subsystem_failed';
      throw e;
    }
    // Connection-level SFTP errors (e.g. "No response from server" surfaced when
    // the connection drops while requests are in flight) must not become uncaught
    // exceptions; per-operation errors are delivered through each operation's callback.
    sftp.on('error', () => undefined);
    const handle = new SftpHandleImpl({ sftp, root: rootPath, onClose: () => this.closeClient(client) });
    client.on('close', () => { if (!handle.closed) handle.close(); });
    try {
      await handle.ensureRoot(); // fail session creation if the root is not an accessible directory
    } catch (err) {
      try { client.end(); } catch { /* ignore */ }
      handle.close();
      throw err;
    }
    return handle;
  }

  private closeClient(client: { end?: () => void; destroy?: () => void }): void {
    try { client.end?.(); } catch { /* ignore */ }
  }
}
