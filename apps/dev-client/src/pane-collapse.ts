export interface PaneCollapseState {
  ssh: boolean;
  sftp: boolean;
}

export const EXPANDED_PANES: PaneCollapseState = { ssh: false, sftp: false };

/** Toggle one desktop pane while enforcing that its peer remains expanded. */
export function togglePaneCollapse(state: PaneCollapseState, pane: keyof PaneCollapseState): PaneCollapseState {
  if (state[pane]) return EXPANDED_PANES;
  return pane === 'ssh' ? { ssh: true, sftp: false } : { ssh: false, sftp: true };
}
