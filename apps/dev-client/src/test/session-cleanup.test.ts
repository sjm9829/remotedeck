import { describe, expect, it, vi } from 'vitest';
import { closeRemoteSessionOnce } from '../session-cleanup.js';

describe('late remote session cleanup', () => {
  it('closes an in-flight session result once after its pane has unmounted', () => {
    const closed = new Set<string>();
    const close = vi.fn(async () => undefined);
    expect(closeRemoteSessionOnce('late-session', closed, close)).toBe(true);
    expect(closeRemoteSessionOnce('late-session', closed, close)).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('absorbs close failure without retrying', async () => {
    const close = vi.fn(() => Promise.reject(new Error('offline')));
    const closed = new Set<string>();
    closeRemoteSessionOnce('late-session', closed, close);
    await Promise.resolve();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    expect(closed.has('late-session')).toBe(true);
  });
});
