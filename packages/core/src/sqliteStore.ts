import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { encrypt, decrypt, serializePayload, deserializePayload } from './crypto.js';
import type { Store, HostRow, CredentialRow, SessionRow, NewHost, NewCredential, CredentialType, SessionState } from './store.js';

interface HostDbRow { id: string; name: string; hostname: string; port: number; user: string; host_key_fingerprint: string | null; host_key_trusted: number; credential_id: string | null; tags: string | null; created_at: string; updated_at: string; }
interface CredDbRow { id: string; name: string; type: CredentialType; secret_encrypted: Buffer | null; key_path: string | null; created_at: string; updated_at: string; }
interface SessionDbRow { id: string; connection_id: string; writer_id: string | null; status: string; closed_at: string | null; host_id: string | null; credential_id: string | null; }

function now(): string { return new Date().toISOString(); }
function mapHost(r: HostDbRow): HostRow {
  return { id: r.id, name: r.name, hostname: r.hostname, port: r.port, username: r.user,
    credentialId: r.credential_id, hostKeyFingerprint: r.host_key_fingerprint,
    hostKeyTrusted: !!r.host_key_trusted, tags: parseTags(r.tags), createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapCred(r: CredDbRow): CredentialRow {
  return { id: r.id, name: r.name, type: r.type, keyPath: r.key_path, hasSecret: !!r.secret_encrypted, createdAt: r.created_at, updatedAt: r.updated_at };
}
function parseTags(t: string | null): string[] { if (!t) return []; try { const v = JSON.parse(t); return Array.isArray(v) ? v : []; } catch { return []; } }

export class SqliteStore implements Store {
  constructor(private readonly db: Database.Database, private readonly masterKey: string) {}

  createHost(h: NewHost): HostRow {
    const id = randomUUID(); const ts = now();
    this.db.prepare('INSERT INTO hosts (id, name, hostname, port, user, credential_id, host_key_fingerprint, host_key_trusted, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, h.name, h.hostname, h.port, h.username, h.credentialId, h.hostKeyFingerprint, h.hostKeyTrusted ? 1 : 0, JSON.stringify(h.tags), ts, ts);
    return this.getHost(id)!;
  }
  listHosts(): HostRow[] { return (this.db.prepare('SELECT * FROM hosts ORDER BY created_at DESC').all() as HostDbRow[]).map(mapHost); }
  getHost(id: string): HostRow | null { const r = this.db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostDbRow | undefined; return r ? mapHost(r) : null; }
  updateHost(id: string, f: Partial<NewHost> & { hostKeyFingerprint?: string | null; hostKeyTrusted?: boolean }): HostRow | null {
    const cur = this.getHost(id); if (!cur) return null;
    const merged = { ...cur, ...f };
    this.db.prepare('UPDATE hosts SET name=?, hostname=?, port=?, user=?, credential_id=?, host_key_fingerprint=?, host_key_trusted=?, tags=?, updated_at=? WHERE id=?')
      .run(merged.name, merged.hostname, merged.port, merged.username, merged.credentialId, merged.hostKeyFingerprint, merged.hostKeyTrusted ? 1 : 0, JSON.stringify(merged.tags), now(), id);
    return this.getHost(id);
  }
  deleteHost(id: string): boolean { return this.db.prepare('DELETE FROM hosts WHERE id = ?').run(id).changes > 0; }
  setHostTrust(id: string, fingerprint: string): HostRow | null {
    this.db.prepare('UPDATE hosts SET host_key_fingerprint = ?, host_key_trusted = 1, updated_at = ? WHERE id = ?').run(fingerprint, now(), id);
    return this.getHost(id);
  }
  hostReferencesCredential(id: string): boolean { return (this.db.prepare('SELECT COUNT(*) AS c FROM hosts WHERE credential_id = ?').get(id) as { c: number }).c > 0; }
  hostHasSessions(id: string): boolean { return (this.db.prepare('SELECT COUNT(*) AS c FROM ssh_connections WHERE host_id = ?').get(id) as { c: number }).c > 0; }

  createCredential(c: NewCredential): CredentialRow {
    const id = randomUUID(); const ts = now();
    const enc = c.secret ? serializePayload(encrypt(c.secret, this.masterKey)) : null;
    this.db.prepare('INSERT INTO credentials (id, name, type, secret_encrypted, key_path, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(id, c.name, c.type, enc, c.keyPath, ts, ts);
    return this.getCredential(id)!;
  }
  listCredentials(): CredentialRow[] { return (this.db.prepare('SELECT * FROM credentials ORDER BY created_at DESC').all() as CredDbRow[]).map(mapCred); }
  getCredential(id: string): CredentialRow | null { const r = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as CredDbRow | undefined; return r ? mapCred(r) : null; }
  updateCredential(id: string, f: { name?: string; type?: CredentialType; keyPath?: string | null; secret?: string | null }): CredentialRow | null {
    const cur = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as CredDbRow | undefined; if (!cur) return null;
    const name = f.name ?? cur.name; const type = f.type ?? cur.type; const keyPath = f.keyPath !== undefined ? f.keyPath : cur.key_path;
    const enc = f.secret ? serializePayload(encrypt(f.secret, this.masterKey)) : cur.secret_encrypted;
    this.db.prepare('UPDATE credentials SET name=?, type=?, key_path=?, secret_encrypted=?, updated_at=? WHERE id=?').run(name, type, keyPath, enc, now(), id);
    return this.getCredential(id);
  }
  deleteCredential(id: string): boolean { return this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id).changes > 0; }
  credentialReferenced(id: string): boolean { return this.hostReferencesCredential(id) || (this.db.prepare('SELECT COUNT(*) AS c FROM ssh_connections WHERE credential_id = ?').get(id) as { c: number }).c > 0; }
  decryptCredentialSecret(id: string): string | null {
    const r = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as CredDbRow | undefined;
    if (!r || !r.secret_encrypted) return null;
    return decrypt(deserializePayload(r.secret_encrypted), this.masterKey);
  }

  createSession(s: { hostId: string; credentialId: string | null; state: SessionState; writerId: string | null }): SessionRow {
    const ts = now();
    const connId = randomUUID();
    this.db.prepare('INSERT INTO ssh_connections (id, host_id, credential_id, status, opened_at) VALUES (?,?,?,?,?)')
      .run(connId, s.hostId, s.credentialId, mapStatusToConn(s.state), ts);
    const sid = randomUUID();
    this.db.prepare('INSERT INTO shell_sessions (id, connection_id, writer_id, status, created_at) VALUES (?,?,?,?,?)')
      .run(sid, connId, s.writerId, s.state, ts);
    return this.getSession(sid)!;
  }
  getSession(id: string): SessionRow | null {
    const r = this.db.prepare('SELECT s.id AS id, s.connection_id AS connection_id, s.writer_id AS writer_id, s.status AS status, s.closed_at AS closed_at, h.id AS host_id, c.id AS credential_id FROM shell_sessions s JOIN ssh_connections sc ON sc.id = s.connection_id JOIN hosts h ON h.id = sc.host_id LEFT JOIN credentials c ON c.id = sc.credential_id WHERE s.id = ?').get(id) as SessionDbRow | undefined;
    return r ? mapSession(r) : null;
  }
  listSessions(): SessionRow[] {
    return (this.db.prepare('SELECT s.id AS id, s.connection_id AS connection_id, s.writer_id AS writer_id, s.status AS status, s.closed_at AS closed_at, h.id AS host_id, c.id AS credential_id FROM shell_sessions s JOIN ssh_connections sc ON sc.id = s.connection_id JOIN hosts h ON h.id = sc.host_id LEFT JOIN credentials c ON c.id = sc.credential_id ORDER BY s.created_at DESC').all() as SessionDbRow[]).map(mapSession);
  }
  updateSession(id: string, f: Partial<Pick<SessionRow, 'state' | 'writerId' | 'closedAt'>>): void {
    const cur = this.db.prepare('SELECT status FROM shell_sessions WHERE id = ?').get(id) as { status: string } | undefined; if (!cur) return;
    const status = f.state ?? cur.status;
    const writerId = f.writerId !== undefined ? f.writerId : (this.db.prepare('SELECT writer_id FROM shell_sessions WHERE id = ?').get(id) as { writer_id: string | null }).writer_id;
    const closedAt = f.closedAt !== undefined ? f.closedAt : (this.db.prepare('SELECT closed_at FROM shell_sessions WHERE id = ?').get(id) as { closed_at: string | null }).closed_at;
    this.db.prepare('UPDATE shell_sessions SET status=?, writer_id=?, closed_at=? WHERE id = ?').run(status, writerId, closedAt, id);
    // mirror status onto the connection row
    this.db.prepare('UPDATE ssh_connections SET status = ?, closed_at = ? WHERE id = (SELECT connection_id FROM shell_sessions WHERE id = ?)').run(mapStatusToConn(status), closedAt, id);
  }

  statusCounts() {
    const s = this.db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status='detached' THEN 1 ELSE 0 END) AS detached FROM shell_sessions").get() as { total: number; active: number; detached: number };
    const c = this.db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active FROM ssh_connections").get() as { total: number; active: number };
    return { sessions: { active: s.active ?? 0, detached: s.detached ?? 0, total: s.total ?? 0 }, connections: { active: c.active ?? 0, total: c.total ?? 0 } };
  }
}

function mapStatusToConn(state: string): string {
  if (state === 'active') return 'active';
  if (state === 'connecting') return 'connecting';
  if (state === 'closed' || state === 'failed') return 'closed';
  return 'connecting';
}
function mapSession(r: SessionDbRow): SessionRow {
  return { id: r.id, hostId: r.host_id!, credentialId: r.credential_id, state: r.status as SessionState, writerId: r.writer_id, createdAt: '', updatedAt: '', closedAt: r.closed_at };
}
