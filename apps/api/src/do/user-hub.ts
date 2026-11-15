import { DurableObject } from 'cloudflare:workers';
import type { RealtimeEvent } from '@aminchat/shared';
import { sha256Hex, randomToken } from '../lib/crypto';
import type { Env } from '../env';

interface Attachment {
  userId: string;
}

const TICKET_TTL_MS = 60_000;

/**
 * One Durable Object per user. Holds all of the user's live WebSocket connections (web tabs, Android app)
 * using the hibernation API, and fans events out to them: new messages, AI streaming deltas, task steps,
 * approvals, typing indicators …
 *
 * Connections are authenticated with a short-lived, single-use ticket (see POST /api/realtime/ticket), so the
 * long-lived bearer token is never placed in a URL.
 */
export class UserHub extends DurableObject<Env> {
  private lastTyping = new Map<string, number>();

  // ------------------------------------------------------------------ RPC (called from the Worker / other DOs)

  async issueTicket(userId: string): Promise<string> {
    await this.ctx.storage.put('userId', userId);
    // Format: "<userId>.<secret>" — the Worker routes the upgrade to the user's Durable Object using the prefix.
    const ticket = `${userId}.${randomToken(24)}`;
    const hash = await sha256Hex(ticket);
    await this.ctx.storage.put(`t:${hash}`, Date.now() + TICKET_TTL_MS);
    // Opportunistic cleanup of expired tickets.
    const all = await this.ctx.storage.list<number>({ prefix: 't:' });
    const now = Date.now();
    const expired = [...all.entries()].filter(([, exp]) => exp < now).map(([k]) => k);
    if (expired.length) await this.ctx.storage.delete(expired);
    return ticket;
  }

  /** Broadcast to every live connection. Returns the number of sockets reached. */
  async publish(events: RealtimeEvent | RealtimeEvent[]): Promise<number> {
    const list = Array.isArray(events) ? events : [events];
    const sockets = this.ctx.getWebSockets();
    let delivered = 0;
    for (const ws of sockets) {
      try {
        for (const ev of list) ws.send(JSON.stringify(ev));
        delivered++;
      } catch {
        // socket is closing; the runtime will call webSocketClose
      }
    }
    return delivered;
  }

  async socketCount(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  // ------------------------------------------------------------------ WebSocket upgrade

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const url = new URL(request.url);
    const ticket = url.searchParams.get('ticket') ?? '';
    const key = `t:${await sha256Hex(ticket)}`;
    const expires = await this.ctx.storage.get<number>(key);
    if (!ticket || !expires || expires < Date.now()) {
      return new Response('Invalid or expired ticket', { status: 401 });
    }
    await this.ctx.storage.delete(key); // single use
    const userId = (await this.ctx.storage.get<string>('userId')) ?? '';
    if (!userId) return new Response('Unknown user', { status: 401 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [userId]);
    server.serializeAttachment({ userId } satisfies Attachment);
    // Keep-alive without waking the object: the client sends the text "ping".
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    server.send(JSON.stringify({ type: 'hello', userId, ts: Date.now() } satisfies RealtimeEvent));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > 2048) return;
    let msg: { type?: string; conversationId?: string };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    if (msg.type === 'typing' && typeof msg.conversationId === 'string') {
      const last = this.lastTyping.get(msg.conversationId) ?? 0;
      if (Date.now() - last < 1500) return;
      this.lastTyping.set(msg.conversationId, Date.now());
      if (this.lastTyping.size > 200) this.lastTyping.clear();
      await this.relayTyping(att.userId, msg.conversationId);
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, 'closing');
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      // already closed
    }
  }

  private async relayTyping(userId: string, conversationId: string): Promise<void> {
    const rows = await this.env.DB.prepare(
      `SELECT user_id FROM conversation_members
       WHERE conversation_id = ?1 AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = ?1 AND user_id = ?2)`,
    )
      .bind(conversationId, userId)
      .all<{ user_id: string }>();
    const others = (rows.results ?? []).map((r) => r.user_id).filter((id) => id !== userId);
    const ev: RealtimeEvent = { type: 'typing', conversationId, userId };
    await Promise.allSettled(others.map((id) => this.env.USER_HUB.get(this.env.USER_HUB.idFromName(id)).publish(ev)));
  }
}
