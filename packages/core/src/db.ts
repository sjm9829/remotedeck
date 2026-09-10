import Database from 'better-sqlite3';

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('key', 'agent', 'password')),
      secret_encrypted BLOB,
      key_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

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

    CREATE TABLE IF NOT EXISTS ssh_connections (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL REFERENCES hosts(id),
      credential_id TEXT REFERENCES credentials(id),
      status TEXT NOT NULL DEFAULT 'connecting',
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS shell_sessions (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES ssh_connections(id),
      title TEXT,
      writer_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      term_size TEXT DEFAULT '{"rows":24,"cols":80}',
      scrollback_limit INTEGER DEFAULT 10000,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
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
  migrateNullableSessionOwnership(db);
}

function tableColumns(db: Database.Database, table: string): Array<{ name: string; notnull: number }> {
  return db.pragma(`table_info(${table})`) as Array<{ name: string; notnull: number }>;
}

/**
 * Slice 2 created connection/session ownership columns as NOT NULL even though
 * both are legitimately absent before credentials or a WebSocket writer are
 * attached. Rebuild the two tables in place so existing databases retain their
 * rows and foreign-key identities while adopting the actual runtime contract.
 */
function migrateNullableSessionOwnership(db: Database.Database): void {
  const connectionColumns = tableColumns(db, 'ssh_connections');
  const sessionColumns = tableColumns(db, 'shell_sessions');
  const credentialId = connectionColumns.find((column) => column.name === 'credential_id');
  const writerId = sessionColumns.find((column) => column.name === 'writer_id');
  const hasUpdatedAt = sessionColumns.some((column) => column.name === 'updated_at');
  if (credentialId?.notnull !== 1 && writerId?.notnull !== 1 && hasUpdatedAt) return;

  const updatedAtSource = hasUpdatedAt ? 'updated_at' : 'created_at';
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE ssh_connections_next (
          id TEXT PRIMARY KEY,
          host_id TEXT NOT NULL REFERENCES hosts(id),
          credential_id TEXT REFERENCES credentials(id),
          status TEXT NOT NULL DEFAULT 'connecting',
          opened_at TEXT NOT NULL,
          closed_at TEXT,
          last_error TEXT
        );
        INSERT INTO ssh_connections_next
          (id, host_id, credential_id, status, opened_at, closed_at, last_error)
          SELECT id, host_id, credential_id, status, opened_at, closed_at, last_error FROM ssh_connections;

        CREATE TABLE shell_sessions_next (
          id TEXT PRIMARY KEY,
          connection_id TEXT NOT NULL REFERENCES ssh_connections_next(id),
          title TEXT,
          writer_id TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          term_size TEXT DEFAULT '{"rows":24,"cols":80}',
          scrollback_limit INTEGER DEFAULT 10000,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          detached_at TEXT,
          reattached_at TEXT,
          closed_at TEXT
        );
        INSERT INTO shell_sessions_next
          (id, connection_id, title, writer_id, status, term_size, scrollback_limit,
           created_at, updated_at, detached_at, reattached_at, closed_at)
          SELECT id, connection_id, title, writer_id, status, term_size, scrollback_limit,
                 created_at, ${updatedAtSource}, detached_at, reattached_at, closed_at
          FROM shell_sessions;

        DROP TABLE shell_sessions;
        DROP TABLE ssh_connections;
        ALTER TABLE ssh_connections_next RENAME TO ssh_connections;
        ALTER TABLE shell_sessions_next RENAME TO shell_sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON shell_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_sessions_connection ON shell_sessions(connection_id);
        CREATE INDEX IF NOT EXISTS idx_connections_host ON ssh_connections(host_id);
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) throw new Error('session schema migration produced foreign-key violations');
}
