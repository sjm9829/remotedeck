// In-process ssh2.Server SFTP fixture: a loopback SSH server with a full SFTP
// subsystem backed by an in-memory filesystem (MemFS). Exercises the REAL ssh2
// SFTP client path (SftpSsh2Transport) over loopback for roundtrip, bounded-memory
// streaming, overwrite/atomic-rename/temp-cleanup, and path-safety (traversal,
// NUL, symlink escape, root ops) tests.

import { randomBytes, createHash } from 'node:crypto';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import ssh2 from 'ssh2';

// cjs-module-lexer exposes the default export carrying both Client and Server.
const { Server } = ssh2 as any;

export interface MemFsNode { type: 'file' | 'directory' | 'symlink'; data: Buffer; target: string; }
export interface SftpFixtureHandle {
  stop(): Promise<void>;
  port: number;
  fingerprint: string; // padded (raw) host-key fingerprint; compare padding-insensitively
  fs: Map<string, MemFsNode>;
  /** Live SFTP write counters (streaming + temp-cleanup assertions). */
  state: { writes: number; tempWrites: string[] };
}

const TYPE_DIR = 0o40000;
const TYPE_REG = 0o100000;
const TYPE_LNK = 0o120000;
const STATUS_EOF = 1; // SFTP_STATUS_EOF — the client stops READDIR on a STATUS(EOF) response

