// Short-lived, single-use WebSocket tickets. Issued via REST (authenticated),
// redeemed on the WS handshake via the Sec-WebSocket-Protocol subprotocol so the
// long-lived API token is never placed in the URL (logs/history exposure).
import { randomBytes } from 'node:crypto';

export interface Ticket { value: string; sessionId: string; role: 'writer' | 'viewer'; expiresAt: number; used: boolean; }

export class TicketStore {
  private tickets = new Map<string, Ticket>();
  constructor(private readonly defaultTtlMs = 30_000) {}

  issue(sessionId: string, role: 'writer' | 'viewer', ttlMs = this.defaultTtlMs): Ticket {
    const value = randomBytes(16).toString('hex');
    const t: Ticket = { value, sessionId, role, expiresAt: Date.now() + ttlMs, used: false };
    this.tickets.set(value, t);
    return t;
  }

  /** Redeem a ticket. Returns the ticket on success; null if unknown, expired, or already used. */
  redeem(value: string): Ticket | null {
    const t = this.tickets.get(value);
    if (!t) return null;
    if (t.used) return null;                 // single-use
    if (Date.now() >= t.expiresAt) { this.tickets.delete(value); return null; } // expired
    t.used = true;
    return t;
  }

  revoke(value: string): boolean { return this.tickets.delete(value); }
}
