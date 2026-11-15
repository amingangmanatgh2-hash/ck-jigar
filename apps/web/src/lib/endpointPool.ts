import { MAX_ENDPOINTS, cleanEndpoints, normalizeEndpoint } from '@aminchat/shared';
import { getServer } from './server';
import { createStore } from './store';

/**
 * The addresses this client can reach the service at, and which one it is using right now.
 *
 *   primary  the address the app was opened from / configured with (web: this origin, Android: the saved server URL)
 *   custom   addresses the user added (a relay a friend runs, a second domain …)
 *   learned  addresses the server itself advertised on GET /api/health (PUBLIC_ENDPOINTS), remembered for the day the primary is blocked
 *
 * When a request fails at the transport level, `failover()` probes the others and switches to the first that answers like our
 * server (never trusting a bare HTTP 200: captive portals and DNS hijacks answer 200 with their own page).
 * While on a fallback the primary is re-checked from time to time and used again as soon as it works.
 */

export type EndpointSource = 'primary' | 'custom' | 'learned';
export type EndpointHealth = 'unknown' | 'ok' | 'down';

export interface EndpointInfo {
  /** '' = same origin. Otherwise an origin such as https://relay.example.com */
  base: string;
  source: EndpointSource;
  health: EndpointHealth;
  latencyMs: number | null;
  checkedAt: number | null;
}

export interface PoolState {
  active: string;
  endpoints: EndpointInfo[];
  probing: boolean;
  /** True while the app talks to something other than its primary address. */
  usingFallback: boolean;
}

export interface PoolStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface PoolDeps {
  storage: PoolStorage;
  fetchFn: typeof fetch;
  now: () => number;
  primary: () => string;
  /** Origin of the page (web). A learned/custom address equal to it is the primary, not an alternative. */
  pageOrigin: () => string;
  probeTimeoutMs: number;
  /** How often the primary is re-checked while a fallback is in use. */
  recheckMs: number;
}

const STORE_KEY = 'aminchat.endpoints';

interface Saved {
  custom: string[];
  learned: string[];
  active: string | null;
}

interface ProbeResult {
  base: string;
  ok: boolean;
  latencyMs: number | null;
  advertised: string[];
}

export class EndpointPool {
  readonly state = createStore<PoolState>({ active: '', endpoints: [], probing: false, usingFallback: false });
  private saved: Saved;
  private health = new Map<string, { health: EndpointHealth; latencyMs: number | null; checkedAt: number | null }>();
  private inflight: Promise<string | null> | null = null;
  /** When the last failover found nothing: for a few seconds further failures do not wait for another round of probes. */
  private noneAt = -Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(active: string) => void>();

  constructor(private readonly deps: PoolDeps) {
    this.saved = this.load();
    this.publish();
  }

  /* ---------------------------------------------------------------- reading */

  /** primary first, then custom, then learned; no duplicates. */
  candidates(): { base: string; source: EndpointSource }[] {
    const out: { base: string; source: EndpointSource }[] = [{ base: this.primaryBase(), source: 'primary' }];
    const seen = new Set([out[0]!.base]);
    const page = this.deps.pageOrigin();
    const add = (list: string[], source: EndpointSource) => {
      for (const raw of list) {
        const base = raw === page && this.primaryBase() === '' ? '' : raw;
        if (!seen.has(base)) {
          seen.add(base);
          out.push({ base, source });
        }
      }
    };
    add(this.saved.custom, 'custom');
    add(this.saved.learned, 'learned');
    return out;
  }

  /** The base URL requests should use right now ('' = same origin). */
  active(): string {
    const list = this.candidates();
    const wanted = this.saved.active;
    return wanted !== null && list.some((c) => c.base === wanted) ? wanted : list[0]!.base;
  }

  private primaryBase(): string {
    const configured = this.deps.primary();
    if (!configured) return '';
    const origin = normalizeEndpoint(configured);
    return origin ?? configured;
  }

