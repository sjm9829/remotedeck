// Host list ordering, live-connection summary and small host-form helpers (DOM-free).

import type { Host } from '@remotedeck/types';

export type TabLiveStatus = 'idle' | 'connecting' | 'connected' | 'error';
export interface HostLive { status: TabLiveStatus; count: number }

/** Name ascending (case-insensitive, digits compared numerically: `host2` before `host10`); id breaks ties so the order is stable. */
export function sortHosts<T extends Pick<Host, 'id' | 'name'>>(hosts: readonly T[]): T[] {
  return [...hosts].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id));
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
