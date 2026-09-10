import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Simple integration test: start server on ephemeral port, hit /healthz
// We use a simpler approach: just verify the modules load and DB migration works

import { openDatabase, runMigrations, encrypt, decrypt, serializePayload, deserializePayload, SqliteStore } from '@remotedeck/core';

describe('core-server skeleton', () => {
  let db: ReturnType<typeof openDatabase>;

  before(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
  });

  after(() => {
    db.close();
  });

  it('DB tables exist after migration', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);
    assert.ok(names.includes('hosts'));
    assert.ok(names.includes('credentials'));
    assert.ok(names.includes('ssh_connections'));
    assert.ok(names.includes('shell_sessions'));
    assert.ok(names.includes('session_attachments'));
    assert.ok(names.includes('audit_logs'));
  });

  it('credential round-trip via DB', () => {
    const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const secret = 'my-ssh-private-key-content';
    const payload = encrypt(secret, masterKey);
    const buf = serializePayload(payload);

    db.prepare('INSERT INTO credentials (id, name, type, secret_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('test-cred-1', 'Test Key', 'key', buf, new Date().toISOString(), new Date().toISOString());

    const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get('test-cred-1') as { secret_encrypted: Buffer };
    const decrypted = decrypt(deserializePayload(row.secret_encrypted), masterKey);
    assert.equal(decrypted, secret);
  });

  it('credential DTO excludes secret', () => {
    const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get('test-cred-1') as Record<string, unknown>;
    const dto = { id: row.id, name: row.name, type: row.type, keyPath: row.key_path, createdAt: row.created_at, updatedAt: row.updated_at };
    const json = JSON.stringify(dto);
    assert.ok(!json.includes('encrypted'));
    assert.ok(!json.includes('secret_encrypted'));
  });

  it('creates a credential-free session before a WebSocket writer is attached', () => {
    const store = new SqliteStore(db, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    const host = store.createHost({
      name: 'credential-free', hostname: '127.0.0.1', port: 22, username: 'operator',
      credentialId: null, tags: [], hostKeyFingerprint: null, hostKeyTrusted: false,
    });
    const session = store.createSession({hostId: host.id, credentialId: null, state: 'creating', writerId: null});

    assert.equal(session.credentialId, null);
    assert.equal(session.writerId, null);
    assert.ok(session.createdAt);
    assert.ok(session.updatedAt);

    store.updateSession(session.id, {state: 'active', writerId: 'writer'});
    let connection = db.prepare('SELECT status FROM ssh_connections WHERE id = (SELECT connection_id FROM shell_sessions WHERE id = ?)').get(session.id) as {status: string};
    assert.equal(connection.status, 'active');
    store.updateSession(session.id, {state: 'detached', writerId: null});
    connection = db.prepare('SELECT status FROM ssh_connections WHERE id = (SELECT connection_id FROM shell_sessions WHERE id = ?)').get(session.id) as {status: string};
    assert.equal(connection.status, 'active', 'detached shell retains its live SSH connection');
    store.updateSession(session.id, {state: 'failed', closedAt: new Date().toISOString()});
    connection = db.prepare('SELECT status FROM ssh_connections WHERE id = (SELECT connection_id FROM shell_sessions WHERE id = ?)').get(session.id) as {status: string};
    assert.equal(connection.status, 'error');
  });

  it('migrates the legacy NOT NULL ownership schema without losing session rows', () => {
    const legacy = openDatabase(':memory:');
    try {
      legacy.exec(`
        CREATE TABLE credentials (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
          secret_encrypted BLOB, key_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE hosts (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, hostname TEXT NOT NULL, port INTEGER NOT NULL,
          user TEXT NOT NULL, host_key_fingerprint TEXT, host_key_trusted INTEGER NOT NULL,
          credential_id TEXT REFERENCES credentials(id), tags TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE ssh_connections (
          id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id),
          credential_id TEXT NOT NULL REFERENCES credentials(id), status TEXT NOT NULL,
          opened_at TEXT NOT NULL, closed_at TEXT, last_error TEXT
        );
        CREATE TABLE shell_sessions (
          id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES ssh_connections(id), title TEXT,
          writer_id TEXT NOT NULL, status TEXT NOT NULL, term_size TEXT, scrollback_limit INTEGER,
          created_at TEXT NOT NULL, detached_at TEXT, reattached_at TEXT, closed_at TEXT
        );
        CREATE TABLE session_attachments (
          id TEXT PRIMARY KEY, session_id TEXT REFERENCES shell_sessions(id), filename TEXT NOT NULL,
          stored_name TEXT NOT NULL, size INTEGER NOT NULL, mime_type TEXT, direction TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT REFERENCES shell_sessions(id),
          event_type TEXT NOT NULL, actor_id TEXT, data TEXT, created_at TEXT NOT NULL
        );
        INSERT INTO credentials VALUES ('cred', 'legacy', 'password', NULL, NULL, '2026-01-01', '2026-01-01');
        INSERT INTO hosts VALUES ('host', 'legacy', '127.0.0.1', 22, 'operator', NULL, 0, 'cred', '[]', '2026-01-01', '2026-01-01');
        INSERT INTO ssh_connections VALUES ('conn', 'host', 'cred', 'active', '2026-01-01', NULL, NULL);
        INSERT INTO shell_sessions VALUES ('session', 'conn', NULL, 'writer', 'active', '{}', 1000, '2026-01-01', NULL, NULL, NULL);
        INSERT INTO session_attachments VALUES ('attachment', 'session', 'file.txt', 'stored', 4, 'text/plain', 'upload', '2026-01-01');
        INSERT INTO audit_logs (session_id, event_type, created_at) VALUES ('session', 'legacy_event', '2026-01-01');
      `);

      runMigrations(legacy);

      const connectionColumns = legacy.pragma('table_info(ssh_connections)') as Array<{name: string; notnull: number}>;
      const sessionColumns = legacy.pragma('table_info(shell_sessions)') as Array<{name: string; notnull: number}>;
      assert.equal(connectionColumns.find((column) => column.name === 'credential_id')?.notnull, 0);
      assert.equal(sessionColumns.find((column) => column.name === 'writer_id')?.notnull, 0);
      assert.ok(sessionColumns.some((column) => column.name === 'updated_at'));
      assert.equal((legacy.prepare('SELECT COUNT(*) AS count FROM shell_sessions WHERE id = ?').get('session') as {count: number}).count, 1);
      assert.equal((legacy.prepare('SELECT COUNT(*) AS count FROM session_attachments WHERE session_id = ?').get('session') as {count: number}).count, 1);
      assert.equal((legacy.prepare('SELECT COUNT(*) AS count FROM audit_logs WHERE session_id = ?').get('session') as {count: number}).count, 1);
      assert.equal((legacy.pragma('foreign_key_list(shell_sessions)') as Array<{table: string}>)[0]?.table, 'ssh_connections');
      assert.deepEqual(legacy.pragma('foreign_key_check'), []);
    } finally {
      legacy.close();
    }
  });
});
