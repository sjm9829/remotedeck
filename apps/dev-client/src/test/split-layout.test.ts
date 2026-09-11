import { describe, expect, it } from 'vitest';
import { MAX_SFTP_HEIGHT, MIN_SFTP_HEIGHT, clampSftpHeight, resizeSftpWithKey } from '../split-layout.js';

describe('SFTP split interaction', () => {
  it('clamps pointer-derived heights to the desktop/tablet bounds', () => {
    expect(clampSftpHeight(50)).toBe(MIN_SFTP_HEIGHT);
    expect(clampSftpHeight(271.6)).toBe(272);
    expect(clampSftpHeight(900)).toBe(MAX_SFTP_HEIGHT);
  });

  it('supports arrows plus Home/End for keyboard resizing', () => {
    expect(resizeSftpWithKey(240, 'ArrowUp')).toBe(264);
    expect(resizeSftpWithKey(240, 'ArrowDown')).toBe(216);
    expect(resizeSftpWithKey(240, 'Home')).toBe(MIN_SFTP_HEIGHT);
    expect(resizeSftpWithKey(240, 'End')).toBe(MAX_SFTP_HEIGHT);
    expect(resizeSftpWithKey(240, 'ArrowLeft')).toBe(240);
  });
});
