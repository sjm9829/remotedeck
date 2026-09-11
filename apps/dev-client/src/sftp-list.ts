// SFTP file-list presentation helpers (DOM-free, unit-testable).

export interface SftpEntry { name: string; type: string; size?: number; mtime?: number }
export type SortKey = 'name' | 'size' | 'mtime';
export type SortDir = 'asc' | 'desc';

/** Human-readable byte size (KB/MB/GB), base 1024. */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    value /= 1024;
    unit = u;
    if (value < 1024) break;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

/** Sort files and directories separately (dirs always grouped on top), then by key. */
export function sortEntries(entries: readonly SftpEntry[], key: SortKey, dir: SortDir): SftpEntry[] {
  const factor = dir === 'asc' ? 1 : -1;
  const compare = (a: SftpEntry, b: SftpEntry): number => {
    if (key === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    if (key === 'size') return (a.size ?? 0) - (b.size ?? 0);
    return (a.mtime ?? 0) - (b.mtime ?? 0);
  };
  const dirs = entries.filter((e) => e.type === 'directory').sort((a, b) => factor * compare(a, b));
  const files = entries.filter((e) => e.type !== 'directory').sort((a, b) => factor * compare(a, b));
  return [...dirs, ...files];
}

/** File-type icon for the list. */
export function fileIcon(type: string): string {
  return type === 'directory' ? '📁' : '📄';
}
