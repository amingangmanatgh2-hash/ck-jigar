import { act, renderHook } from '@testing-library/react';
import type { RealtimeEvent } from '@aminchat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamStore, attachStreamFeed, useLiveBody } from '../src/lib/streams';
import { message } from './fixtures';

describe('StreamStore', () => {
  let store: StreamStore;
  beforeEach(() => {
    store = new StreamStore();
  });

  it('assembles an answer from pieces', () => {
    store.feed('m', { offset: 0, text: 'Hel' });
    store.feed('m', { offset: 3, text: 'lo' });
    expect(store.text('m', '')).toBe('Hello');
  });

  it('keeps early pieces even though nothing displays the message yet (first message of a conversation)', () => {
    store.feed('m', { offset: 0, text: 'حتما' });
    store.feed('m', { offset: 4, text: 'ً!' });
    // a screen mounts later with an empty snapshot: nothing is lost
    expect(store.text('m', '')).toBe('حتماً!');
  });

  it('parks a piece that arrives ahead of its predecessor and applies it when the gap closes', () => {
    store.feed('m', { offset: 0, text: 'ab' });
    store.feed('m', { offset: 4, text: 'ef' });
    expect(store.text('m', '')).toBe('ab');
    store.feed('m', { offset: 2, text: 'cd' });
    expect(store.text('m', '')).toBe('abcdef');
  });

  it('never goes backwards: a stale snapshot shorter than the live text does not win', () => {
    store.feed('m', { offset: 0, text: 'Hello world' });
    expect(store.text('m', 'Hello')).toBe('Hello world');
  });

  it('continues from a newer snapshot and applies parked pieces on top of it', () => {
    store.feed('m', { offset: 10, text: ' world' }); // joined mid-stream: the beginning is missing
    expect(store.text('m', '')).toBe('');
    store.adopt('m', 'Hello, you'); // the server snapshot covers the first 10 characters
    expect(store.text('m', '')).toBe('Hello, you world');
  });

  it('ignores a repeated piece', () => {
    store.feed('m', { offset: 0, text: 'abc' });
    store.feed('m', { offset: 0, text: 'abc' });
    expect(store.text('m', '')).toBe('abc');
  });

  it('hands over to the server text once the message is final, and ignores stragglers', () => {
    store.feed('m', { offset: 0, text: 'draft' });
    store.end('m');
    expect(store.text('m', 'final text')).toBe('final text');
    store.feed('m', { offset: 5, text: ' late' });
    expect(store.text('m', 'final text')).toBe('final text');
  });

  it('notifies subscribers only when the visible text changed', () => {
    const fn = vi.fn();
    store.subscribe(fn);
    store.feed('m', { offset: 0, text: 'a' });
    expect(fn).toHaveBeenCalledTimes(1);
    store.feed('m', { offset: 0, text: 'a' }); // replay
    expect(fn).toHaveBeenCalledTimes(1);
    store.feed('m', { offset: 5, text: 'zzz' }); // parked
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('forgets the oldest streams instead of growing without bound', () => {
    for (let i = 0; i < 60; i++) store.feed(`m${i}`, { offset: 0, text: 'x' });
    expect(store.text('m0', '')).toBe(''); // evicted
    expect(store.text('m59', '')).toBe('x');
  });

  describe('gaps', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('asks for a fresh snapshot, with back-off, while a gap persists', () => {
      const asked = vi.fn();
      store.onGap(asked);
      store.feed('m', { offset: 50, text: 'late piece' });
      vi.advanceTimersByTime(699);
      expect(asked).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(asked).toHaveBeenCalledTimes(1);
      expect(asked).toHaveBeenLastCalledWith('m');
      vi.advanceTimersByTime(1_400);
      expect(asked).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(2_800);
      expect(asked).toHaveBeenCalledTimes(3);
    });

    it('stops asking once the gap is filled by a snapshot', () => {
      const asked = vi.fn();
      store.onGap(asked);
      store.feed('m', { offset: 5, text: 'xy' });
      store.adopt('m', 'abcde');
      vi.advanceTimersByTime(10_000);
      expect(asked).not.toHaveBeenCalled();
      expect(store.text('m', '')).toBe('abcdexy');
    });

    it('stops asking when the message ends', () => {
      const asked = vi.fn();
      store.onGap(asked);
      store.feed('m', { offset: 5, text: 'xy' });
      store.end('m');
      vi.advanceTimersByTime(10_000);
      expect(asked).not.toHaveBeenCalled();
    });
  });
});

describe('attachStreamFeed', () => {
  const fakeClient = () => {
    let handler: ((ev: RealtimeEvent) => void) | null = null;
    return {
      on: (fn: (ev: RealtimeEvent) => void) => {
        handler = fn;
        return () => (handler = null);
      },
      emit: (ev: RealtimeEvent) => handler?.(ev),
      attached: () => handler !== null,
    };
  };

  it('feeds run.delta events and ends the stream when the final message arrives', () => {
    const store = new StreamStore();
    const client = fakeClient();
    const detach = attachStreamFeed(client, store);
    client.emit({ type: 'run.delta', runId: 'r', messageId: 'm', text: 'Hi', offset: 0 });
    client.emit({ type: 'run.delta', runId: 'r', messageId: 'm', text: ' there', offset: 2 });
    expect(store.text('m', '')).toBe('Hi there');
    client.emit({ type: 'message.updated', message: message({ id: 'm', status: 'sent', body: 'Hi there!' }) });
    expect(store.text('m', 'Hi there!')).toBe('Hi there!');
    detach();
    expect(client.attached()).toBe(false);
  });

  it('ignores deltas that belong to no message and does not end a stream on a streaming snapshot', () => {
    const store = new StreamStore();
    const client = fakeClient();
    attachStreamFeed(client, store);
    client.emit({ type: 'run.delta', runId: 'r', messageId: null, text: 'x', offset: 0 });
    client.emit({ type: 'run.delta', runId: 'r', messageId: 'm', text: 'abc', offset: 0 });
    client.emit({ type: 'message.created', message: message({ id: 'm', status: 'streaming', body: '' }) });
    expect(store.text('m', '')).toBe('abc');
  });
});

describe('useLiveBody', () => {
  it('shows the live text of a streaming message, and the stored body of a final one', () => {
    const store = new StreamStore();
    const streaming = message({ id: 'm', status: 'streaming', body: '' });
    const { result, rerender } = renderHook(({ m }) => useLiveBody(m, store), { initialProps: { m: streaming } });
    expect(result.current).toBe('');
    act(() => store.feed('m', { offset: 0, text: 'Hello' }));
    expect(result.current).toBe('Hello');
    act(() => store.feed('m', { offset: 5, text: '!' }));
    expect(result.current).toBe('Hello!');
    // a stale snapshot (shorter) does not rewind the screen
    rerender({ m: message({ id: 'm', status: 'streaming', body: 'He' }) });
    expect(result.current).toBe('Hello!');
    // final message: the stored body is authoritative
    rerender({ m: message({ id: 'm', status: 'sent', body: 'Hello! Final.' }) });
    expect(result.current).toBe('Hello! Final.');
  });

  it('adopts a newer snapshot so later pieces continue from it', () => {
    const store = new StreamStore();
    const { result } = renderHook(() => useLiveBody(message({ id: 'm', status: 'streaming', body: 'Hello, ' }), store));
    act(() => store.feed('m', { offset: 7, text: 'world' }));
    expect(result.current).toBe('Hello, world');
  });

  it('returns an empty string for no message', () => {
    const { result } = renderHook(() => useLiveBody(undefined, new StreamStore()));
    expect(result.current).toBe('');
  });
});
