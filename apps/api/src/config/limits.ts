import type { Env } from '../env';

/** Default per-user AI quota. Admins can override per user (PUT /api/admin/users/:id/quota). */
export interface QuotaDefaults {
  dailyTokens: number;
  dailyRequests: number;
  monthlyTokens: number;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};

export function quotaDefaults(env: Env): QuotaDefaults {
  return {
    dailyTokens: num(env.DEFAULT_DAILY_TOKENS, 300_000),
    dailyRequests: num(env.DEFAULT_DAILY_REQUESTS, 400),
    monthlyTokens: num(env.DEFAULT_MONTHLY_TOKENS, 4_000_000),
  };
}

/** Request-rate limits. `limit` requests per `windowSec` seconds per key. */
export const RATE_LIMITS = {
  /** Registration / login, per IP. */
  authIp: { limit: 30, windowSec: 600 },
  /** Login attempts per username (brute-force protection). */
  loginUser: { limit: 10, windowSec: 900 },
  /** All authenticated API calls, per user. */
  api: { limit: 600, windowSec: 60 },
  /** Calls that start AI work (messages to AMIN AI, mentions, runs, regenerate), per user. */
  ai: { limit: 30, windowSec: 60 },
  /** Long-poll fallback for realtime: one call per ≤25 s when idle, up to a few per second while an answer streams. */
  poll: { limit: 240, windowSec: 60 },
  /** Heavy AI calls (transcription, file conversion, image generation), per user. */
  aiHeavy: { limit: 12, windowSec: 60 },
  /** File uploads, per user. */
  upload: { limit: 30, windowSec: 60 },
  /** Chat messages between people, per user. */
  send: { limit: 120, windowSec: 60 },
} as const;

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
export const MODEL_HEALTH_TTL_MS = 20 * 60 * 1000;

export const RUN_LIMITS = {
  maxSteps: 8,
  maxLlmCalls: 14,
  maxRunMs: 10 * 60 * 1000,
  stepTimeoutMs: 45_000,
  stepMaxAttempts: 3,
  /** Runs that stopped heart-beating for this long are resumed (or failed after `maxResumes`). */
  staleAfterMs: 3 * 60 * 1000,
  maxResumes: 3,
} as const;

/** Prompt budgets (estimated tokens). Conservative so the 24k-context fallback model can still answer. */
export const AI_CONTEXT = {
  historyTokens: 12_000,
  assistTokens: 8_000,
  assistMessages: 60,
  routerRecentChars: 1500,
} as const;
