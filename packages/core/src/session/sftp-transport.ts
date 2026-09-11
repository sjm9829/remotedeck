// SFTP transport abstraction (interface + fake). The real ssh2-backed
// implementation lives in apps/core-server (transport-sftp.ts). The fake drives
// SFTP SESSION MANAGER unit tests (lifecycle, idle close, multi-session
// isolation, stale cleanup) with an in-memory filesystem.

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { TransportTarget } from './transport.js';

export type RemoteFileType = 'file' | 'directory' | 'symlink' | 'other';

export interface DirEntry { name: string; type: RemoteFileType; size: number; mtime: number; }

export interface FileStat {
  type: RemoteFileType;
  size: number;
  mtime: number;
  permissions: number;
  /** Resolved symlink target (absolute remote path), only present for symlinks. */
  target?: string;
}

export interface SftpUploadOptions {
  /** Overwrite an existing destination. Default false -> rejects with `exists`. */
  overwrite?: boolean;
}

export interface SftpHandle extends EventEmitter {
  list(dir: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Delete a file or symlink. */
  unlink(path: string): Promise<void>;
  /** Delete an empty directory; rejects (not_empty) if non-empty. */
  rmdir(path: string): Promise<void>;
  /** Atomic upload: write to a temp name, then rename over dest. */
  upload(src: Readable, dest: string, opts?: SftpUploadOptions): Promise<void>;
  /** Streamed download (bounded memory, no full-content buffering). */
  download(path: string): Promise<Readable>;
  close(): void;
  readonly closed: boolean;
}

export interface SftpTransport {
  /** Open a connection solely to observe the host key fingerprint. */
  observeFingerprint(target: TransportTarget): Promise<string>;
  /** Open an SFTP session rooted at rootPath, verifying the fingerprint. */
  connectSftp(target: TransportTarget, expectedFingerprint: string, rootPath: string): Promise<SftpHandle>;
}

// ---- Fake ------------------------------------------------------------------

interface FakeFsNode { type: RemoteFileType; data: Buffer; target: string; }

export interface FakeSftpTransportOptions {
  fingerprint?: string;
  failObserve?: boolean;
  failConnect?: boolean;
  /** Simulate a fingerprint mismatch: observed equals this, expected is passed through. */
  observedFingerprint?: string;
  expectedRoot?: string;
}

export class FakeSftpTransport implements SftpTransport {
  readonly fingerprint: string;
  readonly failObserve: boolean;
  readonly failConnect: boolean;
  readonly observed: string;
  readonly lastObserveTarget: TransportTarget | null = null;
  readonly lastConnectTarget: TransportTarget | null = null;
  readonly lastConnectRoot: string | null = null;
  readonly handles: FakeSftpHandle[] = [];
  private readonly root: string;
  /** Simple in-memory FS shared across handles (multi-session isolation). */
  readonly fs = new Map<string, FakeFsNode>();

  constructor(opts: FakeSftpTransportOptions = {}) {
    this.fingerprint = opts.fingerprint ?? 'SHA256:FakeFingerprint';
    this.observed = opts.observedFingerprint ?? this.fingerprint;
    this.failObserve = opts.failObserve ?? false;
    this.failConnect = opts.failConnect ?? false;
    this.root = opts.expectedRoot ?? '/root';
  }

  async observeFingerprint(target: TransportTarget): Promise<string> {
    if (this.failObserve) { const e = new Error('fake observe failed'); (e as any).code = 'unreachable'; throw e; }
    return this.observed;
  }

  async connectSftp(target: TransportTarget, expectedFingerprint: string, rootPath: string): Promise<SftpHandle> {
    if (this.failConnect) { const e = new Error('fake connect failed'); (e as any).code = 'unreachable'; throw e; }
    const expected = expectedFingerprint.replace(/=+$/g, '');
    const observed = this.observed.replace(/=+$/g, '');
    if (expected !== observed) { const e = new Error('fingerprint_mismatch'); (e as any).code = 'fingerprint_mismatch'; throw e; }
    void target;
    void rootPath;
    const h = new FakeSftpHandle(this.fs, this.root);
    this.handles.push(h);
    return h;
  }
}

class FakeSftpHandle extends EventEmitter implements SftpHandle {
  private fs: Map<string, FakeFsNode>;
  private root: string;
  private isClosed = false;
  constructor(fs: Map<string, FakeFsNode>, root: string) {
    super();
    this.fs = fs;
    this.root = root;
  }
  get closed(): boolean { return this.isClosed; }
  close(): void { if (!this.isClosed) { this.isClosed = true; this.emit('close'); } }

