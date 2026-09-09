// Pure remote-path safety utilities for SFTP sessions. No I/O: these validate
// and normalize POSIX paths so the SFTP session root cannot be escaped.

export type PathErrorCode = 'invalid_path' | 'outside_root' | 'root_operation';

export class RemotePathError extends Error {
  readonly code: PathErrorCode;
  constructor(message: string, code: PathErrorCode) {
    super(message);
    this.name = 'RemotePathError';
    this.code = code;
  }
}

/** Reject NUL and ASCII control characters (and DEL) in a remote path. */
export function assertCleanPath(p: string): void {
  if (typeof p !== 'string') throw new RemotePathError('path must be a string', 'invalid_path');
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c === 0x00 || c < 0x20 || c === 0x7f)
      throw new RemotePathError('path contains a NUL or control character', 'invalid_path');
  }
}

/**
 * Lexically normalize an absolute or relative POSIX path: drop empty segments and
 * '.' and resolve '..'. A leading '..' that has nothing to pop is preserved (so a
 * relative path can be detected as escaping a root).
 */
export function normalizePosixPath(p: string): string {
  const isAbs = p.startsWith('/');
  const parts = p.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length) stack.pop();
      else if (!isAbs) stack.push('..');
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join('/');
  if (isAbs) return '/' + joined;
  return joined === '' ? '.' : joined;
}

/** Parent directory of an absolute POSIX path (returns '/' for a top-level path). */
export function parentPath(p: string): string {
  const n = normalizePosixPath(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
}

/**
 * Resolve a user-supplied path (relative to the session rootPath) to an absolute
 * remote path that is guaranteed to stay within rootPath.
 *
 * - '', '.' and '/' all denote the root itself.
 * - A leading '/' (other than bare '/') is rejected: paths are relative to root.
 * - NUL/control characters are rejected.
 * - A '..' that escapes the root is rejected (outside_root).
 *
 * Throws RemotePathError with code invalid_path / outside_root.
 */
export function resolveWithinRoot(rootPath: string, relPath: string): string {
  if (typeof relPath !== 'string') throw new RemotePathError('path must be a string', 'invalid_path');
  assertCleanPath(relPath);
  assertCleanPath(rootPath);
  const root = normalizePosixPath(rootPath);
  if (!root.startsWith('/')) throw new RemotePathError('rootPath must be an absolute POSIX path', 'invalid_path');
  const candidate = (relPath === '' || relPath === '.') ? '.' : relPath;
  if (candidate !== '.' && candidate.startsWith('/'))
    throw new RemotePathError('path must be relative to the session root', 'invalid_path');
  const joined = candidate === '.' ? root : root + '/' + candidate;
  const normalized = normalizePosixPath(joined);
  if (normalized !== root && !normalized.startsWith(root + '/'))
    throw new RemotePathError('path escapes the session root', 'outside_root');
  return normalized;
}

/** True when the given (already absolute, normalized) remote path IS the session root. */
export function isRemoteRoot(absPath: string, rootPath: string): boolean {
  return normalizePosixPath(absPath) === normalizePosixPath(rootPath);
}
