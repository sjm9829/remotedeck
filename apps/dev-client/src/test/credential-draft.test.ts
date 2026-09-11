import { describe, expect, it } from 'vitest';
import { buildCredentialRequest, emptyCredentialDraft } from '../credential-draft.js';

describe('new credential request', () => {
  it('emits only API-supported fields for password, key, and agent credentials', () => {
    expect(buildCredentialRequest({ enabled: true, name: ' pw ', type: 'password', secret: 's3cret' })).toEqual({ name: 'pw', type: 'password', secret: 's3cret' });
    expect(buildCredentialRequest({ enabled: true, name: 'key', type: 'key', secret: 'PRIVATE' })).toEqual({ name: 'key', type: 'key', secret: 'PRIVATE' });
    expect(buildCredentialRequest({ enabled: true, name: 'agent', type: 'agent', secret: 'must-not-leak' })).toEqual({ name: 'agent', type: 'agent' });
    expect(buildCredentialRequest(emptyCredentialDraft())).toBeNull();
  });

  it('rejects missing required secrets without including a submitted secret in the error', () => {
    expect(() => buildCredentialRequest({ enabled: true, name: 'pw', type: 'password', secret: '' })).toThrow('비밀번호');
  });
});
