import { describe, expect, it, vi } from 'vitest';
import { persistHost } from '../host-save.js';

const host = { id: 'h1' } as any;
const credential = { id: 'c-new' } as any;

describe('credential creation and host binding', () => {
  it('creates the credential first and binds its id to a new host', async () => {
    const client = { createCredential: vi.fn().mockResolvedValue(credential), createHost: vi.fn().mockResolvedValue(host), updateHost: vi.fn() };
    await persistHost(client, null, { name: 'K6', hostname: 'k6', user: 'operator' }, { name: 'K6 password', type: 'password', secret: 'once' });
    expect(client.createCredential).toHaveBeenCalledWith({ name: 'K6 password', type: 'password', secret: 'once' });
    expect(client.createHost).toHaveBeenCalledWith({ name: 'K6', hostname: 'k6', user: 'operator', credentialId: 'c-new' });
    expect(client.updateHost).not.toHaveBeenCalled();
  });

  it('binds the created credential when editing without mutating the original host body', async () => {
    const client = { createCredential: vi.fn().mockResolvedValue(credential), createHost: vi.fn(), updateHost: vi.fn().mockResolvedValue(host) };
    const body = { name: 'WTR', hostname: 'wtr', user: 'operator', credentialId: 'old' };
    await persistHost(client, 'h1', body, { name: 'new key', type: 'key', secret: 'private-key' });
    expect(client.updateHost).toHaveBeenCalledWith('h1', { ...body, credentialId: 'c-new' });
    expect(body.credentialId).toBe('old');
  });
});
