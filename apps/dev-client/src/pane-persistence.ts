// Per-tab pane layout kept in sessionStorage, next to the tab layout itself.
//
// Inside Workbench the RemoteDeck frame is unmounted whenever another page is
// shown; coming back re-mounts every pane. Without this the file pane re-opened
// expanded, at its default size, in the home folder. Only presentation state is
// stored (collapse, sizes, split, current folders, mobile view), never file
// contents or credentials.

import { MAX_SPLIT, MIN_SPLIT } from './dual-pane.js';
import { MAX_SFTP_HEIGHT, MIN_SFTP_HEIGHT } from './split-layout.js';
import { MIN_SFTP_WIDTH } from './dock-layout.js';

export interface PersistedPane {
  sshCollapsed?: boolean;
  sftpCollapsed?: boolean;
  sftpHeight?: number;
  sftpWidth?: number;
  dual?: boolean;
  split?: number;
  path?: string;
  bPath?: string;
  mobileView?: 'terminal' | 'files';
}

const PREFIX = 'remotedeck:pane:v1:';

export function loadPaneState(tabId: string): PersistedPane {
  try {
    const raw = sessionStorage.getItem(PREFIX + tabId);
    if (!raw) return {};
    return sanitize(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Merges into what is stored, so callers can save one field at a time. */
export function savePaneState(tabId: string, update: PersistedPane): void {
  try {
    sessionStorage.setItem(PREFIX + tabId, JSON.stringify(sanitize({ ...loadPaneState(tabId), ...update })));
  } catch {
    // Private browsing or quota: the layout simply is not remembered.
  }
}

export function clearPaneState(tabId: string): void {
  try {
    sessionStorage.removeItem(PREFIX + tabId);
  } catch {
    // ignore
  }
}

function sanitize(value: unknown): PersistedPane {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  const out: PersistedPane = {};
  const num = (x: unknown, min: number, max: number) => typeof x === 'number' && Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : undefined;
  if (typeof v.sshCollapsed === 'boolean') out.sshCollapsed = v.sshCollapsed;
  if (typeof v.sftpCollapsed === 'boolean') out.sftpCollapsed = v.sftpCollapsed;
  // Both panes collapsed is not a state the UI can reach; expand both.
  if (out.sshCollapsed && out.sftpCollapsed) { out.sshCollapsed = false; out.sftpCollapsed = false; }
  const height = num(v.sftpHeight, MIN_SFTP_HEIGHT, MAX_SFTP_HEIGHT); if (height !== undefined) out.sftpHeight = Math.round(height);
  // The width is clamped again against the window when it is used.
  const width = num(v.sftpWidth, MIN_SFTP_WIDTH, 10_000); if (width !== undefined) out.sftpWidth = Math.round(width);
  if (typeof v.dual === 'boolean') out.dual = v.dual;
  const split = num(v.split, MIN_SPLIT, MAX_SPLIT); if (split !== undefined) out.split = split;
  if (typeof v.path === 'string') out.path = v.path;
  if (typeof v.bPath === 'string') out.bPath = v.bPath;
  if (v.mobileView === 'terminal' || v.mobileView === 'files') out.mobileView = v.mobileView;
  return out;
}
