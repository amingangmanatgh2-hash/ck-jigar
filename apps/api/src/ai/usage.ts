import type { UsageSummaryDto } from '@aminchat/shared';
import { quotaDefaults } from '../config/limits';
import { all, first } from '../db/helpers';
import type { Env } from '../env';
import { quotaExceeded } from '../lib/errors';
import { dayKey, monthStartDay } from '../lib/time';

export interface UsageRecord {
  userId: string;
  runId?: string | null;
  modelId: string;
  role: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  latencyMs: number;
  status: 'ok' | 'error' | 'fallback';
  errorCode?: string | null;
}

export async function recordUsage(env: Env, r: UsageRecord): Promise<void> {
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO ai_usage (user_id, run_id, model_id, role, purpose, input_tokens, output_tokens, estimated, latency_ms, status, error_code, day, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(r.userId, r.runId ?? null, r.modelId, r.role, r.purpose, r.inputTokens, r.outputTokens, r.estimated ? 1 : 0, r.latencyMs, r.status, r.errorCode ?? null, dayKey(now), now)
      .run();
  } catch (err) {
    // Usage logging must never break an answer.
    console.error('usage log failed', String((err as Error)?.message ?? err));
  }
}

export async function effectiveQuota(env: Env, userId: string) {
  const defaults = quotaDefaults(env);
  const row = await first<{ daily_tokens: number | null; daily_requests: number | null; monthly_tokens: number | null }>(
    env.DB.prepare('SELECT daily_tokens, daily_requests, monthly_tokens FROM user_quotas WHERE user_id = ?').bind(userId),
  );
  return {
    dailyTokens: row?.daily_tokens ?? defaults.dailyTokens,
    dailyRequests: row?.daily_requests ?? defaults.dailyRequests,
    monthlyTokens: row?.monthly_tokens ?? defaults.monthlyTokens,
    custom: !!row,
  };
}

export async function usageTotals(env: Env, userId: string, now = Date.now()) {
  const day = dayKey(now);
  const month = monthStartDay(now);
  const r = await first<{ t_tokens: number; t_req: number; t_err: number; m_tokens: number; m_req: number }>(
    env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN day = ?1 AND status != 'error' THEN input_tokens + output_tokens END), 0) AS t_tokens,
         COALESCE(SUM(CASE WHEN day = ?1 AND status != 'error' THEN 1 END), 0) AS t_req,
         COALESCE(SUM(CASE WHEN day = ?1 AND status = 'error' THEN 1 END), 0) AS t_err,
         COALESCE(SUM(CASE WHEN status != 'error' THEN input_tokens + output_tokens END), 0) AS m_tokens,
         COALESCE(SUM(CASE WHEN status != 'error' THEN 1 END), 0) AS m_req
       FROM ai_usage WHERE user_id = ?2 AND day >= ?3`,
    ).bind(day, userId, month),
  );
  return {
    todayTokens: r?.t_tokens ?? 0,
    todayRequests: r?.t_req ?? 0,
    todayErrors: r?.t_err ?? 0,
    monthTokens: r?.m_tokens ?? 0,
    monthRequests: r?.m_req ?? 0,
  };
}

/** Throws 429 QUOTA_EXCEEDED when the user has used up today's or this month's allowance. */
export async function assertWithinQuota(env: Env, userId: string): Promise<void> {
  const [quota, used] = await Promise.all([effectiveQuota(env, userId), usageTotals(env, userId)]);
  if (used.todayTokens >= quota.dailyTokens) {
    throw quotaExceeded('Your daily AI token allowance is used up. It resets at 00:00 UTC.', { scope: 'daily_tokens', used: used.todayTokens, limit: quota.dailyTokens });
  }
  if (used.todayRequests >= quota.dailyRequests) {
    throw quotaExceeded('You reached today\'s AI request limit. It resets at 00:00 UTC.', { scope: 'daily_requests', used: used.todayRequests, limit: quota.dailyRequests });
  }
  if (used.monthTokens >= quota.monthlyTokens) {
    throw quotaExceeded('Your monthly AI token allowance is used up.', { scope: 'monthly_tokens', used: used.monthTokens, limit: quota.monthlyTokens });
  }
}

export async function usageSummary(env: Env, userId: string): Promise<UsageSummaryDto> {
  const [quota, totals] = await Promise.all([effectiveQuota(env, userId), usageTotals(env, userId)]);
  const since = new Date(Date.now() - 13 * 86400_000).toISOString().slice(0, 10);
  const [byDay, byModel] = await Promise.all([
    all<{ day: string; tokens: number; requests: number }>(
      env.DB.prepare(
        `SELECT day, SUM(input_tokens + output_tokens) AS tokens, COUNT(*) AS requests FROM ai_usage
         WHERE user_id = ? AND day >= ? AND status != 'error' GROUP BY day ORDER BY day`,
      ).bind(userId, since),
    ),
    all<{ model_id: string; tokens: number; requests: number; errors: number; fallbacks: number }>(
      env.DB.prepare(
        `SELECT model_id,
                COALESCE(SUM(CASE WHEN status != 'error' THEN input_tokens + output_tokens END), 0) AS tokens,
                SUM(CASE WHEN status != 'error' THEN 1 ELSE 0 END) AS requests,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                SUM(CASE WHEN status = 'fallback' THEN 1 ELSE 0 END) AS fallbacks
         FROM ai_usage WHERE user_id = ? AND day >= ? GROUP BY model_id ORDER BY tokens DESC`,
      ).bind(userId, monthStartDay()),
    ),
  ]);
  return {
    quota: { dailyTokens: quota.dailyTokens, dailyRequests: quota.dailyRequests, monthlyTokens: quota.monthlyTokens, custom: quota.custom },
    today: { tokens: totals.todayTokens, requests: totals.todayRequests, errors: totals.todayErrors },
    month: { tokens: totals.monthTokens, requests: totals.monthRequests },
    byDay,
    byModel: byModel.map((m) => ({ modelId: m.model_id, tokens: m.tokens, requests: m.requests, errors: m.errors, fallbacks: m.fallbacks })),
  };
}
