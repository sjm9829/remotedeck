import { describe, expect, it, vi } from 'vitest';
import { trustPendingSession } from '../ssh-trust-flow.js';

describe('trustPendingSession', () => {
  it('trusts and returns the original 202 session without creating a duplicate', async () => {
    const client = {
      trustHost: vi.fn().mockResolvedValue({}),
      createSession: vi.fn(),
    };

    const sessionId = await trustPendingSession(client, {
      hostId: 'host-1',
      sessionId: 'pending-session-1',
      fingerprint: 'SHA256:observed',
    });

    expect(sessionId).toBe('pending-session-1');
    expect(client.trustHost).toHaveBeenCalledOnce();
    expect(client.trustHost).toHaveBeenCalledWith('host-1', 'SHA256:observed');
    expect(client.createSession).not.toHaveBeenCalled();
  });
});
