import type { RealtimeEvent } from '@aminchat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PollResponse } from '@aminchat/shared';
import { RealtimeClient, type RealtimeOptions } from '../src/lib/realtime';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(ev: unknown) {
    this.onmessage?.({ data: typeof ev === 'string' ? ev : JSON.stringify(ev) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('RealtimeClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    localStorage.setItem('aminchat.token', 'tok');
  });
  afterEach(() => vi.useRealTimers());

  const make = (tickets = vi.fn(async () => 'ticket-1')) => ({ tickets, client: new RealtimeClient((url) => new FakeSocket(url) as unknown as WebSocket, tickets, 25_000) });

  it('gets a ticket, opens the socket with it and delivers events', async () => {
    const { client, tickets } = make();
    const seen: RealtimeEvent[] = [];
    client.on((e) => seen.push(e));
    client.start();
    await flush();
    expect(tickets).toHaveBeenCalledTimes(1);
    const socket = FakeSocket.all[0]!;
    expect(socket.url).toContain('/api/realtime/ws?ticket=ticket-1');
    socket.open();
    expect(client.state.get()).toBe('open');
    socket.push({ type: 'hello', userId: 'u', ts: 1 });
    socket.push('pong'); // keep-alive answers are not events
    socket.push('not json');
    expect(seen).toEqual([{ type: 'hello', userId: 'u', ts: 1 }]);
    client.stop();
  });

  it('pings to keep the connection alive', async () => {
    const { client } = make();
    client.start();
    await flush();
    const socket = FakeSocket.all[0]!;
    socket.open();
    vi.advanceTimersByTime(25_000);
    expect(socket.sent).toEqual(['ping']);
    client.stop();
  });

  it('reconnects with back-off after a drop and tells screens to refetch what they missed', async () => {
    const { client, tickets } = make();
    const resync = vi.fn();
    client.onResync(resync);
    client.start();
    await flush();
    FakeSocket.all[0]!.open();
    expect(resync).not.toHaveBeenCalled(); // the first connection is not a "re-"sync
    FakeSocket.all[0]!.drop();
    expect(client.state.get()).toBe('reconnecting');
    for (let i = 0; i < 60 && FakeSocket.all.length < 2; i++) await vi.advanceTimersByTimeAsync(500); // wait out the back-off
    expect(tickets.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(FakeSocket.all.length).toBeGreaterThanOrEqual(2);
    FakeSocket.all[FakeSocket.all.length - 1]!.open();
    expect(resync).toHaveBeenCalledTimes(1);
    expect(client.state.get()).toBe('open');
    client.stop();
  });

  it('keeps trying when the ticket request fails, and stops for good on stop()', async () => {
    const tickets = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('t2');
    const { client } = make(tickets);
    client.start();
    await flush();
    expect(FakeSocket.all).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all.length).toBeGreaterThanOrEqual(1);
    client.stop();
    const count = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.all.length).toBe(count);
    expect(client.state.get()).toBe('idle');
  });

  it('send() reports whether the message could go out', async () => {
    const { client } = make();
    expect(client.send({ type: 'typing' })).toBe(false);
    client.start();
    await flush();
    const socket = FakeSocket.all[0]!;
    socket.open();
    expect(client.send({ type: 'typing', conversationId: 'c' })).toBe(true);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'typing', conversationId: 'c' });
    client.stop();
  });

  it('does nothing without a signed-in user', async () => {
    localStorage.clear();
    const { client, tickets } = make();
    client.start();
    await flush();
    expect(tickets).not.toHaveBeenCalled();
    client.stop();
  });
});

/* ------------------------------------------------------------------------------------------------------------------------
 * Fallback: long polling when WebSockets cannot be opened
 * ---------------------------------------------------------------------------------------------------------------------- */

