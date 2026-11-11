import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FONT_MAX, FONT_MIN, clampFontSize, defaultFontSize, loadFontSize, saveFontSize, stepFontSize } from '../terminal-prefs.js';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => (store.has(k) ? store.get(k)! : null), setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } },
  });
});
afterEach(() => { Reflect.deleteProperty(globalThis, 'localStorage'); });

describe('terminal prefs', () => {
  it('clamps and steps within bounds', () => {
    expect(clampFontSize(2)).toBe(FONT_MIN);
    expect(clampFontSize(99)).toBe(FONT_MAX);
    expect(clampFontSize(Number.NaN)).toBe(14);
    expect(stepFontSize(FONT_MAX, 1)).toBe(FONT_MAX);
    expect(stepFontSize(FONT_MIN, -1)).toBe(FONT_MIN);
    expect(stepFontSize(14, 1)).toBe(15);
  });
  it('defaults smaller on phones', () => {
    expect(defaultFontSize('mobile')).toBeLessThan(defaultFontSize('desktop'));
    expect(defaultFontSize('drawer')).toBe(defaultFontSize('desktop'));
  });
  it('round-trips and rejects junk', () => {
    expect(loadFontSize()).toBeNull();
    saveFontSize(17);
    expect(loadFontSize()).toBe(17);
    store.set('remotedeck:prefs:v1', '{"fontSize":"big"}');
    expect(loadFontSize()).toBeNull();
    store.set('remotedeck:prefs:v1', 'nope');
    expect(loadFontSize()).toBeNull();
  });
  it('never throws when storage is unavailable', () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } } });
    expect(loadFontSize()).toBeNull();
    expect(() => saveFontSize(12)).not.toThrow();
  });
});

import { loadDock, saveDock } from '../terminal-prefs.js';
describe('dock preference', () => {
  it('round-trips and does not clobber the font size', () => {
    saveFontSize(17);
    saveDock('bottom');
    expect(loadDock()).toBe('bottom');
    expect(loadFontSize()).toBe(17);
    saveFontSize(18);
    expect(loadDock()).toBe('bottom');
  });
  it('ignores junk', () => {
    store.set('remotedeck:prefs:v1', '{"dock":"left"}');
    expect(loadDock()).toBeNull();
  });
});

import { loadSidebarHidden, saveSidebarHidden } from '../terminal-prefs.js';
describe('sidebar preference', () => {
  it('defaults visible, persists, and keeps other prefs', () => {
    expect(loadSidebarHidden()).toBe(false);
    saveFontSize(16);
    saveSidebarHidden(true);
    expect(loadSidebarHidden()).toBe(true);
    expect(loadFontSize()).toBe(16);
    saveSidebarHidden(false);
    expect(loadSidebarHidden()).toBe(false);
  });
});
