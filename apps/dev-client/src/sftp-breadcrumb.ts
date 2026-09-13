// Breadcrumb path segments for SFTP navigation (DOM-free, unit-testable).
// Paths are session-root-relative, exactly as in `sftp-path.ts` (root is "").

import { normalizeSftpPath } from './sftp-path.js';

export interface Crumb {
  /** Display label; the root crumb uses "/". */
  label: string;
  /** Target path for this crumb ("" is the session root). */
  path: string;
}

/** Build clickable ancestor crumbs from the root down to `path`. */
export function breadcrumbs(path: string): Crumb[] {
  const normalized = normalizeSftpPath(path);
  const crumbs: Crumb[] = [{ label: '/', path: '' }];
  if (normalized === '') return crumbs;
  const parts = normalized.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    crumbs.push({ label: parts[i], path: parts.slice(0, i + 1).join('/') });
  }
  return crumbs;
}
