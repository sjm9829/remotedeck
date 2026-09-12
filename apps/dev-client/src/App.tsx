import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RemoteDeckClient } from '@remotedeck/client-sdk';
import type { Credential, Host } from '@remotedeck/types';
import { resolveConfig } from './config.js';
import { createResizeController, type ResizeController } from './terminal-controller.js';
import { adoptSocket, closeSocketRef } from './socket-slot.js';
import { createExclusiveRunner } from './async-guard.js';
import { createUploadFlow } from './upload-flow.js';
import { trustPendingSession, type PendingSshTrust } from './ssh-trust-flow.js';
import { activateMostRecentHostTab, activateWorkspaceTab, addWorkspaceTab, closeWorkspaceTab, createWorkspaceTabsState, type WorkspaceTab, type WorkspaceTabsState } from './workspace-tabs.js';
import { DEFAULT_SFTP_HEIGHT, MAX_SFTP_HEIGHT, MIN_SFTP_HEIGHT, clampSftpHeight, resizeSftpWithKey } from './split-layout.js';
import { buildCredentialRequest, emptyCredentialDraft, type NewCredentialDraft } from './credential-draft.js';
import { persistHost } from './host-save.js';
import { layoutForWidth, type RemoteDeckLayout } from './responsive-layout.js';
import { joinSftpPath, parentSftpPath } from './sftp-path.js';
import { formatSize, sortEntries, fileIcon, type SortKey, type SortDir } from './sftp-list.js';
import { DEFAULT_SPLIT, clampSplit, otherSide, planMove, resizeSplitWithKey, type PaneSide } from './dual-pane.js';
import { createSftpUnmountCleanup } from './sftp-cleanup.js';
import { createSshUnmountCleanup } from './ssh-cleanup.js';
import { scheduleWorkspaceAutoStart, startWorkspaceConnections } from './deferred-auto-start.js';
import { EXPANDED_PANES, togglePaneCollapse } from './pane-collapse.js';
import { closeRemoteSessionOnce } from './session-cleanup.js';
import { terminalIdentity } from './terminal-identity.js';
import { saveTabState, loadTabState, type PersistedTabState } from './session-persistence.js';

const DEV_DIRECT = import.meta.env.VITE_REMOTEDECK_MODE === 'direct';
type FileEntry = { name: string; type: string; size?: number };
type SftpTrust = { id: string; fingerprint: string };
type ConfirmState = { kind: 'file' | 'dir'; name: string; side: PaneSide } | null;
type PromptState = { mode: 'mkdir'; side: PaneSide } | { mode: 'rename'; from: string; side: PaneSide } | null;

export function isArchivedHost(host: Pick<Host, 'tags'>): boolean {
  return host.tags.some((tag) => tag.toLocaleLowerCase() === 'archived');
}

export function archiveToggleLabel(count: number, shown: boolean): string {
  return `보관됨 ${count}개 ${shown ? '숨기기' : '표시'}`;
}

export function filterHosts(hosts: readonly Host[], query: string, includeArchived = false): Host[] {
  const needle = query.trim().toLocaleLowerCase();
  return hosts.filter((host) => (includeArchived || !isArchivedHost(host)) && (!needle || [host.name, host.hostname, host.username, host.tags.join(' ')].some((value) => value.toLocaleLowerCase().includes(needle))));
}

type HostDraft = { name: string; hostname: string; port: string; username: string; credentialId: string; tags: string };
function hostDraft(host: Host | null): HostDraft {
  return host ? { name: host.name, hostname: host.hostname, port: String(host.port), username: host.username, credentialId: host.credentialId ?? '', tags: host.tags.join(', ') }
    : { name: '', hostname: '', port: '22', username: '', credentialId: '', tags: '' };
}

function useDialogFocus(onCancel: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
    focusable()[0]?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); cancelRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable(); const first = items[0]; const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog.addEventListener('keydown', onKey);
    return () => { dialog.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);
  return ref;
}

