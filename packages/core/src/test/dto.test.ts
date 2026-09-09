import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Simulate the DTO pattern: API response for credential must not include secret
interface CredentialDto {
  id: string;
  name: string;
  type: string;
  keyPath: string | null;
  createdAt: string;
  updatedAt: string;
  // No secret_encrypted field
}

function toCredentialDto(row: Record<string, unknown>): CredentialDto {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as string,
    keyPath: (row.key_path as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

describe('credential DTO redaction', () => {
  it('excludes secret_encrypted from DTO', () => {
    const row = {
      id: 'cred-1',
      name: 'My Key',
      type: 'key',
      secret_encrypted: Buffer.from('some-encrypted-blob'),
      key_path: '/home/user/.ssh/id_ed25519',
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };
    const dto = toCredentialDto(row);
    assert.equal(dto.id, 'cred-1');
    assert.equal(dto.name, 'My Key');
    assert.ok(!('secret_encrypted' in dto));
    assert.ok(!('secret' in dto));
    const json = JSON.stringify(dto);
    assert.ok(!json.includes('encrypted'));
    assert.ok(!json.includes('blob'));
  });
});
