// sessionStorage-backed persistence for workspace tab layout.
//
// Credentials and tokens are NEVER stored; only the structural tab state needed
// to re-create tabs and auto-reconnect on page reload. Session IDs from the
// previous page are discarded because WebSocket connections are lost on reload.

export interface PersistedTab {
  id: string;
  hostId: string;
  label: string;
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
  return typeof obj.id === "string" && typeof obj.hostId === "string" && typeof obj.label === "string";
}
