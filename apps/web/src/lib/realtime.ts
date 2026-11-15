import type { PollResponse, RealtimeEvent } from '@aminchat/shared';
import { getToken, http, request, wsUrl } from './api';
import { pool } from './endpointPool';
import { createStore } from './store';

/**
 *  idle         not started / signed out
 *  connecting   first connection of this session
 *  open         live WebSocket
 *  polling      connected through the long-poll fallback (WebSockets are blocked or keep failing on this network)
 *  reconnecting connection lost; trying again
 */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'polling' | 'reconnecting';
type Listener = (ev: RealtimeEvent) => void;
type SocketFactory = (url: string) => WebSocket;
type Cursor = { epoch: string; seq: number };
export type PollFn = (cursor: Cursor | null, waitSec: number, signal: AbortSignal) => Promise<PollResponse>;

export interface RealtimeOptions {
  pingMs: number;
  /** A socket that has not opened after this long is treated as blocked (a filtered upgrade usually hangs instead of failing). */
  openTimeoutMs: number;
  /** This many sockets in a row that never opened → switch to long polling. */
  wsFailuresBeforePoll: number;
  /** While polling, try a WebSocket again this often and go back to it when it works. */
  wsRetryWhilePollingMs: number;
  pollWaitSec: number;
  /** Minimum time between two polls (bounds the request rate while an answer streams). */
  pollGapMs: number;
  poll: PollFn;
  now: () => number;
}

const defaultPoll: PollFn = (cursor, waitSec, signal) =>
  request<PollResponse>('GET', '/api/realtime/poll', { query: { wait: waitSec, ...(cursor ? { epoch: cursor.epoch, seq: cursor.seq } : {}) }, signal, timeoutMs: (waitSec + 15) * 1000 });

const DEFAULTS: RealtimeOptions = {
  pingMs: 25_000,
  openTimeoutMs: 8_000,
  wsFailuresBeforePoll: 2,
  wsRetryWhilePollingMs: 180_000,
  pollWaitSec: 20,
  pollGapMs: 250,
  poll: defaultPoll,
  now: () => Date.now(),
};

/**
 * One live connection per signed-in user (UserHub Durable Object), by the best transport this network allows:
 *   1. WebSocket: POST /api/realtime/ticket → short-lived single-use ticket → /api/realtime/ws?ticket=… ; "ping" every 25 s.
 *   2. Long polling (GET /api/realtime/poll) when WebSockets cannot be opened — common behind filtering middleboxes and some proxies.
 *      It carries exactly the same events; while it is active a WebSocket is tried again every few minutes.
 * After EVERY (re)connection, and whenever the server says its buffer cannot prove nothing was missed, `onResync` listeners run so
 * screens refetch what they show. Reconnects use exponential back-off with jitter.
 */
export class RealtimeClient {
  readonly state = createStore<ConnectionState>('idle');
  private listeners = new Set<Listener>();
  private resyncs = new Set<() => void>();
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private upgradeTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private running = false;
  private hasConnectedBefore = false;
  private generation = 0;
  private mode: 'ws' | 'poll' = 'ws';
  private wsFailures = 0;
  private pollAbort: AbortController | null = null;
  private wake: (() => void) | null = null;
  private offPool: (() => void) | null = null;
  private readonly opts: RealtimeOptions;

  constructor(
    private readonly makeSocket: SocketFactory = (url) => new WebSocket(url),
    private readonly getTicket: () => Promise<string> = async () => (await http.post<{ ticket: string }>('/api/realtime/ticket')).ticket,
    pingMs?: number,
    options: Partial<RealtimeOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...options, ...(pingMs !== undefined ? { pingMs } : {}) };
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onResync(fn: () => void): () => void {
    this.resyncs.add(fn);
    return () => this.resyncs.delete(fn);
  }

  /** Which transport carries events right now (for the connection indicator). */
  get transport(): 'websocket' | 'poll' | null {
    const s = this.state.get();
    return s === 'open' ? 'websocket' : s === 'polling' ? 'poll' : null;
  }

