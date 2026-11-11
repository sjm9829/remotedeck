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

/**
 * Compact modified-time label from a Unix timestamp in seconds. Same year: `MM-DD HH:mm`;
 * older: `YYYY-MM-DD`. Zero/absent timestamps (some servers omit them) render as an empty cell.
 */
export function formatMtime(mtimeSeconds: number | undefined, now: Date = new Date()): string {
  if (!mtimeSeconds || mtimeSeconds <= 0) return '';
  const d = new Date(mtimeSeconds * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getFullYear()}-${date}`;
}

export interface SelectionSummary { count: number; files: number; folders: number; bytes: number }

/** Totals for the status bar: how many items are selected and the combined size of the files. */
export function summarizeSelection(entries: readonly SftpEntry[], selected: ReadonlySet<string>): SelectionSummary {
  let files = 0; let folders = 0; let bytes = 0;
  for (const entry of entries) {
    if (!selected.has(entry.name)) continue;
    if (entry.type === 'directory') folders += 1; else { files += 1; bytes += entry.size ?? 0; }
  }
  return { count: files + folders, files, folders, bytes };
}

/** `폴더 2 · 파일 14` style listing summary. */
export function listingSummary(entries: readonly SftpEntry[]): string {
  const folders = entries.filter((entry) => entry.type === 'directory').length;
  const files = entries.length - folders;
  if (entries.length === 0) return '비어 있음';
  return [folders ? `폴더 ${folders}` : '', files ? `파일 ${files}` : ''].filter(Boolean).join(' · ');
}
