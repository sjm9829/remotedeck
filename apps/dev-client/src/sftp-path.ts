/** Client-side mirror of the server contract: every operation path is relative to the SFTP session root. */
export function normalizeSftpPath(path: string): string {
  if (path === '' || path === '.' || path === '/') return '';
  if (path.startsWith('/')) throw new Error('SFTP path must be relative to the session root');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) throw new Error('SFTP path escapes the session root');
      parts.pop();
    } else {
      for (let index = 0; index < part.length; index += 1) {
        const code = part.charCodeAt(index);
        if (code === 0 || code < 32 || code === 127) throw new Error('SFTP path contains a control character');
      }
      parts.push(part);
    }
  }
  return parts.join('/');
}

export function joinSftpPath(base: string, name: string): string {
  const normalizedBase = normalizeSftpPath(base);
  return normalizeSftpPath(normalizedBase ? `${normalizedBase}/${name}` : name);
}

export function parentSftpPath(path: string): string {
  const parts = normalizeSftpPath(path).split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}
