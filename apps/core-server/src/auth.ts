import { timingSafeEqual, createHash } from 'node:crypto';

/** Constant-time comparison of two tokens (hashed to fixed length first). */
export function constantTimeTokenEquals(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Extract a bearer token from an Authorization header, or null. */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1] : null;
}
