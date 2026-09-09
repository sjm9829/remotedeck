import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { WebSocketServer } from 'ws';
import type { ResolvedConfig } from './config.js';
import type { Db } from './dbtypes.js';
import { registerRoutes } from './routes.js';
import { constantTimeTokenEquals, extractBearer } from './auth.js';

export const HEALTH_PATH = '/healthz';
export const WS_PATH_PREFIX = '/ws';

export interface AppHandle {
  app: FastifyInstance;
  /** Attach the WebSocket upgrade handler to the running server. */
  attachWebSocketServer: () => WebSocketServer;
}

export function createApp(
  db: Db,
  config: ResolvedConfig,
  opts: { logger?: boolean } = {},
): AppHandle {
  const app = Fastify({ logger: opts.logger ?? false });

  // CORS: explicit allow-list only. Empty list => no cross-origin (same-origin only).
  app.register(cors, {
    origin: config.allowedOrigins,
    credentials: true,
  });
  app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  // Auth hook: only /healthz is unauthenticated. Everything else requires a valid token.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path === HEALTH_PATH) return;
    const presented = extractBearer(req.headers.authorization);
    if (!presented || !constantTimeTokenEquals(presented, config.apiToken)) {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing or invalid token' } });
    }
  });

  // Health endpoint (no auth).
  app.get(HEALTH_PATH, async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // API routes (protected by the auth hook above).
  registerRoutes(app, db, config.masterKey, Date.now());

  const wss = new WebSocketServer({ noServer: true });

  function attachWebSocketServer(): WebSocketServer {
    app.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      if (!url.pathname.startsWith(WS_PATH_PREFIX)) return;
      // Browsers cannot set custom headers on WS handshakes, so a ?token= query is
      // accepted as an alternative to the Authorization header.
      const presented = extractBearer(req.headers.authorization) ?? url.searchParams.get('token');
      if (!presented || !constantTimeTokenEquals(presented, config.apiToken)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    return wss;
  }

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
      type: 'status',
      ts: new Date().toISOString(),
      data: { status: 'connected', message: 'RemoteDeck Core 1A' },
    }));
    ws.on('close', () => {});
  });

  return { app, attachWebSocketServer };
}
