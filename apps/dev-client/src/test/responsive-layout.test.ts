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

  // Regression: on mobile the inactive pane is hidden with `visibility: hidden`,
  // but a descendant that sets `visibility: visible` (e.g. `.rd-row-actions`) would
  // still paint over the active pane and look like the two panels overlap. The hide
  // rule must therefore also target the inactive pane's descendants so nothing leaks.
  it('hides the inactive mobile pane together with its descendants', () => {
    const css = readFileSync(new URL('../App.css', import.meta.url), 'utf8');
    expect(css).toContain('.rd-split[data-mobile-view="terminal"] .rd-sftp-pane, .rd-split[data-mobile-view="terminal"] .rd-sftp-pane *');
    expect(css).toContain('.rd-split[data-mobile-view="files"] .rd-terminal-pane, .rd-split[data-mobile-view="files"] .rd-terminal-pane *');
  });
});
