import { describe, expect, it } from 'vitest';
import { fileIcon, formatSize, sortEntries, type SftpEntry } from '../sftp-list.js';

const dir = (name: string): SftpEntry => ({ name, type: 'directory' });
const file = (name: string, size: number, mtime = 0): SftpEntry => ({ name, type: 'file', size, mtime });

describe('formatSize', () => {
  it('renders raw bytes under 1 KB', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
  });
  it('steps to KB/MB/GB on binary units', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(20480)).toBe('20 KB');
    expect(formatSize(1024 * 1024 * 3 + 1)).toBe('3.0 MB');
    expect(formatSize(1024 ** 3 * 2)).toBe('2.0 GB');
  });
  it('returns an empty string when size is undefined', () => {
    expect(formatSize(undefined)).toBe('');
  });
});

describe('sortEntries', () => {
  it('keeps directories grouped on top of files for name/asc', () => {
    const out = sortEntries([file('b.txt', 10), dir('zeta'), file('a.txt', 20), dir('alpha')], 'name', 'asc');
    expect(out.map((e) => e.name)).toEqual(['alpha', 'zeta', 'a.txt', 'b.txt']);
  });
  it('reverses the whole order for desc while keeping dirs above files', () => {
    const out = sortEntries([dir('alpha'), dir('zeta'), file('a.txt', 1), file('b.txt', 2)], 'name', 'desc');
    expect(out.map((e) => e.name)).toEqual(['zeta', 'alpha', 'b.txt', 'a.txt']);
  });
  it('sorts numerically by size when size key is active', () => {
    const out = sortEntries([file('small', 100), file('huge', 5000), file('mid', 500)], 'size', 'asc');
    expect(out.map((e) => e.name)).toEqual(['small', 'mid', 'huge']);
  });
  it('treats undefined size as zero', () => {
    const out = sortEntries([file('a', 5), { name: 'b', type: 'file' }], 'size', 'asc');
    expect(out.map((e) => e.name)).toEqual(['b', 'a']);
  });
  it('sorts by mtime when that key is active', () => {
    const out = sortEntries([file('newer', 1, 300), file('older', 1, 100), file('middle', 1, 200)], 'mtime', 'asc');
    expect(out.map((e) => e.name)).toEqual(['older', 'middle', 'newer']);
  });
});

describe('fileIcon', () => {
  it('uses the folder icon for directories and the document icon otherwise', () => {
    expect(fileIcon('directory')).toBe('📁');
    expect(fileIcon('file')).toBe('📄');
    expect(fileIcon('link')).toBe('📄');
  });
});