  /** Subscribe to switches (the realtime connection reconnects to the new address). Returns an unsubscribe function. */
  onActiveChange(fn: (active: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /* ---------------------------------------------------------------- user-managed list */

  /** Returns an error key instead of throwing so the UI can show it. */
  addCustom(input: string): 'ok' | 'invalid' | 'duplicate' | 'limit' {
    const base = normalizeEndpoint(input);
    if (!base) return 'invalid';
    if (this.candidates().some((c) => c.base === base || (c.base === '' && base === this.deps.pageOrigin()))) return 'duplicate';
    if (this.saved.custom.length >= MAX_ENDPOINTS) return 'limit';
    this.saved.custom.push(base);
    this.persist();
    this.publish();
    void this.probeAll();
    return 'ok';
  }

  remove(base: string): void {
    this.saved.custom = this.saved.custom.filter((b) => b !== base);
    this.saved.learned = this.saved.learned.filter((b) => b !== base);
    if (this.saved.active === base) this.saved.active = null;
    this.health.delete(base);
    this.persist();
    this.publish();
  }

  /** Remembers addresses advertised by the server (already validated here again: never trust the wire). */
  learn(advertised: string[]): void {
    const known = new Set(this.candidates().map((c) => c.base));
    let changed = false;
    for (const base of cleanEndpoints(advertised)) {
      if (known.has(base) || (base === this.deps.pageOrigin() && this.primaryBase() === '')) continue;
      if (this.saved.learned.length >= MAX_ENDPOINTS) break;
      this.saved.learned.push(base);
      changed = true;
    }
    if (changed) {
      this.persist();
      this.publish();
    }
  }

  /* ---------------------------------------------------------------- health */

  reportSuccess(base: string): void {
    const prev = this.health.get(base);
    if (prev?.health === 'ok') return;
    this.health.set(base, { health: 'ok', latencyMs: prev?.latencyMs ?? null, checkedAt: this.deps.now() });
    this.publish();
  }

  reportFailure(base: string): void {
    this.health.set(base, { health: 'down', latencyMs: null, checkedAt: this.deps.now() });
    this.publish();
  }

  private async probe(base: string): Promise<ProbeResult> {
    const started = this.deps.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.deps.probeTimeoutMs);
    const bad: ProbeResult = { base, ok: false, latencyMs: null, advertised: [] };
    try {
      const res = await this.deps.fetchFn(`${base}/api/health`, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
      if (!res.ok) return bad;
      const body = (await res.json()) as { ok?: unknown; service?: unknown; endpoints?: unknown };
      if (body?.ok !== true || body.service !== 'amin-chat') return bad; // a captive portal or hijacked DNS answers 200 too
      return { base, ok: true, latencyMs: Math.max(0, this.deps.now() - started), advertised: Array.isArray(body.endpoints) ? body.endpoints.filter((e): e is string => typeof e === 'string') : [] };
    } catch {
      return bad;
    } finally {
      clearTimeout(timer);
    }
  }

  private record(r: ProbeResult): void {
    this.health.set(r.base, { health: r.ok ? 'ok' : 'down', latencyMs: r.latencyMs, checkedAt: this.deps.now() });
    if (r.ok && r.advertised.length) this.learn(r.advertised);
  }

  /** Checks every address in parallel, remembers what they advertise, and picks the best one. */
  async probeAll(): Promise<void> {
    this.state.set((s) => ({ ...s, probing: true }));
    try {
      // addresses learned from an answer are checked too (a few rounds at most: the learned list is capped)
      const probed = new Set<string>();
      for (let round = 0; round < 3; round++) {
        const todo = this.candidates().filter((c) => !probed.has(c.base));
        if (todo.length === 0) break;
        const results = await Promise.all(todo.map((c) => this.probe(c.base)));
        for (const r of results) {
          probed.add(r.base);
          this.record(r);
        }
      }
      this.choose();
    } finally {
      this.state.set((s) => ({ ...s, probing: false }));
      this.publish();
    }
  }

  /**
   * A request to `failed` just failed at the transport level. Resolves with the address to retry on as soon as ONE alternative
   * answers (the others keep being checked in the background), or null when there is none. Concurrent callers share one run.
   */
  failover(failed: string): Promise<string | null> {
    this.reportFailure(failed);
    if (this.active() !== failed) return Promise.resolve(this.active()); // somebody already switched
    if (this.deps.now() - this.noneAt < 5000) return Promise.resolve(null); // everything was down a moment ago
    this.inflight ??= this.runFailover(failed).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async runFailover(failed: string): Promise<string | null> {
    const others = this.candidates().filter((c) => c.base !== failed);
    if (others.length === 0) return null;
    const probes = others.map((c) => this.probe(c.base).then((r) => (this.record(r), r)));
    const winner = await new Promise<ProbeResult | null>((resolve) => {
      let pending = probes.length;
      for (const p of probes) {
        void p.then((r) => {
          if (r.ok) resolve(r);
          else if (--pending === 0) resolve(null);
        });
      }
    });
    if (!winner) {
      this.noneAt = this.deps.now();
      this.publish();
      return null;
    }
    this.switchTo(winner.base);
    void Promise.allSettled(probes).then(() => this.publish());
    return winner.base;
  }

  /** The primary when it works, otherwise the quickest working alternative; never flip-flops when nothing works. */
  private choose(): void {
    const list = this.candidates();
    const okOf = (base: string) => this.health.get(base)?.health === 'ok';
    const primary = list[0]!.base;
    if (okOf(primary)) return this.switchTo(primary);
    const alive = list.filter((c) => okOf(c.base)).sort((a, b) => (this.health.get(a.base)?.latencyMs ?? 1e9) - (this.health.get(b.base)?.latencyMs ?? 1e9));
    const current = this.active();
    if (alive.length > 0 && !okOf(current)) this.switchTo(alive[0]!.base);
  }

  private switchTo(base: string): void {
    const before = this.active();
    this.saved.active = base === this.primaryBase() ? null : base;
    this.persist();
    this.publish();
    if (this.active() !== before) this.listeners.forEach((fn) => fn(this.active()));
  }

  /* ---------------------------------------------------------------- background checks */

  /** Starts the periodic re-check of the primary while a fallback is in use, and a first look at all addresses. */
  start(): void {
    if (this.timer) return;
    void this.probeAll();
    this.timer = setInterval(() => {
      if (this.active() !== this.primaryBase()) void this.probeAll();
    }, this.deps.recheckMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ---------------------------------------------------------------- persistence + view */

  private load(): Saved {
    try {
      const raw = JSON.parse(this.deps.storage.get(STORE_KEY) ?? 'null') as Partial<Saved> | null;
      const clean = (v: unknown) => cleanEndpoints(Array.isArray(v) ? v : []);
      return { custom: clean(raw?.custom), learned: clean(raw?.learned), active: typeof raw?.active === 'string' ? raw.active : null };
    } catch {
      return { custom: [], learned: [], active: null };
    }
  }

  private persist(): void {
    try {
      this.deps.storage.set(STORE_KEY, JSON.stringify(this.saved));
    } catch {
      // storage unavailable: the list just is not remembered
    }
  }

  private publish(): void {
    const active = this.active();
    const endpoints = this.candidates().map((c) => ({ ...c, ...(this.health.get(c.base) ?? { health: 'unknown' as const, latencyMs: null, checkedAt: null }) }));
    this.state.set((s) => ({ ...s, active, endpoints, usingFallback: active !== this.primaryBase() }));
  }
}

export const pool = new EndpointPool({
  storage: {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => localStorage.setItem(k, v),
  },
  fetchFn: (...args) => fetch(...args),
  now: () => Date.now(),
  primary: getServer,
  pageOrigin: () => (typeof location !== 'undefined' ? location.origin : ''),
  probeTimeoutMs: 4000,
  recheckMs: 120_000,
});
