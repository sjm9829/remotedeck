import Fastify, { type FastifyInstance, type FastifyError, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { SessionManager } from '@remotedeck/core/session/manager';
import { SftpSessionManager } from '@remotedeck/core/session/sftp-manager';
import type { SftpTransport } from '@remotedeck/core/session/sftp-transport';
import { registerSftpRoutes } from './routes-sftp.js';
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
  sftpTransport: SftpTransport;
  config: ResolvedConfig;
  manager?: SessionManager;
  sftpManager?: SftpSessionManager;
  ticketStore?: TicketStore;
}
export interface AppHandle {
  app: FastifyInstance;
  manager: SessionManager;
  sftpManager: SftpSessionManager;
  ticketStore: TicketStore;
  store: Store;
  transport: SshTransport;
  attachWebSocketServer: () => import('ws').WebSocketServer;
}

const CODE_STATUS: Record<string, number> = {
  not_found: 404, conflict: 409, forbidden: 403, invalid_state: 409, bad_request: 400, unauthorized: 401,
  // SFTP file-operation error codes -> stable 4xx/5xx mapping.
  no_such_file: 404, exists: 409, not_empty: 409, not_a_directory: 400, not_a_file: 400,
  outside_root: 403, root_operation: 400, invalid_path: 400, invalid_root: 400,
  permission_denied: 403, sftp_failure: 500,
  session_closed: 409, session_not_found: 404,
  sftp_connect_failed: 502, fingerprint_mismatch: 409, unreachable: 502,
  auth_failed: 502, timeout: 502, subsystem_failed: 502, not_supported: 400,
  host_not_found: 404, invalid_credential: 400,
};

export function createApp(deps: AppDeps, opts: { logger?: boolean; idleTimeoutMs?: number } = {}): AppHandle {
  const { config, store } = deps;
  const manager = deps.manager ?? new SessionManager({ store, transport: deps.transport, idleTimeoutMs: opts.idleTimeoutMs });
  const sftpManager = deps.sftpManager ?? new SftpSessionManager({ store, transport: deps.sftpTransport, idleTimeoutMs: opts.idleTimeoutMs });
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
  registerSftpRoutes(app, { sftpManager });

  const attachWebSocketServer = attachWs(app, { manager, ticketStore });

  return { app, manager, sftpManager, ticketStore, store, transport: deps.transport, attachWebSocketServer };
}
