import type { AiTriggerResult, E2eePayload, MessageDto } from '@aminchat/shared';
import { ApiError } from './api';
import { createStore } from './store';

/**
 * Messages written while there is no usable connection. They are kept on this device (per user) and sent, in order, as soon as the
 * network is back. Every entry carries its idempotency token (`clientId`), so a send that DID arrive but whose answer was lost is
 * recognised by the server and never shows up twice.
 *
 * What is queued — and what is not:
 *   • plain text in ordinary chats (stored as typed, on this device only, like the composer's drafts);
 *   • secret (E2EE) chats: only the CIPHERTEXT. The plaintext never reaches storage;
 *   • not queued: files (they need the network to upload) and messages to AMIN AI (an answer cannot be produced offline anyway).
 *     Those fail visibly and keep their text in the composer.
 */

export interface OutboxEntry {
  clientId: string;
  conversationId: string;
  body?: string;
  cipher?: E2eePayload;
  replyToId?: string;
  queuedAt: number;
  attempts: number;
  /** pending = will be (re)sent automatically; failed = the server refused it for good — the user decides. */
  state: 'pending' | 'failed';
  errorCode?: string;
  errorMessage?: string;
}

export interface SendResult {
  message: MessageDto;
  ai: AiTriggerResult;
  duplicate?: boolean;
}

export type SendFn = (conversationId: string, body: { body?: string; cipher?: E2eePayload; replyToId?: string; clientId: string }) => Promise<SendResult>;

export interface OutboxStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface OutboxDeps {
  storage: OutboxStorage;
  send: SendFn;
  now: () => number;
}

export const OUTBOX_MAX = 100;
const KEY = (userId: string) => `aminchat.outbox.${userId}`;
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

export interface OutboxState {
  entries: OutboxEntry[];
  flushing: boolean;
}

/** Network trouble and server hiccups are retried; a refusal of the request itself is final. */
export function isTransient(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true; // anything unexpected: keep the message, try again later
  return err.status === 0 || err.status === 401 || err.status === 408 || err.status === 429 || err.status >= 500;
}

/** "There is no connection" as opposed to "the server said no". */
export const isOffline = (err: unknown): boolean => err instanceof ApiError && err.status === 0;

function valid(e: unknown): e is OutboxEntry {
  const x = e as Partial<OutboxEntry> | null;
  return (
    !!x &&
    typeof x.clientId === 'string' &&
    /^[A-Za-z0-9_-]{8,64}$/.test(x.clientId) &&
    typeof x.conversationId === 'string' &&
    typeof x.queuedAt === 'number' &&
    (typeof x.body === 'string' || (typeof x.cipher === 'object' && x.cipher !== null)) &&
    (x.state === 'pending' || x.state === 'failed')
  );
}