function trapTabWithin(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter((item) => item.offsetParent !== null);
  const first = items[0]; const last = items[items.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function Dialog({ label, onCancel, children, small = false }: { label: string; onCancel: () => void; children: ReactNode; small?: boolean }) {
  const ref = useDialogFocus(onCancel);
  return <div ref={ref} className="rd-modal" role="dialog" aria-modal="true" aria-label={label}><div className={`rd-modal-box ${small ? 'small' : ''}`}>{children}</div></div>;
}

function HostModal({ host, credentials, busy, error, onCancel, onSave }: { host: Host | null; credentials: readonly Credential[]; busy: boolean; error: string; onCancel: () => void; onSave: (draft: HostDraft, credential: NewCredentialDraft, clearSecret: () => void) => Promise<void> }) {
  const [draft, setDraft] = useState(() => hostDraft(host));
  const [newCredential, setNewCredential] = useState(emptyCredentialDraft);
  const titleId = useId();
  const dialogRef = useDialogFocus(onCancel);
  const field = (key: keyof HostDraft) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft((current) => ({ ...current, [key]: event.target.value }));
  const credentialField = (key: keyof NewCredentialDraft) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setNewCredential((current) => ({ ...current, [key]: event.target.value }));
  const submit = (event: FormEvent) => { event.preventDefault(); void onSave(draft, newCredential, () => setNewCredential((current) => ({ ...current, secret: '' }))); };
  return <div ref={dialogRef} className="rd-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <form className="rd-modal-box rd-host-form" onSubmit={submit}>
      <div className="rd-modal-title" id={titleId}>{host ? '호스트 편집' : '새 호스트'}</div>
      <div className="rd-form-grid">
        <label>이름<input aria-label="호스트 이름" value={draft.name} onChange={field('name')} required /></label>
        <label>주소<input aria-label="호스트 주소" value={draft.hostname} onChange={field('hostname')} required autoCapitalize="none" /></label>
        <label>포트<input aria-label="SSH 포트" value={draft.port} onChange={field('port')} required inputMode="numeric" type="number" min="1" max="65535" /></label>
        <label>사용자 이름<input aria-label="사용자 이름" value={draft.username} onChange={field('username')} required autoCapitalize="none" /></label>
        <label className="span-2">자격 증명<select aria-label="자격 증명" value={draft.credentialId} disabled={newCredential.enabled} onChange={field('credentialId')}><option value="">지정 안 함</option>{credentials.map((credential) => <option value={credential.id} key={credential.id}>{credential.name} · {credential.type}</option>)}</select></label>
        <label className="span-2">태그<input aria-label="호스트 태그" value={draft.tags} onChange={field('tags')} placeholder="예: homelab, storage" /></label>
      </div>
      <label className="rd-new-credential-toggle"><input type="checkbox" checked={newCredential.enabled} onChange={(event) => setNewCredential((current) => ({ ...current, enabled: event.target.checked, secret: '' }))} />새 자격 증명을 만들어 이 호스트에 연결</label>
      {newCredential.enabled && <fieldset className="rd-credential-fields"><legend>새 자격 증명</legend>
        <label>이름<input aria-label="새 자격 증명 이름" value={newCredential.name} onChange={credentialField('name')} required /></label>
        <label>방식<select aria-label="새 자격 증명 방식" value={newCredential.type} onChange={(event) => setNewCredential((current) => ({ ...current, type: event.target.value as NewCredentialDraft['type'], secret: '' }))}><option value="password">Password</option><option value="key">Private key</option><option value="agent">Agent</option></select></label>
        {newCredential.type === 'password' && <label className="span-2">비밀번호<input aria-label="새 자격 증명 비밀번호" type="password" value={newCredential.secret} onChange={credentialField('secret')} autoComplete="new-password" required /></label>}
        {newCredential.type === 'key' && <label className="span-2">개인 키<textarea aria-label="새 자격 증명 개인 키" value={newCredential.secret} onChange={(event) => setNewCredential((current) => ({ ...current, secret: event.target.value }))} autoComplete="off" required spellCheck={false} /></label>}
        {newCredential.type === 'agent' && <p className="rd-form-note span-2">Agent 자격정보는 저장할 수 있지만 현재 SSH 연결 transport에서는 사용할 수 없습니다.</p>}
      </fieldset>}
      <p className="rd-form-note">비밀 값은 전송 직후 입력 상태에서 지우며 목록·오류에 다시 표시하지 않습니다.</p>
      {error && <p className="rd-inline-error" role="alert">{error}</p>}
      <div className="rd-modal-actions"><button type="button" onClick={onCancel} disabled={busy}>취소</button><button className="primary" type="submit" disabled={busy}>{busy ? '저장 중…' : '저장'}</button></div>
    </form>
  </div>;
}

export function WorkspacePane({ tab, host, client, active, onStatus }: { tab: WorkspaceTab; host: Host; client: RemoteDeckClient; active: boolean; onStatus?: (tabId: string, status: 'idle' | 'connecting' | 'connected' | 'error') => void }) {
  const [sshState, setSshState] = useState<'idle' | 'connecting' | 'trust' | 'ready' | 'attached' | 'error'>('idle');
  const [sshStatus, setSshStatus] = useState('연결 전');
  const [sessionId, setSessionId] = useState(tab.sessionId ?? '');
  const [pendingTrust, setPendingTrust] = useState<PendingSshTrust | null>(null);
  const sshRunner = useMemo(() => createExclusiveRunner(), []);
  const termEl = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const hostNameRef = useRef(host.name);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef(tab.sessionId ?? '');
  const closedSshSessionIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const ctrlRef = useRef<ResizeController | null>(null);
  const [collapsedPanes, setCollapsedPanes] = useState(EXPANDED_PANES);
  const { ssh: sshCollapsed, sftp: sftpCollapsed } = collapsedPanes;
  const [mobileView, setMobileView] = useState<'terminal' | 'files'>('terminal');
  const [sftpHeight, setSftpHeight] = useState(DEFAULT_SFTP_HEIGHT);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [sftpId, setSftpId] = useState('');
  const [sftpPath, setSftpPath] = useState('');
  const [sftpFiles, setSftpFiles] = useState<FileEntry[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const toggleSort = (key: SortKey) => { if (key === sortKey) setSortDir((current) => current === 'asc' ? 'desc' : 'asc'); else { setSortKey(key); setSortDir('asc'); } };
  const sortedFiles = useMemo(() => sortEntries(sftpFiles, sortKey, sortDir), [sftpFiles, sortKey, sortDir]);
  const [sftpBusy, setSftpBusy] = useState(false);
  const [sftpStatus, setSftpStatus] = useState('연결 전');
  const [sftpError, setSftpError] = useState('');
  const [sftpTrust, setSftpTrust] = useState<SftpTrust | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [prompt, setPrompt] = useState<PromptState>(null);
  const [promptValue, setPromptValue] = useState('');
  const [overwriteName, setOverwriteName] = useState<string | null>(null);
  // Dual-pane (split window) state: the left pane reuses sftpPath/sftpFiles (side 'a');
  // the right pane keeps its own path/list (side 'b'). Both share one SFTP session.
  const [dual, setDual] = useState(false);
  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const [bPath, setBPath] = useState('');
  const [bFiles, setBFiles] = useState<FileEntry[]>([]);
  const bPathRef = useRef('');
  const bFilesRef = useRef<FileEntry[]>([]);
  const duoRef = useRef<HTMLDivElement | null>(null);
  const dragSplitRef = useRef<{ pointerId: number; startX: number; rectWidth: number; startSplit: number } | null>(null);
  const uploadTarget = useRef<{ side: PaneSide; dir: string }>({ side: 'a', dir: '' });
  const sortedB = useMemo(() => sortEntries(bFiles, sortKey, sortDir), [bFiles, sortKey, sortDir]);
  const pathRefOf = (side: PaneSide) => side === 'a' ? sftpPathRef : bPathRef;
  const filesRefOf = (side: PaneSide) => side === 'a' ? sftpFilesRef : bFilesRef;
  useEffect(() => { bPathRef.current = bPath; }, [bPath]);
  useEffect(() => { bFilesRef.current = bFiles; }, [bFiles]);
  const sftpIdRef = useRef('');
  const closedSftpSessionIdsRef = useRef(new Set<string>());
  const sftpPathRef = useRef('');
  const sftpFilesRef = useRef<FileEntry[]>([]);
  const workspaceStartedRef = useRef(false);
  const workspaceStartRef = useRef<() => Promise<void>>(async () => undefined);
  const terminalKey = terminalIdentity(host);

  useEffect(() => { sftpIdRef.current = sftpId; }, [sftpId]);
  useEffect(() => { hostNameRef.current = host.name; }, [host.name]);
  useEffect(() => { sftpPathRef.current = sftpPath; }, [sftpPath]);
  useEffect(() => { sftpFilesRef.current = sftpFiles; }, [sftpFiles]);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => {
    const mapped = sshState === 'attached' || sshState === 'ready' ? 'connected' : sshState === 'connecting' || sshState === 'trust' ? 'connecting' : sshState === 'error' ? 'error' : 'idle';
    onStatus?.(tab.id, mapped);
  }, [sshState, onStatus, tab.id]);
  useEffect(() => createSshUnmountCleanup(client, () => sessionIdRef.current, () => closeSocketRef(wsRef), closedSshSessionIdsRef.current), [client]);
  useEffect(() => createSftpUnmountCleanup(client, () => sftpIdRef.current, closedSftpSessionIdsRef.current), [client]);
  const loadSide = useCallback(async (side: PaneSide, id: string, path: string) => { const result = await client.sftpList(id, path); if (!mountedRef.current) return; if (side === 'a') { setSftpFiles(result.files); setSftpPath(result.path); setSftpStatus(result.path || '/'); } else { setBFiles(result.files); setBPath(result.path); } }, [client]);
  const loadFiles = useCallback((id: string, path: string) => loadSide('a', id, path), [loadSide]);
  const uploadFlow = useMemo(() => createUploadFlow(async (file, overwrite) => {
    const id = sftpIdRef.current; if (!id) return;
    const { side, dir } = uploadTarget.current;
    setSftpBusy(true); setSftpError(''); setSftpStatus(`업로드 중 · ${file.name}`);
    try { await client.sftpUpload(id, joinSftpPath(dir, file.name), file, overwrite); await loadSide(side, id, dir); }
    catch (error) { setSftpError((error as Error).message); } finally { setSftpBusy(false); }
  }), [client, loadSide]);

  useEffect(() => {
    if (!termEl.current) return;
    const terminal = new Terminal({ cols: 80, rows: 24, convertEol: true, theme: { background: '#10151d', foreground: '#d8e1ee', cursor: '#55b7ff' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(termEl.current); terminal.writeln(`${hostNameRef.current} — 연결 대기`);
    terminal.onData((data) => { const socket = wsRef.current; if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data: { data } })); });
    const controller = createResizeController({ fit, getSize: () => ({ rows: terminal.rows, cols: terminal.cols }), send: (size) => { const socket = wsRef.current; if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', data: size })); }, target: termEl.current });
    controller.start(); termRef.current = terminal; ctrlRef.current = controller;
    return () => { controller.dispose(); closeSocketRef(wsRef); terminal.dispose(); termRef.current = null; ctrlRef.current = null; };
  }, [terminalKey]);
  useEffect(() => { if (active) requestAnimationFrame(() => ctrlRef.current?.fitNow()); }, [active, sshCollapsed, sftpCollapsed, sftpHeight]);

  const attachSession = useCallback(async (id: string) => {
    if (!mountedRef.current) return;
    const ticket = await client.wsTicket(id, 'writer');
    if (!mountedRef.current) return;
    const socket = client.connectSession(id, ticket.ticket);
    if (!mountedRef.current) { try { socket.close(); } catch { /* already closed */ } return; }
    adoptSocket(wsRef, socket);
    socket.onopen = () => { setSshState('attached'); setSshStatus('SSH 연결됨'); termRef.current?.reset(); termRef.current?.writeln(`[${hostNameRef.current} 연결됨]`); ctrlRef.current?.fitNow(); };
    socket.onmessage = (event) => { try { const message = JSON.parse(event.data); if (message.type === 'output' || message.type === 'scrollback') termRef.current?.write(message.data.data); if (message.type === 'status') setSshStatus(`SSH · ${message.data.status}`); } catch { /* ignore */ } };
    socket.onclose = () => { if (wsRef.current === socket) wsRef.current = null; setSshState('ready'); setSshStatus('SSH 연결 해제됨'); };
  }, [client]);
  const connectSsh = useCallback(async () => {
    await sshRunner.run(async () => { setSshState('connecting'); setSshStatus('SSH 연결 중…');
      try { const created = await client.createSession({ hostId: host.id }); sessionIdRef.current = created.id;
        if (!mountedRef.current) { closeRemoteSessionOnce(created.id, closedSshSessionIdsRef.current, (id) => client.closeSession(id)); return; }
        setSessionId(created.id);
        if (created.requiresTrust) { setPendingTrust({ hostId: host.id, sessionId: created.id, fingerprint: created.fingerprint }); setSshState('trust'); setSshStatus('호스트 키 확인 필요'); return; }
        setSshState('ready'); await attachSession(created.id);
      } catch (error) { if (mountedRef.current) { setSshState('error'); setSshStatus(`SSH 오류 · ${(error as Error).message}`); } }
    });
  }, [attachSession, client, host.id, sshRunner]);
  const approveTrust = async () => { if (!pendingTrust) return; await sshRunner.run(async () => { try { const originalId = await trustPendingSession(client, pendingTrust); sessionIdRef.current = originalId; if (!mountedRef.current) { closeRemoteSessionOnce(originalId, closedSshSessionIdsRef.current, (id) => client.closeSession(id)); return; } setSessionId(originalId); setPendingTrust(null); setSshState('ready'); await attachSession(originalId); } catch (error) { if (mountedRef.current) { setSshState('error'); setSshStatus(`SSH 오류 · ${(error as Error).message}`); } } }); };

  const connectSftp = useCallback(async () => {
    if (sftpBusy || sftpIdRef.current) return; setSftpBusy(true); setSftpError(''); setSftpStatus('SFTP 연결 중…');
    try { const result = await client.createSftpSession({ hostId: host.id, rootPath: '/' }); sftpIdRef.current = result.session.id;
      if (!mountedRef.current) { closeRemoteSessionOnce(result.session.id, closedSftpSessionIdsRef.current, (id) => client.closeSftpSession(id)); return; }
      if (result.requiresTrust) { setSftpTrust({ id: result.session.id, fingerprint: result.fingerprint ?? '' }); setSftpStatus('SFTP 호스트 키 확인 필요'); }
      else { setSftpId(result.session.id); await loadFiles(result.session.id, ''); }
    } catch (error) { if (mountedRef.current) { setSftpError((error as Error).message); setSftpStatus('SFTP를 사용할 수 없음'); } } finally { if (mountedRef.current) setSftpBusy(false); }
  }, [client, host.id, loadFiles, sftpBusy]);
  const connectWorkspace = async () => {
    await startWorkspaceConnections(
      () => sshState === 'ready' && sessionId ? attachSession(sessionId) : (sshState === 'idle' || sshState === 'error') ? connectSsh() : Promise.resolve(),
      () => (!sftpId && !sftpTrust) ? connectSftp() : Promise.resolve(),
    );
  };
  workspaceStartRef.current = connectWorkspace;
  useEffect(() => scheduleWorkspaceAutoStart(() => workspaceStartRef.current(), workspaceStartedRef), []);
  const toggleSshCollapsed = () => setCollapsedPanes((current) => togglePaneCollapse(current, 'ssh'));
  const toggleSftpCollapsed = () => setCollapsedPanes((current) => togglePaneCollapse(current, 'sftp'));
  const approveSftpTrust = async () => { if (!sftpTrust) return; setSftpBusy(true); setSftpError(''); try { await client.trustSftpSession(sftpTrust.id); sftpIdRef.current = sftpTrust.id; if (!mountedRef.current) { closeRemoteSessionOnce(sftpTrust.id, closedSftpSessionIdsRef.current, (id) => client.closeSftpSession(id)); return; } setSftpId(sftpTrust.id); setSftpTrust(null); await loadFiles(sftpTrust.id, ''); } catch (error) { if (mountedRef.current) setSftpError((error as Error).message); } finally { if (mountedRef.current) setSftpBusy(false); } };
  const runSftp = async (action: () => Promise<void>) => { setSftpBusy(true); setSftpError(''); try { await action(); } catch (error) { setSftpError((error as Error).message); } finally { setSftpBusy(false); } };
  const navigate = (side: PaneSide, path: string) => { if (sftpId) void runSftp(() => loadSide(side, sftpId, path)); };
  const runPrompt = async () => { if (!prompt || !sftpId || !promptValue.trim()) return; const value = promptValue.trim(); const side = prompt.side; const dir = pathRefOf(side).current; await runSftp(async () => { if (prompt.mode === 'mkdir') await client.sftpMkdir(sftpId, joinSftpPath(dir, value)); else await client.sftpRename(sftpId, joinSftpPath(dir, prompt.from), joinSftpPath(dir, value)); await loadSide(side, sftpId, dir); }); setPrompt(null); };
  const confirmDelete = async () => { if (!confirm || !sftpId) return; const side = confirm.side; const dir = pathRefOf(side).current; await runSftp(async () => { const path = joinSftpPath(dir, confirm.name); if (confirm.kind === 'dir') await client.sftpDeleteDir(sftpId, path); else await client.sftpDeleteFile(sftpId, path); await loadSide(side, sftpId, dir); }); setConfirm(null); };
  const selectUpload = async (event: ChangeEvent<HTMLInputElement>, side: PaneSide) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file || !sftpId) return; const dir = pathRefOf(side).current; uploadTarget.current = { side, dir }; const result = await uploadFlow.select(filesRefOf(side).current.map((entry) => entry.name), file); if (result.overwrite) setOverwriteName(file.name); };
  const download = async (name: string, side: PaneSide) => { if (!sftpId) return; const dir = pathRefOf(side).current; await runSftp(async () => { const blob = await client.sftpDownload(sftpId, joinSftpPath(dir, name)); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); }); };
  const toggleDual = () => {
    const next = !dual;
    setDual(next);
    if (next && sftpId && bFilesRef.current.length === 0) void runSftp(() => loadSide('b', sftpId, sftpPathRef.current));
  };
  const moveEntry = async (side: PaneSide, entry: FileEntry) => {
    if (!sftpId) return;
    const dest = otherSide(side);
    const plan = planMove(pathRefOf(side).current, pathRefOf(dest).current, { name: entry.name, type: entry.type }, filesRefOf(dest).current.map((e) => e.name));
    if (!plan.ok) { setSftpError(plan.reason === 'same-dir' ? '두 창의 경로가 같아 이동할 수 없습니다.' : '디렉터리를 자기 자신 하위로 이동할 수 없습니다.'); return; }
    await runSftp(async () => {
      await client.sftpRename(sftpId, plan.from, plan.to);
      await Promise.all([loadSide(side, sftpId, pathRefOf(side).current), loadSide(dest, sftpId, pathRefOf(dest).current)]);
    });
  };
  const startSplitDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = duoRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    dragSplitRef.current = { pointerId: event.pointerId, startX: event.clientX, rectWidth: rect.width, startSplit: split };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveSplitDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragSplitRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setSplit(clampSplit(drag.startSplit + (event.clientX - drag.startX) / drag.rectWidth));
  };
  const endSplitDrag = (event: React.PointerEvent<HTMLDivElement>) => { if (dragSplitRef.current?.pointerId === event.pointerId) dragSplitRef.current = null; };
  const splitKey = (event: React.KeyboardEvent<HTMLDivElement>) => { const next = resizeSplitWithKey(split, event.key); if (next !== split) { event.preventDefault(); setSplit(next); } };
  const renderBrowser = (side: PaneSide) => {
    const path = side === 'a' ? sftpPath : bPath;
    const files = side === 'a' ? sftpFiles : bFiles;
    const sorted = side === 'a' ? sortedFiles : sortedB;
    const goto = (p: string) => navigate(side, p);
    return <>
      <div className="rd-file-tools"><button className="compact" disabled={!path || sftpBusy} onClick={() => goto(parentSftpPath(path))} aria-label="상위 폴더">↑</button><span className="path" title={path || '/'}>{path || '/'}</span><button className="compact" disabled={sftpBusy} onClick={() => goto(path)} aria-label="파일 새로고침">↻</button><button className="compact" disabled={sftpBusy} onClick={() => { setPromptValue(''); setPrompt({ mode: 'mkdir', side }); }}>새 폴더</button><label className="rd-upload compact">업로드<input type="file" aria-label="업할 파일 선택" disabled={sftpBusy} onChange={(event) => void selectUpload(event, side)} /></label></div>
      <div className="rd-file-head" role="row"><button className={`rd-file-th ${sortKey === 'name' ? 'active' : ''}`} role="columnheader" aria-sort={sortKey === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} onClick={() => toggleSort('name')}>이름 {sortKey === 'name' ? (sortDir === 'asc' ? '▲' : '▼') : ''}</button><button className={`rd-file-th ${sortKey === 'size' ? 'active' : ''}`} role="columnheader" aria-sort={sortKey === 'size' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} onClick={() => toggleSort('size')}>크기 {sortKey === 'size' ? (sortDir === 'asc' ? '▲' : '▼') : ''}</button><span className="rd-file-th" /></div>
      <ul className="rd-filelist">{sorted.map((entry) => <li className="rd-file-row" key={`${side}/${entry.name}`}><button className="rd-file-name" disabled={sftpBusy} onClick={() => entry.type === 'directory' && goto(joinSftpPath(path, entry.name))}><span aria-hidden="true">{fileIcon(entry.type)}</span>{entry.name}</button><span className="meta">{entry.type === 'directory' ? '폴더' : formatSize(entry.size)}</span><div className="rd-row-actions">{entry.type === 'file' && <button className="icon" aria-label={`${entry.name} 다운로드`} onClick={() => void download(entry.name, side)}>↓</button>}{dual && <button className="icon" aria-label={`${entry.name}를 다른 창으로 이동`} onClick={() => void moveEntry(side, entry)}>→</button>}<button className="icon" aria-label={`${entry.name} 이름 변경`} onClick={() => { setPromptValue(entry.name); setPrompt({ mode: 'rename', from: entry.name, side }); }}>✎</button><button className="icon danger" aria-label={`${entry.name} 삭제`} onClick={() => { setConfirm({ kind: entry.type === 'directory' ? 'dir' : 'file', name: entry.name, side }); }}>×</button></div></li>)}{files.length === 0 && <li className="rd-empty-state">빈 폴더입니다.</li>}</ul>
    </>;
  };
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => { dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: sftpHeight }; event.currentTarget.setPointerCapture(event.pointerId); };
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => { const current = dragRef.current; if (current?.pointerId === event.pointerId) setSftpHeight(clampSftpHeight(current.startHeight + current.startY - event.clientY)); };
  const stopDrag = (event: ReactPointerEvent<HTMLDivElement>) => { if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null; };
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => { const height = resizeSftpWithKey(sftpHeight, event.key); if (height !== sftpHeight) { event.preventDefault(); setSftpHeight(height); } };
  const segmentKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const view = event.key === 'ArrowLeft' || event.key === 'Home' ? 'terminal' : 'files';
    if (view === 'files') setCollapsedPanes(EXPANDED_PANES);
    setMobileView(view);
    requestAnimationFrame(() => document.getElementById(`${tab.id}-${view}-tab`)?.focus());
  };

  const terminalPanelId = `${tab.id}-terminal`; const filesPanelId = `${tab.id}-files`;
  return <section id={`${tab.id}-panel`} role="tabpanel" className="rd-workspace" aria-label={`${tab.label} 작업 공간`} hidden={!active} data-workspace-id={tab.id}>
    <div className="rd-workspace-toolbar"><div className="rd-target"><strong>{host.name}</strong><span>{host.username}@{host.hostname}:{host.port}</span></div><span className={`rd-state rd-state--${sshState}`}>{sshStatus}</span></div>
    {pendingTrust && <div className="rd-trust" role="alert"><strong>SSH 호스트 키를 확인해 주세요.</strong><code>{pendingTrust.fingerprint}</code><button className="primary compact" onClick={() => void approveTrust()}>신뢰하고 기존 세션 연결</button></div>}
    <div className="rd-mobile-segments" role="tablist" aria-label={`${host.name} 작업 보기`} onKeyDown={segmentKeyDown}><button id={`${tab.id}-terminal-tab`} role="tab" aria-selected={mobileView === 'terminal'} aria-controls={terminalPanelId} tabIndex={mobileView === 'terminal' ? 0 : -1} onClick={() => { setCollapsedPanes(EXPANDED_PANES); setMobileView('terminal'); }}>Terminal</button><button id={`${tab.id}-files-tab`} role="tab" aria-selected={mobileView === 'files'} aria-controls={filesPanelId} tabIndex={mobileView === 'files' ? 0 : -1} onClick={() => { setCollapsedPanes(EXPANDED_PANES); setMobileView('files'); }}>Files</button></div>
    <div className="rd-split" data-mobile-view={mobileView} data-ssh-collapsed={sshCollapsed} data-sftp-collapsed={sftpCollapsed}>
      <div id={terminalPanelId} role="tabpanel" className="rd-terminal-pane" aria-label={`${host.name} 터미널`} data-collapsed={sshCollapsed}><div className="rd-terminal-title"><span>SSH 터미널</span><span className="rd-pane-title-actions"><span>{sessionId ? `세션 ${sessionId.slice(0, 8)}` : '대기'}</span><button className="rd-pane-collapse" aria-label={`SSH ${sshCollapsed ? '펼치기' : '접기'}`} aria-expanded={!sshCollapsed} onClick={toggleSshCollapsed}>{sshCollapsed ? '펼치기' : '접기'}</button></span></div><div className="rd-terminal-wrap" ref={termEl} /></div>
      {!sftpCollapsed && !sshCollapsed && <div className="rd-divider" role="separator" aria-label="SSH와 SFTP 패널 높이" aria-orientation="horizontal" aria-valuemin={MIN_SFTP_HEIGHT} aria-valuemax={MAX_SFTP_HEIGHT} aria-valuenow={sftpHeight} tabIndex={0} onPointerDown={startDrag} onPointerMove={drag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onKeyDown={resizeWithKeyboard} />}
      <aside id={filesPanelId} role="tabpanel" className="rd-sftp-pane" aria-label={`${host.name} SFTP 파일`} data-collapsed={sftpCollapsed} style={!sftpCollapsed && !sshCollapsed ? { height: sftpHeight } : undefined}><div className="rd-pane-title"><span>SFTP</span><span className="rd-pane-title-actions"><span className={sftpError ? 'error' : ''}>{sftpBusy ? '작업 중…' : sftpStatus}</span><button className="rd-pane-collapse" aria-pressed={dual} aria-label="SFTP 창 분할" title="두 개의 파일 창을 나란히 표시" onClick={toggleDual}>분할</button><button className="rd-pane-collapse" aria-label={`SFTP ${sftpCollapsed ? '펼치기' : '접기'}`} aria-expanded={!sftpCollapsed} onClick={toggleSftpCollapsed}>{sftpCollapsed ? '펼치기' : '접기'}</button></span></div><div className="rd-sftp-body">
        {sftpTrust && <div className="rd-trust compact-trust" role="alert"><span>SFTP 키 확인</span><code>{sftpTrust.fingerprint}</code><button className="primary compact" onClick={() => void approveSftpTrust()}>신뢰</button></div>}
        {sftpError && <div className="rd-sftp-unavailable" role="status">파일 패널만 사용할 수 없습니다.<br />{sftpError}<button className="compact" onClick={() => void connectSftp()}>다시 시도</button></div>}
        {!sftpId && !sftpTrust && !sftpError && <div className="rd-empty-state">연결하면 이 서버의 파일을 함께 볼 수 있습니다.</div>}
        {sftpId && (dual ? <div className="rd-sftp-duo" ref={duoRef}><div className="rd-sftp-col" style={{ flexGrow: split, flexBasis: 0 }}>{renderBrowser('a')}</div><div className="rd-sftp-vdivider" role="separator" aria-orientation="vertical" aria-label="두 파일 창 너비 조절" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(split * 100)} tabIndex={0} onPointerDown={startSplitDrag} onPointerMove={moveSplitDrag} onPointerUp={endSplitDrag} onPointerCancel={endSplitDrag} onKeyDown={splitKey} /><div className="rd-sftp-col" style={{ flexGrow: 1 - split, flexBasis: 0 }}>{renderBrowser('b')}</div></div> : <div className="rd-sftp-col">{renderBrowser('a')}</div>)}
      </div></aside>
    </div>
    {prompt && <Dialog small label={prompt.mode === 'mkdir' ? '새 폴더 이름' : '이름 변경'} onCancel={() => setPrompt(null)}><label>{prompt.mode === 'mkdir' ? '새 폴더 이름' : '새 이름'}<input value={promptValue} onChange={(event) => setPromptValue(event.target.value)} /></label><div className="rd-modal-actions"><button onClick={() => setPrompt(null)}>취소</button><button className="primary" disabled={!promptValue.trim()} onClick={() => void runPrompt()}>확인</button></div></Dialog>}
    {confirm && <Dialog small label="삭제 확인" onCancel={() => setConfirm(null)}><p><strong>{confirm.name}</strong>을(를) 삭제할까요? {confirm.kind === 'dir' && '빈 폴더만 삭제할 수 있습니다.'}</p><div className="rd-modal-actions"><button onClick={() => setConfirm(null)}>취소</button><button className="danger" onClick={() => void confirmDelete()}>삭제</button></div></Dialog>}
    {overwriteName && <Dialog small label="덮어쓰기 확인" onCancel={() => { uploadFlow.cancel(); setOverwriteName(null); }}><p><strong>{overwriteName}</strong> 파일을 덮어쓸까요?</p><div className="rd-modal-actions"><button onClick={() => { uploadFlow.cancel(); setOverwriteName(null); }}>취소</button><button className="danger" onClick={() => { setOverwriteName(null); void uploadFlow.confirm(); }}>덮어쓰기</button></div></Dialog>}
  </section>;
}


