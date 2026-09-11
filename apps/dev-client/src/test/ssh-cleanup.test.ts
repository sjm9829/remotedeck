import { describe, expect, it, vi } from 'vitest';
import { createSshUnmountCleanup } from '../ssh-cleanup.js';

describe('SSH workspace unmount cleanup', () => {
  it('closes the socket and the latest server session exactly once', async () => {
    let current = 'ssh-old';
    const closeSession = vi.fn(async () => ({ state: 'closed', closedAt: new Date().toISOString() }));
    const closeSocket = vi.fn();
    const cleanup = createSshUnmountCleanup({ closeSession }, () => current, closeSocket);

    current = 'ssh-latest';
    cleanup();
    cleanup();
    await Promise.resolve();

    expect(closeSocket).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith('ssh-latest');
  });

  it('only closes the socket when no server session was created', () => {
    const closeSession = vi.fn(async () => undefined);
    const closeSocket = vi.fn();

    createSshUnmountCleanup({ closeSession }, () => '', closeSocket)();

    expect(closeSocket).toHaveBeenCalledTimes(1);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('absorbs asynchronous and synchronous close failures without retrying', async () => {
    const rejection = vi.fn(() => Promise.reject(new Error('network unavailable')));
    const rejectedCleanup = createSshUnmountCleanup({ closeSession: rejection }, () => 'ssh-rejected', vi.fn());
    rejectedCleanup();
    rejectedCleanup();
    await Promise.resolve();
    await Promise.resolve();
    expect(rejection).toHaveBeenCalledTimes(1);

    const thrown = vi.fn(() => { throw new Error('bad mock'); });
    const thrownCleanup = createSshUnmountCleanup({ closeSession: thrown }, () => 'ssh-thrown', vi.fn());
    expect(() => { thrownCleanup(); thrownCleanup(); }).not.toThrow();
    expect(thrown).toHaveBeenCalledTimes(1);
  });

  it('does not close the same session twice across Strict Mode effect re-setup', () => {
    const closeSession = vi.fn(async () => undefined);
    const closedSessionIds = new Set<string>();
    const currentSessionId = () => 'ssh-mounted';

    createSshUnmountCleanup({ closeSession }, currentSessionId, vi.fn(), closedSessionIds)();
    createSshUnmountCleanup({ closeSession }, currentSessionId, vi.fn(), closedSessionIds)();

    expect(closeSession).toHaveBeenCalledTimes(1);
  });
});
