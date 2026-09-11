// Behavioral tests for the socket-slot lifecycle helpers.
//
// These prove the invariant behind defect #1: adopting a new socket must close
// the previous one (handlers detached + close()), host change / detach must
// close and clear the socket, and a closing socket can never fire a handler
// back into component state because close detaches the handlers first.

import { describe, it, expect } from 'vitest';
import { adoptSocket, closeSocketRef, closeSocketHandle, type RefLike } from '../socket-slot.js';

class FakeSocket {
  closed = 0;
  onopen: unknown = null;
  onmessage: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  close() { this.closed++; }
}

function ref(): RefLike<FakeSocket> {
  return { current: null };
}

describe('adoptSocket', () => {
  it('stores a socket in an empty slot without closing anything', () => {
    const r = ref();
    const a = new FakeSocket();
    adoptSocket(r as RefLike<any>, a as any);
    expect(r.current).toBe(a);
    expect(a.closed).toBe(0);
  });

  it('closes the previous socket before adopting a new one (no silent leak)', () => {
    const r = ref();
    const a = new FakeSocket();
    const b = new FakeSocket();
    adoptSocket(r as RefLike<any>, a as any);
    // give `a` handlers that would otherwise keep it "live"
    a.onclose = () => {}; a.onmessage = () => {}; a.onopen = () => {};
    adoptSocket(r as RefLike<any>, b as any);

    expect(r.current).toBe(b);
    expect(a.closed).toBe(1);          // previous socket was closed
    expect(a.onclose).toBeNull();      // handlers detached
    expect(a.onmessage).toBeNull();
    expect(a.onopen).toBeNull();
  });

  it('re-adopting the SAME socket does not close it', () => {
    const r = ref();
    const a = new FakeSocket();
    adoptSocket(r as RefLike<any>, a as any);
    adoptSocket(r as RefLike<any>, a as any);
    expect(r.current).toBe(a);
    expect(a.closed).toBe(0);
  });
});

describe('closeSocketRef', () => {
  it('closes and clears the held socket', () => {
    const r = ref();
    const a = new FakeSocket();
    r.current = a;
    closeSocketRef(r as RefLike<any>);
    expect(r.current).toBeNull();
    expect(a.closed).toBe(1);
  });

  it('is idempotent on an empty slot', () => {
    const r = ref();
    closeSocketRef(r as RefLike<any>);
    closeSocketRef(r as RefLike<any>);
    expect(r.current).toBeNull();
  });

  it('a detached socket cannot fire its onclose into component state', () => {
    let fired = false;
    const r = ref();
    const a = new FakeSocket();
    a.onclose = () => { fired = true; };
    r.current = a;

    closeSocketRef(r as RefLike<any>);
    // Simulate the socket's close event arriving after we closed it.
    (a.onclose as (() => void) | null)?.();

    expect(fired).toBe(false); // handler was nulled before close
  });
});

describe('closeSocketHandle', () => {
  it('nulls all handlers and closes', () => {
    const a = new FakeSocket();
    a.onopen = () => {}; a.onmessage = () => {}; a.onclose = () => {}; a.onerror = () => {};
    closeSocketHandle(a as any);
    expect(a.onopen).toBeNull();
    expect(a.onmessage).toBeNull();
    expect(a.onclose).toBeNull();
    expect(a.onerror).toBeNull();
    expect(a.closed).toBe(1);
  });

  it('swallows a throw from close() (already closed)', () => {
    const a = new FakeSocket();
    a.close = () => { throw new Error('already closed'); };
    expect(() => closeSocketHandle(a as any)).not.toThrow();
  });

  it('is a no-op for null', () => {
    expect(() => closeSocketHandle(null)).not.toThrow();
  });
});
