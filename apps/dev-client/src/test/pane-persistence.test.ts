import { beforeEach, describe, expect, it } from 'vitest';
import { clearPaneState, loadPaneState, savePaneState } from '../pane-persistence.js';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
  });
});

describe('pane layout persistence', () => {
  it('returns nothing for a tab never saved', () => {
    expect(loadPaneState('workspace-1')).toEqual({});
  });

  it('round-trips collapse, sizes, split, folders and mobile view per tab', () => {
    savePaneState('workspace-1', { sshCollapsed: false, sftpCollapsed: true, sftpHeight: 400, sftpWidth: 600, dual: true, split: 0.6, path: '/srv', bPath: '/tmp', mobileView: 'files' });
    expect(loadPaneState('workspace-1')).toEqual({ sshCollapsed: false, sftpCollapsed: true, sftpHeight: 400, sftpWidth: 600, dual: true, split: 0.6, path: '/srv', bPath: '/tmp', mobileView: 'files' });
    expect(loadPaneState('workspace-2')).toEqual({});
  });

  it('merges updates, so a save without a folder keeps the saved folder', () => {
    savePaneState('workspace-1', { path: '/srv' });
    savePaneState('workspace-1', { sftpCollapsed: true });
    expect(loadPaneState('workspace-1')).toEqual({ path: '/srv', sftpCollapsed: true });
  });

  it('clamps sizes and drops invalid or impossible values', () => {
    store.set('remotedeck:pane:v1:workspace-1', JSON.stringify({ sshCollapsed: true, sftpCollapsed: true, sftpHeight: 99999, sftpWidth: 10, split: 2, path: 5, mobileView: 'x' }));
    expect(loadPaneState('workspace-1')).toEqual({ sshCollapsed: false, sftpCollapsed: false, sftpHeight: 720, sftpWidth: 320, split: 0.75 });
    store.set('remotedeck:pane:v1:workspace-1', 'not json');
    expect(loadPaneState('workspace-1')).toEqual({});
  });

  it('forgets a closed tab', () => {
    savePaneState('workspace-1', { dual: true });
    clearPaneState('workspace-1');
    expect(loadPaneState('workspace-1')).toEqual({});
  });

  it('keeps working when storage throws', () => {
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } } });
    expect(() => savePaneState('workspace-1', { dual: true })).not.toThrow();
    expect(loadPaneState('workspace-1')).toEqual({});
    expect(() => clearPaneState('workspace-1')).not.toThrow();
  });
});
