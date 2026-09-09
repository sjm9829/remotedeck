import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase, runMigrations } from '@remotedeck/core';
import { SqliteStore } from '@remotedeck/core';
import { resolveConfig } from './config.js';
import { createApp } from './app.js';
import { Ssh2Transport } from './transport-ssh2.js';
import { SftpSsh2Transport } from './transport-sftp.js';

async function main(): Promise<void> {
  const config = resolveConfig(process.env); // fail closed
  mkdirSync(dirname(config.dbPath), { recursive: true }); // ensure data dir exists (fail closed still applies to config)
  const db = openDatabase(config.dbPath);
  runMigrations(db);
  const store = new SqliteStore(db, config.masterKey);
  const transport = new Ssh2Transport();
  const sftpTransport = new SftpSsh2Transport();
  const { app, attachWebSocketServer, manager, sftpManager } = createApp({ store, transport, sftpTransport, config }, { logger: true });
  // Clean up stale SFTP sessions left in the DB by a previous server run.
  const stale = sftpManager.recover();
  if (stale.length > 0) console.log(`[sftp] cleaned ${stale.length} stale session(s)`);
  attachWebSocketServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`RemoteDeck core-server listening on :${config.port}`);
  const shutdown = (): void => { try { sftpManager.dispose(); } catch { /* */ } process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => { console.error(err); process.exit(1); });
