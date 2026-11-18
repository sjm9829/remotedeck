import { describe, expect, it } from 'vitest';
import { resolveTheme, terminalTheme } from '../theme.js';

describe('theme', () => {
  it('follows the Workbench choice, and the device for system', () => {
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
  });
  it('gives the terminal a white ground with darker ANSI colours in light', () => {
    const light = terminalTheme('light');
    expect(light.background).toBe('#ffffff');
    expect(light.yellow).not.toBe(undefined);
    expect(terminalTheme('dark').background).not.toBe('#ffffff');
  });
});
