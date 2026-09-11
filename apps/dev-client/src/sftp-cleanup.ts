import { closeRemoteSessionOnce } from './session-cleanup.js';

export interface SftpCloseClient {
  closeSftpSession(id: string): Promise<void>;
}

/** Build the React unmount cleanup without capturing a stale session id. */
export function createSftpUnmountCleanup(client: SftpCloseClient, currentSessionId: () => string, closedSessionIds: Set<string> = new Set()): () => void {
  return () => {
    closeRemoteSessionOnce(currentSessionId(), closedSessionIds, (id) => client.closeSftpSession(id));
  };
}
