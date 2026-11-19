import type { MessageDto } from '@aminchat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api';
import { OUTBOX_MAX, Outbox, clientIdOfPending, isOffline, isPendingId, isTransient, pendingAsMessages, type OutboxEntry, type SendFn, type SendResult } from '../src/lib/outbox';

const msg = (id: string, body = 'x'): MessageDto =>
  ({ id, conversationId: 'c1', threadId: null, senderId: 'me', kind: 'text', body, cipher: null, replyToId: null, viaAi: false, status: 'sent', createdAt: 1, editedAt: null, deleted: false, attachments: [], meta: null }) as MessageDto;
const ok = (id = 'srv1', extra: Partial<SendResult> = {}): SendResult => ({ message: msg(id), ai: { triggered: false }, ...extra });
const NETWORK = () => new ApiError(0, 'NETWORK', 'down');

function make(send: SendFn, userId = 'u1') {
  const mem = new Map<string, string>();
  const outbox = new Outbox({ storage: { get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v), remove: (k) => void mem.delete(k) }, send, now: () => Date.now() });
  outbox.bind(userId);
  return { outbox, mem };
}
const id = (n: number) => `client-id-${String(n).padStart(4, '0')}`;
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('Outbox', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a queued message right away when the network is fine, with its idempotency token, then forgets it', async () => {
    const send = vi.fn<SendFn>(async () => ok());
    const { outbox, mem } = make(send);
    const delivered = vi.fn();
    outbox.onDelivered(delivered);
    const entry = outbox.enqueue({ clientId: id(1), conversationId: 'c1', body: 'hello', replyToId: 'm0' });
    expect(entry).toMatchObject({ state: 'pending', attempts: 0 });
    expect(mem.get('aminchat.outbox.u1')).toContain('hello'); // written before anything is sent
    await settle();
    expect(send).toHaveBeenCalledWith('c1', { clientId: id(1), body: 'hello', replyToId: 'm0' });
    expect(outbox.count()).toBe(0);
    expect(mem.has('aminchat.outbox.u1')).toBe(false);
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ clientId: id(1) }), expect.objectContaining({ message: expect.objectContaining({ id: 'srv1' }) }));
  });

  it('keeps messages while offline, retries with back-off, and delivers them in order once the network is back', async () => {
    let online = false;
    const order: string[] = [];
    const send = vi.fn<SendFn>(async (_c, b) => {
      if (!online) throw NETWORK();
      order.push(b.body!);
      return ok(`srv-${order.length}`);
    });
    const { outbox } = make(send);
    outbox.enqueue({ clientId: id(1), conversationId: 'c1', body: 'one' });
    outbox.enqueue({ clientId: id(2), conversationId: 'c1', body: 'two' });
    outbox.enqueue({ clientId: id(3), conversationId: 'c1', body: 'three' });
    await settle();
    expect(send).toHaveBeenCalledTimes(1); // it did not hammer: the first failure stops the run
    expect(outbox.count()).toBe(3);
    expect(outbox.state.get().entries[0]!.attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(3_000); // first back-off (≤ 2 s)
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
    const attempts = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_900); // the next wait is longer than the first
    expect(send.mock.calls.length).toBeLessThanOrEqual(attempts + 1);

    online = true;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(order).toEqual(['one', 'two', 'three']);
    expect(outbox.count()).toBe(0);
  });

  it('nudge() (network event, realtime connected) retries immediately instead of waiting for the timer', async () => {
    let online = false;
    const send = vi.fn<SendFn>(async () => {
      if (!online) throw NETWORK();
      return ok();
    });
    const { outbox } = make(send);
    outbox.enqueue({ clientId: id(1), conversationId: 'c1', body: 'hi' });
    await settle();
    expect(outbox.count()).toBe(1);
    online = true;
    outbox.nudge();
    await settle();
    expect(outbox.count()).toBe(0);
  });

  it('queues new messages behind older ones of the same conversation, but not behind other conversations', async () => {
    const sent: string[] = [];
    let blockA = true;
    const send = vi.fn<SendFn>(async (conversationId, b) => {
      if (conversationId === 'A' && blockA) throw NETWORK();
      sent.push(`${conversationId}:${b.body}`);
      return ok();
    });
    const { outbox } = make(send);
    outbox.enqueue({ clientId: id(1), conversationId: 'A', body: 'a1' });
    await settle();
    expect(outbox.hasQueued('A')).toBe(true);
    expect(outbox.hasQueued('B')).toBe(false);
    blockA = false;
    outbox.enqueue({ clientId: id(2), conversationId: 'A', body: 'a2' });
    outbox.enqueue({ clientId: id(3), conversationId: 'B', body: 'b1' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent.indexOf('A:a1')).toBeLessThan(sent.indexOf('A:a2'));
    expect(sent).toContain('B:b1');
    expect(outbox.count()).toBe(0);
  });

  it('survives a restart: the queue is reloaded and flushed, and a corrupt or foreign store is ignored', async () => {
    const send = vi.fn<SendFn>(async () => {
      throw NETWORK();
    });
    const first = make(send);
    first.outbox.enqueue({ clientId: id(1), conversationId: 'c1', body: 'saved' });
    await settle();
    const stored = first.mem.get('aminchat.outbox.u1')!;

    const sent: string[] = [];
    const second = make(async (_c, b) => (sent.push(b.body!), ok()));
    second.mem.set('aminchat.outbox.u1', stored);
    second.outbox.bind('u1'); // the same user signs in again
    await settle();
    expect(sent).toEqual(['saved']);

    // another user on the same device never sees or sends it
    const third = make(send, 'u2');
    third.mem.set('aminchat.outbox.u1', stored);
    third.outbox.bind('u2');
    expect(third.outbox.count()).toBe(0);

    // garbage in storage is dropped entry by entry
    const fourth = make(send);
    fourth.mem.set('aminchat.outbox.u1', JSON.stringify([{ nope: 1 }, 'text', { clientId: 'short', conversationId: 'c', queuedAt: 1, body: 'x', state: 'pending' }, JSON.parse(stored)[0]]));
    fourth.outbox.bind('u1');
    expect(fourth.outbox.state.get().entries.map((e) => e.body)).toEqual(['saved']);
    fourth.mem.set('aminchat.outbox.u1', '{broken');
    fourth.outbox.bind('u1');
    expect(fourth.outbox.count()).toBe(0);
  });

  it('marks a message the server refuses as failed (and does not retry it), others continue', async () => {
    const send = vi.fn<SendFn>(async (_c, b) => {
      if (b.body === 'bad') throw new ApiError(403, 'FORBIDDEN', 'You are not a member');
      return ok();
    });
    const { outbox } = make(send);
    outbox.enqueue({ clientId: id(1), conversationId: 'c1', body: 'bad' });
    outbox.enqueue({ clientId: id(2), conversationId: 'c1', body: 'good' });
    await vi.advanceTimersByTimeAsync(10);
    expect(outbox.state.get().entries).toEqual([expect.objectContaining({ body: 'bad', state: 'failed', errorCode: 'FORBIDDEN' })]);
    const calls = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send.mock.calls.length).toBe(calls);

    outbox.retry(id(1)); // the user presses "send again"
    await vi.advanceTimersByTimeAsync(10);
    expect(send.mock.calls.length).toBe(calls + 1);
    expect(outbox.state.get().entries[0]).toMatchObject({ state: 'failed', attempts: 1 });
    outbox.discard(id(1));
    expect(outbox.count()).toBe(0);
  });

  it('keeps a message on server errors and on 429 (honouring Retry-After), and through a 401 (session ended)', async () => {
    const results: (Error | null)[] = [new ApiError(503, 'UNAVAILABLE', 'x'), new ApiError(429, 'RATE_LIMITED', 'x', undefined, 30), new ApiError(401, 'UNAUTHORIZED', 'x'), null];
    const send = vi.fn<SendFn>(async () => {
      const r = results.shift();
      if (r) throw r;
      return ok();
    });
    const { outbox } = make(send);
    outbox.enqueue({ clientId: id(1), conversationId: 'c1', body: 'x' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(send).toHaveBeenCalledTimes(2); // 503, then 429
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).toHaveBeenCalledTimes(2); // 30 s were asked for
    await vi.advanceTimersByTimeAsync(11_000);
    expect(send).toHaveBeenCalledTimes(3); // 401: kept
    expect(outbox.state.get().entries[0]!.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(70_000);
    expect(outbox.count()).toBe(0);
  });

  it('treats a duplicate answer like a success', async () => {
    const send = vi.fn<SendFn>(async () => ok('srv1', { duplicate: true }));
    const { outbox } = make(send);
    const delivered = vi.fn();
    outbox.onDelivered(delivered);
    outbox.enqueue({ clientId: id(1), conversationId: 'c1', body: 'x' });
    await settle();
    expect(outbox.count()).toBe(0);
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it('stores only ciphertext for secret chats', async () => {
    const cipher = { v: 1, iv: 'aXY=', ct: 'Y2lwaGVy' } as never;
    const send = vi.fn<SendFn>(async () => {
      throw NETWORK();
    });
    const { outbox, mem } = make(send);
    outbox.enqueue({ clientId: id(1), conversationId: 'secret', cipher });
    await settle();
    const raw = mem.get('aminchat.outbox.u1')!;
    expect(raw).toContain('Y2lwaGVy');
    expect(JSON.parse(raw)[0].body).toBeUndefined();
    expect(send).toHaveBeenCalledWith('secret', { clientId: id(1), cipher });
  });

  it('refuses honestly when it cannot keep a message (limit, storage full, signed out)', async () => {
    const send = vi.fn<SendFn>(async () => {
      throw NETWORK();
    });
    const { outbox } = make(send);
    for (let i = 0; i < OUTBOX_MAX; i++) expect(outbox.enqueue({ clientId: id(i), conversationId: `c${i % 3}`, body: 'x' })).toMatchObject({ state: 'pending' });
    expect(outbox.enqueue({ clientId: id(999), conversationId: 'c1', body: 'x' })).toBe('full');

    const mem = new Map<string, string>();
    const full = new Outbox({ storage: { get: () => null, set: () => { throw new Error('QuotaExceededError'); }, remove: () => void mem.clear() }, send, now: () => 1 });
    full.bind('u1');
    expect(full.enqueue({ clientId: id(1), conversationId: 'c1', body: 'x' })).toBe('storage');
    expect(full.count()).toBe(0); // it did not pretend to have it

    full.unbind();
    expect(full.enqueue({ clientId: id(2), conversationId: 'c1', body: 'x' })).toBe('signed-out');
  });

  it('sign-out: clear() wipes the stored text; an expired session keeps it for the same user', async () => {
    const send = vi.fn<SendFn>(async () => {
      throw NETWORK();
    });
    const { outbox, mem } = make(send);
    outbox.enqueue({ clientId: id(1), conversationId: 'c1', body: 'private words' });
    await settle();
    outbox.unbind(); // session expired: nothing is sent, nothing is deleted
    expect(mem.get('aminchat.outbox.u1')).toContain('private words');
    expect(send).toHaveBeenCalledTimes(1);
    outbox.bind('u1');
    expect(outbox.count()).toBe(1);

    outbox.clear(); // explicit sign-out
    expect(mem.has('aminchat.outbox.u1')).toBe(false);
    outbox.unbind();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send.mock.calls.length).toBeLessThanOrEqual(2); // no more sends after the sign-out
  });

  it('does not deliver for a user who signed out while a send was in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = vi.fn<SendFn>(async () => {
      await gate;
      return ok();
    });
    const { outbox } = make(send);
    const delivered = vi.fn();
    outbox.onDelivered(delivered);
    outbox.enqueue({ clientId: id(1), conversationId: 'c1', body: 'x' });
    await settle();
    outbox.unbind();
    release();
    await settle();
    expect(delivered).not.toHaveBeenCalled();
  });

  it('a nudge during a run makes it go around once more instead of running twice in parallel', async () => {
    let inFlight = 0;
    let max = 0;
    const send = vi.fn<SendFn>(async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 100));
      inFlight--;
      return ok();
    });
    const { outbox } = make(send);
    outbox.enqueue({ clientId: id(1), conversationId: 'c1', body: 'a' });
    outbox.enqueue({ clientId: id(2), conversationId: 'c1', body: 'b' });
    outbox.nudge();
    outbox.nudge();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(max).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('error classification', () => {
  it('knows network trouble from a refusal', () => {
    expect(isOffline(new ApiError(0, 'NETWORK', ''))).toBe(true);
    expect(isOffline(new ApiError(500, 'X', ''))).toBe(false);
    expect(isOffline(new Error('x'))).toBe(false);
    for (const s of [0, 401, 408, 429, 500, 502, 503]) expect(isTransient(new ApiError(s, 'X', '')), String(s)).toBe(true);
    for (const s of [400, 403, 404, 409, 413]) expect(isTransient(new ApiError(s, 'X', '')), String(s)).toBe(false);
    expect(isTransient(new TypeError('boom'))).toBe(true);
  });
});

