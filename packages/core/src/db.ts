import Database from 'better-sqlite3';

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hostname TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22,
      user TEXT NOT NULL,
      host_key_fingerprint TEXT,
      host_key_trusted INTEGER NOT NULL DEFAULT 0,
      credential_id TEXT REFERENCES credentials(id),
      tags TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('key', 'agent', 'password')),
      secret_encrypted BLOB,
      key_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ssh_connections (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL REFERENCES hosts(id),
      credential_id TEXT NOT NULL REFERENCES credentials(id),
      status TEXT NOT NULL DEFAULT 'connecting',
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS shell_sessions (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES ssh_connections(id),
      title TEXT,
      writer_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      term_size TEXT DEFAULT '{"rows":24,"cols":80}',
      scrollback_limit INTEGER DEFAULT 10000,
      created_at TEXT NOT NULL,
      detached_at TEXT,
      reattached_at TEXT,
      closed_at TEXT
    );
  CREATE TABLE IF NOT EXISTS sftp_sessions (
    id TEXT PRIMARY KEY, hostId TEXT NOT NULL, credentialId TEXT,
    rootPath TEXT NOT NULL, fingerprint TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'starting', reason TEXT,
    lastActiveAt TEXT NOT NULL, closedAt TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );

    CREATE TABLE IF NOT EXISTS session_attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES shell_sessions(id),
      filename TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT,
      direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES shell_sessions(id),
      event_type TEXT NOT NULL,
      actor_id TEXT,
      data TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_status ON shell_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_connection ON shell_sessions(connection_id);
    CREATE INDEX IF NOT EXISTS idx_connections_host ON ssh_connections(host_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_session ON session_attachments(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_session_time ON audit_logs(session_id, created_at);
  `);
}
