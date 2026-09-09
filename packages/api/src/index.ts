import type { Host, Credential, SshConnection, ShellSession, SessionAttachment } from '@remotedeck/types';

// Re-export types for convenience
export type { Host, Credential, SshConnection, ShellSession, SessionAttachment };

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
  credentialId?: string;
  tags?: string[];
}

export interface CreateCredentialRequest {
  name: string;
  type: 'key' | 'agent' | 'password';
  secret?: string;
  keyPath?: string;
}

export interface CreateSessionRequest {
  hostId: string;
  credentialId: string;
  title?: string;
}

export interface TrustHostRequest {
  fingerprint: string;
}

export interface ResizeRequest {
  rows: number;
  cols: number;
}