function normPath(p: string): string {
  const isAbs = p.startsWith('/');
  const stack: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (stack.length) stack.pop(); else if (!isAbs) stack.push('..'); continue; }
    stack.push(part);
  }
  const j = stack.join('/');
  return isAbs ? '/' + j : j === '' ? '.' : j;
}
function parentOf(p: string): string {
  const n = normPath(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
}

function attrsFor(node: MemFsNode): any {
  const type = node.type === 'directory' ? TYPE_DIR : node.type === 'symlink' ? TYPE_LNK : TYPE_REG;
  // ssh2 serializes the SFTP permissions field from `attrs.mode` (not `permissions`).
  return {
    mode: type | (node.type === 'directory' ? 0o755 : 0o644),
    size: node.data.length,
    atime: 0, mtime: 0, uid: 0, gid: 0,
  };
}
function longnameFor(name: string, node: MemFsNode): string {
  const perms = node.type === 'directory' ? 'drwxr-xr-x' : node.type === 'symlink' ? 'lrwxrwxrwx' : '-rw-r--r--';
  return perms + ' 1 root root ' + node.data.length + ' ' + name;
}

export interface SftpFixtureOptions {
  hostKeyPem: string;
  hostKeyWire: Buffer;
  userKeyBlob?: Buffer;
  username?: string;
  password?: string;
  root: string;
  seed?: Map<string, MemFsNode>;
  /**
   * Fail WRITE operations once more than this many writes have been served
   * (return SFTP_FAILURE). 0/undefined = never fail. Used to exercise the
   * premature write-stream close path (a failed SFTP WRITE surfaces as a
   * write-stream 'close' with the Writable marked errored, not an 'error').
   */
  failWriteAfter?: number;
}

export async function startSftpFixture(opts: SftpFixtureOptions): Promise<SftpFixtureHandle> {
  if (!opts || !opts.hostKeyPem) throw new Error('hostKeyPem required');
  const fs = new Map<string, MemFsNode>();
  const setDir = (p: string): void => { fs.set(p, { type: 'directory', data: Buffer.alloc(0), target: '' }); };
  setDir(opts.root);
  for (const [k, v] of opts.seed ?? new Map()) fs.set(normPath(k), v);

  const handles = new Map<string, { kind: 'dir' | 'file'; path: string; read: boolean; pos: number }>();
  let handleSeq = 0;
  const newHandle = (kind: 'dir' | 'file', path: string): Buffer => {
    const h = 'h' + (++handleSeq);
    handles.set(h, { kind, path, read: false, pos: 0 });
    return Buffer.from(h);
  };
  const state = { writes: 0, tempWrites: [] as string[] };

  // Realpath that follows symlinks in every component (so an intermediate symlink
  // pointing outside the root is resolved, enabling fail-closed escape checks).
  const realpath = (raw: string): string => {
    const clean = (p: string): string[] => p.split('/').filter((c) => c !== '' && c !== '.');
    const comps = clean(raw);
    const out: string[] = [];
    let i = 0;
    let guard = 0;
    while (i < comps.length) {
      const c = comps[i++];
      if (c === '..') { if (out.length) out.pop(); continue; }
      const curPath = '/' + out.join('/') + (out.length ? '/' : '') + c;
      const node = fs.get(curPath);
      if (node && node.type === 'symlink') {
        if (++guard > 32) break; // avoid symlink loops
        const t = node.target;
        const abs = t.startsWith('/');
        if (abs) out.length = 0; // absolute target replaces the current prefix
        const tc = clean(t);
        comps.splice(i, 0, ...tc);
        continue;
      }
      out.push(c);
    }
    return '/' + out.join('/');
  };

  const server = new Server({ hostKeys: [opts.hostKeyPem] }, (client: any) => {
    // Disconnecting a fixture can interrupt an unfinished SSH handshake.
    client.on('error', () => undefined);
    client.on('authentication', (ctx: any) => {
      if (ctx.method === 'password') {
        const ok = !opts.username || (ctx.username === opts.username && ctx.password === opts.password);
        ok ? ctx.accept() : ctx.reject();
      } else if (ctx.method === 'publickey') {
        const ok = opts.userKeyBlob ? Buffer.compare(Buffer.from(ctx.key.data), opts.userKeyBlob) === 0 : true;
        ok ? ctx.accept() : ctx.reject();
      } else {
        ctx.reject();
      }
    });
    client.on('ready', () => {
      client.on('session', (acc: any, rej: any) => {
        const session = acc();
        session.on('sftp', (sftpAcc: any, sftpRej: any) => {
          const sftp = sftpAcc();
          const status = (id: number, code: number = 0): void => { try { sftp.status(id, code); } catch { /* */ } };
          const handle = (id: number, h: Buffer): void => { try { sftp.handle(id, h); } catch { /* */ } };
          const name = (id: number, entries: any[]): void => { try { sftp.name(id, entries); } catch { /* */ } };
          const attrs = (id: number, a: any): void => { try { sftp.attrs(id, a); } catch { /* */ } };
          const data = (id: number, buf: Buffer): void => { try { sftp.data(id, buf); } catch { /* */ } };

          sftp.on('REALPATH', (id: number, p: Buffer) => {
            const rp = realpath(p.toString());
            if (fs.has(rp) || normPath(p.toString()) === opts.root) {
              const node = fs.get(rp) ?? { type: 'directory' as const, data: Buffer.alloc(0), target: '' };
              name(id, [{ filename: rp, longname: longnameFor(rp, node), attrs: attrsFor(node) }]);
            } else status(id, 2); // no such file
          });

          sftp.on('OPENDIR', (id: number, p: Buffer) => {
            const n = normPath(p.toString());
            const node = fs.get(n);
            if (!node || node.type !== 'directory') return status(id, 2);
            handle(id, newHandle('dir', n));
          });

          sftp.on('READDIR', (id: number, h: Buffer) => {
            const rec = handles.get(h.toString());
            if (!rec) return status(id, 2);
            if (rec.read) return status(id, STATUS_EOF); // EOF after the single batch
            rec.read = true;
            const prefix = rec.path + '/';
            const out: any[] = [];
            for (const [key, val] of fs.entries()) {
              if (key === rec.path || !key.startsWith(prefix)) continue;
              const rest = key.slice(prefix.length);
              if (rest.includes('/')) continue;
              out.push({ filename: rest, longname: longnameFor(rest, val), attrs: attrsFor(val) });
            }
            out.sort((a, b) => a.filename.localeCompare(b.filename));
            name(id, out);
          });

          // POSIX lstat: follow intermediate symlinks, do NOT follow the final
          // component (so a symlink leaf still reports as a symlink).
          const lstatResolve = (raw: string): string => {
            const n = normPath(raw);
            const base = n.split('/').pop() ?? '';
            const parent = parentOf(n);
            const parentCanon = parent === '/' ? '/' : realpath(parent);
            return parentCanon === '/' ? '/' + base : parentCanon + '/' + base;
          };
          sftp.on('LSTAT', (id: number, p: Buffer) => {
            const node = fs.get(lstatResolve(p.toString()));
            if (!node) return status(id, 2);
            attrs(id, attrsFor(node));
          });
          sftp.on('STAT', (id: number, p: Buffer) => {
            const n = realpath(p.toString());
            const node = fs.get(n);
            if (!node) return status(id, 2);
            attrs(id, attrsFor(node));
          });
          sftp.on('FSTAT', (id: number, h: Buffer) => {
            const rec = handles.get(h.toString());
            if (!rec) return status(id, 2);
            const node = fs.get(rec.path);
            if (!node) return status(id, 2);
            attrs(id, attrsFor(node));
          });
          sftp.on('READLINK', (id: number, p: Buffer) => {
            const n = normPath(p.toString());
            const node = fs.get(n);
            if (!node || node.type !== 'symlink') return status(id, 2);
            name(id, [{ filename: node.target, longname: node.target, attrs: {} }]);
          });

          sftp.on('OPEN', (id: number, p: Buffer, flags: number) => {
            const n = realpath(normPath(p.toString())); // follow symlinks to the real target
            // SFTP OPEN_MODE bitmask: READ=0x01, WRITE=0x02, APPEND=0x04, CREAT=0x08, TRUNC=0x10, EXCL=0x20
            const write = (flags & 0x02) !== 0;
            const create = (flags & 0x08) !== 0;
            let node = fs.get(n);
            if ((write || create) && !node) { node = { type: 'file', data: Buffer.alloc(0), target: '' }; fs.set(n, node); }
            if (!node || node.type === 'directory') return status(id, 2);
            const hbuf = newHandle('file', n);
            const rec = handles.get(hbuf.toString())!;
            if (write) rec.pos = 0;
            handle(id, hbuf);
          });

          sftp.on('WRITE', (id: number, h: Buffer, off: number, buf: Buffer) => {
            const rec = handles.get(h.toString());
            if (!rec) return status(id, 2);
            state.writes++;
            if (rec.path.startsWith('.') && rec.path.includes('.rd-tmp-')) state.tempWrites.push(rec.path);
            // Optional write failure (exercises premature write-stream close).
            if (opts.failWriteAfter !== undefined && state.writes > opts.failWriteAfter) return status(id, 4); // SFTP_FAILURE
            const node = fs.get(rec.path)!;
            const data = Buffer.alloc(off + buf.length);
            node.data.copy(data, 0);
            buf.copy(data, off);
            node.data = data;
            status(id, 0);
          });

          sftp.on('READ', (id: number, h: Buffer, off: number, len: number) => {
            const rec = handles.get(h.toString());
            if (!rec) return status(id, 2);
            const node = fs.get(rec.path);
            if (!node) return status(id, 2);
            const end = off + len;
            if (off >= node.data.length) { data(id, Buffer.alloc(0)); status(id, 1); return; } // EOF
            const chunk = node.data.subarray(off, Math.min(end, node.data.length));
            data(id, chunk);
          });

          sftp.on('CLOSE', (id: number, h: Buffer) => { handles.delete(h.toString()); status(id, 0); });
          sftp.on('FSYNC', (id: number, h: Buffer) => { status(id, 0); });

          sftp.on('MKDIR', (id: number, p: Buffer) => {
            const n = normPath(p.toString());
            if (fs.has(n)) return status(id, 4); // failure (exists)
            const parent = parentOf(n);
            const pnode = fs.get(parent);
            if (!pnode || pnode.type !== 'directory') return status(id, 2);
            fs.set(n, { type: 'directory', data: Buffer.alloc(0), target: '' });
            status(id, 0);
          });
          sftp.on('RMDIR', (id: number, p: Buffer) => {
            const n = normPath(p.toString());
            const node = fs.get(n);
            if (!node) return status(id, 2);
            if (node.type !== 'directory') return status(id, 4);
            const prefix = n + '/';
            for (const key of fs.keys()) if (key.startsWith(prefix)) return status(id, 69); // not empty (SFTP_ENOTEMPTY=69)
            fs.delete(n); status(id, 0);
          });
          sftp.on('REMOVE', (id: number, p: Buffer) => {
            const n = normPath(p.toString());
            const node = fs.get(n);
            if (!node) return status(id, 2);
            if (node.type === 'directory') return status(id, 4);
            fs.delete(n); status(id, 0);
          });
          sftp.on('RENAME', (id: number, from: Buffer, to: Buffer) => {
            const n1 = normPath(from.toString());
            const n2 = normPath(to.toString());
            const node = fs.get(n1);
            if (!node) return status(id, 2);
            fs.delete(n1); fs.set(n2, node); status(id, 0);
          });
          sftp.on('SYMLINK', (id: number, a: Buffer, b: Buffer) => {
            // ssh2 client sends (id, linkPath, targetPath) for SYMLINK.
            const node: MemFsNode = { type: 'symlink', data: Buffer.alloc(0), target: b.toString() };
            fs.set(normPath(a.toString()), node); status(id, 0);
          });
          sftp.on('SETSTAT', (id: number, _p: Buffer, _a: any) => status(id, 0));
          sftp.on('FSETSTAT', (id: number, _h: Buffer, _a: any) => status(id, 0));
        });
      });
    });
  });

  // Own the TCP listener so teardown also covers clients that have not yet
  // completed the SSH handshake (and never emitted SSH 'connection').
  const sockets = new Set<Socket>();
  const listener = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    server.injectSocket(socket);
  });
  await new Promise<void>((res, rej) => { listener.once('error', rej); listener.listen(0, '127.0.0.1', () => res()); });
  const port = (listener.address() as AddressInfo).port;
  let stopping: Promise<void> | undefined;
  // Fingerprint of the host key (padded base64, matching the raw wire key).
  const fingerprint = 'SHA256:' + createHash('sha256').update(opts.hostKeyWire).digest('base64').replace(/=+$/g, '');
  return {
    port,
    fingerprint,
    fs,
    state,
    stop: () => {
      stopping ??= new Promise<void>((resolve, reject) => {
        // Start closing before awaiting completion; net.Server waits for all
        // accepted sockets, so explicitly close them even after a failed test.
        listener.close((error) => error ? reject(error) : resolve());
        for (const socket of sockets) socket.destroy();
      });
      return stopping;
    },
  };
}
