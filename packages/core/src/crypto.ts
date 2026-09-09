import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits auth tag

export interface EncryptedPayload {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * masterKey must be a 32-byte hex-encoded string (from REMOTEDECK_MASTER_KEY env).
 */
export function encrypt(plaintext: string, masterKeyHex: string): EncryptedPayload {
  const key = Buffer.from(masterKeyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('Master key must be 32 bytes (64 hex chars)');
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, ciphertext };
}

/**
 * Decrypt an EncryptedPayload back to plaintext.
 */
export function decrypt(payload: EncryptedPayload, masterKeyHex: string): string {
  const key = Buffer.from(masterKeyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('Master key must be 32 bytes (64 hex chars)');
  }
  const decipher = createDecipheriv(ALGO, key, payload.iv);
  decipher.setAuthTag(payload.tag);
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Serialize EncryptedPayload to a single buffer for DB storage.
 * Format: [12-byte IV][16-byte tag][ciphertext...]
 */
export function serializePayload(payload: EncryptedPayload): Buffer {
  return Buffer.concat([payload.iv, payload.tag, payload.ciphertext]);
}

/**
 * Deserialize a stored buffer back into an EncryptedPayload.
 */
export function deserializePayload(buf: Buffer): EncryptedPayload {
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Encrypted payload too short');
  }
  return {
    iv: buf.subarray(0, IV_LENGTH),
    tag: buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH),
    ciphertext: buf.subarray(IV_LENGTH + TAG_LENGTH),
  };
}
