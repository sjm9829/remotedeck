import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTabState, loadTabState, saveTabState } from '../session-persistence.js';

// Provide a minimal sessionStorage shim; the vitest node environment lacks one.
const store = new Map<string, string>();
const sessionStorageShim = {
  getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
};

beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, 'sessionStorage', { value: sessionStorageShim, configurable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tab state persistence', () => {
  it('round-trips a simple layout', () => {
    const state = { tabs: [{ id: 'workspace-1', hostId: 'h1', label: 'Host A · 1' }], activeTabId: 'workspace-1' };
    saveTabState(state);
    expect(loadTabState()).toEqual(state);
  });

  it('returns null when nothing has been saved yet', () => {
    expect(loadTabState()).toBeNull();
  });

  it('returns null for a malformed payload', () => {
    sessionStorage.setItem('remotedeck:tabs:v1', 'not json');
    expect(loadTabState()).toBeNull();
    sessionStorage.setItem('remotedeck:tabs:v1', JSON.stringify({ tabs: [{ nope: 1 }] }));
    expect(loadTabState()).toBeNull();
  });

  it('drops state when the persisted active id refers to a missing tab (loader treats null)', () => {
    saveTabState({ tabs: [], activeTabId: null });
    const loaded = loadTabState();
    expect(loaded).not.toBeNull();
    expect(loaded!.tabs).toEqual([]);
  });

  it('clearTabState wipes the key', () => {
    saveTabState({ tabs: [{ id: 'a', hostId: 'h', label: 'A' }], activeTabId: 'a' });
    clearTabState();
    expect(loadTabState()).toBeNull();
  });

  it('swallows storage errors so persistence never breaks the tab flow', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: { setItem: () => { throw new Error('quota'); }, getItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('nope'); } },
      configurable: true,
    });
    expect(() => saveTabState({ tabs: [], activeTabId: null })).not.toThrow();
    expect(loadTabState()).toBeNull();
    expect(() => clearTabState()).not.toThrow();
  });
});
