import { describe, expect, it } from 'vitest';
import { STREAM_DOWNLOAD_THRESHOLD_BYTES, shouldStreamDownload, summarizeBulkDelete } from '../sftp-download.js';

describe('sftp download policy', () => {
  it('streams only big files in same-origin mode', () => {
    expect(shouldStreamDownload(STREAM_DOWNLOAD_THRESHOLD_BYTES, 'same-origin')).toBe(true);
    expect(shouldStreamDownload(STREAM_DOWNLOAD_THRESHOLD_BYTES - 1, 'same-origin')).toBe(false);
    expect(shouldStreamDownload(undefined, 'same-origin')).toBe(false);
    expect(shouldStreamDownload(STREAM_DOWNLOAD_THRESHOLD_BYTES * 4, 'direct')).toBe(false);
  });
  it('summarizes partial bulk deletes', () => {
    expect(summarizeBulkDelete({ deleted: ['a'], failed: [] })).toBe('');
    const text = summarizeBulkDelete({ deleted: ['a', 'b'], failed: [{ name: 'x', message: 'not empty' }, { name: 'y', message: '' }, { name: 'z', message: '' }, { name: 'w', message: '' }] });
    expect(text).toContain('2개 삭제, 4개 실패');
    expect(text).toContain('x, y, z 외 1개');
    expect(text).toContain('not empty');
  });
});
