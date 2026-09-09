// Minimal RemoteDeck client SDK (browser + node). Credentials/token live only in
// memory; nothing is persisted to localStorage. WebSocket auth uses a single-use
// ticket via the Sec-WebSocket-Protocol subprotocol (never a URL query token).
import type { WsMessage } from '@remotedeck/protocol';
import type { Readable } from 'node:stream';

export interface ClientConfig { baseUrl: string; token: string; }
const WS_SUBPROTOCOL_PREFIX = 'remotedeck.v1.';

async function j(res: Response): Promise<any> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

export class RemoteDeckClient {
  private baseUrl: string;
  private token: string;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
  }
  private headers(): Record<string, string> { return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }; }

  async health(): Promise<{ status: string; timestamp: string }> { return (await j(await fetch(`${this.baseUrl}/healthz`))); }
  async status(): Promise<any> { return (await j(await fetch(`${this.baseUrl}/api/status`, { headers: this.headers() }))); }

  async listHosts(): Promise<any[]> { return (await j(await fetch(`${this.baseUrl}/api/hosts`, { headers: this.headers() }))).data; }
  async createHost(b: { name: string; hostname: string; user: string; credentialId?: string; tags?: string[] }): Promise<any> {
    return (await j(await fetch(`${this.baseUrl}/api/hosts`, { method: 'POST', headers: this.headers(), body: JSON.stringify(b) }))).data;
  }
  async trustHost(id: string, fingerprint: string): Promise<any> {
    return (await j(await fetch(`${this.baseUrl}/api/hosts/${id}/trust`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ fingerprint }) }))).data;
  }

  async createCredential(b: { name: string; type: string; secret?: string; keyPath?: string }): Promise<any> {
    return (await j(await fetch(`${this.baseUrl}/api/credentials`, { method: 'POST', headers: this.headers(), body: JSON.stringify(b) }))).data;
  }

  async listSessions(): Promise<any[]> { return (await j(await fetch(`${this.baseUrl}/api/sessions`, { headers: this.headers() }))).data; }
  async createSession(b: { hostId: string; credentialId?: string }): Promise<any> {
    return (await j(await fetch(`${this.baseUrl}/api/sessions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(b) }))).data;
  }
  async closeSession(id: string): Promise<any> {
    return (await j(await fetch(`${this.baseUrl}/api/sessions/${id}/close`, { method: 'POST', headers: this.headers() }))).data;
  }
  async wsTicket(sessionId: string, role: 'writer' | 'viewer' = 'writer'): Promise<{ ticket: string; role: string; expiresAt: string }> {
    return (await j(await fetch(`${this.baseUrl}/api/sessions/${sessionId}/ws-ticket`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ role }) }))).data;
  }

  // Open a session WebSocket using a single-use ticket via the negotiated subprotocol.
  connectSession(sessionId: string, ticket: string): WebSocket {
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    return new WebSocket(`${wsBase}/ws/sessions/${sessionId}`, [WS_SUBPROTOCOL_PREFIX + ticket]);
  }

  // ---- SFTP sessions + file operations ------------------------------------
  // Paths are relative to the session rootPath. Upload/download stream the body
  // (no whole-file buffering); the auth header is the only credential sent.
  async listSftpSessions(): Promise<any[]> {
    return (await j(await fetch(`${this.baseUrl}/api/sftp/sessions`, { headers: this.headers() }))).sessions;
  }
  async createSftpSession(b: { hostId: string; rootPath: string; credentialId?: string | null }): Promise<{ session: any; requiresTrust: boolean; fingerprint?: string }> {
    return j(await fetch(`${this.baseUrl}/api/sftp/sessions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(b) }));
  }
  async trustSftpSession(id: string): Promise<any> {
    return (await j(await fetch(`${this.baseUrl}/api/sftp/sessions/${id}/trust`, { method: 'POST', headers: this.headers() }))).session;
  }
  async getSftpSession(id: string): Promise<any> {
    return (await j(await fetch(`${this.baseUrl}/api/sftp/sessions/${id}`, { headers: this.headers() }))).session;
  }
  async closeSftpSession(id: string): Promise<void> {
    await j(await fetch(`${this.baseUrl}/api/sftp/sessions/${id}`, { method: 'DELETE', headers: this.headers() }));
  }
  async sftpList(id: string, path = ''): Promise<{ path: string; files: any[] }> {
    const q = path ? `?path=${encodeURIComponent(path)}` : '';
    return j(await fetch(`${this.baseUrl}/api/sftp/sessions/${id}/list${q}`, { headers: this.headers() }));
  }
  async sftpStat(id: string, path: string): Promise<any> {
    return (await j(await fetch(`${this.baseUrl}/api/sftp/sessions/${id}/stat?path=${encodeURIComponent(path)}`, { headers: this.headers() }))).stat;
  }
  async sftpMkdir(id: string, path: string): Promise<void> {
    await j(await fetch(`${this.baseUrl}/api/sftp/sessions/${id}/mkdir`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ path }) }));
  }
  async sftpRename(id: string, from: string, to: string): Promise<void> {
    await j(await fetch(`${this.baseUrl}/api/sftp/sessions/${id}/rename`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ from, to }) }));
  }
  async sftpDeleteFile(id: string, path: string): Promise<void> {
    await j(await fetch(`${this.baseUrl}/api/sftp/sessions/${id}/file?path=${encodeURIComponent(path)}`, { method: 'DELETE', headers: this.headers() }));
  }
  async sftpDeleteDir(id: string, path: string): Promise<void> {
    await j(await fetch(`${this.baseUrl}/api/sftp/sessions/${id}/dir?path=${encodeURIComponent(path)}`, { method: 'DELETE', headers: this.headers() }));
  }
  // `source` may be a Blob/File/ArrayBuffer/Uint8Array (browser) or a Readable (node).
  sftpUploadUrl(id: string, path: string, overwrite = false): string {
    const q = `path=${encodeURIComponent(path)}${overwrite ? '&overwrite=true' : ''}`;
    return `${this.baseUrl}/api/sftp/sessions/${id}/upload?${q}`;
  }
  async sftpUpload(id: string, path: string, source: Blob | ArrayBuffer | Uint8Array | Readable, overwrite = false): Promise<void> {
    const body = source as unknown as Blob;
    await j(await fetch(this.sftpUploadUrl(id, path, overwrite), { method: 'PUT', headers: this.headers(), body }));
  }
  sftpDownloadUrl(id: string, path: string): string {
    return `${this.baseUrl}/api/sftp/sessions/${id}/download?path=${encodeURIComponent(path)}`;
  }
  async sftpDownload(id: string, path: string): Promise<Blob> {
    const res = await fetch(this.sftpDownloadUrl(id, path), { headers: this.headers() });
    if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(`${res.status} ${JSON.stringify(body)}`); }
    return res.blob();
  }
}

export type { WsMessage };
