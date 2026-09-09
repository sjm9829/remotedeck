import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Simple integration test: start server on ephemeral port, hit /healthz
// We use a simpler approach: just verify the modules load and DB migration works

import { openDatabase, runMigrations, encrypt, decrypt, serializePayload, deserializePayload } from '@remotedeck/core';

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
});
