import type { RemoteDeckClient } from '@remotedeck/client-sdk';

export interface PendingSshTrust {
  hostId: string;
  sessionId: string;
  fingerprint: string;
}

/**
 * Trust the fingerprint observed while creating a session and keep that exact
 * session. The server advances all awaiting sessions for the host during the
 * trust call, so creating another session here would leak a duplicate.
 */
export async function trustPendingSession(
  client: Pick<RemoteDeckClient, 'trustHost'>,
  pending: PendingSshTrust,
): Promise<string> {
  await client.trustHost(pending.hostId, pending.fingerprint);
  return pending.sessionId;
}
