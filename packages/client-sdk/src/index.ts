// Mode-aware RemoteDeck client SDK (browser + node).
//
// Modes:
//   'direct'      (default) - baseUrl is a full URL; token required; sends
//                Authorization: Bearer <token> on every REST request.
//   'same-origin' - baseUrl is a path prefix (e.g. '' or '/remotedeck');
//                auth is handled by the reverse proxy (e.g. Workbench);
//                NO Authorization header is sent; credentials: 'same-origin'
//                is set on every request so cookies are forwarded.
//
// WebSocket auth always uses a single-use ticket via the Sec-WebSocket-Protocol
// subprotocol ('remotedeck.v1.<ticket>'). Tokens are never placed in URLs.
//
// Credentials (token, pageOrigin) are held in memory only - nothing is written
// to localStorage, sessionStorage, or the URL.

import type { WsMessage } from '@remotedeck/protocol';
import type { Credential, Host, SshSession } from '@remotedeck/types';
import type {
  CreateCredentialRequest,
  CreateHostRequest,
  CreateSessionResponse,
  UpdateCredentialRequest,
  UpdateHostRequest,
  WsTicketResponse,
} from '@remotedeck/api';
import type { Readable } from 'node:stream';

export type ClientMode = 'direct' | 'same-origin';

export interface ClientConfig {
  /**
   * 'direct' mode     : full base URL, e.g. 'http://localhost:4100'
   * 'same-origin' mode: path prefix, e.g. '' or '/remotedeck'
   */
  baseUrl: string;
  /** API token. Required in 'direct' mode; ignored in 'same-origin' mode. */
  token?: string;
  /** Auth mode. Defaults to 'direct' for backward compatibility. */
  mode?: ClientMode;
  /**
   * Page origin used to derive the WebSocket URL in 'same-origin' mode.
   * Example: 'https://workbench.example'.
   * Defaults to window.location.origin in browser environments.
   */
  pageOrigin?: string;
}

/** WS subprotocol prefix - kept in sync with @remotedeck/protocol. */
export const WS_SUBPROTOCOL_PREFIX = 'remotedeck.v1.';

// ── URL helpers (exported for unit testing) ─────────────────────────────────

/**
 * Build the REST URL for a given API path.
 * Works correctly for both absolute (direct) and relative (same-origin) baseUrl.
 */
export function buildRestUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${path}`;
}

/**
 * Build the WebSocket URL for a session.
 *
 * 'direct' mode      : derives ws:// or wss:// from the full baseUrl.
 * 'same-origin' mode : derives ws:// or wss:// from pageOrigin (or
 *                      globalThis.location.origin in browsers) + baseUrl path.
 */
export function buildWsUrl(
  config: Pick<ClientConfig, 'baseUrl' | 'mode' | 'pageOrigin'>,
  sessionId: string,
  loc?: { protocol: string; host: string },
): string {
  const base = config.baseUrl.replace(/\/+$/, '');
  const path = `${base}/ws/sessions/${sessionId}`;

  if (config.mode === 'same-origin') {
    let origin = config.pageOrigin;
    if (!origin && loc) origin = `${loc.protocol}//${loc.host}`;
    if (!origin && typeof globalThis !== 'undefined' && 'location' in globalThis) {
      origin = (globalThis as unknown as { location: { origin: string } }).location.origin;
    }
    if (!origin) throw new Error('same-origin mode requires pageOrigin or a browser location');
    const wsProto = origin.startsWith('https') ? 'wss:' : 'ws:';
    const host = origin.replace(/^https?:\/\//, '');
    return `${wsProto}//${host}${path}`;
  }

  // 'direct' mode: convert http/https to ws/wss
  return config.baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws') + `/ws/sessions/${sessionId}`;
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function j(res: Response): Promise<any> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

// ── Client ──────────────────────────────────────────────────────────────────

export class RemoteDeckClient {
  private baseUrl: string;
  private token: string;
  private mode: ClientMode;
  private pageOrigin?: string;

  constructor(config: ClientConfig) {
    this.baseUrl    = config.baseUrl.replace(/\/+$/, '');
    this.token      = config.token ?? '';
    this.mode       = config.mode ?? 'direct';
    this.pageOrigin = config.pageOrigin;
  }

  /** Returns mode-aware headers, adding JSON content-type only for JSON bodies. */
  private headers(jsonBody = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (jsonBody) h['content-type'] = 'application/json';
    if (this.mode === 'direct' && this.token) {
      h['authorization'] = `Bearer ${this.token}`;
    }
    return h;
  }

