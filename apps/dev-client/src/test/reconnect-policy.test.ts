import { describe, expect, it } from 'vitest';
import { MAX_AUTO_ATTEMPTS, backoffMs, classifyClose, isReattachableState, isSessionGoneError, isTerminalSessionState } from '../reconnect-policy.js';

describe('reconnect policy', () => {
  it('backs off exponentially and caps at 15s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(backoffMs)).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    expect(backoffMs(-3)).toBe(500);
    expect(MAX_AUTO_ATTEMPTS).toBeGreaterThan(5);
  });
  it('retries network-style closes and writer-lease conflicts', () => {
    expect(classifyClose(1006, '')).toBe('retry');
    expect(classifyClose(1001, 'server shutdown')).toBe('retry');
    expect(classifyClose(1008, 'conflict')).toBe('retry');
    expect(classifyClose(1008, 'unauthorized')).toBe('retry');
  });
  it('stops retrying only when the session itself is gone', () => {
    expect(classifyClose(1008, 'not_found')).toBe('session-gone');
    expect(classifyClose(1008, 'invalid_state')).toBe('session-gone');
    expect(classifyClose(1000, 'closed')).toBe('session-gone');
  });
  it('recognises 404 ticket errors and session states', () => {
    expect(isSessionGoneError('404 {"error":"not_found"}')).toBe(true);
    expect(isSessionGoneError('500 {}')).toBe(false);
    expect(isSessionGoneError('Failed to fetch')).toBe(false);
    expect(isTerminalSessionState('closed')).toBe(true);
    expect(isTerminalSessionState('failed')).toBe(true);
    expect(isTerminalSessionState('detached')).toBe(false);
    expect(isReattachableState('detached')).toBe(true);
    expect(isReattachableState('active')).toBe(true);
    expect(isReattachableState('closed')).toBe(false);
    expect(isReattachableState('awaiting-trust')).toBe(false);
  });
});