/** Rebuild tab state from sessionStorage. Returns the restored layout and a
 *  counter offset so newly opened tabs get ids that do not collide with the
 *  restored ones (ids are `workspace-<n>`). */
export function restorePersistedTabs(): { state: WorkspaceTabsState; counter: number } {
  const saved = loadTabState();
  if (!saved || saved.tabs.length === 0) return { state: createWorkspaceTabsState(), counter: 0 };
  const tabs = saved.tabs.map((t) => ({ id: t.id, hostId: t.hostId, label: t.label, sessionId: null, sftpSessionId: null }));
  let maxN = 0;
  for (const tab of saved.tabs) {
    const match = /^workspace-(\d+)$/.exec(tab.id);
    if (match) maxN = Math.max(maxN, Number(match[1]));
  }
  const activeTabId = saved.activeTabId && tabs.some((tab) => tab.id === saved.activeTabId) ? saved.activeTabId : (tabs[0]?.id ?? null);
  return { state: { tabs, activeTabId }, counter: maxN };
}

export function App() {
  const config = resolveConfig();
  const rootRef = useRef<HTMLDivElement | null>(null); const [layout, setLayout] = useState<RemoteDeckLayout>('desktop');
  const [apiBase, setApiBase] = useState('http://localhost:4100'); const [token, setToken] = useState('');
  const client = useMemo(() => config.mode === 'same-origin' ? new RemoteDeckClient({ baseUrl: config.baseUrl, mode: 'same-origin' }) : token ? new RemoteDeckClient({ baseUrl: apiBase, token, mode: 'direct' }) : null, [apiBase, config.baseUrl, config.mode, token]);
  const [hosts, setHosts] = useState<Host[]>([]); const [credentials, setCredentials] = useState<Credential[]>([]); const [query, setQuery] = useState(''); const [showArchived, setShowArchived] = useState(false); const [catalogStatus, setCatalogStatus] = useState('호스트 불러오는 중…');
  // Compute the initial tab layout once. When Workbench navigation reloads the
  // page, sessionStorage restores the same tabs so their panes re-mount and
  // auto-reconnect; fresh counters avoid id collisions with restored tabs.
  const initialTabs = useMemo(() => restorePersistedTabs(), []);
  const [tabs, setTabs] = useState(initialTabs.state);
  const tabCounter = useRef(initialTabs.counter); const hostOrdinals = useRef(new Map<string, number>()); const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [tabStatus, setTabStatus] = useState<Record<string, 'idle' | 'connecting' | 'connected' | 'error'>>({});
  const reportTabStatus = useCallback((tabId: string, status: 'idle' | 'connecting' | 'connected' | 'error') => {
    setTabStatus((current) => current[tabId] === status ? current : { ...current, [tabId]: status });
  }, []);
  const [modalHost, setModalHost] = useState<Host | null | undefined>(undefined); const [modalBusy, setModalBusy] = useState(false); const [modalError, setModalError] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false); const drawerButtonRef = useRef<HTMLButtonElement | null>(null); const drawerRef = useRef<HTMLElement | null>(null);
  const refreshCatalog = useCallback(async () => { if (!client) { setCatalogStatus('개발 연결 설정을 입력해 주세요.'); return; } setCatalogStatus('호스트 불러오는 중…'); try { const [nextHosts, nextCredentials] = await Promise.all([client.listHosts(), client.listCredentials()]); setHosts(nextHosts); setCredentials(nextCredentials); setCatalogStatus(nextHosts.length ? `${nextHosts.length}개 호스트` : '저장된 호스트가 없습니다.'); } catch (error) { setCatalogStatus(`목록 오류 · ${(error as Error).message}`); } }, [client]);
  useEffect(() => { void refreshCatalog(); }, [refreshCatalog]);
  // Persist tab layout to sessionStorage so tab navigation in Workbench does not lose sessions.
  useEffect(() => {
    saveTabState({ tabs: tabs.tabs.map((t) => ({ id: t.id, hostId: t.hostId, label: t.label })), activeTabId: tabs.activeTabId });
  }, [tabs]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setLayout(layoutForWidth(entry.contentRect.width)));
    observer.observe(root); return () => observer.disconnect();
  }, []);
  useEffect(() => { if (layout === 'desktop') setDrawerOpen(false); }, [layout]);
  useEffect(() => { if (drawerOpen) drawerRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus(); }, [drawerOpen]);
  const openHost = (host: Host) => { setSelectedHostId(host.id); const ordinal = (hostOrdinals.current.get(host.id) ?? 0) + 1; hostOrdinals.current.set(host.id, ordinal); tabCounter.current += 1; setTabs((current) => addWorkspaceTab(current, { id: `workspace-${tabCounter.current}`, hostId: host.id, label: `${host.name} · ${ordinal}` })); setDrawerOpen(false); drawerButtonRef.current?.focus(); };
  const selectHost = (host: Host) => {
    setSelectedHostId(host.id);
    setTabs((current) => activateMostRecentHostTab(current, host.id));
  };
  const saveHost = async (draft: HostDraft, newCredential: NewCredentialDraft, clearSecret: () => void) => {
    if (!client) return;
    const port = Number(draft.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { setModalError('포트는 1~65535 사이의 정수여야 합니다.'); return; }
    let credentialRequest;
    try { credentialRequest = buildCredentialRequest(newCredential); } catch (error) { setModalError((error as Error).message); return; }
    setModalBusy(true); setModalError('');
    const body = { name: draft.name.trim(), hostname: draft.hostname.trim(), port, user: draft.username.trim(), credentialId: draft.credentialId || null, tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean) };
    try {
      if (credentialRequest) clearSecret();
      await persistHost(client, modalHost?.id ?? null, body, credentialRequest);
      setModalHost(undefined); await refreshCatalog();
    } catch {
      clearSecret();
      setModalError(credentialRequest ? '저장하지 못했습니다. 비밀 값은 지워졌습니다. 다시 입력해 주세요.' : '호스트를 저장하지 못했습니다. 입력 내용을 확인해 주세요.');
    } finally { clearSecret(); setModalBusy(false); }
  };
  const activateTab = (tabId: string) => setTabs((current) => activateWorkspaceTab(current, tabId));
  const tabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || tabs.tabs.length === 0) return;
    event.preventDefault();
    const targetIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.tabs.length) % tabs.tabs.length;
    const target = tabs.tabs[targetIndex]; activateTab(target.id);
    document.getElementById(`${target.id}-tab`)?.focus();
  };
  const closeTab = (tabId: string, index: number) => {
    const fallback = tabs.tabs[index + 1] ?? tabs.tabs[index - 1];
    setTabs((current) => closeWorkspaceTab(current, tabId));
    setTabStatus((current) => { if (!(tabId in current)) return current; const next = { ...current }; delete next[tabId]; return next; });
    if (fallback) requestAnimationFrame(() => document.getElementById(`${fallback.id}-tab`)?.focus());
  };
  const archivedCount = hosts.filter(isArchivedHost).length;
  const visibleHosts = filterHosts(hosts, query, showArchived);
  return <div ref={rootRef} className="rd-root" data-layout={layout} onKeyDown={(event) => { if (event.key === 'Escape' && drawerOpen) { setDrawerOpen(false); drawerButtonRef.current?.focus(); } }}>
    {DEV_DIRECT && <details className="rd-dev"><summary>개발 연결 설정</summary><div className="rd-dev-body"><label>API base<input aria-label="API base" value={apiBase} onChange={(event) => setApiBase(event.target.value)} /></label><label>API token<input aria-label="API token" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" /></label></div></details>}
    <main className="rd-main"><button className="rd-drawer-scrim" data-open={drawerOpen} aria-label="호스트 목록 닫기" tabIndex={drawerOpen && layout !== 'desktop' ? 0 : -1} onClick={() => { setDrawerOpen(false); drawerButtonRef.current?.focus(); }} /><aside ref={drawerRef} id="rd-host-drawer" className="rd-hosts" data-open={drawerOpen} aria-label="저장된 호스트" onKeyDown={(event) => { if (drawerOpen && layout !== 'desktop') trapTabWithin(event); }}><div className="rd-hosts-head"><strong>세션</strong><button className="primary compact" onClick={() => { setModalError(''); setModalHost(null); }}>+ 호스트</button></div><label className="rd-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="호스트 검색" placeholder="호스트 검색" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="rd-host-status" role="status" aria-live="polite">{catalogStatus}<button className="icon" aria-label="호스트 새로고침" onClick={() => void refreshCatalog()}>↻</button></div><div className="rd-host-key-legend" title="점 표시는 접속 가능 여부가 아니라 저장된 호스트 키의 검증 상태입니다."><span className="rd-host-led trusted" aria-hidden="true" />검증됨 <span className="rd-host-led" aria-hidden="true" />미검증 <small>온라인 상태 아님</small></div>{archivedCount > 0 && <button className="rd-archive-toggle" aria-pressed={showArchived} onClick={() => setShowArchived((value) => !value)}>{archiveToggleLabel(archivedCount, showArchived)}</button>}<ul className="rd-host-list">{visibleHosts.map((host) => <li key={host.id} data-archived={isArchivedHost(host)} data-selected={selectedHostId === host.id}><button className="rd-host-open" aria-pressed={selectedHostId === host.id} title="선택 · 더블클릭하면 새 탭" onClick={() => selectHost(host)} onDoubleClick={() => openHost(host)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openHost(host); } }}><span className={`rd-host-led ${host.hostKeyTrusted ? 'trusted' : ''}`} role="img" aria-label={`호스트 키 ${host.hostKeyTrusted ? '검증됨' : '미검증'}`} title={`호스트 키 ${host.hostKeyTrusted ? '검증됨' : '미검증'} · 온라인 상태 표시 아님`} /><span className="rd-host-copy"><strong>{host.name}</strong><small>{host.username}@{host.hostname}:{host.port}</small></span></button><button className="icon rd-host-new-tab" aria-label={`${host.name} 새 탭 열기`} title="새 탭 열기" onClick={() => openHost(host)}>＋</button><button className="icon rd-host-edit" aria-label={`${host.name} 편집`} onClick={() => { setModalError(''); setModalHost(host); }}>✎</button></li>)}</ul></aside>
      <section className="rd-stage" aria-label="원격 작업 공간" aria-hidden={drawerOpen && layout !== 'desktop' || undefined}><div className="rd-session-tabs" role="tablist" aria-label="서버 세션"><button ref={drawerButtonRef} className="rd-drawer-toggle icon" aria-label={drawerOpen ? '호스트 목록 닫기' : '호스트 목록 열기'} aria-controls="rd-host-drawer" aria-expanded={drawerOpen} onClick={() => setDrawerOpen((value) => !value)}>☰</button>{tabs.tabs.map((tab, index) => <div className="rd-session-tab" key={tab.id} data-active={tabs.activeTabId === tab.id} data-status={tabStatus[tab.id] ?? 'idle'}><button id={`${tab.id}-tab`} role="tab" aria-controls={`${tab.id}-panel`} aria-selected={tabs.activeTabId === tab.id} tabIndex={tabs.activeTabId === tab.id ? 0 : -1} onKeyDown={(event) => tabKeyDown(event, index)} onClick={() => activateTab(tab.id)}><span className={`rd-tab-led rd-tab-led--${tabStatus[tab.id] ?? 'idle'}`} aria-hidden="true" />{tab.label}</button><button className="close" aria-label={`${tab.label} 닫기`} onClick={() => closeTab(tab.id, index)}>×</button></div>)}<span className="rd-tabs-hint">선택 · 더블클릭 또는 ＋로 새 탭</span></div>
        <div className="rd-workspace-stack">{tabs.tabs.length === 0 && <div className="rd-welcome"><div className="rd-welcome-icon">⌘</div><h1>원격 서버를 한 화면에서 관리하세요</h1><p>호스트를 더블클릭하거나 ＋를 누르면 SSH와 SFTP 작업 탭이 열립니다.</p><button className="primary" onClick={() => setModalHost(null)}>첫 호스트 추가</button></div>}{client && tabs.tabs.map((tab) => { const host = hosts.find((item) => item.id === tab.hostId); return host ? <WorkspacePane key={tab.id} tab={tab} host={host} client={client} active={tabs.activeTabId === tab.id} onStatus={reportTabStatus} /> : null; })}</div>
      </section></main>
    {modalHost !== undefined && <HostModal key={modalHost?.id ?? 'new'} host={modalHost} credentials={credentials} busy={modalBusy} error={modalError} onCancel={() => setModalHost(undefined)} onSave={saveHost} />}
  </div>;
}
