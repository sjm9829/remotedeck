// Host list ordering, live-connection summary and small host-form helpers (DOM-free).

import type { Host } from '@remotedeck/types';

export type TabLiveStatus = 'idle' | 'connecting' | 'connected' | 'error';
export interface HostLive { status: TabLiveStatus; count: number }

const RECENT_KEY = 'remotedeck:recent:v1';
const RECENT_LIMIT = 50;

export type RecentMap = Record<string, number>;

export function loadRecent(): RecentMap {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: RecentMap = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) if (typeof value === 'number' && Number.isFinite(value)) out[id] = value;
    return out;
  } catch {
    return {};
  }
}

export function saveRecent(recent: RecentMap): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* preference only */ }
}

/** Record that a host was opened now; keeps only the most recent entries. */
export function touchRecent(recent: RecentMap, hostId: string, now: number): RecentMap {
  const next = { ...recent, [hostId]: now };
  const ids = Object.keys(next);
  if (ids.length <= RECENT_LIMIT) return next;
  ids.sort((a, b) => next[b] - next[a]);
  return Object.fromEntries(ids.slice(0, RECENT_LIMIT).map((id) => [id, next[id]]));
}

/** Hosts with an open tab first, then most recently opened, then alphabetical. */
export function sortHosts(hosts: readonly Host[], openIds: ReadonlySet<string>, recent: RecentMap): Host[] {
  return [...hosts].sort((a, b) => {
    const openDiff = Number(openIds.has(b.id)) - Number(openIds.has(a.id));
    if (openDiff) return openDiff;
    const recentDiff = (recent[b.id] ?? 0) - (recent[a.id] ?? 0);
    if (recentDiff) return recentDiff;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

const STATUS_RANK: Record<TabLiveStatus, number> = { error: 0, idle: 1, connecting: 2, connected: 3 };

/** Per-host summary of its open tabs: the "best" live status (connected > connecting > idle) and the tab count. */
export function hostLiveStates(tabs: readonly { id: string; hostId: string }[], status: Readonly<Record<string, TabLiveStatus>>): Map<string, HostLive> {
  const out = new Map<string, HostLive>();
  for (const tab of tabs) {
    const tabStatus = status[tab.id] ?? 'idle';
    const current = out.get(tab.hostId);
    if (!current) out.set(tab.hostId, { status: tabStatus, count: 1 });
    else out.set(tab.hostId, { status: STATUS_RANK[tabStatus] > STATUS_RANK[current.status] ? tabStatus : current.status, count: current.count + 1 });
  }
  return out;
}

/** Closing a tab ends its SSH session; only a live or starting session deserves a confirmation. */
export function needsCloseConfirm(status: TabLiveStatus | undefined): boolean {
  return status === 'connected' || status === 'connecting';
}

export function hasArchivedTag(tags: string): boolean {
  return tags.split(',').some((tag) => tag.trim().toLocaleLowerCase() === 'archived');
}

/** Add or remove the `archived` tag in the comma-separated tag field, keeping the user's other tags. */
export function setArchivedTag(tags: string, archived: boolean): string {
  const parts = tags.split(',').map((tag) => tag.trim()).filter(Boolean).filter((tag) => tag.toLocaleLowerCase() !== 'archived');
  if (archived) parts.push('archived');
  return parts.join(', ');
}
