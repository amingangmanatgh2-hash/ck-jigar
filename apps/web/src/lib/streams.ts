import type { MessageDto, RealtimeEvent } from '@aminchat/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { applyDelta, type Delta } from './deltas';

const MAX_PARKED = 400;
const MAX_STREAMS = 40;
const MAX_ENDED = 200;
const GAP_FIRST_MS = 700;
const GAP_MAX_MS = 5_000;

interface Stream {
  text: string;
  /** pieces that start beyond `text` (something before them has not arrived yet) */
  parked: Delta[];
  touched: number;
  gapTimer: ReturnType<typeof setTimeout> | null;
  gapTries: number;
}

/**
 * The live text of answers that are still being written.
 *
 * It lives OUTSIDE any screen on purpose: the realtime socket delivers `run.delta` pieces whether or not the screen
 * that shows the answer is mounted yet (the first message of a conversation creates the thread, sends, and only then
 * navigates). A bubble shows whichever is further along — the server snapshot or the text assembled here — so a stale
 * snapshot can never rewind an answer and an early piece is never lost.
 */
export class StreamStore {
  private streams = new Map<string, Stream>();
  private ended = new Set<string>();
  private subs = new Set<() => void>();
  private gapHandlers = new Set<(messageId: string) => void>();
  private version = 0;

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };
  getVersion = (): number => this.version;

  /** Called (with back-off) while pieces are parked behind a gap that no snapshot has filled: reload the message. */
  onGap(fn: (messageId: string) => void): () => void {
    this.gapHandlers.add(fn);
    return () => {
      this.gapHandlers.delete(fn);
    };
  }

  /** The text to show: whichever is longer, the server snapshot or what arrived live. Pure. */
  text(messageId: string, snapshot: string): string {
    const s = this.streams.get(messageId);
    return s && s.text.length > snapshot.length ? s.text : snapshot;
  }

  feed(messageId: string, d: Delta): void {
    if (this.ended.has(messageId)) return;
    const s = this.touch(messageId);
    s.parked.push(d);
    if (s.parked.length > MAX_PARKED) s.parked.splice(0, s.parked.length - MAX_PARKED);
    const changed = this.drain(s);
    this.watchGap(messageId, s);
    if (changed) this.bump();
  }

  /** A server snapshot of a message that is still streaming: continue from it when it is further along than we are. */
  adopt(messageId: string, snapshot: string): void {
    if (this.ended.has(messageId)) return;
    const s = this.streams.get(messageId);
    if (!s && !snapshot) return;
    const stream = s ?? this.touch(messageId);
    let changed = false;
    if (snapshot.length > stream.text.length) {
      stream.text = snapshot;
      changed = true;
    }
    if (this.drain(stream)) changed = true;
    this.watchGap(messageId, stream);
    if (changed) this.bump();
  }

  /** The message is final (or gone): the server text is authoritative from now on. */
  end(messageId: string): void {
    const s = this.streams.get(messageId);
    if (!s) return;
    if (s.gapTimer) clearTimeout(s.gapTimer);
    this.streams.delete(messageId);
    this.ended.add(messageId);
    if (this.ended.size > MAX_ENDED) this.ended.delete(this.ended.values().next().value as string);
    this.bump();
  }

  clear(): void {
    for (const s of this.streams.values()) if (s.gapTimer) clearTimeout(s.gapTimer);
    this.streams.clear();
    this.ended.clear();
    this.bump();
  }

  private touch(messageId: string): Stream {
    let s = this.streams.get(messageId);
    if (!s) {
      s = { text: '', parked: [], touched: 0, gapTimer: null, gapTries: 0 };
      this.streams.set(messageId, s);
      if (this.streams.size > MAX_STREAMS) {
        let oldest: string | null = null;
        let at = Infinity;
        for (const [id, v] of this.streams) if (id !== messageId && v.touched < at) [oldest, at] = [id, v.touched];
        if (oldest) this.end(oldest);
      }
    }
    s.touched = Date.now();
    return s;
  }

  private drain(s: Stream): boolean {
    let changed = false;
    let progressed = true;
    while (progressed && s.parked.length) {
      progressed = false;
      for (let i = 0; i < s.parked.length; i++) {
        const next = applyDelta(s.text, s.parked[i]!);
        if (next === null) continue;
        if (next !== s.text) {
          s.text = next;
          changed = true;
        }
        s.parked.splice(i, 1);
        progressed = true;
        break;
      }
    }
    return changed;
  }

  private watchGap(messageId: string, s: Stream): void {
    if (!s.parked.length) {
      if (s.gapTimer) clearTimeout(s.gapTimer);
      s.gapTimer = null;
      s.gapTries = 0;
      return;
    }
    if (s.gapTimer) return;
    const wait = Math.min(GAP_MAX_MS, GAP_FIRST_MS * 2 ** s.gapTries);
    s.gapTimer = setTimeout(() => {
      s.gapTimer = null;
      if (this.streams.get(messageId) !== s || !s.parked.length) return;
      s.gapTries++;
      this.gapHandlers.forEach((h) => {
        try {
          h(messageId);
        } catch {
          // a handler must not break the others
        }
      });
      this.watchGap(messageId, s);
    }, wait);
  }

  private bump(): void {
    this.version++;
    this.subs.forEach((f) => f());
  }
}

export const streams = new StreamStore();

/** Feeds the store from the realtime socket. Call once per client; returns the detach function. */
export function attachStreamFeed(client: { on(fn: (ev: RealtimeEvent) => void): () => void }, store: StreamStore = streams): () => void {
  return client.on((ev) => {
    switch (ev.type) {
      case 'run.delta':
        if (ev.messageId) store.feed(ev.messageId, { offset: ev.offset, text: ev.text });
        break;
      case 'message.created':
      case 'message.updated':
        if (ev.message.status !== 'streaming') store.end(ev.message.id);
        break;
      case 'message.deleted':
        store.end(ev.messageId);
        break;
      default:
        break;
    }
  });
}

type Live = Pick<MessageDto, 'id' | 'status' | 'body'>;

/** The text of a message to display: for one that is still streaming, the live text; otherwise its stored body. */
export function useLiveBody(message: Live | null | undefined, store: StreamStore = streams): string {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  const id = message?.id;
  const streaming = message?.status === 'streaming';
  const snapshot = message?.body ?? '';
  useEffect(() => {
    if (!id) return;
    if (streaming) store.adopt(id, snapshot);
    else store.end(id);
  }, [id, streaming, snapshot, store]);
  if (!message) return '';
  return streaming ? store.text(message.id, snapshot) : snapshot;
}