  /**
   * Returns fetch options for the current mode.
   * 'same-origin': adds credentials: 'same-origin' so cookies are forwarded.
   */
  private fetchOpts(): { credentials?: 'same-origin' | 'include' | 'omit' } {
    return this.mode === 'same-origin' ? { credentials: 'same-origin' } : {};
  }

  private restUrl(path: string): string {
    return buildRestUrl(this.baseUrl, path);
  }

  // ---- Health / status -------------------------------------------------------

  async health(): Promise<{ status: string; timestamp: string }> {
    return j(await fetch(this.restUrl('/healthz'), this.fetchOpts()));
  }

  async status(): Promise<any> {
    return j(await fetch(this.restUrl('/api/status'), { headers: this.headers(), ...this.fetchOpts() }));
  }

  // ---- Hosts -----------------------------------------------------------------

  async listHosts(): Promise<Host[]> {
    return (await j(await fetch(this.restUrl('/api/hosts'), { headers: this.headers(), ...this.fetchOpts() }))).data;
  }

  async getHost(id: string): Promise<Host> {
    return (await j(await fetch(this.restUrl(`/api/hosts/${id}`), { headers: this.headers(), ...this.fetchOpts() }))).data;
  }

  async createHost(b: CreateHostRequest): Promise<Host> {
    return (await j(await fetch(this.restUrl('/api/hosts'), { method: 'POST', headers: this.headers(true), body: JSON.stringify(b), ...this.fetchOpts() }))).data;
  }

  async updateHost(id: string, b: UpdateHostRequest): Promise<Host> {
    return (await j(await fetch(this.restUrl(`/api/hosts/${id}`), { method: 'PATCH', headers: this.headers(true), body: JSON.stringify(b), ...this.fetchOpts() }))).data;
  }

  async trustHost(id: string, fingerprint: string): Promise<Host> {
    return (await j(await fetch(this.restUrl(`/api/hosts/${id}/trust`), { method: 'POST', headers: this.headers(true), body: JSON.stringify({ fingerprint }), ...this.fetchOpts() }))).data;
  }

  // ---- Credentials -----------------------------------------------------------

  async listCredentials(): Promise<Credential[]> {
    return (await j(await fetch(this.restUrl('/api/credentials'), { headers: this.headers(), ...this.fetchOpts() }))).data;
  }

  async getCredential(id: string): Promise<Credential> {
    return (await j(await fetch(this.restUrl(`/api/credentials/${id}`), { headers: this.headers(), ...this.fetchOpts() }))).data;
  }

  async createCredential(b: CreateCredentialRequest): Promise<Credential> {
    return (await j(await fetch(this.restUrl('/api/credentials'), { method: 'POST', headers: this.headers(true), body: JSON.stringify(b), ...this.fetchOpts() }))).data;
  }

  async updateCredential(id: string, b: UpdateCredentialRequest): Promise<Credential> {
    return (await j(await fetch(this.restUrl(`/api/credentials/${id}`), { method: 'PATCH', headers: this.headers(true), body: JSON.stringify(b), ...this.fetchOpts() }))).data;
  }

  // ---- SSH sessions ----------------------------------------------------------

  async listSessions(): Promise<SshSession[]> {
    return (await j(await fetch(this.restUrl('/api/sessions'), { headers: this.headers(), ...this.fetchOpts() }))).data;
  }

  async createSession(b: { hostId: string; credentialId?: string | null }): Promise<CreateSessionResponse['data']> {
    return (await j(await fetch(this.restUrl('/api/sessions'), { method: 'POST', headers: this.headers(true), body: JSON.stringify(b), ...this.fetchOpts() }))).data;
  }

  async closeSession(id: string): Promise<SshSession> {
    return (await j(await fetch(this.restUrl(`/api/sessions/${id}/close`), { method: 'POST', headers: this.headers(), ...this.fetchOpts() }))).data;
  }

  async wsTicket(sessionId: string, role: 'writer' | 'viewer' = 'writer'): Promise<WsTicketResponse['data']> {
    return (await j(await fetch(this.restUrl(`/api/sessions/${sessionId}/ws-ticket`), { method: 'POST', headers: this.headers(true), body: JSON.stringify({ role }), ...this.fetchOpts() }))).data;
  }

  /** Open a session WebSocket using a single-use ticket via the negotiated subprotocol. */
  connectSession(sessionId: string, ticket: string): WebSocket {
    const wsUrl = buildWsUrl({ baseUrl: this.baseUrl, mode: this.mode, pageOrigin: this.pageOrigin }, sessionId);
    return new WebSocket(wsUrl, [WS_SUBPROTOCOL_PREFIX + ticket]);
  }

