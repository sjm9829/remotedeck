import { describe, expect, it } from 'vitest';
import { breadcrumbs } from '../sftp-breadcrumb.js';

describe('breadcrumbs', () => {
  it('is just the root at the session root', () => {
    expect(breadcrumbs('')).toEqual([{ label: '/', path: '' }]);
    expect(breadcrumbs('/')).toEqual([{ label: '/', path: '' }]);
  });
  it('builds a crumb per segment down to the current path', () => {
    expect(breadcrumbs('a/b/c')).toEqual([
      { label: '/', path: '' },
      { label: 'a', path: 'a' },
      { label: 'b', path: 'a/b' },
      { label: 'c', path: 'a/b/c' },
    ]);
  });
  it('normalizes a leading-slash-free single segment', () => {
    expect(breadcrumbs('docs')).toEqual([
      { label: '/', path: '' },
      { label: 'docs', path: 'docs' },
    ]);
  });
});
