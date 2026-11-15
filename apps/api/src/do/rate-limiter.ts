import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

export interface RateResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  limit: number;
}

interface State {
  win: number;
  prev: number;
  curr: number;
  windowMs: number;
  lastHit: number;
}

/**
 * Sliding-window-counter rate limiter. One Durable Object per key (e.g. "ai:usr_123"):
 * strongly consistent, so limits cannot be bypassed by spreading requests over many edge locations.
 */
export class RateLimiter extends DurableObject<Env> {
  private state: State | null = null;
  private alarmSet = false;

  async hit(limit: number, windowMs: number, persist = false): Promise<RateResult> {
    if (!this.state) {
      this.state = (await this.ctx.storage.get<State>('s')) ?? { win: 0, prev: 0, curr: 0, windowMs, lastHit: 0 };
    }
    const s = this.state;
    const now = Date.now();
    const win = Math.floor(now / windowMs);
    if (win !== s.win) {
      s.prev = win === s.win + 1 ? s.curr : 0;
      s.curr = 0;
      s.win = win;
    }
    s.windowMs = windowMs;
    s.lastHit = now;
    const elapsed = (now % windowMs) / windowMs;
    const estimated = s.prev * (1 - elapsed) + s.curr;
    if (estimated + 1 > limit) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(250, windowMs - (now % windowMs)), limit };
    }
    s.curr += 1;
    if (persist || s.curr % 10 === 0) await this.ctx.storage.put('s', s);
    if (!this.alarmSet) {
      this.alarmSet = true;
      // Forget the counters once the key has been idle for two windows so storage does not grow without bound.
      await this.ctx.storage.setAlarm(now + windowMs * 2 + 1000);
    }
    return { allowed: true, remaining: Math.max(0, Math.floor(limit - (estimated + 1))), retryAfterMs: 0, limit };
  }

  override async alarm(): Promise<void> {
    this.alarmSet = false;
    const s = this.state ?? (await this.ctx.storage.get<State>('s'));
    if (!s) return;
    if (Date.now() - s.lastHit > s.windowMs * 2) {
      await this.ctx.storage.deleteAll();
      this.state = null;
    } else {
      this.alarmSet = true;
      await this.ctx.storage.setAlarm(s.lastHit + s.windowMs * 2 + 1000);
    }
  }
}
