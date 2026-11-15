import type { RealtimeEvent } from '@aminchat/shared';
import { getToken, http, wsUrl } from './api';
import { createStore } from './store';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting';
type Listener = (ev: RealtimeEvent) => void;
type SocketFactory = (url: string) => WebSocket;

/**
 * One WebSocket per signed-in user (UserHub Durable Object).
 *   1. POST /api/realtime/ticket (authenticated)  → short-lived single-use ticket;
 *   2. open /api/realtime/ws?ticket=…             → server pushes RealtimeEvents as JSON;
 *   3. send "ping" every 25 s (answered by the hub without waking it); reconnect with exponential back-off + jitter.
 * After EVERY reconnect `onResync` listeners run, so screens refetch whatever they missed while offline.
 */
export class RealtimeClient {
  readonly state = createStore<ConnectionState>('idle');
  private listeners = new Set<Listener>();
  private resyncs = new Set<() => void>();
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private running = false;
  private hasConnectedBefore = false;
  private generation = 0;

  constructor(
    private readonly makeSocket: SocketFactory = (url) => new WebSocket(url),
    private readonly getTicket: () => Promise<string> = async () => (await http.post<{ ticket: string }>('/api/realtime/ticket')).ticket,
    private readonly pingMs = 25_000,
  ) {}

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onResync(fn: () => void): () => void {
    this.resyncs.add(fn);
    return () => this.resyncs.delete(fn);
  }

  /** Fire-and-forget message to the hub (typing indicators). Returns false when the socket is not open. */
  send(payload: Record<string, unknown>): boolean {
    try {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify(payload));
        return true;
      }
    } catch {
      // the close handler reconnects
    }
    return false;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempts = 0;
    this.hasConnectedBefore = false;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.nudge);
      document.addEventListener('visibilitychange', this.nudge);
    }
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.nudge);
      document.removeEventListener('visibilitychange', this.nudge);
    }
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'client stop');
    } catch {
      // already closed
    }
    this.state.set('idle');
  }

  /** The tab became visible / the network came back: reconnect now instead of waiting for the back-off timer. */
  private nudge = (): void => {
    if (!this.running) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (this.ws && this.ws.readyState <= 1) return; // connecting or open
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.connect();
  };

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = null;
    this.retryTimer = null;
  }

  private async connect(): Promise<void> {
    if (!this.running || !getToken()) return;
    const gen = ++this.generation;
    this.state.set(this.hasConnectedBefore ? 'reconnecting' : 'connecting');
    let ticket: string;
    try {
      ticket = await this.getTicket();
    } catch {
      if (gen === this.generation) this.scheduleRetry();
      return;
    }
    if (gen !== this.generation || !this.running) return;
    let ws: WebSocket;
    try {
      ws = this.makeSocket(wsUrl(`/api/realtime/ws?ticket=${encodeURIComponent(ticket)}`));
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.generation) return;
      this.attempts = 0;
      this.state.set('open');
      const reconnect = this.hasConnectedBefore;
      this.hasConnectedBefore = true;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        try {
          if (ws.readyState === 1) ws.send('ping');
        } catch {
          // the close handler will reconnect
        }
      }, this.pingMs);
      if (reconnect) this.resyncs.forEach((fn) => safe(fn));
    };
    ws.onmessage = (e: MessageEvent) => {
      if (gen !== this.generation) return;
      if (typeof e.data !== 'string' || e.data === 'pong') return;
      let ev: RealtimeEvent;
      try {
        ev = JSON.parse(e.data) as RealtimeEvent;
      } catch {
        return;
      }
      if (!ev || typeof ev.type !== 'string') return;
      this.listeners.forEach((l) => safe(() => l(ev)));
    };
    const lost = () => {
      if (gen !== this.generation) return;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      if (this.running) this.scheduleRetry();
    };
    ws.onclose = lost;
    ws.onerror = () => {
      // an error is always followed by close; nothing to do here
    };
  }

  private scheduleRetry(): void {
    if (!this.running) return;
    this.state.set('reconnecting');
    const base = Math.min(20_000, 800 * 2 ** this.attempts++);
    const delay = base / 2 + Math.random() * (base / 2);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error('realtime listener failed', err);
  }
}

export const realtime = new RealtimeClient();
