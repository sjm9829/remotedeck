import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Store } from '@remotedeck/core/store';
import type { SessionManager } from '@remotedeck/core/session/manager';
import type { TicketStore } from '@remotedeck/core/ticket';
import { v4 as uuidv4 } from 'uuid';

export interface RouteDeps { store: Store; manager: SessionManager; ticketStore: TicketStore; startTime: number; version: string; }

const CRED_TYPES = new Set(['key', 'password', 'agent']);
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/=]+$/;

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, manager, ticketStore, startTime, version } = deps;

  app.get('/api/status', async () => {
    const c = store.statusCounts();
    return { status: 'ok', version, uptime: Math.floor((Date.now() - startTime) / 1000), sessions: c.sessions, connections: c.connections };
  });

  // ---- hosts ----
  app.get('/api/hosts', async () => ({ data: store.listHosts() }));

  app.get<{ Params: { id: string } }>('/api/hosts/:id', async (req, reply) => {
    const h = store.getHost(req.params.id);
    return h ? { data: h } : fail(reply, 404, 'not_found', 'host not found');
  });

  app.post<{ Body: any }>('/api/hosts', async (req, reply) => {
    const b: any = req.body ?? {};
    for (const f of ['name', 'hostname', 'user']) if (!b[f] || typeof b[f] !== 'string') return fail(reply, 400, 'bad_request', `${f} is required`);
    if (b.credentialId && !store.getCredential(b.credentialId)) return fail(reply, 400, 'bad_request', 'unknown credentialId');
    const port = b.port === undefined ? 22 : Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(reply, 400, 'bad_request', 'invalid port');
    const row = store.createHost({ name: b.name, hostname: b.hostname, port, username: b.user,
      credentialId: b.credentialId ?? null, tags: Array.isArray(b.tags) ? b.tags : [],
      hostKeyFingerprint: null, hostKeyTrusted: false });
    return reply.code(201).send({ data: row });
  });

  app.patch<{ Params: { id: string }; Body: any }>('/api/hosts/:id', async (req, reply) => {
    const b: any = req.body ?? {};
    if (b.credentialId && !store.getCredential(b.credentialId)) return fail(reply, 400, 'bad_request', 'unknown credentialId');
    const fields: any = {};
    for (const k of ['name', 'hostname', 'user', 'credentialId', 'tags']) if (k in b) fields[k] = b[k];
    if (Object.keys(fields).length === 0) return fail(reply, 400, 'bad_request', 'no fields to update');
    const row = store.updateHost(req.params.id, fields);
    return row ? { data: row } : fail(reply, 404, 'not_found', 'host not found');
  });

  app.delete<{ Params: { id: string } }>('/api/hosts/:id', async (req, reply) => {
    if (!store.getHost(req.params.id)) return fail(reply, 404, 'not_found', 'host not found');
    if (store.hostHasSessions(req.params.id)) return fail(reply, 409, 'conflict', 'host has sessions');
    store.deleteHost(req.params.id);
    return reply.code(204).send();
  });

  // Explicit trust: required before connecting to a host whose key is not yet trusted.
  app.post<{ Params: { id: string }; Body: any }>('/api/hosts/:id/trust', async (req, reply) => {
    const b: any = req.body ?? {};
    if (!b.fingerprint || typeof b.fingerprint !== 'string' || !FINGERPRINT_RE.test(b.fingerprint))
      return fail(reply, 400, 'bad_request', 'fingerprint must match SHA256:<base64>');
    if (!store.getHost(req.params.id)) return fail(reply, 404, 'not_found', 'host not found');
    await manager.trustHost(req.params.id, b.fingerprint);
    return { data: store.getHost(req.params.id) };
  });

  // ---- credentials (never return the secret) ----
  app.get('/api/credentials', async () => ({ data: store.listCredentials() }));

  app.get<{ Params: { id: string } }>('/api/credentials/:id', async (req, reply) => {
    const c = store.getCredential(req.params.id);
    return c ? { data: c } : fail(reply, 404, 'not_found', 'credential not found');
  });

  app.post<{ Body: any }>('/api/credentials', async (req, reply) => {
    const b: any = req.body ?? {};
    if (!b.name || typeof b.name !== 'string') return fail(reply, 400, 'bad_request', 'name is required');
    if (!b.type || !CRED_TYPES.has(b.type)) return fail(reply, 400, 'bad_request', `type must be one of ${[...CRED_TYPES].join('|')}`);
    if (b.type !== 'agent' && !b.secret && !b.keyPath) return fail(reply, 400, 'bad_request', 'secret or keyPath required for this type');
    const row = store.createCredential({ name: b.name, type: b.type, secret: b.secret ?? null, keyPath: b.keyPath ?? null });
    return reply.code(201).send({ data: row });
  });

  app.patch<{ Params: { id: string }; Body: any }>('/api/credentials/:id', async (req, reply) => {
    const b: any = req.body ?? {};
    const fields: any = {};
    if ('name' in b) fields.name = b.name;
    if ('type' in b) { if (!CRED_TYPES.has(b.type)) return fail(reply, 400, 'bad_request', 'invalid type'); fields.type = b.type; }
    if ('keyPath' in b) fields.keyPath = b.keyPath;
    if ('secret' in b && b.secret) fields.secret = b.secret; // empty secret => keep existing
    if (Object.keys(fields).length === 0) return fail(reply, 400, 'bad_request', 'no fields to update');
    const row = store.updateCredential(req.params.id, fields);
    return row ? { data: row } : fail(reply, 404, 'not_found', 'credential not found');
  });

  app.delete<{ Params: { id: string } }>('/api/credentials/:id', async (req, reply) => {
    if (!store.getCredential(req.params.id)) return fail(reply, 404, 'not_found', 'credential not found');
    if (store.credentialReferenced(req.params.id)) return fail(reply, 409, 'conflict', 'credential is referenced');
    store.deleteCredential(req.params.id);
    return reply.code(204).send();
  });

  // ---- sessions ----
  app.get('/api/sessions', async () => ({ data: store.listSessions() }));

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const s = store.getSession(req.params.id);
    return s ? { data: s } : fail(reply, 404, 'not_found', 'session not found');
  });

  app.post<{ Body: any }>('/api/sessions', async (req, reply) => {
    const b: any = req.body ?? {};
    if (!b.hostId) return fail(reply, 400, 'bad_request', 'hostId is required');
    if (!store.getHost(b.hostId)) return fail(reply, 404, 'not_found', 'host not found');
    try {
      const { session, requiresTrust, fingerprint } = await manager.createSession({ hostId: b.hostId, credentialId: b.credentialId ?? null });
      if (requiresTrust) return reply.code(202).send({ data: { ...session, requiresTrust: true, fingerprint } });
      return reply.code(201).send({ data: { ...session, requiresTrust: false } });
    } catch (e: any) {
      if (e.code === 'not_found') return fail(reply, 404, 'not_found', e.message);
      return fail(reply, 409, 'conflict', e.message);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/close', async (req, reply) => {
    const s = store.getSession(req.params.id);
    if (!s) return fail(reply, 404, 'not_found', 'session not found');
    try { await manager.closeSession(req.params.id); } catch { store.updateSession(req.params.id, { state: 'closed', closedAt: new Date().toISOString() }); }
    return { data: store.getSession(req.params.id) };
  });

  // Issue a single-use, short-lived WS ticket (authenticated REST; WS uses subprotocol).
  app.post<{ Params: { id: string }; Body: any }>('/api/sessions/:id/ws-ticket', async (req, reply) => {
    const b: any = req.body ?? {};
    const role = b.role ?? 'writer';
    if (role !== 'writer' && role !== 'viewer') return fail(reply, 400, 'bad_request', "role must be 'writer' or 'viewer'");
    if (!store.getSession(req.params.id)) return fail(reply, 404, 'not_found', 'session not found');
    const t = ticketStore.issue(req.params.id, role);
    return { data: { ticket: t.value, sessionId: t.sessionId, role: t.role, expiresAt: new Date(t.expiresAt).toISOString() } };
  });
}
