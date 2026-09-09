// Shared WebSocket + domain protocol types for RemoteDeck.

export type SessionState =
  | 'creating'
  | 'awaiting-trust'
  | 'connecting'
  | 'active'
  | 'detached'
  | 'closing'
  | 'closed'
  | 'failed';

// --- WebSocket wire messages -------------------------------------------------

// Client -> server
export type WsClientType = 'attach' | 'input' | 'resize' | 'detach' | 'ping';
// Server -> client
export type WsServerType = 'output' | 'status' | 'error' | 'scrollback' | 'viewer_joined' | 'viewer_left' | 'pong';

export interface WsMessage {
  type: string;
  ts: string;
  data: Record<string, unknown>;
}

export interface WsAttachMessage { type: 'attach'; ts: string; data: { role: 'writer' | 'viewer' } }
export interface WsInputMessage { type: 'input'; ts: string; data: { data: string } }
export interface WsResizeMessage { type: 'resize'; ts: string; data: { rows: number; cols: number } }
export interface WsDetachMessage { type: 'detach'; ts: string; data: Record<string, never> }
export interface WsPingMessage { type: 'ping'; ts: string; data: Record<string, never> }

export interface WsOutputMessage { type: 'output'; ts: string; data: { data: string } }
export interface WsScrollbackMessage { type: 'scrollback'; ts: string; data: { data: string } }
export interface WsStatusMessage { type: 'status'; ts: string; data: { status: SessionState; message?: string } }
export interface WsErrorMessage { type: 'error'; ts: string; data: { code: string; message: string } }
export interface WsViewerJoinedMessage { type: 'viewer_joined'; ts: string; data: { viewerId: string } }
export interface WsViewerLeftMessage { type: 'viewer_left'; ts: string; data: { viewerId: string } }
export interface WsPongMessage { type: 'pong'; ts: string; data: Record<string, never> }

// The single-use WS ticket presented via the Sec-WebSocket-Protocol subprotocol
// (never via URL query, which can leak into logs/history).
export const WS_SUBPROTOCOL_PREFIX = 'remotedeck.v1.';
