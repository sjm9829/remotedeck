import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RemoteDeckClient } from '@remotedeck/client-sdk';

// Dev-only in-memory connection settings. Credentials are NEVER persisted to
// browser storage (no localStorage) — they live only in React state.
export function App() {
  const [apiBase, setApiBase] = useState('http://localhost:4100');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('not connected');
  const [hosts, setHosts] = useState<any[]>([]);
  const [sessionId, setSessionId] = useState<string>('');
  const [pendingTrust, setPendingTrust] = useState<{ hostId: string; fingerprint: string } | null>(null);
  const [attachState, setAttachState] = useState<'idle' | 'attached'>('idle');
  const termRef = useRef<HTMLDivElement>(null);
  const termInstance = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const clientRef = useRef<RemoteDeckClient | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const attRef = useRef<string>('');

  useEffect(() => {
    if (!termRef.current) return;
    const term = new Terminal({ cols: 80, rows: 24, convertEol: true });
    const addon = new FitAddon();
    term.loadAddon(addon); term.open(termRef.current); addon.fit();
    term.writeln('RemoteDeck dev client. Set API base + token, then Connect.');
    term.onData((data) => { const ws = wsRef.current; if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: { data } })); });
    window.addEventListener('resize', () => { try { addon.fit(); const s = { rows: term.rows, cols: term.cols }; if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'resize', data: { rows: s.rows, cols: s.cols } })); } catch {} });
    termInstance.current = term; fit.current = addon;
    return () => { term.dispose(); };
  }, []);

  function ensureClient(): RemoteDeckClient | null { if (!token) { setStatus('enter a token first'); return null; } const c = new RemoteDeckClient({ baseUrl: apiBase, token }); clientRef.current = c; return c; }

  async function connect() { const c = ensureClient(); if (!c) return; try { const s = await c.status(); setStatus(`connected · sessions ${s.sessions?.total ?? 0}`); } catch (e) { setStatus('error: ' + (e as Error).message); } }
  async function refreshHosts() { const c = ensureClient(); if (!c) return; try { setHosts(await c.listHosts()); } catch (e) { setStatus('error: ' + (e as Error).message); } }
  async function addCredential() { const c = ensureClient(); if (!c) return; try { await c.createCredential({ name: 'dev-cred-' + Date.now().toString(36), type: 'password', secret: 'dev-secret' }); setStatus('credential created (secret not stored in browser)'); } catch (e) { setStatus('error: ' + (e as Error).message); } }
  async function addHost() { const c = ensureClient(); if (!c) return; try { await c.createHost({ name: 'dev-host-' + Date.now().toString(36), hostname: 'example.com', user: 'root' }); await refreshHosts(); } catch (e) { setStatus('error: ' + (e as Error).message); } }

  async function createSession(hostId: string) { const c = ensureClient(); if (!c) return; try { const s = await c.createSession({ hostId }); if (s.requiresTrust) { setPendingTrust({ hostId, fingerprint: s.fingerprint }); setStatus('awaiting trust: ' + s.fingerprint); } else { setSessionId(s.id); setStatus('session ' + s.state); } } catch (e) { setStatus('error: ' + (e as Error).message); } }
  async function trust() { const c = clientRef.current; if (!c || !pendingTrust) return; try { await c.trustHost(pendingTrust.hostId, pendingTrust.fingerprint); const s = await c.createSession({ hostId: pendingTrust.hostId }); setSessionId(s.id); setPendingTrust(null); setStatus('session ' + s.state); } catch (e) { setStatus('error: ' + (e as Error).message); } }

  async function attach() { const c = clientRef.current; if (!c || !sessionId) return; try { const t = await c.wsTicket(sessionId, 'writer'); const ws = c.connectSession(sessionId, t.ticket); wsRef.current = ws; termInstance.current?.reset(); termInstance.current?.writeln('[attached]'); ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.type === 'output' || m.type === 'scrollback') termInstance.current?.write(m.data.data); else if (m.type === 'status') setStatus('session ' + m.data.status); } catch {} }; ws.onclose = () => { setAttachState('idle'); wsRef.current = null; }; setAttachState('attached'); } catch (e) { setStatus('error: ' + (e as Error).message); } }
  function wsSend(msg: any) { const ws = wsRef.current; if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16, maxWidth: 960 }}>
      <h1 style={{ fontSize: 18 }}>RemoteDeck dev client</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <input aria-label="API base" placeholder="API base URL" value={apiBase} onChange={(e) => setApiBase(e.target.value)} style={{ flex: '1 1 240px' }} />
        <input aria-label="API token" placeholder="API token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" style={{ flex: '1 1 240px' }} />
        <button onClick={connect}>Connect</button>
        <button onClick={addCredential}>Add credential</button>
        <button onClick={addHost}>Add host</button>
      </div>
      <p style={{ fontSize: 13, color: '#444' }}>status: {status}</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <button onClick={refreshHosts}>Refresh hosts</button>
        {pendingTrust && <button onClick={trust}>Trust {pendingTrust.fingerprint?.slice(0, 16)}…</button>}
        {sessionId && <><button onClick={attach} disabled={attachState === 'attached'}>Attach</button>
          <button onClick={() => wsSend({ type: 'detach', data: {} })}>Detach</button>
          <button onClick={() => fit.current?.fit()}>Fit</button></>}
      </div>
      <ul style={{ fontSize: 13 }}>{hosts.map((h) => <li key={h.id}>{h.name} — {h.hostname} <button onClick={() => createSession(h.id)}>session</button></li>)}</ul>
      <div ref={termRef} style={{ height: 420, background: '#0b0f14' }} />
    </div>
  );
}
