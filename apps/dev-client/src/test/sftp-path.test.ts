import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { joinSftpPath, normalizeSftpPath, parentSftpPath } from '../sftp-path.js';

describe('SFTP relative path contract', () => {
  it('keeps every root operation relative instead of producing an absolute path', () => {
    expect(normalizeSftpPath('')).toBe('');
    expect(normalizeSftpPath('/')).toBe('');
    expect(joinSftpPath('', 'upload.txt')).toBe('upload.txt');
    expect(joinSftpPath('/', 'renamed.txt')).toBe('renamed.txt');
    expect(parentSftpPath('top')).toBe('');
  });

  it('builds nested list, upload, rename, and delete paths under the current relative directory', () => {
    expect(joinSftpPath('srv/data', 'child')).toBe('srv/data/child');
    expect(joinSftpPath('srv/data/', 'upload.txt')).toBe('srv/data/upload.txt');
    expect(joinSftpPath('srv/data', 'renamed.txt')).toBe('srv/data/renamed.txt');
    expect(joinSftpPath('srv/data', 'delete.txt')).toBe('srv/data/delete.txt');
    expect(parentSftpPath('srv/data')).toBe('srv');
    expect(parentSftpPath('srv')).toBe('');
  });

  it('does not normalize an absolute or escaping path into an accepted relative path', () => {
    expect(() => normalizeSftpPath('/srv/data')).toThrow('relative');
    expect(() => normalizeSftpPath('../outside')).toThrow('escapes');
  });

  it('routes all App file operations through the relative-path helper', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('function joinPath');
    expect(source.match(/joinSftpPath\(/g)?.length).toBeGreaterThanOrEqual(7);
    expect(source).toContain('parentSftpPath(sftpPath)');
  });
});
