import type { Host, Credential, SshSession, SshConnection, ShellSession, SessionAttachment, SessionState } from '@remotedeck/types';

// Re-export types for convenience
export type { Host, Credential, SshSession, SshConnection, ShellSession, SessionAttachment, SessionState };

// API response wrappers
export interface ApiResponse<T> {
  data: T;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

// Health/Status endpoints
export interface HealthResponse {
  status: 'ok';
  timestamp: string;
}

export interface StatusResponse {
  status: 'ok';
  version: string;
  uptime: number;
  sessions: {
    active: number;
    detached: number;
    total: number;
  };
  connections: {
    active: number;
    total: number;
  };
}

// Request bodies
export interface CreateHostRequest {
  name: string;
  hostname: string;
  port?: number;
  user: string;
  credentialId?: string | null;
  tags?: string[];
}

export interface UpdateHostRequest {
  name?: string;
  hostname?: string;
  port?: number;
  user?: string;
  credentialId?: string | null;
  tags?: string[];
}

export interface CreateCredentialRequest {
  name: string;
  type: 'key' | 'agent' | 'password';
  secret?: string;
  keyPath?: string;
}

export interface UpdateCredentialRequest {
  name?: string;
  type?: 'key' | 'agent' | 'password';
  /** An empty secret intentionally leaves the existing server-side secret unchanged. */
  secret?: string;
  keyPath?: string | null;
}

export interface CreateSessionRequest {
  hostId: string;
  /**
   * Session-level credential override. Optional and nullable: when omitted/null the
   * host's default credential is used. The REST contract reads `credentialId ?? null`.
   */
  credentialId?: string | null;
}

export interface TrustHostRequest {
  fingerprint: string;
}

export interface ResizeRequest {
  rows: number;
  cols: number;
}

// ---- Session response shapes (match the core-server REST contract) ----------
/**
 * POST /api/sessions response body, as a discriminated union on `requiresTrust`:
 * - `202` + `requiresTrust: true`  -> the host key is not yet trusted; `fingerprint`
 *   is the observed value the caller must trust (always present).
 * - `201` + `requiresTrust: false` -> the session is immediately ready.
 */
export type CreateSessionResponse =
  | { data: SshSession & { requiresTrust: true; fingerprint: string } }
  | { data: SshSession & { requiresTrust: false } };

/** POST /api/sessions/:id/ws-ticket response body: a single-use, short-lived ticket
 *  presented on the WS handshake via the Sec-WebSocket-Protocol subprotocol. */
export interface WsTicketResponse {
  data: { ticket: string; sessionId: string; role: 'writer' | 'viewer'; expiresAt: string };
}
