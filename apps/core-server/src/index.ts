import { openDatabase, runMigrations } from '@remotedeck/core';
import { resolveConfig } from './config.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  // Fail closed: throws if REMOTEDECK_MASTER_KEY / REMOTEDECK_API_TOKEN are missing/invalid.
  const config = resolveConfig(process.env);

  const db = openDatabase(config.dbPath);
  runMigrations(db);

  const { app, attachWebSocketServer } = createApp(db, config, { logger: true });
  attachWebSocketServer();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`RemoteDeck core-server listening on :${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
