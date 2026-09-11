import { describe, expect, it } from 'vitest';
import { EXPANDED_PANES, togglePaneCollapse } from '../pane-collapse.js';

describe('desktop pane collapse state', () => {
  it('collapses only SSH and keeps SFTP expanded', () => {
    expect(togglePaneCollapse(EXPANDED_PANES, 'ssh')).toEqual({ ssh: true, sftp: false });
  });

  it('collapsing SFTP always expands SSH', () => {
    expect(togglePaneCollapse({ ssh: true, sftp: false }, 'sftp')).toEqual({ ssh: false, sftp: true });
  });

  it('expands a collapsed pane without collapsing its peer', () => {
    expect(togglePaneCollapse({ ssh: false, sftp: true }, 'sftp')).toEqual(EXPANDED_PANES);
  });
});
