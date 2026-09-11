import { describe, expect, it } from 'vitest';
import {
  activateMostRecentHostTab,
  activateWorkspaceTab,
  addWorkspaceTab,
  closeWorkspaceTab,
  createWorkspaceTabsState,
} from '../workspace-tabs.js';

describe('workspace tab state', () => {
  it('keeps two tabs for the same host isolated by tab identity', () => {
    const empty = createWorkspaceTabsState();
    const one = addWorkspaceTab(empty, { id: 'tab-a', hostId: 'host-k6', label: 'K6 shell', sessionId: 'ssh-a' });
    const two = addWorkspaceTab(one, { id: 'tab-b', hostId: 'host-k6', label: 'K6 logs', sessionId: 'ssh-b', sftpSessionId: 'sftp-b' });

    expect(two.tabs).toHaveLength(2);
    expect(two.tabs[0]).toMatchObject({ id: 'tab-a', hostId: 'host-k6', sessionId: 'ssh-a', sftpSessionId: null });
    expect(two.tabs[1]).toMatchObject({ id: 'tab-b', hostId: 'host-k6', sessionId: 'ssh-b', sftpSessionId: 'sftp-b' });
    expect(two.activeTabId).toBe('tab-b');

    const firstActive = activateWorkspaceTab(two, 'tab-a');
    expect(firstActive.activeTabId).toBe('tab-a');
    const secondOnly = closeWorkspaceTab(firstActive, 'tab-a');
    expect(secondOnly.tabs).toEqual([two.tabs[1]]);
    expect(secondOnly.activeTabId).toBe('tab-b');
  });

  it('does not conflate duplicate host ids with duplicate tab ids', () => {
    let state = addWorkspaceTab(createWorkspaceTabsState(), { id: 'tab-1', hostId: 'host-1', label: 'one' });
    state = addWorkspaceTab(state, { id: 'tab-2', hostId: 'host-1', label: 'two' });
    expect(() => addWorkspaceTab(state, { id: 'tab-2', hostId: 'host-2', label: 'duplicate tab' })).toThrow(/already exists/);
  });

  it('single-click activation never creates a tab and prefers the most recent matching host tab', () => {
    const empty = createWorkspaceTabsState();
    expect(activateMostRecentHostTab(empty, 'host-1')).toBe(empty);

    let state = addWorkspaceTab(empty, { id: 'tab-a', hostId: 'host-1', label: 'first' });
    state = addWorkspaceTab(state, { id: 'tab-other', hostId: 'host-2', label: 'other' });
    state = addWorkspaceTab(state, { id: 'tab-b', hostId: 'host-1', label: 'recent' });
    state = activateWorkspaceTab(state, 'tab-other');
    const selected = activateMostRecentHostTab(state, 'host-1');

    expect(selected.tabs).toEqual(state.tabs);
    expect(selected.activeTabId).toBe('tab-b');
  });
});
