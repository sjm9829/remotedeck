// SFTP pane placement: docked to the right of the terminal (wide windows) or below it.
// All DOM-free so the sizing rules are unit-testable.

import type { SftpDock } from './terminal-prefs.js';

/** Containers at least this wide may dock the file pane beside the terminal. */
export const DOCK_RIGHT_MIN_WIDTH = 1000;
export const MIN_SFTP_WIDTH = 320;
export const DEFAULT_SFTP_WIDTH = 480;
/** The terminal always keeps at least this much width when the file pane is docked right. */
export const MIN_TERMINAL_WIDTH = 420;

export function canDockRight(containerWidth: number, layoutIsMobile: boolean): boolean {
  return !layoutIsMobile && containerWidth >= DOCK_RIGHT_MIN_WIDTH;
}

/** Saved preference wins; otherwise wide windows start docked right. */
export function initialDock(saved: SftpDock | null, containerWidth: number): SftpDock {
  return saved ?? (containerWidth >= DOCK_RIGHT_MIN_WIDTH ? 'right' : 'bottom');
}

/** The dock actually used: a right dock silently falls back to bottom when the window is too narrow. */
export function effectiveDock(preferred: SftpDock, containerWidth: number, layoutIsMobile: boolean): SftpDock {
  return preferred === 'right' && canDockRight(containerWidth, layoutIsMobile) ? 'right' : 'bottom';
}

export function clampSftpWidth(width: number, containerWidth: number): number {
  const max = Math.max(MIN_SFTP_WIDTH, containerWidth - MIN_TERMINAL_WIDTH);
  return Math.min(max, Math.max(MIN_SFTP_WIDTH, Math.round(width)));
}

/** Arrow keys nudge a right-docked pane (Left widens it, Right narrows it); Home/End jump to the limits. */
export function resizeSftpWidthWithKey(width: number, key: string, containerWidth: number, step = 24): number {
  if (key === 'ArrowLeft') return clampSftpWidth(width + step, containerWidth);
  if (key === 'ArrowRight') return clampSftpWidth(width - step, containerWidth);
  if (key === 'Home') return clampSftpWidth(MIN_SFTP_WIDTH, containerWidth);
  if (key === 'End') return clampSftpWidth(Number.MAX_SAFE_INTEGER, containerWidth);
  return width;
}
