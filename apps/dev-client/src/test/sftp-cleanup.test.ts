import { describe, expect, it, vi } from 'vitest';
import { createSftpUnmountCleanup } from '../sftp-cleanup.js';

describe('SFTP workspace unmount cleanup', () => {
  it('closes the latest mounted SFTP session exactly once', () => {
    let current = '';
    const closeSftpSession = vi.fn(async () => undefined);
    const cleanup = createSftpUnmountCleanup({ closeSftpSession }, () => current);

    current = 'sftp-current';
    cleanup();
    expect(closeSftpSession).toHaveBeenCalledTimes(1);
    expect(closeSftpSession).toHaveBeenCalledWith('sftp-current');
  });

  it('does not issue a close when no SFTP session was mounted', () => {
    const closeSftpSession = vi.fn(async () => undefined);
    createSftpUnmountCleanup({ closeSftpSession }, () => '')();
    expect(closeSftpSession).not.toHaveBeenCalled();
  });
});