  private norm(p: string): string {
    // Resolve a path to an absolute key, mirroring resolveWithinRoot. The manager
    // passes absolute (root-anchored) paths, but also accept relative-to-root paths
    // for direct (unit) callers.
    if (p === '' || p === '.' || p === '/') return this.root;
    const joined = p.startsWith('/') ? p : (this.root === '/' ? '/' + p : this.root + '/' + p);
    const parts = joined.split('/');
    const stack: string[] = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') { if (stack.length) stack.pop(); else stack.push('..'); continue; }
      stack.push(part);
    }
    const n = '/' + stack.join('/');
    if (this.root !== '/' && n !== this.root && !n.startsWith(this.root + '/'))
      throw Object.assign(new Error('outside_root'), { code: 'outside_root' });
    return n;
  }
  private ensure(p: string): void {
    if (this.isClosed) throw Object.assign(new Error('sftp_closed'), { code: 'session_closed' });
  }

  async list(dir: string): Promise<DirEntry[]> {
    this.ensure(dir);
    const n = this.norm(dir);
    const node = this.fs.get(n);
    if (!node || node.type !== 'directory') throw Object.assign(new Error('no_such_file'), { code: 'no_such_file' });
    const prefix = n + '/';
    const out: DirEntry[] = [];
    for (const [key, val] of this.fs.entries()) {
      if (key === n || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes('/')) continue; // only immediate children
      out.push({ name: rest, type: val.type, size: val.data.length, mtime: 0 });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async stat(path: string): Promise<FileStat> {
    this.ensure(path);
    const n = this.norm(path);
    const node = this.fs.get(n);
    if (!node) throw Object.assign(new Error('no_such_file'), { code: 'no_such_file' });
    const st: FileStat = { type: node.type, size: node.data.length, mtime: 0, permissions: node.type === 'directory' ? 0o40755 : 0o100644 };
    if (node.type === 'symlink') st.target = node.target;
    return st;
  }

  async mkdir(path: string): Promise<void> {
    this.ensure(path);
    const n = this.norm(path);
    if (this.fs.has(n)) throw Object.assign(new Error('exists'), { code: 'exists' });
    // Parent must exist and be a directory.
    const parent = n.slice(0, n.lastIndexOf('/'));
    if (parent !== '/' && !this.fs.has(parent)) throw Object.assign(new Error('no_such_file'), { code: 'no_such_file' });
    this.fs.set(n, { type: 'directory', data: Buffer.alloc(0), target: '' });
  }

  async rename(from: string, to: string): Promise<void> {
    this.ensure(from);
    const n1 = this.norm(from);
    const n2 = this.norm(to);
    const node = this.fs.get(n1);
    if (!node) throw Object.assign(new Error('no_such_file'), { code: 'no_such_file' });
    if (n2 === n1) return;
    this.fs.delete(n1);
    this.fs.set(n2, node);
  }

  async unlink(path: string): Promise<void> {
    this.ensure(path);
    const n = this.norm(path);
    const node = this.fs.get(n);
    if (!node) throw Object.assign(new Error('no_such_file'), { code: 'no_such_file' });
    if (node.type === 'directory') throw Object.assign(new Error('not_a_file'), { code: 'not_a_file' });
    this.fs.delete(n);
  }

  async rmdir(path: string): Promise<void> {
    this.ensure(path);
    const n = this.norm(path);
    const node = this.fs.get(n);
    if (!node) throw Object.assign(new Error('no_such_file'), { code: 'no_such_file' });
    if (node.type !== 'directory') throw Object.assign(new Error('not_a_directory'), { code: 'not_a_directory' });
    const prefix = n + '/';
    for (const key of this.fs.keys()) if (key.startsWith(prefix)) throw Object.assign(new Error('not_empty'), { code: 'not_empty' });
    this.fs.delete(n);
  }

  async upload(src: Readable, dest: string, opts?: SftpUploadOptions): Promise<void> {
    this.ensure(dest);
    const n = this.norm(dest);
    if (this.fs.has(n) && !opts?.overwrite) throw Object.assign(new Error('exists'), { code: 'exists' });
    const chunks: Buffer[] = [];
    for await (const c of src) chunks.push(c as Buffer);
    this.fs.set(n, { type: 'file', data: Buffer.concat(chunks), target: '' });
  }

  async download(path: string): Promise<Readable> {
    this.ensure(path);
    const n = this.norm(path);
    const node = this.fs.get(n);
    if (!node) throw Object.assign(new Error('no_such_file'), { code: 'no_such_file' });
    if (node.type === 'directory') throw Object.assign(new Error('not_a_file'), { code: 'not_a_file' });
    return Readable.from(node.data);
  }
}
