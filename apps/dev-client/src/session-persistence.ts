// sessionStorage-backed persistence for workspace tab layout.
//
// Credentials and tokens are NEVER stored; only the structural tab state needed
// to re-create tabs and auto-reconnect on page reload. The opaque SSH session id
// is kept so a reload re-attaches to the still-running server session (the server
// keeps detached sessions and replays scrollback) instead of leaking it and
// starting a fresh shell. The id grants nothing by itself: attaching still needs
// an authenticated ws-ticket.

export interface PersistedTab {
  id: string;
  hostId: string;
  label: string;
  /** Last known live SSH session id for this tab, if any. */
  sessionId?: string;
}

export interface PersistedTabState {
  tabs: PersistedTab[];
  activeTabId: string | null;
}

const STORAGE_KEY = "remotedeck:tabs:v1";

export function saveTabState(state: PersistedTabState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage quota exceeded or private browsing: ignore, non-critical.
  }
}

export function loadTabState(): PersistedTabState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.tabs) || !parsed.tabs.every(isValidTab)) return null;
    return { tabs: parsed.tabs, activeTabId: parsed.activeTabId ?? null };
  } catch {
    return null;
  }
}

export function clearTabState(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function isValidTab(t: unknown): t is PersistedTab {
  if (typeof t !== "object" || t === null) return false;
  const obj = t as Record<string, unknown>;
  return typeof obj.id === "string" && typeof obj.hostId === "string" && typeof obj.label === "string"
    && (obj.sessionId === undefined || typeof obj.sessionId === "string");
}
