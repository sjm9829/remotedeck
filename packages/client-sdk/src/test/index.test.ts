// client-sdk mode-aware behavior tests
//
// Verifies:
//   - 'direct' mode: Authorization: Bearer header IS present
//   - 'same-origin' mode: Authorization header is NOT present
//   - 'same-origin' mode: credentials: 'same-origin' IS present
//   - REST URLs use the correct base path
//   - WebSocket URLs are constructed correctly for both modes
//   - WS subprotocol is 'remotedeck.v1.<ticket>'

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteDeckClient, buildRestUrl, buildWsUrl, WS_SUBPROTOCOL_PREFIX } from '../index.js';

// ── fetch stub ────────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  options: any;
}

let fetchCalls: FetchCall[] = [];
let origFetch: any;

function stubFetch(responseBody: object = { data: null, sessions: [], status: 'ok', timestamp: '' }): void {
  origFetch = globalThis.fetch;
  const mock: any = async (input: any, init?: any): Promise<any> => {
    const url: string = typeof input === 'string' ? input : input.url ?? String(input);
    fetchCalls.push({ url, options: init ?? {} });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  globalThis.fetch = mock;
}

function restoreFetch(): void {
  globalThis.fetch = origFetch;
}

// ── buildRestUrl ────────────────────────────────────────────────────────────────

describe('buildRestUrl', () => {
  it('absolute direct baseUrl', () => {
    assert.equal(buildRestUrl('http://localhost:4100', '/api/hosts'), 'http://localhost:4100/api/hosts');
  });

  it('absolute direct baseUrl with trailing slash', () => {
    assert.equal(buildRestUrl('http://localhost:4100/', '/api/hosts'), 'http://localhost:4100/api/hosts');
  });

  it('same-origin empty baseUrl -> root-relative path', () => {
    assert.equal(buildRestUrl('', '/api/hosts'), '/api/hosts');
  });

  it('same-origin sub-path baseUrl', () => {
    assert.equal(buildRestUrl('/remotedeck', '/api/hosts'), '/remotedeck/api/hosts');
  });

  it('same-origin sub-path baseUrl with trailing slash', () => {
    assert.equal(buildRestUrl('/remotedeck/', '/api/hosts'), '/remotedeck/api/hosts');
  });
});

// ── buildWsUrl ──────────────────────────────────────────────────────────────────

describe('buildWsUrl', () => {
  it('direct http -> ws', () => {
    const url = buildWsUrl({ baseUrl: 'http://localhost:4100', mode: 'direct' }, 'sess-1');
    assert.equal(url, 'ws://localhost:4100/ws/sessions/sess-1');
  });

  it('direct https -> wss', () => {
    const url = buildWsUrl({ baseUrl: 'https://remote.example', mode: 'direct' }, 'sess-2');
    assert.equal(url, 'wss://remote.example/ws/sessions/sess-2');
  });

  it('same-origin https pageOrigin -> wss with path prefix', () => {
    const url = buildWsUrl(
      { baseUrl: '/remotedeck', mode: 'same-origin', pageOrigin: 'https://workbench.example' },
      'sess-3',
    );
    assert.equal(url, 'wss://workbench.example/remotedeck/ws/sessions/sess-3');
  });

  it('same-origin http pageOrigin -> ws with path prefix', () => {
    const url = buildWsUrl(
      { baseUrl: '/remotedeck', mode: 'same-origin', pageOrigin: 'http://localhost:3000' },
      'sess-4',
    );
    assert.equal(url, 'ws://localhost:3000/remotedeck/ws/sessions/sess-4');
  });

  it('same-origin empty baseUrl -> no path prefix', () => {
    const url = buildWsUrl(
      { baseUrl: '', mode: 'same-origin', pageOrigin: 'https://workbench.example' },
      'sess-5',
    );
    assert.equal(url, 'wss://workbench.example/ws/sessions/sess-5');
  });

  it('same-origin uses loc fallback when pageOrigin absent', () => {
    const url = buildWsUrl(
      { baseUrl: '/app', mode: 'same-origin' },
      'sess-6',
      { protocol: 'https:', host: 'proxy.example' },
    );
    assert.equal(url, 'wss://proxy.example/app/ws/sessions/sess-6');
  });
});

// ── WS subprotocol constant ─────────────────────────────────────────────────────

describe('WS_SUBPROTOCOL_PREFIX', () => {
  it('matches the protocol constant', () => {
    assert.equal(WS_SUBPROTOCOL_PREFIX, 'remotedeck.v1.');
  });
});

// ── RemoteDeckClient: direct mode ────────────────────────────────────────────────

describe('RemoteDeckClient - direct mode', () => {
  const TOKEN = 'a'.repeat(40);
  beforeEach(() => { fetchCalls = []; stubFetch(); });
  afterEach(() => { restoreFetch(); });

  it('sends Authorization: Bearer header on REST calls', async () => {
    const c = new RemoteDeckClient({ baseUrl: 'http://localhost:4100', token: TOKEN });
    await c.listHosts();
    assert.equal(fetchCalls.length, 1);
    const h = fetchCalls[0].options.headers as Record<string, string>;
    assert.equal(h['authorization'], `Bearer ${TOKEN}`);
  });

  it('does NOT set credentials option', async () => {
    const c = new RemoteDeckClient({ baseUrl: 'http://localhost:4100', token: TOKEN });
    await c.listHosts();
    assert.equal(fetchCalls[0].options.credentials, undefined);
  });

  it('uses absolute REST URL', async () => {
    const c = new RemoteDeckClient({ baseUrl: 'http://localhost:4100', token: TOKEN });
    await c.listHosts();
    assert.equal(fetchCalls[0].url, 'http://localhost:4100/api/hosts');
  });

  it('closes SFTP without a body/content-type while preserving bearer auth', async () => {
    const c = new RemoteDeckClient({ baseUrl: 'http://localhost:4100', token: TOKEN });
    await c.closeSftpSession('sftp-1');
    const call = fetchCalls[0];
    const h = call.options.headers as Record<string, string>;
    assert.equal(call.url, 'http://localhost:4100/api/sftp/sessions/sftp-1');
    assert.equal(call.options.method, 'DELETE');
    assert.equal(call.options.body, undefined);
    assert.ok(!('content-type' in h));
    assert.equal(h.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.options.credentials, undefined);
  });
});

// ── RemoteDeckClient: same-origin mode ───────────────────────────────────────────

describe('RemoteDeckClient - same-origin mode', () => {
  const TOKEN = 'a'.repeat(40);
  beforeEach(() => { fetchCalls = []; stubFetch(); });
  afterEach(() => { restoreFetch(); });

  it('does NOT send Authorization header even when token is provided in config', async () => {
    const c = new RemoteDeckClient({
      baseUrl: '/remotedeck',
      token: TOKEN,
      mode: 'same-origin',
      pageOrigin: 'https://workbench.example',
    });
    await c.listHosts();
    assert.equal(fetchCalls.length, 1);
    const h = fetchCalls[0].options.headers as Record<string, string>;
    assert.ok(!('authorization' in h), 'authorization header must be absent');
    assert.ok(!('Authorization' in h), 'Authorization header must be absent');
  });

  it('sets credentials: same-origin on requests', async () => {
    const c = new RemoteDeckClient({ baseUrl: '/remotedeck', mode: 'same-origin' });
    await c.listHosts();
    assert.equal(fetchCalls[0].options.credentials, 'same-origin');
  });

  it('uses relative REST URL with sub-path', async () => {
    const c = new RemoteDeckClient({ baseUrl: '/remotedeck', mode: 'same-origin' });
    await c.listHosts();
    assert.equal(fetchCalls[0].url, '/remotedeck/api/hosts');
  });

  it('healthz request omits Authorization and sets credentials', async () => {
    const c = new RemoteDeckClient({ baseUrl: '/remotedeck', mode: 'same-origin' });
    await c.health();
    const h = fetchCalls[0].options.headers as Record<string, string> | undefined;
    if (h) assert.ok(!('authorization' in h));
    assert.equal(fetchCalls[0].options.credentials, 'same-origin');
  });

  it('POST ws-ticket uses relative path and no Authorization', async () => {
    stubFetch({ data: { ticket: 'tk-abc', sessionId: 's1', role: 'writer', expiresAt: '' } });
    const c = new RemoteDeckClient({ baseUrl: '/remotedeck', mode: 'same-origin' });
    const t = await c.wsTicket('s1');
    assert.equal(t.ticket, 'tk-abc');
    assert.equal(fetchCalls[0].url, '/remotedeck/api/sessions/s1/ws-ticket');
    const h = fetchCalls[0].options.headers as Record<string, string>;
    assert.ok(!('authorization' in h));
  });

  it('createSession uses relative path and no Authorization', async () => {
    stubFetch({ data: { id: 's1', requiresTrust: false } });
    const c = new RemoteDeckClient({ baseUrl: '/remotedeck', mode: 'same-origin' });
    await c.createSession({ hostId: 'h1' });
    assert.equal(fetchCalls[0].url, '/remotedeck/api/sessions');
    const h = fetchCalls[0].options.headers as Record<string, string>;
    assert.ok(!('authorization' in h));
    assert.equal(h['content-type'], 'application/json');
    assert.equal(fetchCalls[0].options.credentials, 'same-origin');
  });

  it('closes SFTP without a body/content-type while preserving same-origin credentials', async () => {
    const c = new RemoteDeckClient({ baseUrl: '/remotedeck', token: TOKEN, mode: 'same-origin' });
    await c.closeSftpSession('sftp-2');
    const call = fetchCalls[0];
    const h = call.options.headers as Record<string, string>;
    assert.equal(call.url, '/remotedeck/api/sftp/sessions/sftp-2');
    assert.equal(call.options.method, 'DELETE');
    assert.equal(call.options.body, undefined);
    assert.ok(!('content-type' in h));
    assert.ok(!('authorization' in h));
    assert.equal(call.options.credentials, 'same-origin');
  });
});

describe('RemoteDeckClient - host and credential CRUD contracts', () => {
  beforeEach(() => { fetchCalls = []; });
  afterEach(() => { restoreFetch(); });

  it('returns the server host DTO fields without a legacy user alias', async () => {
    stubFetch({ data: {
      id: 'h1', name: 'K6', hostname: 'k6.internal', port: 2222,
      username: 'operator', credentialId: 'c1', tags: ['compute'],
      hostKeyFingerprint: 'SHA256:abc', hostKeyTrusted: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } });
    const c = new RemoteDeckClient({ baseUrl: '/remotedeck', mode: 'same-origin' });
    const host = await c.getHost('h1');
    assert.equal(host.username, 'operator');
    assert.equal(host.port, 2222);
    assert.equal(host.credentialId, 'c1');
    assert.deepEqual(host.tags, ['compute']);
    assert.equal(host.hostKeyTrusted, true);
    assert.equal((host as unknown as Record<string, unknown>).user, undefined);
    assert.equal(fetchCalls[0].url, '/remotedeck/api/hosts/h1');
  });

  it('creates a host with an explicit port and updates it with PATCH', async () => {
    stubFetch({ data: {} });
    const c = new RemoteDeckClient({ baseUrl: '/remotedeck', mode: 'same-origin' });
    await c.createHost({ name: 'WTR Pro', hostname: 'wtr.internal', port: 2201, user: 'operator', credentialId: 'c1', tags: ['storage'] });
    await c.updateHost('h2', { port: 2202, user: 'admin', credentialId: null });

    assert.equal(fetchCalls[0].url, '/remotedeck/api/hosts');
    assert.equal(fetchCalls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
      name: 'WTR Pro', hostname: 'wtr.internal', port: 2201, user: 'operator', credentialId: 'c1', tags: ['storage'],
    });
    assert.equal(fetchCalls[1].url, '/remotedeck/api/hosts/h2');
    assert.equal(fetchCalls[1].options.method, 'PATCH');
    assert.deepEqual(JSON.parse(fetchCalls[1].options.body), { port: 2202, user: 'admin', credentialId: null });
  });

  it('lists, gets, and updates credentials without exposing a secret field', async () => {
    stubFetch({ data: [] });
    const c = new RemoteDeckClient({ baseUrl: '/remotedeck', mode: 'same-origin' });
    await c.listCredentials();
    await c.getCredential('c1');
    await c.updateCredential('c1', { name: 'Home lab key', keyPath: null });

    assert.equal(fetchCalls[0].url, '/remotedeck/api/credentials');
    assert.equal(fetchCalls[1].url, '/remotedeck/api/credentials/c1');
    assert.equal(fetchCalls[2].url, '/remotedeck/api/credentials/c1');
    assert.equal(fetchCalls[2].options.method, 'PATCH');
    assert.deepEqual(JSON.parse(fetchCalls[2].options.body), { name: 'Home lab key', keyPath: null });
  });
});

