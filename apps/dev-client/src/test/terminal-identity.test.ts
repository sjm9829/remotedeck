import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { terminalIdentity } from '../terminal-identity.js';

describe('terminal lifecycle identity', () => {
  it('does not change when an open host is renamed', () => {
    const before = { id: 'host-1', name: 'K6' };
    const after = { id: 'host-1', name: 'K6 compute' };
    expect(terminalIdentity(before)).toBe(terminalIdentity(after));
  });

  it('changes for a different connection target identity', () => {
    expect(terminalIdentity({ id: 'host-1' })).not.toBe(terminalIdentity({ id: 'host-2' }));
  });

  it('keys the mounted terminal effect only by connection identity', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('const terminalKey = terminalIdentity(host)');
    expect(source).toContain('}, [terminalKey]);');
    expect(source).not.toContain('[host.id, host.name]');
  });
});
