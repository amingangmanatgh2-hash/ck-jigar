import type { RealtimeEvent } from '@aminchat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient } from '../src/lib/realtime';

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
    await vi.advanceTimersByTimeAsync(60_000);
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
