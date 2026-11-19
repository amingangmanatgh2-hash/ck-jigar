import { vi } from 'vitest';

/**
 * A scriptable network for the client's transport tests: every address ("base") behaves one of a few ways, and every request is
 * recorded. Addresses are origins such as https://relay.test; '' is "this origin" (relative URLs).
 */
export type Behavior = 'ok' | 'down' | 'portal' | 'gateway' | 'hang';

export interface Recorded {
  base: string;
  method: string;
  path: string;
  body: string | null;
}

export const HEALTH = (endpoints: string[] = []) => ({ ok: true, service: 'amin-chat', time: 1, environment: 'test', endpoints });

export class FakeNet {
  behaviors = new Map<string, Behavior>();
  advertised: string[] = [];
  latency = new Map<string, number>();
  log: Recorded[] = [];
  /** Per-test reply for non-health paths on a healthy address. */
  handler: (r: Recorded) => { status?: number; json?: unknown } = () => ({ json: { data: 1 } });

  set(base: string, behavior: Behavior): this {
    this.behaviors.set(base, behavior);
    return this;
  }

  private split(url: string): { base: string; path: string } {
    const m = /^(https?:\/\/[^/]+)(\/.*)?$/.exec(url);
    return m ? { base: m[1]!, path: m[2] ?? '/' } : { base: '', path: url };
  }

  fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { base, path } = this.split(String(input));
    const method = init?.method ?? 'GET';
    const rec: Recorded = { base, method, path, body: typeof init?.body === 'string' ? init.body : null };
    this.log.push(rec);
    const behavior = this.behaviors.get(base) ?? 'down';
    const ms = this.latency.get(base) ?? 0;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    if (behavior === 'down') throw new TypeError('Failed to fetch');
    if (behavior === 'hang') {
      await new Promise<never>((_, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (behavior === 'portal') return new Response('<html>blocked</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    if (behavior === 'gateway') return new Response('Bad gateway', { status: 502, headers: { 'Content-Type': 'text/plain' } });
    // a healthy address: it is OUR Worker, which marks every answer with X-Request-Id
    const headers = { 'Content-Type': 'application/json', 'X-Request-Id': 'req_test' };
    if (path === '/api/health') return new Response(JSON.stringify(HEALTH(this.advertised)), { status: 200, headers });
    const out = this.handler(rec);
    return new Response(JSON.stringify(out.json ?? {}), { status: out.status ?? 200, headers });
  });

  requestsTo(base: string, method?: string): Recorded[] {
    return this.log.filter((r) => r.base === base && (!method || r.method === method) && r.path !== '/api/health');
  }
}
