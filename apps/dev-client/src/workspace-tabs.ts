export type WorkspaceTabId = string;
export type HostId = string;

export interface WorkspaceTab {
  /** UI workspace identity. Never derived from hostId. */
  id: WorkspaceTabId;
  hostId: HostId;
  label: string;
  sessionId: string | null;
  sftpSessionId: string | null;
}

export interface WorkspaceTabsState {
  readonly tabs: readonly WorkspaceTab[];
  readonly activeTabId: WorkspaceTabId | null;
}

export type NewWorkspaceTab = Omit<WorkspaceTab, 'sessionId' | 'sftpSessionId'> &
  Partial<Pick<WorkspaceTab, 'sessionId' | 'sftpSessionId'>>;

export function createWorkspaceTabsState(): WorkspaceTabsState {
  return { tabs: [], activeTabId: null };
}

export function addWorkspaceTab(state: WorkspaceTabsState, input: NewWorkspaceTab): WorkspaceTabsState {
  if (state.tabs.some((tab) => tab.id === input.id)) {
    throw new Error(`workspace tab already exists: ${input.id}`);
  }
  const tab: WorkspaceTab = {
    ...input,
    sessionId: input.sessionId ?? null,
    sftpSessionId: input.sftpSessionId ?? null,
  };
  return { tabs: [...state.tabs, tab], activeTabId: tab.id };
}

export function activateWorkspaceTab(state: WorkspaceTabsState, id: WorkspaceTabId): WorkspaceTabsState {
  if (!state.tabs.some((tab) => tab.id === id)) return state;
  return { ...state, activeTabId: id };
}

/** Single-click host selection: activate the most recently opened tab without creating one. */
export function activateMostRecentHostTab(state: WorkspaceTabsState, hostId: HostId): WorkspaceTabsState {
  const existing = [...state.tabs].reverse().find((tab) => tab.hostId === hostId);
  return existing ? activateWorkspaceTab(state, existing.id) : state;
}

export function closeWorkspaceTab(state: WorkspaceTabsState, id: WorkspaceTabId): WorkspaceTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (state.activeTabId !== id) return { ...state, tabs };

  // Prefer the tab immediately to the left, then the first remaining tab.
  const nextActive = tabs[Math.max(0, index - 1)]?.id ?? null;
  return { tabs, activeTabId: nextActive };
}
