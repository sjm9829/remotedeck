import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { WebSocketServer } from 'ws';
import { openDatabase, runMigrations } from '@remotedeck/core';
import { registerRoutes } from './routes.js';

const PORT = parseInt(process.env.PORT || '4100', 10);
const DB_PATH = process.env.DATABASE_PATH || './data/remotedeck.db';
const MASTER_KEY = process.env.REMOTEDECK_MASTER_KEY || '';

const startTime = Date.now();

async function main() {
  const app = Fastify({ logger: true });

  await app.register(cors);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  // Open and migrate DB
  const db = openDatabase(DB_PATH);
  runMigrations(db);

  // Simple auth middleware (single-user: check bearer token)
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing or invalid token' } });
    }
  });

  // Health endpoint (no auth)
  app.get('/healthz', async () => ({
    status: 'ok' as const,
    timestamp: new Date().toISOString(),
  }));

  // Register API routes
  registerRoutes(app, db, MASTER_KEY, startTime);

  // Start HTTP server
  await app.listen({ port: PORT, host: '0.0.0.0' });

  // Attach WebSocket server
  const wss = new WebSocketServer({ server: app.server, path: '/ws/v1/sessions/' });
  wss.on('connection', (ws, req) => {
    ws.send(JSON.stringify({
      type: 'status',
      ts: new Date().toISOString(),
      data: { status: 'connected', message: 'RemoteDeck Core 1A skeleton' },
    }));
    ws.on('close', () => {});
  });

  console.log(`RemoteDeck core-server listening on :${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
