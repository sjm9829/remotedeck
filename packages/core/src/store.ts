// Storage abstraction. MemoryStore keeps everything in-memory (used by tests and
// can back the server); SqliteStore is the durable implementation. Neither returns
// credential secrets. No native modules are imported here so this module (and the
// session manager) can be exercised deterministically without better-sqlite3.
import { randomUUID } from 'node:crypto';
import { encrypt, decrypt, serializePayload, deserializePayload } from './crypto.js';

export type CredentialType = 'key' | 'password' | 'agent';

export interface HostRow {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  credentialId: string | null;
  hostKeyFingerprint: string | null;
  hostKeyTrusted: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CredentialRow {
  id: string;
  name: string;
  type: CredentialType;
  keyPath: string | null;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SessionState =
  | 'creating' | 'awaiting-trust' | 'connecting' | 'active'
  | 'detached' | 'closing' | 'closed' | 'failed';

export interface SessionRow {
  id: string;
  hostId: string;
  credentialId: string | null;
  state: SessionState;
  writerId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface NewHost {
  name: string; hostname: string; port: number; username: string;
  credentialId: string | null; tags: string[];
  hostKeyFingerprint: string | null; hostKeyTrusted: boolean;
}
export interface NewCredential {
  name: string; type: CredentialType; secret: string | null; keyPath: string | null;
}
// ---- SFTP sessions ---------------------------------------------------------

export type SftpSessionStatus = 'starting' | 'awaiting-trust' | 'ready' | 'error';

export interface SftpSession {
  id: string;
  hostId: string;
  credentialId: string | null;
  rootPath: string;
  fingerprint: string;
  status: SftpSessionStatus;
  reason: string | null;
  lastActiveAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SftpSessionRecordInput {
  hostId: string;
  credentialId: string | null;
  rootPath: string;
  fingerprint: string;
  status: SftpSessionStatus;
  lastActiveAt: string;
  createdAt: string;
  updatedAt: string;
}


export interface Store {
  createHost(h: NewHost): HostRow;
  listHosts(): HostRow[];
  getHost(id: string): HostRow | null;
  updateHost(id: string, fields: Partial<NewHost>): HostRow | null;
  deleteHost(id: string): boolean;
  setHostTrust(id: string, fingerprint: string): HostRow | null;
  hostReferencesCredential(id: string): boolean;
  hostHasSessions(id: string): boolean;

  createCredential(c: NewCredential): CredentialRow;
  listCredentials(): CredentialRow[];
  getCredential(id: string): CredentialRow | null;
  updateCredential(id: string, fields: { name?: string; type?: CredentialType; keyPath?: string | null; secret?: string | null }): CredentialRow | null;
  deleteCredential(id: string): boolean;
  credentialReferenced(id: string): boolean;
  decryptCredentialSecret(id: string): string | null;

  createSession(s: { hostId: string; credentialId: string | null; state: SessionState; writerId: string | null }): SessionRow;
  getSession(id: string): SessionRow | null;
  listSessions(): SessionRow[];
  updateSession(id: string, fields: Partial<Pick<SessionRow, 'state' | 'writerId' | 'closedAt'>>): void;

  statusCounts(): { sessions: { active: number; detached: number; total: number }; connections: { active: number; total: number } };

  // SFTP sessions.
  createSftpSession(input: SftpSessionRecordInput): SftpSession;
  getSftpSession(id: string): SftpSession | null;
  listSftpSessions(): SftpSession[];
  updateSftpSession(id: string, fields: Partial<Pick<SftpSession, 'status' | 'reason' | 'fingerprint' | 'lastActiveAt' | 'closedAt' | 'updatedAt'>>): void;
  deleteSftpSession(id: string): boolean;
}

function now(): string { return new Date().toISOString(); }

export class MemoryStore implements Store {
  private hosts = new Map<string, HostRow>();
  private creds = new Map<string, CredentialRow & { secretEncrypted: Buffer | null }>();
  private sessions = new Map<string, SessionRow>();
  private sftpSessions = new Map<string, SftpSession>();

  createHost(h: NewHost): HostRow {
    const row: HostRow = { id: randomUUID(), ...h, createdAt: now(), updatedAt: now() };
    this.hosts.set(row.id, row);
    return row;
  }
  listHosts(): HostRow[] { return [...this.hosts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  getHost(id: string): HostRow | null { return this.hosts.get(id) ?? null; }
  updateHost(id: string, fields: Partial<NewHost>): HostRow | null {
    const row = this.hosts.get(id); if (!row) return null;
    Object.assign(row, fields, { updatedAt: now() });
    return row;
  }
  deleteHost(id: string): boolean { return this.hosts.delete(id); }
  setHostTrust(id: string, fingerprint: string): HostRow | null {
    const row = this.hosts.get(id); if (!row) return null;
    row.hostKeyFingerprint = fingerprint; row.hostKeyTrusted = true; row.updatedAt = now();
    return row;
  }
  hostReferencesCredential(id: string): boolean { return [...this.hosts.values()].some((h) => h.credentialId === id); }
  hostHasSessions(id: string): boolean { return [...this.sessions.values()].some((s) => s.hostId === id); }

  createCredential(c: NewCredential): CredentialRow {
    const enc = c.secret ? serializePayload(encrypt(c.secret, this.masterKey)) : null;
    const row: CredentialRow & { secretEncrypted: Buffer | null } = {
      id: randomUUID(), name: c.name, type: c.type, keyPath: c.keyPath,
      hasSecret: !!enc, createdAt: now(), updatedAt: now(), secretEncrypted: enc,
    };
    this.creds.set(row.id, row);
    return stripSecret(row);
  }
  listCredentials(): CredentialRow[] { return [...this.creds.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(stripSecret); }
  getCredential(id: string): CredentialRow | null { const r = this.creds.get(id); return r ? stripSecret(r) : null; }
  updateCredential(id: string, fields: { name?: string; type?: CredentialType; keyPath?: string | null; secret?: string | null }): CredentialRow | null {
    const row = this.creds.get(id); if (!row) return null;
    if (fields.name !== undefined) row.name = fields.name;
    if (fields.type !== undefined) row.type = fields.type;
    if (fields.keyPath !== undefined) row.keyPath = fields.keyPath;
    if (fields.secret) row.secretEncrypted = serializePayload(encrypt(fields.secret, this.masterKey)), row.hasSecret = true; // empty => keep existing
    row.updatedAt = now();
    return stripSecret(row);
  }
  deleteCredential(id: string): boolean { return this.creds.delete(id); }
  credentialReferenced(id: string): boolean { return [...this.hosts.values()].some((h) => h.credentialId === id); }
  decryptCredentialSecret(id: string): string | null {
    const r = this.creds.get(id); if (!r || !r.secretEncrypted) return null;
    return decrypt(deserializePayload(r.secretEncrypted), this.masterKey);
  }

  createSession(s: { hostId: string; credentialId: string | null; state: SessionState; writerId: string | null }): SessionRow {
    const row: SessionRow = { id: randomUUID(), ...s, createdAt: now(), updatedAt: now(), closedAt: null };
    this.sessions.set(row.id, row);
    return row;
  }
  getSession(id: string): SessionRow | null { return this.sessions.get(id) ?? null; }
  listSessions(): SessionRow[] { return [...this.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  updateSession(id: string, fields: Partial<Pick<SessionRow, 'state' | 'writerId' | 'closedAt'>>): void {
    const row = this.sessions.get(id); if (!row) return; Object.assign(row, fields, { updatedAt: now() });
  }

  statusCounts() {
    const s = { active: 0, detached: 0, total: 0 };
    for (const r of this.sessions.values()) { s.total++; if (r.state === 'active') s.active++; else if (r.state === 'detached') s.detached++; }
    return { sessions: s, connections: { active: s.active, total: s.total } };
  }

  createSftpSession(input: SftpSessionRecordInput): SftpSession {
    const id = randomUUID();
    const row: SftpSession = { id, ...input, closedAt: null, reason: null };
    this.sftpSessions.set(id, row);
    return row;
  }
  getSftpSession(id: string): SftpSession | null { return this.sftpSessions.get(id) ?? null; }
  listSftpSessions(): SftpSession[] { return [...this.sftpSessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  updateSftpSession(id: string, fields: Partial<Pick<SftpSession, 'status' | 'reason' | 'fingerprint' | 'lastActiveAt' | 'closedAt' | 'updatedAt'>>): void {
    const row = this.sftpSessions.get(id); if (!row) return;
    Object.assign(row, fields, { updatedAt: now() });
  }
  deleteSftpSession(id: string): boolean { return this.sftpSessions.delete(id); }

  // masterKey injected for encryption (MemoryStore keeps it in memory)
  constructor(private readonly masterKey: string) {}
}

function stripSecret(r: CredentialRow & { secretEncrypted: Buffer | null }): CredentialRow {
  return { id: r.id, name: r.name, type: r.type, keyPath: r.keyPath, hasSecret: r.hasSecret, createdAt: r.createdAt, updatedAt: r.updatedAt };
}
