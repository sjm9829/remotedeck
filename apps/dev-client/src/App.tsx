import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RemoteDeckClient } from '@remotedeck/client-sdk';

// Dev-only in-memory connection settings. Deliberately NOT persisted to
// localStorage: credentials/tokens must never be written to browser storage.
export function App() {
  const [apiBase, setApiBase] = useState('http://localhost:4100');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('not connected');
  const termRef = useRef<HTMLDivElement>(null);
  const termInstance = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!termRef.current) return;
    const term = new Terminal({ cols: 80, rows: 24, convertEol: true });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(termRef.current);
    addon.fit();
    term.writeln('RemoteDeck dev client ready.');
    termInstance.current = term;
    fit.current = addon;
    return () => term.dispose();
  }, []);

  async function pingHealth() {
    if (!token) { setStatus('enter a token first'); return; }
    try {
      const client = new RemoteDeckClient({ baseUrl: apiBase, token });
      const h = await client.health();
      setStatus(`health ok @ ${h.timestamp}`);
    } catch (err) {
      setStatus(`health error: ${(err as Error).message}`);
    }
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16, maxWidth: 900 }}>
      <h1 style={{ fontSize: 18 }}>RemoteDeck dev client</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <input
          aria-label="API base"
          placeholder="API base URL"
          value={apiBase}
          onChange={(e) => setApiBase(e.target.value)}
          style={{ flex: '1 1 240px' }}
        />
        <input
          aria-label="API token"
          placeholder="API token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ flex: '1 1 240px' }}
          autoComplete="off"
        />
        <button onClick={pingHealth}>Check health</button>
      </div>
      <p style={{ fontSize: 13, color: '#444' }}>status: {status}</p>
      <div ref={termRef} style={{ height: 400, background: '#0b0f14' }} />
    </div>
  );
}
