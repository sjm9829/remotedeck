import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { RemoteDeckClient } from '@remotedeck/client-sdk';
import type { Credential, Host } from '@remotedeck/types';
import { resolveConfig } from './config.js';
import { createResizeController, type ResizeController } from './terminal-controller.js';
import { adoptSocket, closeSocketRef } from './socket-slot.js';
import { createExclusiveRunner } from './async-guard.js';
import { createUploadFlow } from './upload-flow.js';
import { trustPendingSession, type PendingSshTrust } from './ssh-trust-flow.js';
import { activateMostRecentHostTab, activateWorkspaceTab, addWorkspaceTab, closeWorkspaceTab, createWorkspaceTabsState, setWorkspaceTabSession, type WorkspaceTab, type WorkspaceTabsState } from './workspace-tabs.js';
import { MAX_AUTO_ATTEMPTS, backoffMs, classifyClose, isSessionGoneError, isTerminalSessionState } from './reconnect-policy.js';
import { createHeartbeat } from './heartbeat.js';
import { folderNames, folderOf, groupHosts, normalizeFolderName, renameFolderTag, setFolderTag, visibleTags } from './host-folders.js';
import { hasArchivedTag, hostLiveStates, loadRecent, needsCloseConfirm, saveRecent, setArchivedTag, sortHosts, touchRecent, type RecentMap } from './host-order.js';
import { FONT_MAX, FONT_MIN, TERMINAL_FONT_FAMILY, TERMINAL_SCROLLBACK, defaultFontSize, loadCollapsedFolders, loadDock, loadFontSize, loadSidebarHidden, saveCollapsedFolders, saveDock, saveFontSize, saveSidebarHidden, stepFontSize, type SftpDock } from './terminal-prefs.js';
import { DEFAULT_SFTP_HEIGHT, MAX_SFTP_HEIGHT, MIN_SFTP_HEIGHT, clampSftpHeight, resizeSftpWithKey } from './split-layout.js';
import { buildCredentialRequest, emptyCredentialDraft, type NewCredentialDraft } from './credential-draft.js';
import { persistHost } from './host-save.js';
import { layoutForWidth, type RemoteDeckLayout } from './responsive-layout.js';
import { MOBILE_KEY_ROWS, NO_MODIFIERS, buttonPress, resolveKeyboardKey, toggleModifier, type ModifierState, type MobileKey } from './mobile-keys.js';
import { joinSftpPath, parentSftpPath } from './sftp-path.js';
import { formatMtime, formatSize, listingSummary, sortEntries, summarizeSelection, type SortKey, type SortDir } from './sftp-list.js';
import { DEFAULT_SFTP_WIDTH, MIN_SFTP_WIDTH, canDockRight, clampSftpWidth, effectiveDock, initialDock, resizeSftpWidthWithKey } from './dock-layout.js';
import { IconChevronDown, IconColumns, IconDockBottom, IconDockRight, IconFile, IconFolder, IconFolderPlus, IconMore, IconRefresh, IconUp, IconUpload } from './icons.js';
import { DEFAULT_SPLIT, clampSplit, otherSide, planBulkMove, planMove, resizeSplitWithKey, type PaneSide } from './dual-pane.js';
import { createSftpUnmountCleanup } from './sftp-cleanup.js';
import { shouldStreamDownload, summarizeBulkDelete } from './sftp-download.js';
import { breadcrumbs } from './sftp-breadcrumb.js';
import { contextMenuItems, type ContextActionId } from './sftp-context-menu.js';
import { createBatchUploadFlow } from './sftp-batch-upload.js';
import { clearSelection, emptySelection, moveCursor, pruneSelection, selectAll, selectEntry, selectedInOrder, type Selection } from './sftp-selection.js';
import { createSshUnmountCleanup } from './ssh-cleanup.js';
import { scheduleWorkspaceAutoStart, startWorkspaceConnections } from './deferred-auto-start.js';
import { EXPANDED_PANES, togglePaneCollapse } from './pane-collapse.js';
import { closeRemoteSessionOnce } from './session-cleanup.js';
import { terminalIdentity } from './terminal-identity.js';
import { saveTabState, loadTabState, type PersistedTabState } from './session-persistence.js';

const DEV_DIRECT = import.meta.env.VITE_REMOTEDECK_MODE === 'direct';
/** Width of the always-visible host list in the desktop layout (matches `.rd-main` grid). */
const HOST_LIST_WIDTH = 238;
type FileEntry = { name: string; type: string; size?: number };
type SftpTrust = { id: string; fingerprint: string };
type ConfirmState = { kind: 'file' | 'dir'; name: string; side: PaneSide } | null;
type PromptState = { mode: 'mkdir'; side: PaneSide } | { mode: 'rename'; from: string; side: PaneSide } | null;
type ContextMenuState = { side: PaneSide; name: string; x: number; y: number } | null;
type BulkDeleteState = { side: PaneSide; items: { name: string; kind: 'file' | 'dir' }[] } | null;

export function isArchivedHost(host: Pick<Host, 'tags'>): boolean {
  return host.tags.some((tag) => tag.toLocaleLowerCase() === 'archived');
}

export function archiveToggleLabel(count: number, shown: boolean): string {
  return `보관됨 ${count}개 ${shown ? '숨기기' : '표시'}`;
}

export type CatalogState = 'loading' | 'ready' | 'error';

export type WelcomePanel = { title: string; body: string; action?: string };

/** Workspace welcome copy. The `add first host` call to action belongs only to a
 *  genuinely empty catalog; a loaded catalog names the saved hosts it already
 *  offers so a returning user is never asked to add their first host again. */
export function welcomePanel(state: CatalogState, hostCount: number): WelcomePanel {
  if (state === 'loading') return { title: '호스트 목록을 불러오는 중입니다', body: '잠시만 기다려 주세요.' };
  if (state === 'error') return { title: '호스트 목록을 불러오지 못했습니다', body: '네트워크나 로그인 상태를 확인한 뒤 다시 시도해 주세요.' };
  if (hostCount === 0) return { title: '원격 서버를 한 화면에서 관리하세요', body: '호스트를 추가하면 SSH 터미널과 SFTP 파일 창을 한 번에 열 수 있습니다.', action: '첫 호스트 추가' };
  return { title: `${hostCount}개의 호스트가 준비되어 있습니다`, body: '목록에서 호스트를 누르면 SSH · SFTP 탭이 열립니다. ＋로 같은 호스트의 탭을 더 열 수 있습니다.', action: '호스트 추가' };
}

export function filterHosts(hosts: readonly Host[], query: string, includeArchived = false): Host[] {
  const needle = query.trim().toLocaleLowerCase();
  return hosts.filter((host) => (includeArchived || !isArchivedHost(host)) && (!needle || [host.name, host.hostname, host.username, host.tags.join(' ')].some((value) => value.toLocaleLowerCase().includes(needle))));
}

