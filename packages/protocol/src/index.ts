export type WsMessageType =
  | 'output'
  | 'input'
  | 'resize'
  | 'scrollback'
  | 'viewer_joined'
  | 'viewer_left'
  | 'status'
  | 'ping'
  | 'pong'
  | 'error';

export interface WsMessage {
  type: WsMessageType;
  ts: string;
  data: Record<string, unknown>;
}

export interface WsInputMessage {
  type: 'input';
  ts: string;
  data: { data: string };
}

export interface WsOutputMessage {
  type: 'output';
  ts: string;
  data: { data: string };
}

export interface WsResizeMessage {
  type: 'resize';
  ts: string;
  data: { rows: number; cols: number };
}

export interface WsScrollbackMessage {
  type: 'scrollback';
  ts: string;
  data: { data: string };
}

export interface WsStatusMessage {
  type: 'status';
  ts: string;
  data: { status: string; message?: string };
}

export interface WsErrorMessage {
  type: 'error';
  ts: string;
  data: { code: string; message: string };
}

export interface WsViewerJoinedMessage {
  type: 'viewer_joined';
  ts: string;
  data: { viewerId: string; role: string };
}

export interface WsViewerLeftMessage {
  type: 'viewer_left';
  ts: string;
  data: { viewerId: string };
}
