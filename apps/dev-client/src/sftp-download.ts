// Large downloads should stream straight to disk through the browser's own download
// manager (native progress, no whole-file Blob in memory). That needs a plain URL the
// browser can fetch with its cookies, so it is only possible in same-origin mode;
// direct mode authenticates with a bearer header and must keep the Blob path.

export const STREAM_DOWNLOAD_THRESHOLD_BYTES = 16 * 1024 * 1024;

export function shouldStreamDownload(size: number | undefined, mode: 'direct' | 'same-origin'): boolean {
  return mode === 'same-origin' && typeof size === 'number' && size >= STREAM_DOWNLOAD_THRESHOLD_BYTES;
}

export interface BulkDeleteOutcome {
  deleted: string[];
  failed: { name: string; message: string }[];
}

/** Human-readable summary of a bulk delete, naming at most three failures. */
export function summarizeBulkDelete(outcome: BulkDeleteOutcome): string {
  const { deleted, failed } = outcome;
  if (failed.length === 0) return '';
  const shown = failed.slice(0, 3).map((item) => item.name).join(', ');
  const more = failed.length > 3 ? ` 외 ${failed.length - 3}개` : '';
  const first = failed[0].message ? ` · ${failed[0].message}` : '';
  return `${deleted.length}개 삭제, ${failed.length}개 실패 (${shown}${more})${first}`;
}
