import { closeRemoteSessionOnce } from './session-cleanup.js';

export interface SshCloseClient {
  closeSession(id: string): Promise<unknown>;
}

/**
 * Build the workspace unmount cleanup without capturing a stale SSH session.
 * React may invoke an effect cleanup more than once in development, so each
 * cleanup instance owns a once guard. Closing the server session is best
 * effort: unmount must not create an unhandled rejection or retry forever.
 */
export function createSshUnmountCleanup(
  client: SshCloseClient,
  currentSessionId: () => string,
  closeSocket: () => void,
  closedSessionIds: Set<string> = new Set(),
): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    closeSocket();
    closeRemoteSessionOnce(currentSessionId(), closedSessionIds, (id) => client.closeSession(id));
  };
}