describe('pendingAsMessages (what a chat shows for unsent messages)', () => {
  const entry = (n: number, over: Partial<OutboxEntry> = {}): OutboxEntry => ({ clientId: id(n), conversationId: 'c1', body: `text ${n}`, queuedAt: 1000 + n, attempts: 0, state: 'pending', ...over });

  it('builds message-shaped stand-ins in the order they were written', () => {
    const out = pendingAsMessages([entry(2), entry(1, { replyToId: 'm0' }), entry(3, { body: undefined, cipher: { v: 1, iv: 'a', ct: 'b' } as never })], [], 'me');
    expect(out.map((m) => m.body)).toEqual(['text 1', 'text 2', null]);
    expect(out[0]).toMatchObject({ senderId: 'me', kind: 'text', status: 'sent', replyToId: 'm0', conversationId: 'c1', clientId: id(1), createdAt: 1001 });
    expect(out[2]!.cipher).toBeTruthy();
    expect(out.every((m) => isPendingId(m.id))).toBe(true);
    expect(clientIdOfPending(out[0]!.id)).toBe(id(1));
  });

  it('does not show a message twice once the real one has arrived (matched by the sender’s own token)', () => {
    const delivered = [{ ...msg('srv-1', 'text 1'), clientId: id(1) }, msg('srv-9', 'from someone else')];
    const out = pendingAsMessages([entry(1), entry(2)], delivered, 'me');
    expect(out.map((m) => m.body)).toEqual(['text 2']);
  });

  it('real message ids are never mistaken for stand-ins', () => {
    expect(isPendingId('msg_123')).toBe(false);
    expect(isPendingId('pending:abc')).toBe(true);
  });
});
