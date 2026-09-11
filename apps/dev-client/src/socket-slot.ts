// Socket lifecycle helper (extracted from <App/> for testability).
//
// The terminal WebSocket must be owned by exactly one slot. When the user
// switches hosts, creates/replaces a session, or reattaches, the previous
// socket must be fully closed (handlers detached + close()) BEFORE a new one is
// adopted — otherwise a stale socket keeps mutating component state through its
// onclose/onmessage closures. These helpers make that invariant explicit and
// unit-testable without a DOM.

/** The subset of `WebSocket` this module touches. Kept structural so the
 *  browser `WebSocket` is assignable and tests can inject a fake. */
export interface DetachableSocket {
  close(): void;
  onopen: unknown;
  onmessage: unknown;
  onclose: unknown;
  onerror: unknown;
}

/** A mutable holder shaped like a React `useRef`. */
export interface RefLike<T> {
  current: T | null;
}

/**
 * Detach every event handler and close the socket. Nulling the handlers first
 * guarantees a closing socket cannot fire onclose/onmessage into (stale)
 * component state. Safe to call on an already-closed socket.
 */
export function closeSocketHandle(ws: DetachableSocket | null): void {
  if (!ws) return;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  try {
    ws.close();
  } catch {
    /* already closed */
  }
}

/**
 * Adopt `ws` as the slot's socket, guaranteeing the previous socket (if any) is
 * closed first. Re-adopting the *same* socket is a no-op. This is the only safe
 * way to store a new socket: it never leaves a live socket behind.
 */
export function adoptSocket(ref: RefLike<DetachableSocket>, ws: DetachableSocket): void {
  const prev = ref.current;
  ref.current = ws;
  if (prev && prev !== ws) closeSocketHandle(prev);
}

/**
 * Close and clear the socket held in `ref` (used on detach, host change and
 * unmount). Idempotent: a second call with an empty slot does nothing.
 */
export function closeSocketRef(ref: RefLike<DetachableSocket>): void {
  const cur = ref.current;
  ref.current = null;
  closeSocketHandle(cur);
}
