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

  // ---- Files (SFTP) tab state ----
  const [filesOpen, setFilesOpen] = useState(false);
  const [sftpHostId, setSftpHostId] = useState('');
  const [sftpRoot, setSftpRoot] = useState('/');
  const [sftpId, setSftpId] = useState('');
  const [sftpStatus, setSftpStatus] = useState('');
  const [sftpError, setSftpError] = useState('');
  const [sftpBusy, setSftpBusy] = useState(false);
  const [sftpPath, setSftpPath] = useState('');
  const [sftpFiles, setSftpFiles] = useState<any[]>([]);
  const [sftpTrust, setSftpTrust] = useState<{ id: string; fingerprint: string } | null>(null);
  const [uploadProgress, setUploadProgress] = useState('');

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

  // ---- Files (SFTP) operations ----
  function filesClient(): RemoteDeckClient | null { const c = clientRef.current; if (!c) { setSftpError('connect first'); return null; } return c; }
  async function openFiles() {
    const c = filesClient(); if (!c || !sftpHostId) { setSftpError('choose a host'); return; }
    setSftpBusy(true); setSftpError(''); setSftpStatus('connecting…');
    try {
      const res = await c.createSftpSession({ hostId: sftpHostId, rootPath: sftpRoot || '/' });
      if (res.requiresTrust) { setSftpTrust({ id: res.session.id, fingerprint: res.fingerprint ?? '' }); setSftpStatus('awaiting trust'); }
      else { setSftpId(res.session.id); setSftpPath(''); await loadFiles(c, res.session.id, ''); setSftpStatus('ready · ' + res.session.rootPath); }
    } catch (e) { setSftpStatus(''); setSftpError((e as Error).message); } finally { setSftpBusy(false); }
  }
  async function sftpTrustNow() {
    const c = filesClient(); if (!c || !sftpTrust) return;
    setSftpBusy(true); setSftpError('');
    try { await c.trustSftpSession(sftpTrust.id); setSftpId(sftpTrust.id); setSftpTrust(null); setSftpPath(''); await loadFiles(c, sftpTrust.id, ''); setSftpStatus('ready (trusted)'); }
    catch (e) { setSftpError((e as Error).message); } finally { setSftpBusy(false); }
  }
  async function loadFiles(c: RemoteDeckClient, id: string, path: string) {
    setSftpBusy(true); setSftpError('');
    try { const r = await c.sftpList(id, path); setSftpFiles(r.files); setSftpPath(r.path); }
    catch (e) { setSftpError((e as Error).message); } finally { setSftpBusy(false); }
  }
  async function nav(path: string) { const c = filesClient(); if (!c || !sftpId) return; await loadFiles(c, sftpId, path); }
  async function doMkdir() { const c = filesClient(); if (!c || !sftpId) return; const name = window.prompt('new directory name (relative to ' + (sftpPath || 'root') + ')'); if (!name) return; await run(c, () => c.sftpMkdir(sftpId, join(sftpPath, name)), () => loadFiles(c, sftpId, sftpPath)); }
  async function doRename(name: string) { const c = filesClient(); if (!c || !sftpId) return; const to = window.prompt('rename to (new name, same parent):', name); if (!to || to === name) return; await run(c, () => c.sftpRename(sftpId, join(sftpPath, name), join(sftpPath, to)), () => loadFiles(c, sftpId, sftpPath)); }
  async function doDeleteFile(name: string) { const c = filesClient(); if (!c || !sftpId) return; if (!window.confirm('delete file ' + name + '?')) return; await run(c, () => c.sftpDeleteFile(sftpId, join(sftpPath, name)), () => loadFiles(c, sftpId, sftpPath)); }
  async function doDeleteDir(name: string) { const c = filesClient(); if (!c || !sftpId) return; if (!window.confirm('delete directory ' + name + ' (must be empty)?')) return; await run(c, () => c.sftpDeleteDir(sftpId, join(sftpPath, name)), () => loadFiles(c, sftpId, sftpPath)); }
  async function doDownload(name: string) { const c = filesClient(); if (!c || !sftpId) return; setSftpBusy(true); setSftpError(''); setUploadProgress('downloading ' + name + '…'); try { const blob = await c.sftpDownload(sftpId, join(sftpPath, name)); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); setUploadProgress(''); } catch (e) { setUploadProgress(''); setSftpError((e as Error).message); } finally { setSftpBusy(false); } }
  async function doUpload(file?: File) { const c = filesClient(); if (!c || !sftpId || !file) return; const overwrite = sftpFiles.some((f) => f.name === file.name); if (overwrite && !window.confirm(file.name + ' already exists — overwrite?')) return; setSftpBusy(true); setSftpError(''); setUploadProgress('uploading ' + file.name + ' (' + file.size + ' bytes)…'); try { await c.sftpUpload(sftpId, join(sftpPath, file.name), file, overwrite); setUploadProgress(''); await loadFiles(c, sftpId, sftpPath); } catch (e) { setUploadProgress(''); setSftpError((e as Error).message); } finally { setSftpBusy(false); } }
  async function closeFiles() { const c = filesClient(); if (!c || !sftpId) return; try { await c.closeSftpSession(sftpId); } catch (e) { setSftpError((e as Error).message); } setSftpId(''); setSftpFiles([]); setSftpPath(''); setSftpStatus('closed'); }
  async function run(c: RemoteDeckClient, action: () => Promise<void>, reload: () => Promise<void>) { setSftpBusy(true); setSftpError(''); try { await action(); await reload(); } catch (e) { setSftpError((e as Error).message); } finally { setSftpBusy(false); } }
  function join(base: string, name: string): string { const b = base || ''; const p = b.endsWith('/') ? b : b + '/'; return p + name; }

  const breadcrumb = sftpPath ? sftpPath : '(root)';

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16, maxWidth: 960 }}>
      <h1 style={{ fontSize: 18 }}>RemoteDeck dev client</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <input aria-label="API base" placeholder="API base URL" value={apiBase} onChange={(e) => setApiBase(e.target.value)} style={{ flex: '1 1 240px' }} />
        <input aria-label="API token" placeholder="API token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" style={{ flex: '1 1 240px' }} />
        <button onClick={connect}>Connect</button>
        <button onClick={addCredential}>Add credential</button>
        <button onClick={addHost}>Add host</button>
        <button onClick={() => setFilesOpen(!filesOpen)}>{filesOpen ? 'Hide files' : 'Files'}</button>
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

      {filesOpen && (
        <div style={{ border: '1px solid #ccc', borderRadius: 6, padding: 12, marginBottom: 12 }}>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Files (SFTP)</h2>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select aria-label="SFTP host" value={sftpHostId} onChange={(e) => setSftpHostId(e.target.value)} style={{ flex: '1 1 180px' }}>
              <option value="">select host…</option>
              {hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
            <input aria-label="SFTP root" placeholder="root path (e.g. /home/user)" value={sftpRoot} onChange={(e) => setSftpRoot(e.target.value)} style={{ flex: '1 1 200px' }} />
            <button onClick={openFiles} disabled={sftpBusy}>Open files</button>
            {sftpId && <button onClick={() => loadFiles(filesClient()!, sftpId, sftpPath)} disabled={sftpBusy}>Refresh</button>}
            {sftpId && <button onClick={closeFiles}>Close</button>}
          </div>
          {sftpTrust && (
            <div style={{ fontSize: 13, marginBottom: 8 }}>awaiting trust — fingerprint: {sftpTrust.fingerprint} <button onClick={sftpTrustNow}>Trust &amp; connect</button></div>
          )}
          {(sftpStatus || sftpError || sftpBusy || uploadProgress) && (
            <div style={{ fontSize: 12, marginBottom: 8, color: sftpError ? '#b00020' : '#222' }}>
              {uploadProgress || (sftpBusy ? 'working… ' : '')}{sftpError ? sftpError : sftpStatus}
            </div>
          )}
          {sftpId && (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>path: {breadcrumb}</span>
                {sftpPath && <button onClick={() => nav(parent(sftpPath))}>…up</button>}
                <button onClick={doMkdir} disabled={sftpBusy}>New folder</button>
                <label style={{ fontSize: 13 }}>Upload: <input type="file" onChange={(e) => doUpload((e.target as HTMLInputElement).files?.[0])} /></label>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ borderBottom: '1px solid #ddd', textAlign: 'left' }}><th style={{ padding: 4 }}>name</th><th>type</th><th>size</th><th></th></tr></thead>
                <tbody>
                  {sftpFiles.length === 0 && <tr><td colSpan={4} style={{ padding: 6, color: '#777' }}>(empty)</td></tr>}
                  {sftpFiles.map((f) => (
                    <tr key={f.name} style={{ borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: 4 }}>
                        {f.type === 'directory'
                          ? <button style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#0066cc' }} onClick={() => nav(join(sftpPath, f.name))}>📁 {f.name}</button>
                          : <span>📄 {f.name}</span>}
                      </td>
                      <td>{f.type}</td>
                      <td>{f.type === 'file' ? f.size : '—'}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {f.type === 'file' && <><button onClick={() => doDownload(f.name)}>download</button> </>}
                        <button onClick={() => doRename(f.name)}>rename</button>
                        {f.type === 'file' ? <button onClick={() => doDeleteFile(f.name)}>delete</button> : <button onClick={() => doDeleteDir(f.name)}>delete</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div ref={termRef} style={{ height: 420, background: '#0b0f14' }} />
    </div>
  );
}

// parent of a relative path ('a/b' -> 'a', 'a' -> '', '' -> '')
function parent(p: string): string { const parts = p.split('/').filter(Boolean); parts.pop(); return parts.join('/'); }
