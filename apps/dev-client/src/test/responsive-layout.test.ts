import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { layoutForWidth } from '../responsive-layout.js';

describe('responsive layout boundaries', () => {
  it('uses desktop, drawer, and mobile modes at the specified container widths', () => {
    expect(layoutForWidth(900)).toBe('desktop');
    expect(layoutForWidth(899)).toBe('drawer');
    expect(layoutForWidth(600)).toBe('drawer');
    expect(layoutForWidth(599)).toBe('mobile');
  });

  it('applies the same boundaries with container queries, not viewport media queries', () => {
    const css = readFileSync(new URL('../App.css', import.meta.url), 'utf8');
    expect(css).toContain('container: remote-deck / inline-size');
    expect(css).toContain('@container remote-deck (max-width: 899px)');
    expect(css).toContain('@container remote-deck (max-width: 599px)');
    expect(css).not.toContain('@media (max-width:');
  });
});
