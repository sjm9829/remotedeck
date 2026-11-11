import { describe, expect, it } from 'vitest';
import { DEFAULT_SFTP_WIDTH, DOCK_RIGHT_MIN_WIDTH, MIN_SFTP_WIDTH, canDockRight, clampSftpWidth, effectiveDock, initialDock, resizeSftpWidthWithKey } from '../dock-layout.js';

describe('SFTP dock layout', () => {
  it('docks right only in wide, non-mobile containers', () => {
    expect(canDockRight(DOCK_RIGHT_MIN_WIDTH, false)).toBe(true);
    expect(canDockRight(DOCK_RIGHT_MIN_WIDTH - 1, false)).toBe(false);
    expect(canDockRight(1600, true)).toBe(false);
  });
  it('starts from the saved preference, else from the window width', () => {
    expect(initialDock('bottom', 1600)).toBe('bottom');
    expect(initialDock(null, 1600)).toBe('right');
    expect(initialDock(null, 800)).toBe('bottom');
  });
  it('falls back to bottom when a right dock no longer fits', () => {
    expect(effectiveDock('right', 1400, false)).toBe('right');
    expect(effectiveDock('right', 884, false)).toBe('bottom');
    expect(effectiveDock('bottom', 1400, false)).toBe('bottom');
  });
  it('keeps both the file pane and the terminal usable', () => {
    expect(clampSftpWidth(10, 1400)).toBe(MIN_SFTP_WIDTH);
    expect(clampSftpWidth(5000, 1400)).toBe(1400 - 420);
    expect(clampSftpWidth(DEFAULT_SFTP_WIDTH, 1400)).toBe(DEFAULT_SFTP_WIDTH);
  });
  it('resizes with arrows and jumps with Home/End', () => {
    expect(resizeSftpWidthWithKey(480, 'ArrowLeft', 1400)).toBe(504);
    expect(resizeSftpWidthWithKey(480, 'ArrowRight', 1400)).toBe(456);
    expect(resizeSftpWidthWithKey(480, 'Home', 1400)).toBe(MIN_SFTP_WIDTH);
    expect(resizeSftpWidthWithKey(480, 'End', 1400)).toBe(980);
    expect(resizeSftpWidthWithKey(480, 'ArrowUp', 1400)).toBe(480);
  });
});