export class Outbox {
  readonly state = createStore<OutboxState>({ entries: [], flushing: false });
  private userId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private streak = 0;
  private delivered = new Set<(entry: OutboxEntry, res: SendResult) => void>();
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly deps: OutboxDeps) {}

  /** Starts serving this user's queue (what is left from earlier sessions is picked up and sent). */
  bind(userId: string): void {
    this.unbind();
    this.userId = userId;
    let loaded: OutboxEntry[] = [];
    try {
      const raw = JSON.parse(this.deps.storage.get(KEY(userId)) ?? '[]') as unknown;
      loaded = Array.isArray(raw) ? raw.filter(valid).slice(0, OUTBOX_MAX) : [];
    } catch {
      loaded = [];
    }
    this.state.set({ entries: loaded, flushing: false });
    if (loaded.some((e) => e.state === 'pending')) void this.flush();
  }

  /** Stops sending (sign-out, expired session). The queue stays on the device unless `clear()` is called. */
  unbind(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.userId = null;
    this.streak = 0;
    this.state.set({ entries: [], flushing: false });
  }

  /** Deletes the queue of the signed-in user (explicit sign-out: their unsent text must not stay on the device). */
  clear(): void {
    if (this.userId) this.deps.storage.remove(KEY(this.userId));
    this.state.set((s) => ({ ...s, entries: [] }));
  }

  onDelivered(fn: (entry: OutboxEntry, res: SendResult) => void): () => void {
    this.delivered.add(fn);
    return () => this.delivered.delete(fn);
  }

  count(): number {
    return this.state.get().entries.length;
  }

  forConversation(conversationId: string): OutboxEntry[] {
    return this.state.get().entries.filter((e) => e.conversationId === conversationId);
  }

  /** Anything of this conversation still waiting? A new message must queue behind it to keep the order. */
  hasQueued(conversationId: string): boolean {
    return this.state.get().entries.some((e) => e.conversationId === conversationId);
  }

  /** Adds a message. Returns the entry, or why it could not be kept (the caller then keeps the text in the composer). */
  enqueue(input: { clientId: string; conversationId: string; body?: string; cipher?: E2eePayload; replyToId?: string }): OutboxEntry | 'full' | 'storage' | 'signed-out' {
    if (!this.userId) return 'signed-out';
    const entries = this.state.get().entries;
    if (entries.length >= OUTBOX_MAX) return 'full';
    const entry: OutboxEntry = { ...input, queuedAt: this.deps.now(), attempts: 0, state: 'pending' };
    if (!this.persist([...entries, entry])) return 'storage';
    this.state.set((s) => ({ ...s, entries: [...s.entries, entry] }));
    void this.flush();
    return entry;
  }

  retry(clientId: string): void {
    this.update(clientId, (e) => ({ ...e, state: 'pending', attempts: 0, errorCode: undefined, errorMessage: undefined }));
    this.streak = 0;
    void this.flush(true);
  }

  discard(clientId: string): void {
    this.replaceAll(this.state.get().entries.filter((e) => e.clientId !== clientId));
  }

  /** The connection may be back (network event, realtime connected, tab visible): try now instead of waiting for the timer. */
  nudge(): void {
    if (!this.userId) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.flush(true);
  }

  /**
   * Sends what is waiting. Only one run at a time. A run picks up entries added while it is going, so a plain call during a run
   * does nothing; `force` (a sign that the connection may just have come back) makes the run go around once more when it ends.
   */
  flush(force = false): Promise<void> {
    if (this.running) {
      if (force) this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      this.state.set((s) => ({ ...s, flushing: false }));
      if (this.again) {
        this.again = false;
        void this.flush();
      }
    });
    return this.running;
  }

  private async run(): Promise<void> {
    const owner = this.userId;
    if (!owner) return;
    this.state.set((s) => ({ ...s, flushing: true }));
    const blocked = new Set<string>(); // a conversation whose head message could not go out keeps the later ones back (order)
    let retryAfterMs = 0;
    for (;;) {
      if (this.userId !== owner) return; // signed out meanwhile
      const next = this.state.get().entries.find((e) => e.state === 'pending' && !blocked.has(e.conversationId));
      if (!next) break;
      try {
        const res = await this.deps.send(next.conversationId, { clientId: next.clientId, ...(next.body !== undefined ? { body: next.body } : {}), ...(next.cipher ? { cipher: next.cipher } : {}), ...(next.replyToId ? { replyToId: next.replyToId } : {}) });
        if (this.userId !== owner) return;
        this.streak = 0;
        this.replaceAll(this.state.get().entries.filter((e) => e.clientId !== next.clientId));
        this.delivered.forEach((fn) => {
          try {
            fn(next, res);
          } catch (err) {
            console.error('outbox listener failed', err);
          }
        });
      } catch (err) {
        if (this.userId !== owner) return;
        if (isTransient(err)) {
          this.update(next.clientId, (e) => ({ ...e, attempts: e.attempts + 1 }));
          blocked.add(next.conversationId);
          if (err instanceof ApiError && err.status === 429 && err.retryAfterSec) retryAfterMs = Math.max(retryAfterMs, err.retryAfterSec * 1000);
          if (isOffline(err)) break; // nothing else can succeed right now
        } else {
          const code = err instanceof ApiError ? err.code : 'UNKNOWN';
          this.update(next.clientId, (e) => ({ ...e, state: 'failed', attempts: e.attempts + 1, errorCode: code, errorMessage: err instanceof Error ? err.message : undefined }));
        }
      }
    }
    if (this.state.get().entries.some((e) => e.state === 'pending')) this.scheduleRetry(retryAfterMs);
  }

  private scheduleRetry(minMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    const base = BACKOFF_MS[Math.min(this.streak, BACKOFF_MS.length - 1)]!;
    this.streak++;
    const delay = Math.max(minMs, base / 2 + Math.random() * (base / 2));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private update(clientId: string, fn: (e: OutboxEntry) => OutboxEntry): void {
    this.replaceAll(this.state.get().entries.map((e) => (e.clientId === clientId ? fn(e) : e)));
  }

  private replaceAll(entries: OutboxEntry[]): void {
    this.persist(entries);
    this.state.set((s) => ({ ...s, entries }));
  }

  private persist(entries: OutboxEntry[]): boolean {
    if (!this.userId) return false;
    try {
      if (entries.length === 0) this.deps.storage.remove(KEY(this.userId));
      else this.deps.storage.set(KEY(this.userId), JSON.stringify(entries));
      return true;
    } catch {
      return false; // storage full or unavailable
    }
  }
}

/* ------------------------------------------------------------------------------------------------------------------------
 * What a chat shows for messages that are not on the server yet
 * ---------------------------------------------------------------------------------------------------------------------- */

const PENDING_PREFIX = 'pending:';
export const isPendingId = (id: string): boolean => id.startsWith(PENDING_PREFIX);
export const clientIdOfPending = (id: string): string => id.slice(PENDING_PREFIX.length);

/**
 * Stand-ins that look like the messages the queued entries will become. An entry whose message has already arrived (found by its
 * `clientId`, e.g. through the realtime feed while the send request was still open) is not shown twice.
 */
export function pendingAsMessages(entries: readonly OutboxEntry[], delivered: readonly MessageDto[], meId: string): MessageDto[] {
  const known = new Set(delivered.map((m) => m.clientId).filter((c): c is string => !!c));
  return entries
    .filter((e) => !known.has(e.clientId))
    .sort((a, b) => a.queuedAt - b.queuedAt)
    .map((e) => ({
      id: `${PENDING_PREFIX}${e.clientId}`,
      conversationId: e.conversationId,
      threadId: null,
      senderId: meId,
      kind: 'text' as const,
      body: e.body ?? null,
      cipher: e.cipher ?? null,
      replyToId: e.replyToId ?? null,
      viaAi: false,
      status: 'sent' as const,
      createdAt: e.queuedAt,
      editedAt: null,
      deleted: false,
      attachments: [],
      meta: null,
      clientId: e.clientId,
    }));
}
