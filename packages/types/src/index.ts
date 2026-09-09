export type HostStatus = 'pending_key' | 'trusted' | 'revoked';
export type ConnectionStatus = 'connecting' | 'active' | 'closing' | 'closed' | 'error';
export type SessionStatus = 'active' | 'detached' | 'closed';
export type CredentialType = 'key' | 'agent' | 'password';
export type AttachmentDirection = 'upload' | 'download';
export type ViewerRole = 'writer' | 'viewer';

export interface Host {
  id: string;
  name: string;
  hostname: string;
  port: number;
  user: string;
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
  createdAt: string;
  updatedAt: string;
  // secret_encrypted is never exposed in API responses
}

export interface SshConnection {
  id: string;
  hostId: string;
  credentialId: string;
  status: ConnectionStatus;
  openedAt: string;
  closedAt: string | null;
  lastError: string | null;
}

export interface ShellSession {
  id: string;
  connectionId: string;
  title: string | null;
  writerId: string;
  status: SessionStatus;
  termSize: { rows: number; cols: number };
  scrollbackLimit: number;
  createdAt: string;
  detachedAt: string | null;
  reattachedAt: string | null;
  closedAt: string | null;
}

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
