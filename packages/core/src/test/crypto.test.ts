import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, serializePayload, deserializePayload } from '../crypto.js';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 32 bytes hex

describe('crypto', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const plaintext = 'ssh-rsa AAAAB3NzaC1yc2E... testkey';
    const payload = encrypt(plaintext, TEST_KEY);
    const decrypted = decrypt(payload, TEST_KEY);
    assert.equal(decrypted, plaintext);
  });

  it('serialize/deserialize preserves payload', () => {
    const plaintext = 'super-secret-password-123';
    const payload = encrypt(plaintext, TEST_KEY);
    const buf = serializePayload(payload);
    const restored = deserializePayload(buf);
    const decrypted = decrypt(restored, TEST_KEY);
    assert.equal(decrypted, plaintext);
  });

  it('rejects wrong key', () => {
    const plaintext = 'test';
    const payload = encrypt(plaintext, TEST_KEY);
    const wrongKey = 'ff23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    assert.throws(() => decrypt(payload, wrongKey));
  });

  it('rejects tampered ciphertext', () => {
    const plaintext = 'test';
    const payload = encrypt(plaintext, TEST_KEY);
    payload.ciphertext[0] ^= 0xff;
    assert.throws(() => decrypt(payload, TEST_KEY));
  });

  it('rejects short buffer on deserialize', () => {
    assert.throws(() => deserializePayload(Buffer.alloc(10)));
  });
});
