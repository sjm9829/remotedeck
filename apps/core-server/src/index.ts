import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase, runMigrations } from '@remotedeck/core';
import { SqliteStore } from '@remotedeck/core';
import { resolveConfig } from './config.js';
import { createApp } from './app.js';
import { Ssh2Transport } from './transport-ssh2.js';

async function main(): Promise<void> {
  const config = resolveConfig(process.env); // fail closed
  mkdirSync(dirname(config.dbPath), { recursive: true }); // ensure data dir exists (fail closed still applies to config)
  const db = openDatabase(config.dbPath);
  runMigrations(db);
  const store = new SqliteStore(db, config.masterKey);
  const transport = new Ssh2Transport();
  const { app, attachWebSocketServer } = createApp({ store, transport, config }, { logger: true });
  attachWebSocketServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`RemoteDeck core-server listening on :${config.port}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
