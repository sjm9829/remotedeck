import { describe, expect, it, vi } from 'vitest';
import type { Host } from '@remotedeck/types';

vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));

const hosts: Host[] = [
  { id: 'k6', name: 'K6', hostname: '10.0.0.6', port: 22, username: 'operator', credentialId: null, tags: ['compute'], hostKeyFingerprint: null, hostKeyTrusted: false, createdAt: '', updatedAt: '' },
  { id: 'wtr', name: 'WTR Pro', hostname: 'wtr.internal', port: 2201, username: 'admin', credentialId: null, tags: ['storage'], hostKeyFingerprint: 'SHA256:x', hostKeyTrusted: true, createdAt: '', updatedAt: '' },
];

describe('host sidebar search', () => {
  it('matches name, address, username, and tags case-insensitively', async () => {
    const { filterHosts } = await import('../App.js');
    expect(filterHosts(hosts, 'wtr')).toEqual([hosts[1]]);
    expect(filterHosts(hosts, '10.0.0')).toEqual([hosts[0]]);
    expect(filterHosts(hosts, 'ADMIN')).toEqual([hosts[1]]);
    expect(filterHosts(hosts, 'compute')).toEqual([hosts[0]]);
    expect(filterHosts(hosts, '   ')).toEqual(hosts);
  });

  it('hides archived hosts by default and searches them only when explicitly shown', async () => {
    const { archiveToggleLabel, filterHosts, isArchivedHost } = await import('../App.js');
    const archived = { ...hosts[0], id: 'archived', name: 'old K6', tags: ['archived', 'duplicate'] };
    expect(isArchivedHost(archived)).toBe(true);
    expect(filterHosts([...hosts, archived], '')).not.toContainEqual(archived);
    expect(filterHosts([...hosts, archived], 'old')).toEqual([]);
    expect(filterHosts([...hosts, archived], 'old', true)).toEqual([archived]);
    expect(archiveToggleLabel(1, false)).toBe('보관됨 1개 표시');
    expect(archiveToggleLabel(1, true)).toBe('보관됨 1개 숨기기');
  });
});