type HostDraft = { name: string; hostname: string; port: string; username: string; credentialId: string; tags: string; folder: string };
function hostDraft(host: Host | null): HostDraft {
  return host ? { name: host.name, hostname: host.hostname, port: String(host.port), username: host.username, credentialId: host.credentialId ?? '', tags: visibleTags(host.tags).join(', '), folder: folderOf(host) }
    : { name: '', hostname: '', port: '22', username: '', credentialId: '', tags: '', folder: '' };
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

function HostModal({ host, credentials, folders, busy, error, onCancel, onSave }: { host: Host | null; credentials: readonly Credential[]; folders: readonly string[]; busy: boolean; error: string; onCancel: () => void; onSave: (draft: HostDraft, credential: NewCredentialDraft, clearSecret: () => void) => Promise<void> }) {
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
        <label className="span-2">폴더<input aria-label="호스트 폴더" list="rd-folder-options" value={draft.folder} onChange={field('folder')} placeholder="없음 (새 이름을 입력하면 폴더가 만들어집니다)" maxLength={40} autoComplete="off" /><datalist id="rd-folder-options">{folders.map((name) => <option value={name} key={name} />)}</datalist></label>
        <label className="span-2">태그<input aria-label="호스트 태그" value={draft.tags} onChange={field('tags')} placeholder="예: homelab, storage" /></label>
        {host && <label className="rd-archive-check span-2"><input type="checkbox" checked={hasArchivedTag(draft.tags)} onChange={(event) => setDraft((current) => ({ ...current, tags: setArchivedTag(current.tags, event.target.checked) }))} />보관 — 목록에서 숨깁니다 ("보관됨 표시"로 다시 볼 수 있음)</label>}
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

export type SshUiState = 'idle' | 'connecting' | 'trust' | 'ready' | 'attached' | 'reconnecting' | 'disconnected' | 'ended' | 'error';

/** Label of the manual (re)connect button for a terminal state, or null when none applies. */
export function reconnectLabel(state: SshUiState): string | null {
  if (state === 'reconnecting') return '지금 다시 연결';
  if (state === 'disconnected') return '다시 연결';
  if (state === 'ended') return '새 세션 시작';
  if (state === 'error') return '다시 시도';
  return null;
}

export function WorkspacePane({ tab, host, client, active, onStatus, onSessionId, fontSize = 14, onFontStep, containerWidth = 0, isMobile = false }: { tab: WorkspaceTab; host: Host; client: RemoteDeckClient; active: boolean; fontSize?: number; onFontStep?: (delta: number) => void; containerWidth?: number; isMobile?: boolean; onStatus?: (tabId: string, status: 'idle' | 'connecting' | 'connected' | 'error') => void; onSessionId?: (tabId: string, sessionId: string | null) => void }) {
  const [sshState, setSshState] = useState<SshUiState>('idle');
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
  // Short non-blocking confirmations (upload done, copied, reconnected …).
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<number | null>(null);
  const notifyRef = useRef<(message: string) => void>(() => undefined);
  notifyRef.current = (message: string) => { if (!mountedRef.current) return; setToast(message); if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current); toastTimerRef.current = window.setTimeout(() => { toastTimerRef.current = null; setToast(''); }, 2600); };
  useEffect(() => () => { if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current); }, []);
  // Reconnect machinery: a restored tab re-attaches to the id saved before reload;
  // a dropped socket is retried with backoff against the same server session.
  const restoreIdRef = useRef(tab.sessionId ?? '');
  const autoRecreateRef = useRef(false);
  const attemptRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const sshStateRef = useRef<SshUiState>('idle');
  const socketLostRef = useRef<(code: number, reason: string) => void>(() => undefined);
  const retryAttachRef = useRef<() => Promise<void>>(async () => undefined);
  const heartbeat = useMemo(() => createHeartbeat({
    send: () => { const socket = wsRef.current; if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping', data: {} })); },
    onDead: () => { closeSocketRef(wsRef); socketLostRef.current(1006, 'heartbeat'); },
  }), []);
  const ctrlRef = useRef<ResizeController | null>(null);
  const [collapsedPanes, setCollapsedPanes] = useState(EXPANDED_PANES);
  const { ssh: sshCollapsed, sftp: sftpCollapsed } = collapsedPanes;
  const [mobileView, setMobileView] = useState<'terminal' | 'files'>('terminal');
  const modifierRef = useRef<ModifierState>(NO_MODIFIERS);
  const [modsActive, setModsActive] = useState<ModifierState>(NO_MODIFIERS);
  const applyModifiers = useCallback((next: ModifierState) => { modifierRef.current = next; setModsActive(next); }, []);
  const [sftpHeight, setSftpHeight] = useState(DEFAULT_SFTP_HEIGHT);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  // File pane placement: docked right of the terminal in wide windows, otherwise below it.
  const [dockPref, setDockPref] = useState<SftpDock>(() => initialDock(loadDock(), containerWidth));
  const dockMode = effectiveDock(dockPref, containerWidth, isMobile);
  const dockAvailable = canDockRight(containerWidth, isMobile);
  const [sftpWidth, setSftpWidth] = useState(DEFAULT_SFTP_WIDTH);
  const dragWRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const toggleDock = () => { const next: SftpDock = dockMode === 'right' ? 'bottom' : 'right'; setDockPref(next); saveDock(next); };
  const [dropSide, setDropSide] = useState<PaneSide | null>(null);
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
  // Multi-selection + power-user browse state (per pane). Selection is a set of
  // entry names per side; it drives bulk delete/download/move and the context menu.
  const [selA, setSelA] = useState<Selection>(emptySelection);
  const [selB, setSelB] = useState<Selection>(emptySelection);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [bulkDelete, setBulkDelete] = useState<BulkDeleteState>(null);
  const [batchConflicts, setBatchConflicts] = useState<string[] | null>(null);
  const selOf = (side: PaneSide): Selection => side === 'a' ? selA : selB;
  const setSelOf = (side: PaneSide) => (side === 'a' ? setSelA : setSelB);
  const namesOf = (side: PaneSide) => (side === 'a' ? sortedFiles : sortedB).map((entry) => entry.name);
  const entryOf = (side: PaneSide, name: string) => (side === 'a' ? sortedFiles : sortedB).find((entry) => entry.name === name);
  // Keep selections valid across refreshes/navigation: drop entries that vanished.
  useEffect(() => { setSelA((current) => pruneSelection(current, sftpFiles.map((entry) => entry.name))); }, [sftpFiles]);
  useEffect(() => { setSelB((current) => pruneSelection(current, bFiles.map((entry) => entry.name))); }, [bFiles]);
  const sftpIdRef = useRef('');
  const closedSftpSessionIdsRef = useRef(new Set<string>());
  const sftpPathRef = useRef('');
  const sftpFilesRef = useRef<FileEntry[]>([]);
  const workspaceStartedRef = useRef(false);
  const workspaceStartRef = useRef<() => Promise<void>>(async () => undefined);
  const terminalKey = terminalIdentity(host);
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  useEffect(() => { sftpIdRef.current = sftpId; }, [sftpId]);
  useEffect(() => { hostNameRef.current = host.name; }, [host.name]);
  useEffect(() => { sftpPathRef.current = sftpPath; }, [sftpPath]);
  useEffect(() => { sftpFilesRef.current = sftpFiles; }, [sftpFiles]);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => { sshStateRef.current = sshState; }, [sshState]);
  useEffect(() => {
    const mapped = sshState === 'attached' || sshState === 'ready' ? 'connected' : sshState === 'connecting' || sshState === 'trust' || sshState === 'reconnecting' ? 'connecting' : sshState === 'error' || sshState === 'disconnected' ? 'error' : 'idle';
    onStatus?.(tab.id, mapped);
  }, [sshState, onStatus, tab.id]);
  useEffect(() => createSshUnmountCleanup(client, () => sessionIdRef.current, () => closeSocketRef(wsRef), closedSshSessionIdsRef.current), [client]);
  useEffect(() => () => { heartbeat.stop(); if (retryTimerRef.current !== null) { window.clearTimeout(retryTimerRef.current); retryTimerRef.current = null; } }, [heartbeat]);
  useEffect(() => createSftpUnmountCleanup(client, () => sftpIdRef.current, closedSftpSessionIdsRef.current), [client]);
  const loadSide = useCallback(async (side: PaneSide, id: string, path: string) => { const result = await client.sftpList(id, path); if (!mountedRef.current) return; if (side === 'a') { setSftpFiles(result.files); setSftpPath(result.path); setSftpStatus(result.path || '/'); } else { setBFiles(result.files); setBPath(result.path); } }, [client]);
  const loadFiles = useCallback((id: string, path: string) => loadSide('a', id, path), [loadSide]);
  const uploadFlow = useMemo(() => createUploadFlow(async (file, overwrite) => {
    const id = sftpIdRef.current; if (!id) return;
    const { side, dir } = uploadTarget.current;
    setSftpBusy(true); setSftpError(''); setSftpStatus(`업로드 중 · ${file.name}`);
    try { await client.sftpUpload(id, joinSftpPath(dir, file.name), file, overwrite); await loadSide(side, id, dir); notifyRef.current(`업로드 완료 · ${file.name}`); }
    catch (error) { setSftpError((error as Error).message); } finally { setSftpBusy(false); }
  }), [client, loadSide]);
  const batchUpload = useMemo(() => createBatchUploadFlow<File>(
    (file) => file.name,
    async (file, overwrite) => {
      const id = sftpIdRef.current; if (!id) return;
      const { side, dir } = uploadTarget.current;
      setSftpBusy(true); setSftpError(''); setSftpStatus(`업로드 중 · ${file.name}`);
      try { await client.sftpUpload(id, joinSftpPath(dir, file.name), file, overwrite); await loadSide(side, id, dir); notifyRef.current(`업로드 완료 · ${file.name}`); }
      catch (error) { setSftpError((error as Error).message); } finally { setSftpBusy(false); }
    },
  ), [client, loadSide]);

  useEffect(() => {
    if (!termEl.current) return;
    const terminal = new Terminal({ cols: 80, rows: 24, convertEol: true, fontSize: fontSizeRef.current, fontFamily: TERMINAL_FONT_FAMILY, scrollback: TERMINAL_SCROLLBACK, macOptionIsMeta: true, allowProposedApi: true, theme: { background: '#10151d', foreground: '#d8e1ee', cursor: '#55b7ff' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.loadAddon(new WebLinksAddon());
    // Unicode 11 widths keep Korean/emoji cells aligned in TUIs (Codex, htop, tmux).
    try { terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11'; } catch { /* keep default widths */ }
    terminal.open(termEl.current); terminal.writeln(`${hostNameRef.current} — 연결 대기`);
    terminal.onData((data) => { const socket = wsRef.current; if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data: { data } })); });
    terminal.attachCustomKeyEventHandler((event) => {
      // Ctrl/Cmd+C with a selection copies it (like Windows Terminal) instead of sending ^C.
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c' && terminal.hasSelection()) {
        void navigator.clipboard?.writeText(terminal.getSelection()).then(() => notifyRef.current('복사했습니다')).catch(() => undefined);
        terminal.clearSelection();
        return false;
      }
      const mods = modifierRef.current;
      if (event.type !== 'keydown' || (!mods.ctrl && !mods.alt)) return true;
      if (event.ctrlKey || event.altKey || event.metaKey) { modifierRef.current = NO_MODIFIERS; setModsActive(NO_MODIFIERS); return true; }
      const res = resolveKeyboardKey(event.key, mods);
      modifierRef.current = NO_MODIFIERS; setModsActive(NO_MODIFIERS);
      const socket = wsRef.current;
      if (res.data !== null && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data: { data: res.data } }));
      return res.data !== null;
    });
    const controller = createResizeController({ fit, getSize: () => ({ rows: terminal.rows, cols: terminal.cols }), send: (size) => { const socket = wsRef.current; if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', data: size })); }, target: termEl.current });
    controller.start(); termRef.current = terminal; ctrlRef.current = controller;
    return () => { controller.dispose(); closeSocketRef(wsRef); terminal.dispose(); termRef.current = null; ctrlRef.current = null; modifierRef.current = NO_MODIFIERS; };
  }, [terminalKey]);
  useEffect(() => { if (active) requestAnimationFrame(() => ctrlRef.current?.fitNow()); }, [active, sshCollapsed, sftpCollapsed, sftpHeight, sftpWidth, dockMode]);
  useEffect(() => { const terminal = termRef.current; if (!terminal || terminal.options.fontSize === fontSize) return; terminal.options.fontSize = fontSize; requestAnimationFrame(() => ctrlRef.current?.fitNow()); }, [fontSize]);

  // A bar button sends its own bytes without stealing focus from the terminal,
  // so the on-screen keyboard stays open. Modifiers only prefix software-keyboard
  // keystrokes (handled by the terminal's custom key handler above).
  const pressMobileKey = useCallback((key: MobileKey) => {
    termRef.current?.focus();
    const res = buttonPress(key, modifierRef.current);
    if (res.consumed) applyModifiers(NO_MODIFIERS);
    const socket = wsRef.current;
    if (res.data && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data: { data: res.data } }));
  }, [applyModifiers]);
  const pasteClipboard = useCallback(async () => {
    try { const text = await navigator.clipboard.readText(); if (text) termRef.current?.paste(text); } catch { /* permission denied or empty clipboard */ }
    termRef.current?.focus();
  }, []);
  const toggleMobileModifier = useCallback((name: 'ctrl' | 'alt') => {
    applyModifiers(toggleModifier(modifierRef.current, name));
    termRef.current?.focus();
  }, [applyModifiers]);

  const clearRetry = useCallback(() => { if (retryTimerRef.current !== null) { window.clearTimeout(retryTimerRef.current); retryTimerRef.current = null; } }, []);
  // The server session is gone for good (shell exited, session closed, restart could not recover it).
  const endSession = useCallback((message: string) => {
    clearRetry(); heartbeat.stop(); closeSocketRef(wsRef); autoRecreateRef.current = false;
    onSessionId?.(tab.id, null);
    if (!mountedRef.current) return;
    setSshState('ended'); setSshStatus(message);
  }, [clearRetry, heartbeat, onSessionId, tab.id]);
  const attachSession = useCallback(async (id: string) => {
    if (!mountedRef.current) return;
    const ticket = await client.wsTicket(id, 'writer');
    if (!mountedRef.current) return;
    const socket = client.connectSession(id, ticket.ticket);
    if (!mountedRef.current) { try { socket.close(); } catch { /* already closed */ } return; }
    adoptSocket(wsRef, socket);
    socket.onopen = () => { const wasReconnect = attemptRef.current > 0; if (wasReconnect) notifyRef.current('다시 연결되었습니다'); attemptRef.current = 0; autoRecreateRef.current = false; heartbeat.start(); setSshState('attached'); setSshStatus('SSH 연결됨'); termRef.current?.reset(); termRef.current?.writeln(`[${hostNameRef.current} 연결됨]`); ctrlRef.current?.fitNow(); };
    socket.onmessage = (event) => {
      heartbeat.touch();
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'output' || message.type === 'scrollback') termRef.current?.write(message.data.data);
        if (message.type === 'status') {
          if (isTerminalSessionState(message.data.status)) { endSession('SSH 세션이 종료되었습니다'); return; }
          setSshStatus(message.data.status === 'active' ? 'SSH 연결됨' : `SSH · ${message.data.status}`);
        }
      } catch { /* ignore */ }
    };
    socket.onclose = (event) => { if (wsRef.current === socket) wsRef.current = null; heartbeat.stop(); socketLostRef.current(event.code, event.reason); };
  }, [client, endSession, heartbeat]);
  const scheduleRetry = useCallback(() => {
    clearRetry();
    if (!mountedRef.current) return;
    const attempt = attemptRef.current;
    if (attempt >= MAX_AUTO_ATTEMPTS) { setSshState('disconnected'); setSshStatus('SSH 연결이 끊어졌습니다'); return; }
    attemptRef.current = attempt + 1;
    setSshState('reconnecting'); setSshStatus(`재연결 중… (${attempt + 1}/${MAX_AUTO_ATTEMPTS})`);
    retryTimerRef.current = window.setTimeout(() => { retryTimerRef.current = null; void retryAttachRef.current(); }, backoffMs(attempt));
  }, [clearRetry]);
  const connectSsh = useCallback(async () => {
    await sshRunner.run(async () => { setSshState('connecting'); setSshStatus('SSH 연결 중…');
      try {
        // A tab restored after a reload re-attaches to its still-running server session.
        const restoreId = restoreIdRef.current; restoreIdRef.current = '';
        if (restoreId) {
          sessionIdRef.current = restoreId; setSessionId(restoreId); autoRecreateRef.current = true; setSshStatus('기존 세션에 다시 연결 중…');
          try { await attachSession(restoreId); return; }
          catch (error) {
            if (!isSessionGoneError((error as Error).message)) { scheduleRetry(); return; }
            autoRecreateRef.current = false; sessionIdRef.current = ''; setSessionId('');
          }
        }
        const created = await client.createSession({ hostId: host.id }); sessionIdRef.current = created.id;
        if (!mountedRef.current) { closeRemoteSessionOnce(created.id, closedSshSessionIdsRef.current, (id) => client.closeSession(id)); return; }
        setSessionId(created.id); onSessionId?.(tab.id, created.id);
        if (created.requiresTrust) { setPendingTrust({ hostId: host.id, sessionId: created.id, fingerprint: created.fingerprint }); setSshState('trust'); setSshStatus('호스트 키 확인 필요'); return; }
        setSshState('ready'); await attachSession(created.id);
      } catch (error) { if (mountedRef.current) { setSshState('error'); setSshStatus(`SSH 오류 · ${(error as Error).message}`); } }
    });
  }, [attachSession, client, host.id, onSessionId, scheduleRetry, sshRunner, tab.id]);
  retryAttachRef.current = async () => {
    const id = sessionIdRef.current;
    if (!id || !mountedRef.current) return;
    try { await attachSession(id); }
    catch (error) { if (isSessionGoneError((error as Error).message)) endSession('SSH 세션이 종료되었습니다'); else scheduleRetry(); }
  };
  socketLostRef.current = (code, reason) => {
    if (!mountedRef.current) return;
    if (classifyClose(code, reason) === 'session-gone') {
      // A restored session that no longer exists is replaced silently; a live one that ended is reported.
      if (autoRecreateRef.current) { autoRecreateRef.current = false; sessionIdRef.current = ''; setSessionId(''); onSessionId?.(tab.id, null); void connectSsh(); return; }
      endSession('SSH 세션이 종료되었습니다'); return;
    }
    scheduleRetry();
  };
  const manualReconnect = () => {
    attemptRef.current = 0; clearRetry();
    if ((sshState === 'reconnecting' || sshState === 'disconnected') && sessionIdRef.current) { setSshState('reconnecting'); setSshStatus('재연결 중…'); void retryAttachRef.current(); }
    else void connectSsh();
  };
  // Returning to the page (tab switch, phone unlock, network back) is the moment a
  // silently dead socket is noticed: probe a live socket, retry a waiting one at once.
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState === 'hidden' || !mountedRef.current) return;
      const state = sshStateRef.current;
      if (state === 'attached') heartbeat.probe();
      else if ((state === 'reconnecting' || state === 'disconnected') && sessionIdRef.current) { attemptRef.current = 0; clearRetry(); setSshState('reconnecting'); setSshStatus('재연결 중…'); void retryAttachRef.current(); }
    };
    document.addEventListener('visibilitychange', wake); window.addEventListener('online', wake); window.addEventListener('pageshow', wake);
    return () => { document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); window.removeEventListener('pageshow', wake); };
  }, [clearRetry, heartbeat]);
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
  const runPrompt = async () => { if (!prompt || !sftpId || !promptValue.trim()) return; const value = promptValue.trim(); const side = prompt.side; const dir = pathRefOf(side).current; await runSftp(async () => { if (prompt.mode === 'mkdir') await client.sftpMkdir(sftpId, joinSftpPath(dir, value)); else await client.sftpRename(sftpId, joinSftpPath(dir, prompt.from), joinSftpPath(dir, value)); await loadSide(side, sftpId, dir); notifyRef.current(prompt.mode === 'mkdir' ? '폴더를 만들었습니다' : '이름을 변경했습니다'); }); setPrompt(null); };
  const confirmDelete = async () => { if (!confirm || !sftpId) return; const side = confirm.side; const dir = pathRefOf(side).current; await runSftp(async () => { const path = joinSftpPath(dir, confirm.name); if (confirm.kind === 'dir') await client.sftpDeleteDir(sftpId, path); else await client.sftpDeleteFile(sftpId, path); await loadSide(side, sftpId, dir); notifyRef.current('삭제했습니다'); }); setConfirm(null); };
  const selectUpload = async (event: ChangeEvent<HTMLInputElement>, side: PaneSide) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file || !sftpId) return; const dir = pathRefOf(side).current; uploadTarget.current = { side, dir }; const result = await uploadFlow.select(filesRefOf(side).current.map((entry) => entry.name), file); if (result.overwrite) setOverwriteName(file.name); };
  const download = async (name: string, side: PaneSide) => {
    if (!sftpId) return; const dir = pathRefOf(side).current;
    // Big files go through the browser's own download manager (streamed, native progress).
    const size = filesRefOf(side).current.find((entry) => entry.name === name)?.size;
    if (shouldStreamDownload(size, resolveConfig().mode)) { const anchor = document.createElement('a'); anchor.href = client.sftpDownloadUrl(sftpId, joinSftpPath(dir, name)); anchor.download = name; anchor.click(); return; }
    await runSftp(async () => { const blob = await client.sftpDownload(sftpId, joinSftpPath(dir, name)); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); }); };
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
  // --- SFTP power-user browsing: selection, bulk operations, context menu, drag-drop ---
  const selectRow = (event: ReactMouseEvent, side: PaneSide, name: string) => {
    setContextMenu(null);
    setSelOf(side)(selectEntry(namesOf(side), name, { additive: event.ctrlKey || event.metaKey, range: event.shiftKey }, selOf(side)));
  };
  const openEntry = (side: PaneSide, entry: FileEntry) => { if (entry.type === 'directory') navigate(side, joinSftpPath(pathRefOf(side).current, entry.name)); else void download(entry.name, side); };
  const openContextMenu = (event: ReactMouseEvent, side: PaneSide, entry: FileEntry) => {
    event.preventDefault();
    event.stopPropagation();
    const sel = selOf(side);
    if (!sel.selected.has(entry.name)) setSelOf(side)(selectEntry(namesOf(side), entry.name, {}, sel));
    setContextMenu({ side, name: entry.name, x: event.clientX, y: event.clientY });
  };
  const runContextAction = (action: ContextActionId) => {
    const menu = contextMenu; if (!menu) return;
    const { side, name } = menu;
    const sel = selOf(side);
    const target = entryOf(side, name);
    setContextMenu(null);
    if (action === 'open') { if (target) void openEntry(side, target); }
    else if (action === 'download') { for (const n of selectedInOrder(sel, namesOf(side))) { const e = entryOf(side, n); if (e && e.type === 'file') void download(n, side); } }
    else if (action === 'rename') { if (target) { setPromptValue(name); setPrompt({ mode: 'rename', from: name, side }); } }
    else if (action === 'move') { for (const n of selectedInOrder(sel, namesOf(side))) { const e = entryOf(side, n); if (e) void moveEntry(side, e); } }
    else if (action === 'delete') {
      const names = sel.selected.has(name) ? selectedInOrder(sel, namesOf(side)) : [name];
      const items = names.map((n) => { const e = entryOf(side, n); return { name: n, kind: (e && e.type === 'directory' ? 'dir' : 'file') as 'file' | 'dir' }; });
      setBulkDelete({ side, items });
    }
  };
  const downloadSelection = (side: PaneSide) => { const sel = selOf(side); for (const n of selectedInOrder(sel, namesOf(side))) { const e = entryOf(side, n); if (e && e.type === 'file') void download(n, side); } };
  const deleteSelection = (side: PaneSide) => { const sel = selOf(side); const items = selectedInOrder(sel, namesOf(side)).map((n) => { const e = entryOf(side, n); return { name: n, kind: (e && e.type === 'directory' ? 'dir' : 'file') as 'file' | 'dir' }; }); if (items.length) setBulkDelete({ side, items }); };
  const confirmBulkDelete = async () => {
    if (!bulkDelete || !sftpId) return; const { side, items } = bulkDelete; const dir = pathRefOf(side).current;
    // Keep going after a failure and report exactly what was and was not deleted.
    const outcome: { deleted: string[]; failed: { name: string; message: string }[] } = { deleted: [], failed: [] };
    await runSftp(async () => {
      for (const item of items) {
        const path = joinSftpPath(dir, item.name);
        try { if (item.kind === 'dir') await client.sftpDeleteDir(sftpId, path); else await client.sftpDeleteFile(sftpId, path); outcome.deleted.push(item.name); }
        catch (error) { outcome.failed.push({ name: item.name, message: (error as Error).message }); }
      }
      await loadSide(side, sftpId, dir);
    });
    const summary = summarizeBulkDelete(outcome); if (summary) setSftpError(summary); else if (outcome.deleted.length) notifyRef.current(`${outcome.deleted.length}개 삭제했습니다`);
    setSelOf(side)(clearSelection());
    setBulkDelete(null);
  };
  const moveSelection = async (side: PaneSide) => {
    if (!sftpId) return;
    const sel = selOf(side);
    const entries = (side === 'a' ? sftpFiles : bFiles).filter((entry) => sel.selected.has(entry.name)).map((entry) => ({ name: entry.name, type: entry.type }));
    if (!entries.length) return;
    const dest = otherSide(side);
    const plan = planBulkMove(pathRefOf(side).current, pathRefOf(dest).current, entries, filesRefOf(dest).current.map((entry) => entry.name));
    if (plan.skipped.length) setSftpError(plan.skipped[0].reason === 'same-dir' ? '두 창의 경로가 같아 이동할 수 없습니다.' : '디렉터리를 자기 자신 하위로 이동할 수 없습니다.');
    await runSftp(async () => {
      for (const step of plan.moves) await client.sftpRename(sftpId, step.from, step.to);
      await Promise.all([loadSide(side, sftpId, pathRefOf(side).current), loadSide(dest, sftpId, pathRefOf(dest).current)]);
    });
    setSelOf(side)(clearSelection());
  };
  const dropUpload = (event: ReactDragEvent, side: PaneSide) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (!files.length || !sftpId) return;
    const dir = pathRefOf(side).current;
    uploadTarget.current = { side, dir };
    const { conflicts } = batchUpload.add(filesRefOf(side).current.map((entry) => entry.name), files);
    if (conflicts.length) setBatchConflicts(conflicts);
  };
  const rowKeyDown = (event: KeyboardEvent<HTMLLIElement>, side: PaneSide, entry: FileEntry) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelOf(side)(moveCursor(namesOf(side), selOf(side), event.key === 'ArrowDown' ? 1 : -1)); }
    else if (event.key === 'Enter') { event.preventDefault(); openEntry(side, entry); }
    else if (event.key === 'a' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); setSelOf(side)(selectAll(namesOf(side))); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelection(side); }
    else if (event.key === 'Escape') { setSelOf(side)(clearSelection()); }
  };
  const closeContextMenu = () => setContextMenu(null);
  useEffect(() => {
    if (!contextMenu) return;
    const onDoc = () => setContextMenu(null);
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setContextMenu(null); };
    document.addEventListener('click', onDoc);
    document.addEventListener('contextmenu', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', onDoc); document.removeEventListener('contextmenu', onDoc); document.removeEventListener('keydown', onKey); };
  }, [contextMenu]);
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
  const isCoarsePointer = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const openRowMenu = (event: ReactMouseEvent, side: PaneSide, entry: FileEntry) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const sel = selOf(side);
    if (!sel.selected.has(entry.name)) setSelOf(side)(selectEntry(namesOf(side), entry.name, {}, sel));
    setContextMenu({ side, name: entry.name, x: Math.max(8, rect.right - 176), y: rect.bottom + 2 });
  };
  const renderBrowser = (side: PaneSide, withGlobalControls: boolean) => {
    const path = side === 'a' ? sftpPath : bPath;
    const files = side === 'a' ? sftpFiles : bFiles;
    const sorted = side === 'a' ? sortedFiles : sortedB;
    const sel = selOf(side);
    const selCount = sel.selected.size;
    const crumbs = breadcrumbs(path);
    const goto = (p: string) => navigate(side, p);
    const summary = summarizeSelection(files, sel.selected);
    const sortMark = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? '▲' : '▼') : '';
    const ariaSort = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
    const allSelected = files.length > 0 && selCount === files.length;
    return <>
      <div className="rd-file-tools">
        <button className="icon rd-tool" disabled={!path || sftpBusy} onClick={() => goto(parentSftpPath(path))} aria-label="상위 폴더" title="상위 폴더"><IconUp /></button>
        <nav className="rd-breadcrumb" aria-label="경로">{crumbs.map((crumb, index) => index === crumbs.length - 1 ? <span className="crumb current" key={`${side}-c${index}`} aria-current="page">{crumb.label}</span> : <button className="crumb" key={`${side}-c${index}`} disabled={sftpBusy} onClick={() => goto(crumb.path)}>{crumb.label}</button>)}</nav>
        <button className="icon rd-tool" disabled={sftpBusy} onClick={() => goto(path)} aria-label="파일 새로고침" title="새로고침"><IconRefresh /></button>
        <button className="icon rd-tool" disabled={sftpBusy} onClick={() => { setPromptValue(''); setPrompt({ mode: 'mkdir', side }); }} aria-label="새 폴더" title="새 폴더"><IconFolderPlus /></button>
        <label className="icon rd-tool rd-upload" title="업로드" aria-label="업로드"><IconUpload /><input type="file" aria-label="업로드할 파일 선택" disabled={sftpBusy} onChange={(event) => void selectUpload(event, side)} /></label>
        {withGlobalControls && <span className="rd-tool-group rd-desk-only"><span className="rd-tool-sep" aria-hidden="true" />
          <button className="icon rd-tool" aria-pressed={dual} aria-label="SFTP 창 분할" title="두 개의 파일 창을 나란히 표시" onClick={toggleDual}><IconColumns /></button>
          {dockAvailable && <button className="icon rd-tool" aria-label={dockMode === 'right' ? '파일 창을 아래로' : '파일 창을 오른쪽으로'} title={dockMode === 'right' ? '파일 창을 터미널 아래로 이동' : '파일 창을 터미널 오른쪽으로 이동'} onClick={toggleDock}>{dockMode === 'right' ? <IconDockBottom /> : <IconDockRight />}</button>}
          <button className="icon rd-tool" aria-label="SFTP 접기" aria-expanded={!sftpCollapsed} title="파일 창 접기" onClick={toggleSftpCollapsed}><IconChevronDown /></button>
        </span>}
      </div>
      <div className="rd-file-head" role="row">
        <span className="rd-check"><input type="checkbox" aria-label="전체 선택" checked={allSelected} ref={(element) => { if (element) element.indeterminate = selCount > 0 && !allSelected; }} disabled={files.length === 0} onChange={() => setSelOf(side)(allSelected ? clearSelection() : selectAll(sorted.map((entry) => entry.name)))} /></span>
        <button className={`rd-file-th ${sortKey === 'name' ? 'active' : ''}`} role="columnheader" aria-sort={ariaSort('name')} onClick={() => toggleSort('name')}>이름 {sortMark('name')}</button>
        <button className={`rd-file-th rd-col-mtime ${sortKey === 'mtime' ? 'active' : ''}`} role="columnheader" aria-sort={ariaSort('mtime')} onClick={() => toggleSort('mtime')}>수정일 {sortMark('mtime')}</button>
        <button className={`rd-file-th rd-col-size ${sortKey === 'size' ? 'active' : ''}`} role="columnheader" aria-sort={ariaSort('size')} onClick={() => toggleSort('size')}>크기 {sortMark('size')}</button>
        <span className="rd-file-th" />
      </div>
      <ul className={`rd-filelist${dropSide === side ? ' is-drop' : ''}`} role="listbox" aria-multiselectable="true"
        onDragOver={(event) => event.preventDefault()}
        onDragEnter={(event) => { if (event.dataTransfer?.types?.includes('Files')) setDropSide(side); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropSide(null); }}
        onDrop={(event) => { setDropSide(null); dropUpload(event, side); }}>
        {sorted.map((entry) => {
          const selected = sel.selected.has(entry.name);
          const isDir = entry.type === 'directory';
          const mtime = formatMtime(entry.mtime);
          const size = isDir ? '' : formatSize(entry.size);
          return <li className="rd-file-row" key={`${side}/${entry.name}`} role="option" aria-selected={selected} tabIndex={0}
            onClick={(event) => { if (isCoarsePointer() && isDir && !event.ctrlKey && !event.metaKey && !event.shiftKey) { setContextMenu(null); openEntry(side, entry); return; } selectRow(event, side, entry.name); }}
            onDoubleClick={() => openEntry(side, entry)} onContextMenu={(event) => openContextMenu(event, side, entry)} onKeyDown={(event) => rowKeyDown(event, side, entry)}>
            <span className="rd-check" onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`${entry.name} 선택`} checked={selected} onChange={() => setSelOf(side)(selectEntry(namesOf(side), entry.name, { additive: true }, selOf(side)))} /></span>
            <span className="rd-file-name">{isDir ? <IconFolder /> : <IconFile />}<span className="rd-file-text"><span className="rd-file-label">{entry.name}</span><span className="rd-file-sub">{[mtime, isDir ? '폴더' : size].filter(Boolean).join(' · ')}</span></span></span>
            <span className="meta rd-col-mtime">{mtime}</span>
            <span className="meta rd-col-size">{isDir ? '폴더' : size}</span>
            <button className="icon rd-row-more" aria-label={`${entry.name} 메뉴`} aria-haspopup="menu" onClick={(event) => openRowMenu(event, side, entry)}><IconMore /></button>
          </li>;
        })}
        {files.length === 0 && <li className="rd-empty-state">빈 폴더입니다. 파일을 끌어다 놓으면 업로드됩니다.</li>}
      </ul>
      <div className="rd-file-status" role="status">{selCount > 0
        ? <><span className="rd-status-text">{selCount}개 선택{summary.files > 0 ? ` · ${formatSize(summary.bytes)}` : ''}</span><span className="rd-status-actions"><button className="compact" disabled={sftpBusy || summary.files === 0} onClick={() => downloadSelection(side)}>다운로드</button>{dual && <button className="compact" disabled={sftpBusy} onClick={() => void moveSelection(side)}>다른 창으로</button>}<button className="compact danger" disabled={sftpBusy} onClick={() => deleteSelection(side)}>삭제</button><button className="compact" onClick={() => setSelOf(side)(clearSelection())}>해제</button></span></>
        : <><span className="rd-status-text">{listingSummary(files)}</span><span className={`rd-status-busy${sftpBusy ? ' is-busy' : ''}`}>{sftpBusy ? sftpStatus.startsWith('업로드') ? sftpStatus : '작업 중…' : ''}</span></>}</div>
    </>;
  };
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => { dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: sftpHeight }; event.currentTarget.setPointerCapture(event.pointerId); };
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => { const current = dragRef.current; if (current?.pointerId === event.pointerId) setSftpHeight(clampSftpHeight(current.startHeight + current.startY - event.clientY)); };
  const stopDrag = (event: ReactPointerEvent<HTMLDivElement>) => { if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null; };
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => { const height = resizeSftpWithKey(sftpHeight, event.key); if (height !== sftpHeight) { event.preventDefault(); setSftpHeight(height); } };
  const startDragW = (event: ReactPointerEvent<HTMLDivElement>) => { dragWRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sftpWidth }; event.currentTarget.setPointerCapture(event.pointerId); };
  const dragW = (event: ReactPointerEvent<HTMLDivElement>) => { const current = dragWRef.current; if (current?.pointerId === event.pointerId) setSftpWidth(clampSftpWidth(current.startWidth + current.startX - event.clientX, containerWidth)); };
  const stopDragW = (event: ReactPointerEvent<HTMLDivElement>) => { if (dragWRef.current?.pointerId === event.pointerId) dragWRef.current = null; };
  const resizeWidthWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => { const width = resizeSftpWidthWithKey(sftpWidth, event.key, containerWidth); if (width !== sftpWidth) { event.preventDefault(); setSftpWidth(width); } };
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
    <div className="rd-workspace-toolbar"><div className="rd-target"><strong>{host.name}</strong><span>{host.username}@{host.hostname}:{host.port}</span></div><span className={`rd-state rd-state--${sshState}`}>{sshStatus}</span>{reconnectLabel(sshState) && <button className="compact rd-reconnect" onClick={manualReconnect}>{reconnectLabel(sshState)}</button>}<span className="rd-font-controls" role="group" aria-label="터미널 글자 크기"><button className="rd-font-btn" aria-label="글자 작게" disabled={fontSize <= FONT_MIN} onClick={() => onFontStep?.(-1)}>A−</button><span className="rd-font-size" aria-live="polite">{fontSize}</span><button className="rd-font-btn" aria-label="글자 크게" disabled={fontSize >= FONT_MAX} onClick={() => onFontStep?.(1)}>A+</button></span></div>
    {pendingTrust && <div className="rd-trust" role="alert"><strong>SSH 호스트 키를 확인해 주세요.</strong><code>{pendingTrust.fingerprint}</code><button className="primary compact" onClick={() => void approveTrust()}>신뢰하고 기존 세션 연결</button></div>}
    <div className="rd-mobile-segments" role="tablist" aria-label={`${host.name} 작업 보기`} onKeyDown={segmentKeyDown}><button id={`${tab.id}-terminal-tab`} role="tab" aria-selected={mobileView === 'terminal'} aria-controls={terminalPanelId} tabIndex={mobileView === 'terminal' ? 0 : -1} onClick={() => { setCollapsedPanes(EXPANDED_PANES); setMobileView('terminal'); }}>Terminal</button><button id={`${tab.id}-files-tab`} role="tab" aria-selected={mobileView === 'files'} aria-controls={filesPanelId} tabIndex={mobileView === 'files' ? 0 : -1} onClick={() => { setCollapsedPanes(EXPANDED_PANES); setMobileView('files'); }}>Files</button></div>
    <div className="rd-mobile-keys" role="toolbar" aria-label={`${host.name} 특수 키`} data-active={mobileView}>
      <div className="rd-mobile-keys-row">
        <button type="button" aria-pressed={modsActive.ctrl} className={`rd-mkey rd-mkey--mod${modsActive.ctrl ? ' is-active' : ''}`} title="Ctrl (다음 키에 적용)" onPointerDown={(event) => { event.preventDefault(); toggleMobileModifier('ctrl'); }}>Ctrl</button>
        <button type="button" aria-pressed={modsActive.alt} className={`rd-mkey rd-mkey--mod${modsActive.alt ? ' is-active' : ''}`} title="Alt (다음 키에 적용)" onPointerDown={(event) => { event.preventDefault(); toggleMobileModifier('alt'); }}>Alt</button>
        {MOBILE_KEY_ROWS[0].map((key) => <button key={key.id} type="button" title={key.title} aria-label={key.title} className="rd-mkey" onPointerDown={(event) => { event.preventDefault(); pressMobileKey(key); }}>{key.label}</button>)}
        <button type="button" title="클립보드 붙여넣기" aria-label="클립보드 붙여넣기" className="rd-mkey rd-mkey--paste" onPointerDown={(event) => event.preventDefault()} onClick={() => void pasteClipboard()}>붙임</button>
      </div>
      <div className="rd-mobile-keys-row">
        {MOBILE_KEY_ROWS[1].map((key) => <button key={key.id} type="button" title={key.title} aria-label={key.title} className="rd-mkey" onPointerDown={(event) => { event.preventDefault(); pressMobileKey(key); }}>{key.label}</button>)}
      </div>
    </div>
    <div className="rd-split" data-mobile-view={mobileView} data-ssh-collapsed={sshCollapsed} data-sftp-collapsed={sftpCollapsed} data-dock={dockMode}>
      <div id={terminalPanelId} role="tabpanel" className="rd-terminal-pane" aria-label={`${host.name} 터미널`} data-collapsed={sshCollapsed}><div className="rd-terminal-title"><span>SSH 터미널</span><span className="rd-pane-title-actions"><span className="rd-session-id">{sessionId ? `세션 ${sessionId.slice(0, 8)}` : '대기'}</span><button className="rd-pane-collapse" aria-label={`SSH ${sshCollapsed ? '펼치기' : '접기'}`} aria-expanded={!sshCollapsed} onClick={toggleSshCollapsed}>{sshCollapsed ? '펼치기' : '접기'}</button></span></div><div className="rd-terminal-wrap" ref={termEl} /></div>
      {!sftpCollapsed && !sshCollapsed && (dockMode === 'right'
        ? <div className="rd-divider rd-divider--v" role="separator" aria-label="터미널과 SFTP 패널 너비" aria-orientation="vertical" aria-valuemin={MIN_SFTP_WIDTH} aria-valuemax={Math.max(MIN_SFTP_WIDTH, containerWidth)} aria-valuenow={sftpWidth} tabIndex={0} onPointerDown={startDragW} onPointerMove={dragW} onPointerUp={stopDragW} onPointerCancel={stopDragW} onKeyDown={resizeWidthWithKeyboard} />
        : <div className="rd-divider" role="separator" aria-label="SSH와 SFTP 패널 높이" aria-orientation="horizontal" aria-valuemin={MIN_SFTP_HEIGHT} aria-valuemax={MAX_SFTP_HEIGHT} aria-valuenow={sftpHeight} tabIndex={0} onPointerDown={startDrag} onPointerMove={drag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onKeyDown={resizeWithKeyboard} />)}
      <aside id={filesPanelId} role="tabpanel" className="rd-sftp-pane" aria-label={`${host.name} SFTP 파일`} data-collapsed={sftpCollapsed} data-slim={Boolean(sftpId) && !sftpCollapsed && !dual} style={!sftpCollapsed && !sshCollapsed ? (dockMode === 'right' ? { width: sftpWidth } : { height: sftpHeight }) : undefined}><div className="rd-pane-title"><span>SFTP</span><span className="rd-pane-title-actions"><span className={sftpError ? 'error' : ''}>{sftpBusy ? '작업 중…' : sftpStatus}</span><button className="rd-pane-collapse" aria-pressed={dual} aria-label="SFTP 창 분할" title="두 개의 파일 창을 나란히 표시" onClick={toggleDual}>분할</button>{dockAvailable && <button className="rd-pane-collapse" aria-label={dockMode === 'right' ? '파일 창을 아래로' : '파일 창을 오른쪽으로'} onClick={toggleDock}>{dockMode === 'right' ? '아래로' : '오른쪽으로'}</button>}<button className="rd-pane-collapse" aria-label={`SFTP ${sftpCollapsed ? '펼치기' : '접기'}`} aria-expanded={!sftpCollapsed} onClick={toggleSftpCollapsed}>{sftpCollapsed ? '펼치기' : '접기'}</button></span></div><div className="rd-sftp-body">
        {sftpTrust && <div className="rd-trust compact-trust" role="alert"><span>SFTP 키 확인</span><code>{sftpTrust.fingerprint}</code><button className="primary compact" onClick={() => void approveSftpTrust()}>신뢰</button></div>}
        {sftpError && !sftpId && <div className="rd-sftp-unavailable" role="status">파일 패널만 사용할 수 없습니다.<br />{sftpError}<button className="compact" onClick={() => void connectSftp()}>다시 시도</button></div>}
        {sftpError && sftpId && <div className="rd-sftp-error" role="alert"><span>{sftpError}</span><button className="icon" aria-label="오류 닫기" onClick={() => setSftpError('')}>×</button></div>}
        {!sftpId && !sftpTrust && !sftpError && <div className="rd-empty-state">연결하면 이 서버의 파일을 함께 볼 수 있습니다.</div>}
        {sftpId && (dual ? <div className="rd-sftp-duo" ref={duoRef}><div className="rd-sftp-col" style={{ flexGrow: split, flexBasis: 0 }}>{renderBrowser('a', false)}</div><div className="rd-sftp-vdivider" role="separator" aria-orientation="vertical" aria-label="두 파일 창 너비 조절" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(split * 100)} tabIndex={0} onPointerDown={startSplitDrag} onPointerMove={moveSplitDrag} onPointerUp={endSplitDrag} onPointerCancel={endSplitDrag} onKeyDown={splitKey} /><div className="rd-sftp-col" style={{ flexGrow: 1 - split, flexBasis: 0 }}>{renderBrowser('b', false)}</div></div> : <div className="rd-sftp-col">{renderBrowser('a', true)}</div>)}
      </div></aside>
    </div>
    {prompt && <Dialog small label={prompt.mode === 'mkdir' ? '새 폴더 이름' : '이름 변경'} onCancel={() => setPrompt(null)}><label>{prompt.mode === 'mkdir' ? '새 폴더 이름' : '새 이름'}<input value={promptValue} onChange={(event) => setPromptValue(event.target.value)} /></label><div className="rd-modal-actions"><button onClick={() => setPrompt(null)}>취소</button><button className="primary" disabled={!promptValue.trim()} onClick={() => void runPrompt()}>확인</button></div></Dialog>}
    {confirm && <Dialog small label="삭제 확인" onCancel={() => setConfirm(null)}><p><strong>{confirm.name}</strong>을(를) 삭제할까요? {confirm.kind === 'dir' && '빈 폴더만 삭제할 수 있습니다.'}</p><div className="rd-modal-actions"><button onClick={() => setConfirm(null)}>취소</button><button className="danger" onClick={() => void confirmDelete()}>삭제</button></div></Dialog>}
    {overwriteName && <Dialog small label="덮어쓰기 확인" onCancel={() => { uploadFlow.cancel(); setOverwriteName(null); }}><p><strong>{overwriteName}</strong> 파일을 덮어쓸까요?</p><div className="rd-modal-actions"><button onClick={() => { uploadFlow.cancel(); setOverwriteName(null); }}>취소</button><button className="danger" onClick={() => { setOverwriteName(null); void uploadFlow.confirm(); }}>덮어쓰기</button></div></Dialog>}
    {contextMenu && (() => { const target = entryOf(contextMenu.side, contextMenu.name); if (!target) return null; const sel = selOf(contextMenu.side); const items = contextMenuItems({ entry: { name: target.name, type: target.type }, selectionCount: Math.max(1, sel.selected.size), dual }); return <div className="rd-context-menu" role="menu" style={{ left: Math.max(8, Math.min(contextMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 184)), top: Math.max(8, Math.min(contextMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 8 - items.length * 32)) }}>{items.map((item) => <button role="menuitem" key={item.id} className={item.danger ? 'danger' : ''} onClick={() => runContextAction(item.id)}>{item.label}</button>)}</div>; })()}
    {bulkDelete && <Dialog small label="삭제 확인" onCancel={() => setBulkDelete(null)}><p><strong>{bulkDelete.items.length}개</strong> 항목을 삭제할까요? {bulkDelete.items.some((item) => item.kind === 'dir') && '빈 폴더는 비어 있어야 삭제할 수 있습니다.'}</p><div className="rd-modal-actions"><button onClick={() => setBulkDelete(null)}>취소</button><button className="danger" onClick={() => void confirmBulkDelete()}>삭제</button></div></Dialog>}
    {toast && <div className="rd-toast" role="status" aria-live="polite">{toast}</div>}
    {batchConflicts && <Dialog small label="덮어쓰기 확인" onCancel={() => { batchUpload.cancel(); setBatchConflicts(null); }}><p>이미 존재하는 파일 <strong>{batchConflicts.length}개</strong>를 덮어쓸까요?</p><ul className="rd-conflict-list">{batchConflicts.map((name) => <li key={name}>{name}</li>)}</ul><div className="rd-modal-actions"><button onClick={() => { batchUpload.cancel(); setBatchConflicts(null); }}>그만두기</button><button className="danger" onClick={() => { setBatchConflicts(null); void batchUpload.confirmAll(); }}>덮어쓰기</button></div></Dialog>}
  </section>;
}


