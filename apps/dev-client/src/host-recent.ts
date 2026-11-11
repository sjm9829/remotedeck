// "Recently used hosts" bookkeeping for the welcome cards (DOM-free apart from localStorage).

import type { Host } from '@remotedeck/types';
import { sortHosts } from './host-order.js';

// Same key the earlier (since removed) recent-history code used, so existing history carries over.
const RECENT_KEY = 'remotedeck:recent:v1';
const RECENT_STORE_LIMIT = 50;
export const WELCOME_RECENT_LIMIT = 8;

export type RecentMap = Record<string, number>;

export function loadRecent(): RecentMap {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
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
  if (ids.length <= RECENT_STORE_LIMIT) return next;
  ids.sort((a, b) => next[b] - next[a]);
  return Object.fromEntries(ids.slice(0, RECENT_STORE_LIMIT).map((id) => [id, next[id]]));
}

/**
 * The hosts to offer on the welcome screen: the most recently opened ones, newest first.
 * Hosts that no longer exist (or are filtered out of `hosts`) are skipped. With no usable history at all
 * (new browser, cleared storage) it falls back to the first hosts by name so the screen is never empty.
 */
export function welcomeRecentHosts<T extends Pick<Host, 'id' | 'name'>>(hosts: readonly T[], recent: RecentMap, limit = WELCOME_RECENT_LIMIT): T[] {
  const used = hosts.filter((host) => recent[host.id] !== undefined);
  if (used.length === 0) return sortHosts(hosts).slice(0, limit);
  return [...used].sort((a, b) => recent[b.id] - recent[a.id] || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id)).slice(0, limit);
}