describe('RealtimeClient — long-poll fallback', () => {
  const ev = (id: string): RealtimeEvent => ({ type: 'typing', conversationId: 'c', userId: id }) as RealtimeEvent;

  /** A scripted server for GET /api/realtime/poll. */
  class FakePoll {
    epoch = 'e1';
    seq = 0;
    buffer: { seq: number; ev: RealtimeEvent }[] = [];
    calls: ({ epoch: string; seq: number } | null)[] = [];
    fail = false;
    forceReset = false;
    hold = false;
    waiting: ((r: PollResponse) => void)[] = [];
    publish(...events: RealtimeEvent[]) {
      for (const e of events) this.buffer.push({ seq: ++this.seq, ev: e });
      this.flush();
    }
    private flush() {
      const w = this.waiting.splice(0);
      for (const resolve of w) resolve({ epoch: this.epoch, seq: this.seq, events: [], reset: false });
    }
    fn = (cursor: { epoch: string; seq: number } | null, _wait: number, signal: AbortSignal): Promise<PollResponse> => {
      this.calls.push(cursor);
      if (this.fail) return Promise.reject(new Error('network'));
      if (!cursor) return Promise.resolve({ epoch: this.epoch, seq: this.seq, events: [], reset: false });
      if (this.forceReset) {
        this.forceReset = false;
        return Promise.resolve({ epoch: this.epoch, seq: this.seq, events: [], reset: true });
      }
      const events = this.buffer.filter((b) => b.seq > cursor.seq);
      if (events.length > 0 || !this.hold) return Promise.resolve({ epoch: this.epoch, seq: this.seq, events: events.map((b) => b.ev), reset: false });
      return new Promise<PollResponse>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        this.waiting.push(() => resolve({ epoch: this.epoch, seq: this.seq, events: this.buffer.filter((b) => b.seq > cursor.seq).map((b) => b.ev), reset: false }));
      });
    };
  }

  const OPTS: Partial<RealtimeOptions> = { openTimeoutMs: 8_000, wsFailuresBeforePoll: 2, wsRetryWhilePollingMs: 180_000, pollGapMs: 250, pollWaitSec: 20 };

  function setup(server = new FakePoll(), tickets = vi.fn(async () => 'ticket-1')) {
    const client = new RealtimeClient((url) => new FakeSocket(url) as unknown as WebSocket, tickets, 25_000, { ...OPTS, poll: server.fn });
    const seen: RealtimeEvent[] = [];
    const resync = vi.fn();
    client.on((e) => seen.push(e));
    client.onResync(resync);
    return { client, server, tickets, seen, resync };
  }

  /** Advances time until the condition holds (without real waiting). */
  async function until(cond: () => boolean, maxMs = 120_000, step = 250) {
    for (let t = 0; t < maxMs && !cond(); t += step) await vi.advanceTimersByTimeAsync(step);
    expect(cond()).toBe(true);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    localStorage.setItem('aminchat.token', 'tok');
  });
  afterEach(() => vi.useRealTimers());

  it('switches to long polling when sockets keep hanging, and delivers events that way', async () => {
    const { client, server, seen, resync } = setup();
    client.start();
    await vi.advanceTimersByTimeAsync(8_001); // the first socket never opens (a filtered upgrade just hangs)
    expect(client.state.get()).toBe('reconnecting');
    await until(() => client.state.get() === 'polling');
    expect(FakeSocket.all.length).toBeGreaterThanOrEqual(2);
    expect(client.transport).toBe('poll');
    expect(resync).not.toHaveBeenCalled(); // the first connection of a session is not a "re-"sync

    server.publish(ev('a'), ev('b'));
    await until(() => seen.length === 2);
    expect(seen.map((e: any) => e.userId)).toEqual(['a', 'b']);
    server.publish(ev('c'));
    await until(() => seen.length === 3);
    expect(seen.map((e: any) => e.userId)).toEqual(['a', 'b', 'c']); // nothing twice, nothing lost
    expect(server.calls[0]).toBeNull(); // the first call only asks for a cursor
    expect(server.calls.at(-1)).toMatchObject({ epoch: 'e1' });
    client.stop();
  });

  it('a failing ticket request is a network problem, not a blocked WebSocket: it never triggers polling by itself', async () => {
    const tickets = vi.fn().mockRejectedValue(new Error('offline'));
    const { client } = setup(new FakePoll(), tickets);
    client.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tickets.mock.calls.length).toBeGreaterThan(3);
    expect(FakeSocket.all).toHaveLength(0);
    expect(client.state.get()).toBe('reconnecting');
    expect(client.transport).toBeNull();
    client.stop();
  });

  it('asks screens to refetch after the connection was down and comes back (also through polling)', async () => {
    const { client, server, resync } = setup();
    client.start();
    await until(() => client.state.get() === 'polling');
    expect(resync).not.toHaveBeenCalled();

    server.fail = true; // the network drops
    await until(() => server.calls.length > 3 && client.state.get() === 'reconnecting');
    server.fail = false;
    await until(() => client.state.get() === 'polling');
    expect(resync).toHaveBeenCalledTimes(1); // events may have been missed in between
    client.stop();
  });

  it('asks screens to refetch when the server says its buffer cannot prove completeness', async () => {
    const { client, server, resync, seen } = setup();
    client.start();
    await until(() => client.state.get() === 'polling');
    server.publish(ev('x'));
    await until(() => seen.length === 1);
    expect(resync).not.toHaveBeenCalled();
    server.forceReset = true;
    await until(() => resync.mock.calls.length === 1);
    server.publish(ev('y'));
    await until(() => seen.length === 2);
    expect(resync).toHaveBeenCalledTimes(1); // once per reset, not once per poll
    client.stop();
  });

  it('keeps the request rate bounded while events stream in', async () => {
    const { client, server } = setup();
    client.start();
    await until(() => client.state.get() === 'polling');
    server.calls.length = 0;
    // 60 events, one every 10 ms, for 600 ms
    for (let i = 0; i < 60; i++) {
      server.publish(ev(`s${i}`));
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(server.calls.length).toBeLessThanOrEqual(5); // at most one call per 250 ms, not one per event
    client.stop();
  });

  it('moves back to the WebSocket once one can be opened again, and stops polling', async () => {
    const { client, server, seen, resync } = setup();
    client.start();
    await until(() => client.state.get() === 'polling');
    const before = FakeSocket.all.length;
    await until(() => FakeSocket.all.length > before, 200_000); // the periodic WebSocket attempt
    FakeSocket.all.at(-1)!.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(client.state.get()).toBe('open');
    expect(client.transport).toBe('websocket');
    expect(resync).toHaveBeenCalledTimes(1); // the switch itself may have lost something between the last poll and now

    const polls = server.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.calls.length).toBe(polls); // no more polling
    FakeSocket.all.at(-1)!.push(ev('live'));
    expect(seen.at(-1)).toEqual(ev('live'));
    client.stop();
  });

  it('stays on polling when the periodic WebSocket attempt fails', async () => {
    const { client } = setup();
    client.start();
    await until(() => client.state.get() === 'polling');
    const before = FakeSocket.all.length;
    await until(() => FakeSocket.all.length > before, 200_000);
    await vi.advanceTimersByTimeAsync(9_000); // it never opens
    expect(client.state.get()).toBe('polling');
    expect(FakeSocket.all.at(-1)!.readyState).toBe(3); // and was cleaned up
    client.stop();
  });

  it('stop() ends polling for good and aborts the pending request', async () => {
    const server = new FakePoll();
    server.hold = true;
    const { client } = setup(server);
    client.start();
    await until(() => client.state.get() === 'polling');
    await until(() => server.waiting.length === 1);
    client.stop();
    expect(client.state.get()).toBe('idle');
    const calls = server.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(server.calls.length).toBe(calls);
  });

  it('send() is false while polling (typing indicators are WebSocket-only), and does not break', async () => {
    const { client } = setup();
    client.start();
    await until(() => client.state.get() === 'polling');
    expect(client.send({ type: 'typing', conversationId: 'c' })).toBe(false);
    client.stop();
  });

  it('a listener that throws does not stop the others or the connection', async () => {
    const { client, server } = setup();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const good: RealtimeEvent[] = [];
    client.on(() => {
      throw new Error('boom');
    });
    client.on((e) => good.push(e));
    client.start();
    await until(() => client.state.get() === 'polling');
    server.publish(ev('1'));
    await until(() => good.length === 1);
    server.publish(ev('2'));
    await until(() => good.length === 2);
    spy.mockRestore();
    client.stop();
  });
});
