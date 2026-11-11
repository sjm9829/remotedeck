import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Host } from '@remotedeck/types';
import { loadRecent, saveRecent, touchRecent, welcomeRecentHosts } from '../host-recent.js';

const host = (id: string, name = id): Host => ({ id, name, hostname: `${id}.lan`, port: 22, username: 'u', credentialId: null, tags: [], hostKeyFingerprint: null, hostKeyTrusted: true, createdAt: '', updatedAt: '' });

describe('recent hosts', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
    });
  });
  afterEach(() => { Reflect.deleteProperty(globalThis, 'localStorage'); });

  it('keeps only the most recent entries', () => {
    let recent = {};
    for (let i = 0; i < 60; i++) recent = touchRecent(recent, `h${i}`, i);
    expect(Object.keys(recent)).toHaveLength(50);
    expect(recent).toHaveProperty('h59');
    expect(recent).not.toHaveProperty('h0');
  });

  it('round-trips through storage and ignores malformed data', () => {
    saveRecent({ a: 5 });
    expect(loadRecent()).toEqual({ a: 5 });
    localStorage.setItem('remotedeck:recent:v1', '[1,2]');
    expect(loadRecent()).toEqual({});
    localStorage.setItem('remotedeck:recent:v1', '{"a":"x","b":3}');
    expect(loadRecent()).toEqual({ b: 3 });
    localStorage.setItem('remotedeck:recent:v1', 'not json');
    expect(loadRecent()).toEqual({});
  });

  it('shows the 8 most recently used hosts, newest first', () => {
    const hosts = Array.from({ length: 12 }, (_, i) => host(`h${i}`));
    const recent = Object.fromEntries(hosts.map((h, i) => [h.id, i + 1]));
    expect(welcomeRecentHosts(hosts, recent).map((h) => h.id)).toEqual(['h11', 'h10', 'h9', 'h8', 'h7', 'h6', 'h5', 'h4']);
  });

  it('shows only used hosts when fewer than 8 have history, skipping unknown ids', () => {
    const hosts = [host('a'), host('b'), host('c')];
    expect(welcomeRecentHosts(hosts, { b: 9, a: 3, gone: 99 }).map((h) => h.id)).toEqual(['b', 'a']);
  });

  it('falls back to name order when there is no history at all', () => {
    const hosts = [host('1', 'wtr-10'), host('2', 'alpha'), host('3', 'wtr-2')];
    expect(welcomeRecentHosts(hosts, {}).map((h) => h.name)).toEqual(['alpha', 'wtr-2', 'wtr-10']);
    expect(welcomeRecentHosts(hosts, { gone: 5 }).map((h) => h.name)).toEqual(['alpha', 'wtr-2', 'wtr-10']);
  });

  it('breaks timestamp ties by name and does not mutate its input', () => {
    const hosts = [host('b', 'beta'), host('a', 'alpha')];
    const copy = [...hosts];
    expect(welcomeRecentHosts(hosts, { a: 1, b: 1 }).map((h) => h.id)).toEqual(['a', 'b']);
    expect(hosts).toEqual(copy);
  });
});
