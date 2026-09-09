import Fastify, { type FastifyInstance, type FastifyError, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { SessionManager } from '@remotedeck/core/session/manager';
import { TicketStore } from '@remotedeck/core/ticket';
import type { Store } from '@remotedeck/core/store';
import type { SshTransport } from '@remotedeck/core/session/transport';
import type { ResolvedConfig } from './config.js';
import { registerRoutes } from './routes.js';
import { attachWebSocketServer as attachWs } from './ws.js';
import { constantTimeTokenEquals, extractBearer } from './auth.js';

export const HEALTH_PATH = '/healthz';
export const VERSION = '0.2.0';

export interface AppDeps {
  store: Store;
  transport: SshTransport;
  config: ResolvedConfig;
  manager?: SessionManager;
  ticketStore?: TicketStore;
}
export interface AppHandle {
  app: FastifyInstance;
  manager: SessionManager;
  ticketStore: TicketStore;
  store: Store;
  transport: SshTransport;
  attachWebSocketServer: () => import('ws').WebSocketServer;
}

const CODE_STATUS: Record<string, number> = { not_found: 404, conflict: 409, forbidden: 403, invalid_state: 409, bad_request: 400, unauthorized: 401 };

export function createApp(deps: AppDeps, opts: { logger?: boolean; idleTimeoutMs?: number } = {}): AppHandle {
  const { config, store } = deps;
  const manager = deps.manager ?? new SessionManager({ store, transport: deps.transport, idleTimeoutMs: opts.idleTimeoutMs });
  const ticketStore = deps.ticketStore ?? new TicketStore();

  const app = Fastify({ logger: opts.logger ?? false });
  app.register(cors, { origin: config.allowedOrigins, credentials: true });
  app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  app.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
    const status = (err as any).statusCode ?? CODE_STATUS[(err as any).code] ?? 500;
    const code = CODE_STATUS[(err as any).code] ? (err as any).code : (status === 400 ? 'validation' : 'internal_error');
    reply.code(status).type('application/json').send({ error: { code, message: err.message } });
  });

  // Auth hook: only /healthz is unauthenticated. WS upgrade is authenticated via ticket (see ws.ts).
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path === HEALTH_PATH) return;
    const presented = extractBearer(req.headers.authorization);
    if (!presented || !constantTimeTokenEquals(presented, config.apiToken)) {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing or invalid token' } });
    }
  });

  app.get(HEALTH_PATH, async () => ({ status: 'ok', timestamp: new Date().toISOString() }));
  registerRoutes(app, { store, manager, ticketStore, startTime: Date.now(), version: VERSION });

  const attachWebSocketServer = attachWs(app, { manager, ticketStore });

  return { app, manager, ticketStore, store, transport: deps.transport, attachWebSocketServer };
}
