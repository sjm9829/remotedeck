import { describe, expect, it } from 'vitest';
import type { Host } from '@remotedeck/types';
import { hasArchivedTag, hostLiveStates, needsCloseConfirm, setArchivedTag, sortHosts } from '../host-order.js';

const host = (id: string, name: string): Host => ({ id, name, hostname: `${id}.lan`, port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: null, hostKeyTrusted: true, createdAt: '', updatedAt: '' });
const hosts = [host('c', 'charlie'), host('a', 'alpha'), host('b', 'bravo')];

describe('host ordering', () => {
  it('sorts by name ascending, ignoring case and comparing digits numerically', () => {
    const list = [host('1', 'wtr-10'), host('2', 'Alpha'), host('3', 'wtr-2'), host('4', 'beta'), host('5', 'k6-main')];
    expect(sortHosts(list).map((h) => h.name)).toEqual(['Alpha', 'beta', 'k6-main', 'wtr-2', 'wtr-10']);
  });
  it('is stable for equal names and does not mutate its input', () => {
    const list = [host('b', 'same'), host('a', 'same')];
    const copy = [...list];
    expect(sortHosts(list).map((h) => h.id)).toEqual(['a', 'b']);
    expect(list).toEqual(copy);
  });
  it('is not affected by connection state', () => {
    expect(sortHosts(hosts).map((h) => h.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('live host status', () => {
  const tabs = [{ id: 't1', hostId: 'a' }, { id: 't2', hostId: 'a' }, { id: 't3', hostId: 'b' }];
  it('summarizes the best status and tab count per host', () => {
    const live = hostLiveStates(tabs, { t1: 'connecting', t2: 'connected', t3: 'error' });
    expect(live.get('a')).toEqual({ status: 'connected', count: 2 });
    expect(live.get('b')).toEqual({ status: 'error', count: 1 });
    expect(live.get('z')).toBeUndefined();
  });
  it('treats unknown tabs as idle', () => {
    expect(hostLiveStates(tabs, {}).get('a')).toEqual({ status: 'idle', count: 2 });
  });
  it('asks for confirmation only when closing a live or starting session', () => {
    expect(needsCloseConfirm('connected')).toBe(true);
    expect(needsCloseConfirm('connecting')).toBe(true);
    expect(needsCloseConfirm('idle')).toBe(false);
    expect(needsCloseConfirm('error')).toBe(false);
    expect(needsCloseConfirm(undefined)).toBe(false);
  });
});

describe('archive tag helpers', () => {
  it('adds and removes the tag without touching others', () => {
    expect(setArchivedTag('homelab, storage', true)).toBe('homelab, storage, archived');
    expect(setArchivedTag('homelab, Archived', false)).toBe('homelab');
    expect(setArchivedTag('', true)).toBe('archived');
    expect(setArchivedTag('archived', true)).toBe('archived');
  });
  it('detects the tag case-insensitively', () => {
    expect(hasArchivedTag('a, ARCHIVED')).toBe(true);
    expect(hasArchivedTag('a, b')).toBe(false);
    expect(hasArchivedTag('')).toBe(false);
  });
});
