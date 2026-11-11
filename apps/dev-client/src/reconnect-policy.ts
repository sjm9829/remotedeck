// Pure reconnect policy for the SSH terminal WebSocket.
//
// The server keeps a detached SSH session (and a scrollback ring) alive after a
// WebSocket drops, so a dropped socket is recoverable by re-attaching to the same
// session id. This module decides *whether* and *when* to retry; it owns no timers.

/** Delays (ms) before auto-retry attempt 0,1,2…; the last value repeats. */
const BACKOFF_STEPS_MS = [500, 1000, 2000, 4000, 8000, 15000];

/** After this many consecutive failed attempts the UI stops and offers a button. */
export const MAX_AUTO_ATTEMPTS = 8;

export function backoffMs(attempt: number): number {
  const index = Math.max(0, Math.min(Math.floor(attempt), BACKOFF_STEPS_MS.length - 1));
  return BACKOFF_STEPS_MS[index];
}

export type CloseVerdict = 'retry' | 'session-gone';

/** WebSocket close reasons the server uses when the session itself is unusable. */
const SESSION_GONE_REASONS = new Set(['not_found', 'invalid_state', 'session_not_found', 'not_attachable']);

/**
 * Classify a WebSocket close. Only an explicit "session is gone" signal stops
 * retrying; everything else (network drop 1006, proxy restart 1012/1001, writer
 * lease still held by a half-open socket 'conflict') is worth retrying.
 */
export function classifyClose(code: number, reason: string): CloseVerdict {
  if (code === 1008 && SESSION_GONE_REASONS.has(reason)) return 'session-gone';
  if (code === 1000 && reason === 'closed') return 'session-gone';
  return 'retry';
}

/** REST errors from `wsTicket` look like `404 {...}`; a 404 means the session is gone. */
export function isSessionGoneError(message: string): boolean {
  return /^404\b/.test(message.trim());
}

/** Server-reported session states that can never be re-attached or typed into. */
export function isTerminalSessionState(status: string): boolean {
  return status === 'closed' || status === 'failed';
}

/** Session states a restored tab may re-attach to without creating a new session. */
export function isReattachableState(state: string): boolean {
  return state === 'active' || state === 'detached';
}