  // ---- SFTP sessions + file operations ----------------------------------------
  // Paths are relative to the session rootPath. Upload/download stream the body
  // (no whole-file buffering). In same-origin mode the auth header is omitted;
  // cookies are forwarded instead.

  async listSftpSessions(): Promise<any[]> {
    return (await j(await fetch(this.restUrl('/api/sftp/sessions'), { headers: this.headers(), ...this.fetchOpts() }))).sessions;
  }

  async createSftpSession(b: { hostId: string; rootPath: string; credentialId?: string | null }): Promise<{ session: any; requiresTrust: boolean; fingerprint?: string }> {
    return j(await fetch(this.restUrl('/api/sftp/sessions'), { method: 'POST', headers: this.headers(true), body: JSON.stringify(b), ...this.fetchOpts() }));
  }

  async trustSftpSession(id: string): Promise<any> {
    return (await j(await fetch(this.restUrl(`/api/sftp/sessions/${id}/trust`), { method: 'POST', headers: this.headers(), ...this.fetchOpts() }))).session;
  }

  async getSftpSession(id: string): Promise<any> {
    return (await j(await fetch(this.restUrl(`/api/sftp/sessions/${id}`), { headers: this.headers(), ...this.fetchOpts() }))).session;
  }

  async closeSftpSession(id: string): Promise<void> {
    await j(await fetch(this.restUrl(`/api/sftp/sessions/${id}`), { method: 'DELETE', headers: this.headers(), ...this.fetchOpts() }));
  }

  async sftpList(id: string, path = ''): Promise<{ path: string; files: any[] }> {
    const q = path ? `?path=${encodeURIComponent(path)}` : '';
    return j(await fetch(this.restUrl(`/api/sftp/sessions/${id}/list${q}`), { headers: this.headers(), ...this.fetchOpts() }));
  }

  async sftpStat(id: string, path: string): Promise<any> {
    return (await j(await fetch(this.restUrl(`/api/sftp/sessions/${id}/stat?path=${encodeURIComponent(path)}`), { headers: this.headers(), ...this.fetchOpts() }))).stat;
  }

  async sftpMkdir(id: string, path: string): Promise<void> {
    await j(await fetch(this.restUrl(`/api/sftp/sessions/${id}/mkdir`), { method: 'POST', headers: this.headers(true), body: JSON.stringify({ path }), ...this.fetchOpts() }));
  }

  async sftpRename(id: string, from: string, to: string): Promise<void> {
    await j(await fetch(this.restUrl(`/api/sftp/sessions/${id}/rename`), { method: 'POST', headers: this.headers(true), body: JSON.stringify({ from, to }), ...this.fetchOpts() }));
  }

  async sftpDeleteFile(id: string, path: string): Promise<void> {
    await j(await fetch(this.restUrl(`/api/sftp/sessions/${id}/file?path=${encodeURIComponent(path)}`), { method: 'DELETE', headers: this.headers(), ...this.fetchOpts() }));
  }

  async sftpDeleteDir(id: string, path: string): Promise<void> {
    await j(await fetch(this.restUrl(`/api/sftp/sessions/${id}/dir?path=${encodeURIComponent(path)}`), { method: 'DELETE', headers: this.headers(), ...this.fetchOpts() }));
  }

  // `source` may be a Blob/File/ArrayBuffer/Uint8Array (browser) or a Readable (node).
  sftpUploadUrl(id: string, path: string, overwrite = false): string {
    const q = `path=${encodeURIComponent(path)}${overwrite ? '&overwrite=true' : ''}`;
    return this.restUrl(`/api/sftp/sessions/${id}/upload?${q}`);
  }

  async sftpUpload(id: string, path: string, source: Blob | ArrayBuffer | Uint8Array | Readable, overwrite = false): Promise<void> {
    const body = source as unknown as Blob;
    await j(await fetch(this.sftpUploadUrl(id, path, overwrite), { method: 'PUT', headers: this.headers(), body, ...this.fetchOpts() }));
  }

  sftpDownloadUrl(id: string, path: string): string {
    return this.restUrl(`/api/sftp/sessions/${id}/download?path=${encodeURIComponent(path)}`);
  }

  async sftpDownload(id: string, path: string): Promise<Blob> {
    const res = await fetch(this.sftpDownloadUrl(id, path), { headers: this.headers(), ...this.fetchOpts() });
    if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(`${res.status} ${JSON.stringify(body)}`); }
    return res.blob();
  }
}

export type { WsMessage };
