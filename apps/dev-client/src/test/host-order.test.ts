import { describe, expect, it } from 'vitest';
import type { Host } from '@remotedeck/types';
import { hasArchivedTag, hostLiveStates, needsCloseConfirm, setArchivedTag, sortHosts, touchRecent } from '../host-order.js';

const host = (id: string, name: string): Host => ({ id, name, hostname: `${id}.lan`, port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: null, hostKeyTrusted: true, createdAt: '', updatedAt: '' });
const hosts = [host('c', 'charlie'), host('a', 'alpha'), host('b', 'bravo')];

describe('host ordering', () => {
  it('puts open hosts first, then recent, then alphabetical', () => {
    expect(sortHosts(hosts, new Set(), {}).map((h) => h.id)).toEqual(['a', 'b', 'c']);
    expect(sortHosts(hosts, new Set(), { c: 5, b: 9 }).map((h) => h.id)).toEqual(['b', 'c', 'a']);
    expect(sortHosts(hosts, new Set(['c']), { b: 9 }).map((h) => h.id)).toEqual(['c', 'b', 'a']);
  });
  it('does not mutate its input', () => {
    const copy = [...hosts];
    sortHosts(hosts, new Set(['c']), {});
    expect(hosts).toEqual(copy);
  });
  it('keeps only the most recent entries', () => {
    let recent = {};
    for (let i = 0; i < 60; i++) recent = touchRecent(recent, `h${i}`, i);
    expect(Object.keys(recent)).toHaveLength(50);
    expect(recent).toHaveProperty('h59');
    expect(recent).not.toHaveProperty('h0');
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