// ── connectSession: WebSocket URL and subprotocol ───────────────────────────────

// FakeWebSocket captures the URL and protocols without a real network connection.
class FakeWebSocket {
  static lastUrl = '';
  static lastProtocols: string[] = [];
  constructor(url: string, protocols?: string | string[]) {
    FakeWebSocket.lastUrl = url;
    FakeWebSocket.lastProtocols = typeof protocols === 'string' ? [protocols] : (protocols ?? []);
  }
  onopen?: (() => void) | null = null;
  onclose?: (() => void) | null = null;
  onmessage?: ((ev: any) => void) | null = null;
  send() {}
  close() {}
}

describe('connectSession - WebSocket URL and subprotocol', () => {
  let origWS: any;
  beforeEach(() => {
    origWS = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = FakeWebSocket;
  });
  afterEach(() => { (globalThis as any).WebSocket = origWS; });

  it('direct mode: uses ws:// URL from baseUrl', () => {
    const c = new RemoteDeckClient({ baseUrl: 'http://localhost:4100', token: 'x'.repeat(32) });
    c.connectSession('sess-A', 'abc123');
    assert.equal(FakeWebSocket.lastUrl, 'ws://localhost:4100/ws/sessions/sess-A');
  });

  it('direct mode: uses remotedeck.v1.<ticket> subprotocol', () => {
    const c = new RemoteDeckClient({ baseUrl: 'http://localhost:4100', token: 'x'.repeat(32) });
    c.connectSession('sess-A', 'abc123');
    assert.deepEqual(FakeWebSocket.lastProtocols, ['remotedeck.v1.abc123']);
  });

  it('same-origin mode: uses wss:// URL derived from pageOrigin and sub-path', () => {
    const c = new RemoteDeckClient({
      baseUrl: '/remotedeck',
      mode: 'same-origin',
      pageOrigin: 'https://workbench.example',
    });
    c.connectSession('sess-B', 'def456');
    assert.equal(FakeWebSocket.lastUrl, 'wss://workbench.example/remotedeck/ws/sessions/sess-B');
  });

  it('same-origin mode: correct ticket subprotocol', () => {
    const c = new RemoteDeckClient({
      baseUrl: '/remotedeck',
      mode: 'same-origin',
      pageOrigin: 'https://workbench.example',
    });
    c.connectSession('sess-B', 'def456');
    assert.deepEqual(FakeWebSocket.lastProtocols, ['remotedeck.v1.def456']);
  });
});