/** Rebuild tab state from sessionStorage. Returns the restored layout and a
 *  counter offset so newly opened tabs get ids that do not collide with the
 *  restored ones (ids are `workspace-<n>`). */
export function restorePersistedTabs(): { state: WorkspaceTabsState; counter: number } {
  const saved = loadTabState();
  if (!saved || saved.tabs.length === 0) return { state: createWorkspaceTabsState(), counter: 0 };
  const tabs = saved.tabs.map((t) => ({ id: t.id, hostId: t.hostId, label: t.label, sessionId: t.sessionId ?? null, sftpSessionId: null }));
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
  const rootRef = useRef<HTMLDivElement | null>(null); const [layout, setLayout] = useState<RemoteDeckLayout>('desktop'); const [rootWidth, setRootWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 0));
  const [apiBase, setApiBase] = useState('http://localhost:4100'); const [token, setToken] = useState('');
  const client = useMemo(() => config.mode === 'same-origin' ? new RemoteDeckClient({ baseUrl: config.baseUrl, mode: 'same-origin' }) : token ? new RemoteDeckClient({ baseUrl: apiBase, token, mode: 'direct' }) : null, [apiBase, config.baseUrl, config.mode, token]);
  const [hosts, setHosts] = useState<Host[]>([]); const [credentials, setCredentials] = useState<Credential[]>([]); const [query, setQuery] = useState(''); const [showArchived, setShowArchived] = useState(false); const [catalogStatus, setCatalogStatus] = useState('호스트 불러오는 중…'); const [catalogState, setCatalogState] = useState<CatalogState>('loading');
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
  const [fontSize, setFontSize] = useState(() => loadFontSize() ?? defaultFontSize(typeof window !== 'undefined' && window.innerWidth < 600 ? 'mobile' : 'desktop'));
  const stepFont = useCallback((delta: number) => { setFontSize((current) => { const next = stepFontSize(current, delta); saveFontSize(next); return next; }); }, []);
  const [recent, setRecent] = useState<RecentMap>(() => loadRecent());
  const [sidebarHidden, setSidebarHidden] = useState(() => loadSidebarHidden());
  const [closeConfirm, setCloseConfirm] = useState<{ tabId: string; label: string } | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set(loadCollapsedFolders()));
  const [dragHostId, setDragHostId] = useState<string | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [folderRename, setFolderRename] = useState<{ from: string; value: string } | null>(null);
  const reportSessionId = useCallback((tabId: string, sessionId: string | null) => { setTabs((current) => setWorkspaceTabSession(current, tabId, sessionId)); }, []);
  const [modalHost, setModalHost] = useState<Host | null | undefined>(undefined); const [modalBusy, setModalBusy] = useState(false); const [modalError, setModalError] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false); const drawerButtonRef = useRef<HTMLButtonElement | null>(null); const drawerRef = useRef<HTMLElement | null>(null);
  const refreshCatalog = useCallback(async () => { if (!client) { setCatalogState('error'); setCatalogStatus('개발 연결 설정을 입력해 주세요.'); return; } setCatalogState('loading'); setCatalogStatus('호스트 불러오는 중…'); try { const [nextHosts, nextCredentials] = await Promise.all([client.listHosts(), client.listCredentials()]); setHosts(nextHosts); setCredentials(nextCredentials); setCatalogState('ready'); setCatalogStatus(nextHosts.length ? `${nextHosts.length}개 호스트` : '저장된 호스트가 없습니다.'); } catch (error) { setCatalogState('error'); setCatalogStatus(`목록 오류 · ${(error as Error).message}`); } }, [client]);
  useEffect(() => { void refreshCatalog(); }, [refreshCatalog]);
  // Persist tab layout to sessionStorage so tab navigation in Workbench does not lose sessions.
  useEffect(() => {
    saveTabState({ tabs: tabs.tabs.map((t) => ({ id: t.id, hostId: t.hostId, label: t.label, ...(t.sessionId ? { sessionId: t.sessionId } : {}) })), activeTabId: tabs.activeTabId });
  }, [tabs]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => { setLayout(layoutForWidth(entry.contentRect.width)); setRootWidth(Math.round(entry.contentRect.width)); });
    observer.observe(root); return () => observer.disconnect();
  }, []);
  useEffect(() => { if (layout === 'desktop') setDrawerOpen(false); }, [layout]);
  useEffect(() => { if (drawerOpen) drawerRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus({ preventScroll: true }); }, [drawerOpen]);
  const openHost = (host: Host) => { setRecent((current) => { const next = touchRecent(current, host.id, Date.now()); saveRecent(next); return next; }); setSelectedHostId(host.id); const ordinal = (hostOrdinals.current.get(host.id) ?? 0) + 1; hostOrdinals.current.set(host.id, ordinal); tabCounter.current += 1; setTabs((current) => addWorkspaceTab(current, { id: `workspace-${tabCounter.current}`, hostId: host.id, label: `${host.name} · ${ordinal}` })); setDrawerOpen(false); drawerButtonRef.current?.focus(); };
  // One tap opens the host: an existing tab is re-activated, otherwise a new one opens.
  // The ＋ button opens an additional tab for the same host.
  const selectHost = (host: Host) => {
    if (tabs.tabs.some((tab) => tab.hostId === host.id)) {
      setSelectedHostId(host.id);
      setTabs((current) => activateMostRecentHostTab(current, host.id));
      setDrawerOpen(false); drawerButtonRef.current?.focus();
    } else openHost(host);
  };
  const saveHost = async (draft: HostDraft, newCredential: NewCredentialDraft, clearSecret: () => void) => {
    if (!client) return;
    const port = Number(draft.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { setModalError('포트는 1~65535 사이의 정수여야 합니다.'); return; }
    let credentialRequest;
    try { credentialRequest = buildCredentialRequest(newCredential); } catch (error) { setModalError((error as Error).message); return; }
    setModalBusy(true); setModalError('');
    const body = { name: draft.name.trim(), hostname: draft.hostname.trim(), port, user: draft.username.trim(), credentialId: draft.credentialId || null, tags: setFolderTag(draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean), draft.folder) };
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
  const requestCloseTab = (tabId: string) => {
    const tab = tabs.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    if (needsCloseConfirm(tabStatus[tabId])) setCloseConfirm({ tabId, label: tab.label });
    else closeTab(tabId, tabs.tabs.indexOf(tab));
  };
  const toggleSidebar = () => {
    if (layout === 'desktop') { const next = !sidebarHidden; setSidebarHidden(next); saveSidebarHidden(next); }
    else setDrawerOpen((value) => !value);
  };
  const hostKeyNav = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.rd-host-open')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    event.preventDefault();
    buttons[Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };
  const toggleFolder = (name: string) => setCollapsedFolders((current) => { const next = new Set(current); if (next.has(name)) next.delete(name); else next.add(name); saveCollapsedFolders([...next]); return next; });
  // Folders are `folder:<name>` tags, so moving a host is a partial update of its tags.
  const moveHostToFolder = async (hostId: string, folder: string) => {
    const host = hosts.find((item) => item.id === hostId);
    setDragHostId(null); setDropFolder(null);
    if (!host || !client || folderOf(host) === folder) return;
    try {
      await client.updateHost(host.id, { tags: setFolderTag(host.tags, folder) });
      if (folder) setCollapsedFolders((current) => { if (!current.has(folder)) return current; const next = new Set(current); next.delete(folder); saveCollapsedFolders([...next]); return next; });
      await refreshCatalog();
      setCatalogStatus(folder ? `${host.name} → ${folder}` : `${host.name} 폴더에서 꺼냄`);
    } catch (error) { setCatalogStatus(`이동 실패 · ${(error as Error).message}`); }
  };
  const submitFolderRename = async () => {
    if (!folderRename || !client) return;
    const from = folderRename.from; const to = normalizeFolderName(folderRename.value);
    setFolderRename(null);
    if (!to || to === from) return;
    try {
      await Promise.all(hosts.filter((host) => folderOf(host) === from).map((host) => client.updateHost(host.id, { tags: renameFolderTag(host.tags, from, to) })));
      setCollapsedFolders((current) => { if (!current.has(from)) return current; const next = new Set(current); next.delete(from); next.add(to); saveCollapsedFolders([...next]); return next; });
      await refreshCatalog();
      setCatalogStatus(`폴더 이름을 "${to}"(으)로 바꿨습니다`);
    } catch (error) { setCatalogStatus(`이름 변경 실패 · ${(error as Error).message}`); }
  };
  const archivedCount = hosts.filter(isArchivedHost).length;
  const welcome = welcomePanel(catalogState, hosts.length - archivedCount);
  const liveByHost = hostLiveStates(tabs.tabs, tabStatus);
  const openHostIds = new Set(liveByHost.keys());
  const visibleHosts = sortHosts(filterHosts(hosts, query, showArchived), openHostIds, recent);
  const welcomeHosts = sortHosts(filterHosts(hosts, '', false), openHostIds, recent).slice(0, 8);
  const allFolders = folderNames(hosts);
  const searching = query.trim() !== '';
  const groups = groupHosts(visibleHosts);
  const renderHostRow = (host: Host, inFolder: boolean) => {
    const live = liveByHost.get(host.id); const liveStatus = live?.status ?? 'idle';
    const liveLabel = liveStatus === 'connected' ? '연결됨' : liveStatus === 'connecting' ? '연결 중' : liveStatus === 'error' ? '연결 오류' : '연결 안 됨';
    const tagText = visibleTags(host.tags).join(', ');
    return <li key={host.id} className={inFolder ? 'rd-host-child' : undefined} data-archived={isArchivedHost(host)} data-selected={selectedHostId === host.id} data-dragging={dragHostId === host.id || undefined} draggable onDragStart={(event) => { event.dataTransfer.setData('text/x-remotedeck-host', host.id); event.dataTransfer.effectAllowed = 'move'; setDragHostId(host.id); }} onDragEnd={() => { setDragHostId(null); setDropFolder(null); }}>
      <button className="rd-host-open" aria-pressed={selectedHostId === host.id} title={tagText ? `눌러서 열기 · 태그: ${tagText}` : '눌러서 열기'} onClick={() => selectHost(host)}><span className={`rd-host-led rd-host-led--${liveStatus}`} role="img" aria-label={`${liveLabel}${live ? ` · 탭 ${live.count}개` : ''}`} title={liveLabel} /><span className="rd-host-copy"><strong>{host.name}{live && live.count > 1 && <em className="rd-host-badge" aria-hidden="true">{live.count}</em>}{!host.hostKeyTrusted && <span className="rd-host-warn" role="img" aria-label="처음 연결할 때 호스트 키 확인이 필요합니다" title="처음 연결할 때 호스트 키 확인이 필요합니다">⚠</span>}</strong><small>{host.username}@{host.hostname}:{host.port}</small></span></button>
      <button className="icon rd-host-new-tab" aria-label={`${host.name} 새 탭 열기`} title="같은 호스트로 새 탭 열기" onClick={() => openHost(host)}>＋</button>
      <button className="icon rd-host-edit" aria-label={`${host.name} 편집`} onClick={() => { setModalError(''); setModalHost(host); }}>✎</button>
    </li>;
  };
  return <div ref={rootRef} className="rd-root" data-layout={layout} onKeyDown={(event) => { if (event.key === 'Escape' && drawerOpen) { setDrawerOpen(false); drawerButtonRef.current?.focus(); } }}>
    {DEV_DIRECT && <details className="rd-dev"><summary>개발 연결 설정</summary><div className="rd-dev-body"><label>API base<input aria-label="API base" value={apiBase} onChange={(event) => setApiBase(event.target.value)} /></label><label>API token<input aria-label="API token" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" /></label></div></details>}
    <main className="rd-main" data-sidebar={layout === 'desktop' && sidebarHidden ? 'hidden' : 'shown'}><button className="rd-drawer-scrim" data-open={drawerOpen} aria-label="호스트 목록 닫기" tabIndex={drawerOpen && layout !== 'desktop' ? 0 : -1} onClick={() => { setDrawerOpen(false); drawerButtonRef.current?.focus(); }} /><aside ref={drawerRef} id="rd-host-drawer" className="rd-hosts" data-open={drawerOpen} aria-label="저장된 호스트" onKeyDown={(event) => { if (drawerOpen && layout !== 'desktop') trapTabWithin(event); }}><div className="rd-hosts-head"><strong>호스트</strong><button className="primary compact" onClick={() => { setModalError(''); setModalHost(null); }}>+ 호스트</button></div><label className="rd-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="호스트 검색" placeholder="호스트 검색" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="rd-host-status" role="status" aria-live="polite">{catalogStatus}<button className="icon" aria-label="호스트 새로고침" onClick={() => void refreshCatalog()}>↻</button></div>{archivedCount > 0 && <button className="rd-archive-toggle" aria-pressed={showArchived} onClick={() => setShowArchived((value) => !value)}>{archiveToggleLabel(archivedCount, showArchived)}</button>}<ul className="rd-host-list" data-dragging={dragHostId ? 'true' : undefined} onKeyDown={hostKeyNav} onDragOver={(event) => { if (dragHostId) event.preventDefault(); }} onDrop={(event) => { if (!dragHostId) return; event.preventDefault(); void moveHostToFolder(dragHostId, ''); }}>
        {groups.folders.map((group) => { const isCollapsed = !searching && collapsedFolders.has(group.name); const connected = group.hosts.filter((host) => liveByHost.get(host.id)?.status === 'connected').length; return <Fragment key={`folder:${group.name}`}>
          <li className="rd-folder" data-drop={dropFolder === group.name || undefined}>
            <button className="rd-folder-head" aria-expanded={!isCollapsed} title={isCollapsed ? '폴더 펼치기' : '폴더 접기'} onClick={() => toggleFolder(group.name)} onDragOver={(event) => { if (!dragHostId) return; event.preventDefault(); event.stopPropagation(); setDropFolder(group.name); }} onDragLeave={() => setDropFolder((current) => current === group.name ? null : current)} onDrop={(event) => { if (!dragHostId) return; event.preventDefault(); event.stopPropagation(); void moveHostToFolder(dragHostId, group.name); }}>
              <span className="rd-folder-chevron" data-open={!isCollapsed} aria-hidden="true">▸</span><IconFolder size={15} /><strong>{group.name}</strong><span className="rd-folder-count">{group.hosts.length}</span>{connected > 0 && <span className="rd-host-led rd-host-led--connected" role="img" aria-label={`연결됨 ${connected}개`} />}
            </button>
            <button className="icon rd-folder-edit" aria-label={`${group.name} 폴더 이름 변경`} title="폴더 이름 변경" onClick={() => setFolderRename({ from: group.name, value: group.name })}>✎</button>
          </li>
          {!isCollapsed && group.hosts.map((host) => renderHostRow(host, true))}
        </Fragment>; })}
        {groups.loose.map((host) => renderHostRow(host, false))}
        {dragHostId && (() => { const dragged = hosts.find((host) => host.id === dragHostId); return dragged && folderOf(dragged) ? <li className="rd-drop-hint">여기에 놓으면 폴더에서 꺼냅니다</li> : null; })()}
        {visibleHosts.length === 0 && catalogState === 'ready' && <li className="rd-host-empty">{searching ? '검색 결과가 없습니다.' : '표시할 호스트가 없습니다.'}</li>}</ul></aside>
      <section className="rd-stage" aria-label="원격 작업 공간" aria-hidden={drawerOpen && layout !== 'desktop' || undefined}><div className="rd-session-tabs" role="tablist" aria-label="서버 세션"><button ref={drawerButtonRef} className="rd-drawer-toggle icon" aria-label={(layout === 'desktop' ? !sidebarHidden : drawerOpen) ? '호스트 목록 닫기' : '호스트 목록 열기'} aria-controls="rd-host-drawer" aria-expanded={layout === 'desktop' ? !sidebarHidden : drawerOpen} onClick={toggleSidebar}>☰</button>{tabs.tabs.map((tab, index) => <div className="rd-session-tab" key={tab.id} data-active={tabs.activeTabId === tab.id} data-status={tabStatus[tab.id] ?? 'idle'} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); requestCloseTab(tab.id); } }}><button id={`${tab.id}-tab`} role="tab" aria-controls={`${tab.id}-panel`} aria-selected={tabs.activeTabId === tab.id} tabIndex={tabs.activeTabId === tab.id ? 0 : -1} onKeyDown={(event) => tabKeyDown(event, index)} onClick={() => activateTab(tab.id)}><span className={`rd-tab-led rd-tab-led--${tabStatus[tab.id] ?? 'idle'}`} aria-hidden="true" />{tab.label}</button><button className="close" aria-label={`${tab.label} 닫기`} onClick={() => requestCloseTab(tab.id)}>×</button></div>)}<span className="rd-tabs-hint">호스트를 누르면 열기 · ＋ 추가 탭</span></div>
        <div className="rd-workspace-stack">{tabs.tabs.length === 0 && <div className="rd-welcome"><div className="rd-welcome-icon">⌘</div><h1>{welcome.title}</h1><p>{welcome.body}</p>{catalogState === 'ready' && welcomeHosts.length > 0 && <ul className="rd-welcome-hosts" aria-label="호스트 바로 열기">{welcomeHosts.map((host) => <li key={host.id}><button className="rd-host-card" onClick={() => openHost(host)}><span className="rd-host-led rd-host-led--idle" aria-hidden="true" /><span className="rd-host-card-copy"><strong>{host.name}</strong><small>{host.username}@{host.hostname}:{host.port}</small></span></button></li>)}</ul>}<div className="rd-welcome-actions">{welcome.action && <button className={welcomeHosts.length > 0 ? '' : 'primary'} onClick={() => setModalHost(null)}>{welcome.action}</button>}{catalogState === 'error' && <button className="primary" onClick={() => void refreshCatalog()}>다시 시도</button>}</div></div>}{client && tabs.tabs.map((tab) => { const host = hosts.find((item) => item.id === tab.hostId); return host ? <WorkspacePane key={tab.id} tab={tab} host={host} client={client} active={tabs.activeTabId === tab.id} onStatus={reportTabStatus} onSessionId={reportSessionId} fontSize={fontSize} onFontStep={stepFont} containerWidth={layout === 'desktop' ? Math.max(0, rootWidth - (sidebarHidden ? 0 : HOST_LIST_WIDTH)) : rootWidth} isMobile={layout === 'mobile'} /> : null; })}</div>
      </section></main>
    {folderRename && <Dialog small label="폴더 이름 변경" onCancel={() => setFolderRename(null)}><form onSubmit={(event) => { event.preventDefault(); void submitFolderRename(); }}><label>폴더 이름<input aria-label="폴더 이름" value={folderRename.value} maxLength={40} onChange={(event) => setFolderRename((current) => current ? { ...current, value: event.target.value } : current)} /></label><p className="rd-form-note">같은 이름의 폴더가 이미 있으면 하나로 합쳐집니다.</p><div className="rd-modal-actions"><button type="button" onClick={() => setFolderRename(null)}>취소</button><button className="primary" type="submit" disabled={!normalizeFolderName(folderRename.value)}>변경</button></div></form></Dialog>}
    {closeConfirm && <Dialog small label="세션 종료 확인" onCancel={() => setCloseConfirm(null)}><p><strong>{closeConfirm.label}</strong> 탭을 닫으면 연결된 SSH 세션이 종료되고, 실행 중인 작업도 함께 끝납니다.</p><div className="rd-modal-actions"><button onClick={() => setCloseConfirm(null)}>취소</button><button className="danger" onClick={() => { const index = tabs.tabs.findIndex((item) => item.id === closeConfirm.tabId); setCloseConfirm(null); if (index >= 0) closeTab(closeConfirm.tabId, index); }}>세션 종료</button></div></Dialog>}
    {modalHost !== undefined && <HostModal key={modalHost?.id ?? 'new'} host={modalHost} credentials={credentials} folders={allFolders} busy={modalBusy} error={modalError} onCancel={() => setModalHost(undefined)} onSave={saveHost} />}
  </div>;
}