  /** Fire-and-forget message to the hub (typing indicators). Returns false when there is no open socket (always the case while polling). */
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
    this.mode = 'ws';
    this.wsFailures = 0;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.nudge);
      document.addEventListener('visibilitychange', this.nudge);
    }
    // the client now talks to another address: a socket opened on the old one is useless
    this.offPool = pool.onActiveChange(() => this.addressChanged());
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.mode = 'ws';
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.nudge);
      document.removeEventListener('visibilitychange', this.nudge);
    }
    this.offPool?.();
    this.offPool = null;
    this.clearTimers();
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.wake?.();
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
    if (this.mode === 'poll') {
      this.wake?.(); // a poll loop that is waiting out a back-off tries right away
      return;
    }
    if (this.ws && this.ws.readyState <= 1) return; // connecting or open
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.connect();
  };

  private addressChanged(): void {
    if (!this.running) return;
    if (this.mode === 'poll') {
      this.wake?.();
      return;
    }
    const ws = this.ws;
    this.generation++;
    this.ws = null;
    this.clearTimers();
    try {
      ws?.close(1000, 'address changed');
    } catch {
      // already closed
    }
    this.attempts = 0;
    void this.connect();
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.openTimer) clearTimeout(this.openTimer);
    if (this.upgradeTimer) clearTimeout(this.upgradeTimer);
    this.pingTimer = this.retryTimer = this.openTimer = this.upgradeTimer = null;
  }

  private emit(ev: RealtimeEvent): void {
    this.listeners.forEach((l) => safe(() => l(ev)));
  }

  private resync(): void {
    this.resyncs.forEach((fn) => safe(fn));
  }

  /* ---------------------------------------------------------------------------------------------------- WebSocket */

  private async connect(): Promise<void> {
    if (!this.running || !getToken() || this.mode === 'poll') return;
    const gen = ++this.generation;
    this.state.set(this.hasConnectedBefore ? 'reconnecting' : 'connecting');
    let ticket: string;
    try {
      ticket = await this.getTicket();
    } catch {
      if (gen === this.generation) this.scheduleRetry(); // the plain HTTPS request failed too: not a WebSocket problem
      return;
    }
    if (gen !== this.generation || !this.running) return;
    let ws: WebSocket;
    try {
      ws = this.makeSocket(wsUrl(`/api/realtime/ws?ticket=${encodeURIComponent(ticket)}`));
    } catch {
      this.socketNeverOpened();
      return;
    }
    this.ws = ws;
    this.watch(ws, gen, false);
  }

  /** Handlers shared by a fresh connection and by a socket adopted while polling. */
  private watch(ws: WebSocket, gen: number, alreadyOpen: boolean): void {
    let opened = false;
    let settled = false;
    const markOpen = () => {
      if (gen !== this.generation) return;
      opened = true;
      if (this.openTimer) clearTimeout(this.openTimer);
      this.openTimer = null;
      this.attempts = 0;
      this.wsFailures = 0;
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
      }, this.opts.pingMs);
      if (reconnect) this.resync();
    };
    const lost = () => {
      if (settled || gen !== this.generation) return;
      settled = true;
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.openTimer) clearTimeout(this.openTimer);
      this.pingTimer = this.openTimer = null;
      this.ws = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
      if (!this.running) return;
      if (opened) {
        this.wsFailures = 0;
        this.scheduleRetry();
      } else this.socketNeverOpened();
    };
    ws.onopen = markOpen;
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
      this.emit(ev);
    };
    ws.onclose = lost;
    ws.onerror = () => {
      // an error is always followed by close; nothing to do here
    };
    if (alreadyOpen) markOpen();
    else this.openTimer = setTimeout(() => !opened && lost(), this.opts.openTimeoutMs);
  }

  private socketNeverOpened(): void {
    this.wsFailures++;
    if (this.wsFailures >= this.opts.wsFailuresBeforePoll) this.enterPollMode();
    else this.scheduleRetry();
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

  /* ---------------------------------------------------------------------------------------------------- long polling */

  private enterPollMode(): void {
    if (this.mode === 'poll' || !this.running) return;
    this.mode = 'poll';
    const gen = ++this.generation;
    this.clearTimers();
    this.state.set('reconnecting');
    void this.pollLoop(gen);
    this.scheduleUpgrade();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(t);
        if (self.wake === done) self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  private async pollLoop(gen: number): Promise<void> {
    let cursor: Cursor | null = null;
    let failures = 0;
    const alive = () => this.running && this.mode === 'poll' && gen === this.generation;
    while (alive()) {
      const ctrl = new AbortController();
      this.pollAbort = ctrl;
      const started = this.opts.now();
      let res: PollResponse;
      try {
        res = await this.opts.poll(cursor, this.opts.pollWaitSec, ctrl.signal);
      } catch {
        if (!alive() || ctrl.signal.aborted) return;
        failures++;
        this.state.set('reconnecting');
        const base = Math.min(20_000, 800 * 2 ** Math.min(failures, 5));
        await this.sleep(base / 2 + Math.random() * (base / 2));
        continue;
      }
      if (!alive()) return;
      failures = 0;
      const wasDown = this.state.get() !== 'polling';
      const first = cursor === null;
      this.state.set('polling');
      let needResync = false;
      if (wasDown) {
        needResync = this.hasConnectedBefore; // not the very first connection of the session
        this.hasConnectedBefore = true;
      }
      if (res.reset && !first) needResync = true; // the server cannot prove nothing was missed
      cursor = { epoch: res.epoch, seq: res.seq };
      if (needResync) this.resync();
      for (const ev of res.events) this.emit(ev);
      const elapsed = this.opts.now() - started;
      if (elapsed < this.opts.pollGapMs) await this.sleep(this.opts.pollGapMs - elapsed);
    }
  }

  private scheduleUpgrade(): void {
    if (this.upgradeTimer) clearTimeout(this.upgradeTimer);
    this.upgradeTimer = setTimeout(() => void this.tryUpgrade(), this.opts.wsRetryWhilePollingMs);
  }

  /** While polling: see whether a WebSocket works now, and if so move over to it. */
  private async tryUpgrade(): Promise<void> {
    if (!this.running || this.mode !== 'poll') return;
    const gen = this.generation;
    let ticket: string;
    try {
      ticket = await this.getTicket();
    } catch {
      return this.scheduleUpgrade();
    }
    if (!this.running || this.mode !== 'poll' || gen !== this.generation) return;
    let ws: WebSocket;
    try {
      ws = this.makeSocket(wsUrl(`/api/realtime/ws?ticket=${encodeURIComponent(ticket)}`));
    } catch {
      return this.scheduleUpgrade();
    }
    let done = false;
    const giveUp = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      if (this.running && this.mode === 'poll' && gen === this.generation) this.scheduleUpgrade();
    };
    const timer = setTimeout(giveUp, this.opts.openTimeoutMs);
    ws.onopen = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!this.running || this.mode !== 'poll' || gen !== this.generation) {
        try {
          ws.close();
        } catch {
          // already closed
        }
        return;
      }
      // it works: leave long polling (the poll loop ends because the generation changes)
      this.mode = 'ws';
      this.wsFailures = 0;
      const next = ++this.generation;
      this.pollAbort?.abort();
      this.wake?.();
      this.clearTimers();
      this.ws = ws;
      this.watch(ws, next, true);
    };
    ws.onclose = giveUp;
    ws.onerror = () => {
      // followed by close
    };
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
