import type { FastifyInstance } from 'fastify';
import type { Db } from './dbtypes.js';
import { v4 as uuidv4 } from 'uuid';

export function registerRoutes(app: FastifyInstance, db: Db, masterKey: string, startTime: number): void {

  // GET /api/status
  app.get('/api/status', async () => {
    const sessions = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'detached' THEN 1 ELSE 0 END) as detached
      FROM shell_sessions
    `).get() as { total: number; active: number; detached: number };

    const connections = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
      FROM ssh_connections
    `).get() as { total: number; active: number };

    return {
      status: 'ok' as const,
      version: '0.1.0',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      sessions: {
        active: sessions.active ?? 0,
        detached: sessions.detached ?? 0,
        total: sessions.total ?? 0,
      },
      connections: {
        active: connections.active ?? 0,
        total: connections.total ?? 0,
      },
    };
  });

  // GET /api/hosts
  app.get('/api/hosts', async () => {
    const rows = db.prepare('SELECT * FROM hosts ORDER BY created_at DESC').all();
    return { data: rows };
  });

  // POST /api/hosts
  app.post<{ Body: { name: string; hostname: string; port?: number; user: string; credentialId?: string; tags?: string[] } }>('/api/hosts', async (req) => {
    const { name, hostname, port = 22, user, credentialId, tags } = req.body;
    const id = uuidv4();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO hosts (id, name, hostname, port, user, credential_id, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, name, hostname, port, user, credentialId ?? null, JSON.stringify(tags ?? []), now, now);
    return { data: { id, name, hostname, port, user, hostKeyFingerprint: null, hostKeyTrusted: false, credentialId: credentialId ?? null, tags: tags ?? [], createdAt: now, updatedAt: now } };
  });

  // POST /api/hosts/:id/trust
  app.post<{ Params: { id: string }; Body: { fingerprint: string } }>('/api/hosts/:id/trust', async (req) => {
    const now = new Date().toISOString();
    db.prepare('UPDATE hosts SET host_key_fingerprint = ?, host_key_trusted = 1, updated_at = ? WHERE id = ?')
      .run(req.body.fingerprint, now, req.params.id);
    return { data: { id: req.params.id, hostKeyTrusted: true, hostKeyFingerprint: req.body.fingerprint } };
  });

  // GET /api/credentials (redacted - no secret)
  app.get('/api/credentials', async () => {
    const rows = db.prepare('SELECT id, name, type, key_path, created_at, updated_at FROM credentials ORDER BY created_at DESC').all();
    return { data: rows };
  });

  // POST /api/credentials
  app.post<{ Body: { name: string; type: string; secret?: string; keyPath?: string } }>('/api/credentials', async (req) => {
    const { name, type, secret, keyPath } = req.body;
    const id = uuidv4();
    const now = new Date().toISOString();
    let encryptedBuf: Buffer | null = null;
    if (secret) {
      const { encrypt, serializePayload } = await import('@remotedeck/core');
      encryptedBuf = serializePayload(encrypt(secret, masterKey));
    }
    db.prepare('INSERT INTO credentials (id, name, type, secret_encrypted, key_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, type, encryptedBuf, keyPath ?? null, now, now);
    return { data: { id, name, type, keyPath: keyPath ?? null, createdAt: now, updatedAt: now } };
  });

  // GET /api/sessions
  app.get('/api/sessions', async () => {
    const rows = db.prepare('SELECT * FROM shell_sessions ORDER BY created_at DESC').all();
    return { data: rows };
  });

  // GET /api/credentials/:id (redacted)
  app.get<{ Params: { id: string } }>('/api/credentials/:id', async (req) => {
    const row = db.prepare('SELECT id, name, type, key_path, created_at, updated_at FROM credentials WHERE id = ?').get(req.params.id);
    if (!row) {
      return { error: { code: 'not_found', message: 'Credential not found' } };
    }
    return { data: row };
  });
}
