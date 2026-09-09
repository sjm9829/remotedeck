// Real ssh2-based SFTP transport. Uses the shared `connectSsh` factory (same
// auth + host-key-verify as the shell transport) and wraps the SFTP client with
// per-session path safety: rootPath (manager), symlink-escape checks, atomic
// temp+rename upload, and bounded-memory streams.

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

class SftpHandleImpl extends EventEmitter implements SftpHandle {
  private sftp: SFTPWrapper;
  private root: string;
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

  /** Fail-closed symlink-escape check: resolve the path fully (following symlinks)
   *  and ensure it stays within rootPath. Missing paths (creation ops) skip the check. */
  private async assertWithinRoot(path: string): Promise<void> {
    let resolved: string;
    try { resolved = await this.realpathRaw(path); } catch { return; }
    if (resolved !== this.root && !resolved.startsWith(this.root + '/'))
      throw Object.assign(new Error('symlink escapes the session root'), { code: 'outside_root' });
  }

  // ---- SftpHandle API ------------------------------------------------------
  async list(dir: string): Promise<DirEntry[]> {
    this.assertOpen();
    await this.assertWithinRoot(dir);
    const entries = await new Promise<any[]>((res, rej) => {
      this.sftp.readdir(dir, (err, list) => (err ? rej(mapSftpStatus(this.errCode(err), 'readdir')) : res(list as any[])));
    });
    return entries.map((e: any) => {
      const attrs = e.attrs ?? {};
      const perms: number = attrs.mode ?? attrs.permissions ?? 0;
      return { name: String(e.filename), type: typeFromPerms(perms), size: attrs.size ?? 0, mtime: attrs.mtime ?? 0 };
    });
  }

  async stat(path: string): Promise<FileStat> {
    this.assertOpen();
    const st = await this.lstatRaw(path);
    const perms: number = st.mode ?? 0;
    const type = typeFromPerms(perms);
    const out: FileStat = { type, size: st.size ?? 0, mtime: st.mtime ?? 0, permissions: perms };
    if (type === 'symlink') { try { out.target = await this.readlinkRaw(path); } catch { /* best effort */ } }
    await this.assertWithinRoot(path);
    return out;
  }

  async mkdir(path: string): Promise<void> {
    this.assertOpen();
    await new Promise<void>((res, rej) => {
      this.sftp.mkdir(path, {}, (err) => (err ? rej(mapSftpStatus(this.errCode(err), 'mkdir')) : res()));
    });
  }

  async rename(from: string, to: string): Promise<void> {
    this.assertOpen();
    await this.assertWithinRoot(from);
    await this.assertWithinRoot(to);
    await new Promise<void>((res, rej) => {
      this.sftp.rename(from, to, (err) => (err ? rej(mapSftpStatus(this.errCode(err), 'rename')) : res()));
    });
  }

  async unlink(path: string): Promise<void> {
    this.assertOpen();
    await this.assertWithinRoot(path);
    await new Promise<void>((res, rej) => {
      this.sftp.unlink(path, (err) => (err ? rej(mapSftpStatus(this.errCode(err), 'unlink')) : res()));
    });
  }

  async rmdir(path: string): Promise<void> {
    this.assertOpen();
    await this.assertWithinRoot(path);
    await new Promise<void>((res, rej) => {
      this.sftp.rmdir(path, (err) => (err ? rej(mapSftpStatus(this.errCode(err), 'rmdir')) : res()));
    });
  }

  async upload(src: Readable, dest: string, opts?: SftpUploadOptions): Promise<void> {
    this.assertOpen();
    let destExists = false;
    try { await this.lstatRaw(dest); destExists = true; } catch { destExists = false; }
    if (destExists && !opts?.overwrite)
      throw Object.assign(new Error('destination already exists (use overwrite)'), { code: 'exists' });
    if (destExists) await this.assertWithinRoot(dest);
    const dir = parentPath(dest);
    const temp = dir + '/.rd-tmp-' + randomUUID();
    try {
      await this.writeAll(temp, src);
      await new Promise<void>((res, rej) => {
        this.sftp.rename(temp, dest, (err) => (err ? rej(mapSftpStatus(this.errCode(err), 'rename')) : res()));
      });
    } catch (err) {
      this.sftp.unlink(temp, () => undefined); // best-effort temp cleanup on abort/error
      throw err;
    }
  }

  private writeAll(path: string, src: Readable): Promise<void> {
    return new Promise<void>((res, rej) => {
      const ws: any = this.sftp.createWriteStream(path);
      let settled = false;
      const ok = () => { if (!settled) { settled = true; res(); } };
      const errFn = (e: Error) => { if (!settled) { settled = true; try { ws.destroy?.(); } catch { /* */ } rej(e); } };
      ws.on('open', () => { src.pipe(ws); });
      ws.on('finish', ok);
      ws.on('close', ok);
      ws.on('error', errFn);
      src.on('error', errFn);
    });
  }

  async download(path: string): Promise<Readable> {
    this.assertOpen();
    // Fail-closed symlink-escape check first (realpath follows links), then lstat.
    await this.assertWithinRoot(path);
    const st = await this.lstatRaw(path);
    if (((st.mode ?? 0) & 0o170000) === 0o40000)
      throw Object.assign(new Error('path is a directory'), { code: 'not_a_file' });
    const rs = this.sftp.createReadStream(path) as unknown as Readable;
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

export class SftpSsh2Transport implements SftpTransport {
  private readonly readyTimeoutMs = 20_000;

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
    } catch (err: any) {
      const e = new Error('fingerprint_mismatch: host key changed or connection failed');
      (e as any).code = 'fingerprint_mismatch';
      throw e;
    }
    const sftp = await new Promise<SFTPWrapper>((res, rej) => {
      client.sftp((err, s) => (err ? rej(err) : res(s as SFTPWrapper)));
    });
    const handle = new SftpHandleImpl({ sftp, root: rootPath, onClose: () => this.closeClient(client) });
    client.on('close', () => { if (!handle.closed) handle.close(); });
    return handle;
  }

  private closeClient(client: { end?: () => void; destroy?: () => void }): void {
    try { client.end?.(); } catch { /* ignore */ }
  }
}
