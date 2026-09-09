import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { SessionManager, Attachment } from '@remotedeck/core/session/manager';
import type { TicketStore } from '@remotedeck/core/ticket';
import { WS_SUBPROTOCOL_PREFIX, type WsMessage } from '@remotedeck/protocol';

export function attachWebSocketServer(app: FastifyInstance, deps: { manager: SessionManager; ticketStore: TicketStore }): () => WebSocketServer {
  const { manager, ticketStore } = deps;

  const wss = new WebSocketServer({
    noServer: true,
    // Echo back the offered remotedeck subprotocol so browser handshakes succeed.
    handleProtocols: (protocols: Set<string>) => {
      for (const p of protocols) if (p.startsWith(WS_SUBPROTOCOL_PREFIX)) return p;
      return false;
    },
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const info = (req as any).__remotedeck as { sessionId: string; role: 'writer' | 'viewer' } | undefined;
    if (!info) { ws.close(1008, 'unauthorized'); return; }
    const attachment: Attachment = {
      id: req.socket.remotePort?.toString() ?? Math.random().toString(36).slice(2),
      role: info.role,
      send: (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
      close: (code, reason) => { try { ws.close(code, reason); } catch {} },
    };
    try {
      manager.attach(info.sessionId, attachment);
    } catch (e: any) {
      ws.send(JSON.stringify({ type: 'error', ts: new Date().toISOString(), data: { code: e.code ?? 'error', message: e.message } }));
      ws.close(1008, e.code ?? 'error');
      return;
    }
    ws.on('message', (raw: Buffer) => {
      let msg: WsMessage; try { msg = JSON.parse(raw.toString()); } catch { return; }
      try {
        if (msg.type === 'input') manager.input(attachment.id, (msg.data as any).data ?? '');
        else if (msg.type === 'resize') manager.resize(attachment.id, (msg.data as any).rows, (msg.data as any).cols);
        else if (msg.type === 'detach') manager.detach(attachment.id);
        else if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString(), data: {} }));
      } catch (e: any) {
        ws.send(JSON.stringify({ type: 'error', ts: new Date().toISOString(), data: { code: e.code ?? 'error', message: e.message } }));
      }
    });
    ws.on('close', () => { try { manager.detach(attachment.id); } catch {} });
  });

  return () => {
    app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      if (!url.pathname.startsWith('/ws/sessions/')) return; // let other upgrade handlers pass
      const sessionId = url.pathname.split('/').filter(Boolean).pop() ?? '';
      const protos = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const ticketProto = protos.find((p) => p.startsWith(WS_SUBPROTOCOL_PREFIX));
      const ticket = ticketProto ? ticketProto.slice(WS_SUBPROTOCOL_PREFIX.length) : null;
      const redeemed = ticket ? ticketStore.redeem(ticket) : null;
      if (!redeemed || redeemed.sessionId !== sessionId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      (req as any).__remotedeck = { sessionId, role: redeemed.role };
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    return wss;
  };
}
