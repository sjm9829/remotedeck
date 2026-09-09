// SFTP REST routes: session CRUD + session-scoped file operations. Paths are
// relative to the session rootPath; the manager validates them (path safety,
// symlink escape, root operations) and maps errors to stable 4xx codes.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SftpSessionManager } from '@remotedeck/core/session/sftp-manager';

function httpError(message: string, code: string, status: number): any {
  const e: any = new Error(message);
  e.code = code;
  e.statusCode = status;
  return e;
}

export function registerSftpRoutes(app: FastifyInstance, deps: { sftpManager: SftpSessionManager }): void {
  const { sftpManager } = deps;

  app.post('/api/sftp/sessions', async (req, reply) => {
    const body = (req.body ?? {}) as { hostId?: string; credentialId?: string | null; rootPath?: string };
    if (!body.hostId) throw httpError('hostId is required', 'bad_request', 400);
    if (!body.rootPath || typeof body.rootPath !== 'string') throw httpError('rootPath is required', 'bad_request', 400);
    const { session, requiresTrust, fingerprint } = await sftpManager.create({ hostId: body.hostId, credentialId: body.credentialId ?? null, rootPath: body.rootPath });
    if (requiresTrust) return reply.code(202).send({ session, requiresTrust: true, fingerprint });
    return reply.code(201).send({ session, requiresTrust: false });
  });

  app.get('/api/sftp/sessions', async () => ({ sessions: sftpManager.list() }));

app.post('/api/sftp/sessions/:id/trust', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await sftpManager.trustSession(id);
    return { session };
  });

  app.get('/api/sftp/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sftpManager.get(id);
    if (!session) throw httpError('sftp session not found', 'not_found', 404);
    return { session };
  });

  app.delete('/api/sftp/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!sftpManager.get(id)) throw httpError('sftp session not found', 'not_found', 404);
    await sftpManager.close(id);
    return { ok: true };
  });

  app.get('/api/sftp/sessions/:id/list', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string };
    const dir = typeof q.path === 'string' ? q.path : '';
    const files = await sftpManager.listFiles(id, dir);
    return { files, path: dir };
  });

  app.get('/api/sftp/sessions/:id/stat', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string };
    if (!q.path) throw httpError('path is required', 'bad_request', 400);
    return { stat: await sftpManager.stat(id, q.path) };
  });

  app.post('/api/sftp/sessions/:id/mkdir', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { path?: string };
    if (!body.path) throw httpError('path is required', 'bad_request', 400);
    await sftpManager.mkdir(id, body.path);
    return { ok: true };
  });

  app.post('/api/sftp/sessions/:id/rename', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { from?: string; to?: string };
    if (!body.from || !body.to) throw httpError('from and to are required', 'bad_request', 400);
    await sftpManager.rename(id, body.from, body.to);
    return { ok: true };
  });

  app.delete('/api/sftp/sessions/:id/file', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string };
    if (!q.path) throw httpError('path is required', 'bad_request', 400);
    await sftpManager.unlink(id, q.path);
    return { ok: true };
  });

  app.delete('/api/sftp/sessions/:id/dir', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string };
    if (!q.path) throw httpError('path is required', 'bad_request', 400);
    await sftpManager.rmdir(id, q.path);
    return { ok: true };
  });

  // Upload: stream the raw request body to a temp file, then rename (atomic).
  app.put('/api/sftp/sessions/:id/upload', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string; overwrite?: string };
    if (!q.path) throw httpError('path is required', 'bad_request', 400);
    const overwrite = q.overwrite === 'true' || q.overwrite === '1';
    await sftpManager.upload(id, req.raw, q.path, { overwrite });
    return { ok: true };
  });

  // Download: stream the remote file to the response (bounded memory).
  app.get('/api/sftp/sessions/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string };
    if (!q.path) throw httpError('path is required', 'bad_request', 400);
    const stream = await sftpManager.download(id, q.path);
    reply.header('content-type', 'application/octet-stream');
    stream.on('error', (e: any) => { try { reply.raw.destroy(e); } catch { /* */ } });
    stream.pipe(reply.raw);
    return reply;
  });
}
