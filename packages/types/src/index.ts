export type HostStatus = 'pending_key' | 'trusted' | 'revoked';
// Lifecycle of an SSH session, mirroring the core store / protocol SessionState.
// A session is a single entity: it carries the connection lifecycle AND the
// active writer lease (writerId is null when no writer is attached).
export type SessionState =
  | 'creating'
  | 'awaiting-trust'
  | 'connecting'
  | 'active'
  | 'detached'
  | 'closing'
  | 'closed'
  | 'failed';
export type CredentialType = 'key' | 'agent' | 'password';
export type AttachmentDirection = 'upload' | 'download';
export type ViewerRole = 'writer' | 'viewer';

export interface Host {
  id: string;
  name: string;
  hostname: string;
  port: number;
  /** Login name returned by the server's persisted host record. */
  username: string;
  hostKeyFingerprint: string | null;
  hostKeyTrusted: boolean;
  credentialId: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Credential {
  id: string;
  name: string;
  type: CredentialType;
  keyPath: string | null;
  /** Whether an encrypted secret exists; the secret itself is never returned. */
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
  // secret_encrypted is never exposed in API responses
}

/**
 * An SSH session as returned by the REST API (GET/POST /api/sessions). This is the
 * single session entity from the core store (SessionRow): it has one lifecycle
 * `state`, a nullable `credentialId` (session-level override; null when the host
 * default is used), and a nullable `writerId` (the current writer lease; null when
 * detached or no writer).
 */
export interface SshSession {
  id: string;
  hostId: string;
  credentialId: string | null;
  state: SessionState;
  writerId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
// Back-compatible aliases: the core contract models one session, so both former
// names refer to the same shape.
export type SshConnection = SshSession;
export type ShellSession = SshSession;

export interface SessionViewer {
  id: string;
  sessionId: string;
  role: ViewerRole;
  joinedAt: string;
  leftAt: string | null;
}

export interface SessionAttachment {
  id: string;
  sessionId: string | null;
  filename: string;
  storedName: string;
  size: number;
  mimeType: string | null;
  direction: AttachmentDirection;
  createdAt: string;
}

export interface AuditLog {
  id: number;
  sessionId: string | null;
  eventType: string;
  actorId: string | null;
  data: string | null;
  createdAt: string;
}
