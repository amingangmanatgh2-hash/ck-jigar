import { MODEL_ROLES, type ModelDto, type ModelRole, type ModelsResponse } from '@aminchat/shared';
import { MODEL_HEALTH_TTL_MS } from '../config/limits';
import { all } from '../db/helpers';
import type { Env } from '../env';
import { classifyAiError, marksUnavailable } from './errors';
import { MODELS, ROLE_PRIORITY, SELECTABLE_CHAT_MODELS, getModel, isDeprecated, type ModelSpec } from './models';
import { PROVIDER_LABEL, anyProviderConnected, providerConnected, providerList } from './providers';
import { groqCatalog, groqRun } from './providers/groq';

export interface HealthRow {
  model_id: string;
  status: 'available' | 'unavailable' | 'unknown';
  reason: string | null;
  catalog_listed: number | null;
  latency_ms: number | null;
  checked_at: number;
}

export async function loadHealth(env: Env): Promise<Map<string, HealthRow>> {
  const rows = await all<HealthRow>(env.DB.prepare('SELECT * FROM model_health'));
  return new Map(rows.map((r) => [r.model_id, r]));
}

export async function saveHealth(
  env: Env,
  id: string,
  status: HealthRow['status'],
  reason: string | null,
  extra: { catalogListed?: boolean | null; latencyMs?: number | null } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO model_health (model_id, status, reason, catalog_listed, latency_ms, checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (model_id) DO UPDATE SET status = excluded.status, reason = excluded.reason,
       catalog_listed = COALESCE(excluded.catalog_listed, model_health.catalog_listed),
       latency_ms = COALESCE(excluded.latency_ms, model_health.latency_ms), checked_at = excluded.checked_at`,
  )
    .bind(id, status, reason?.slice(0, 300) ?? null, extra.catalogListed === undefined || extra.catalogListed === null ? null : extra.catalogListed ? 1 : 0, extra.latencyMs ?? null, Date.now())
    .run();
}

/** A cached "unavailable" verdict only holds for the TTL: capacity problems and re-enabled models must be retried. */
export function isBlocked(row: HealthRow | undefined, now = Date.now()): boolean {
  return !!row && row.status === 'unavailable' && now - row.checked_at < MODEL_HEALTH_TTL_MS;
}

export async function recordCallOutcome(env: Env, spec: ModelSpec, ok: boolean, err?: unknown, latencyMs?: number): Promise<void> {
  try {
    if (ok) {
      await saveHealth(env, spec.id, 'available', null, { latencyMs: latencyMs ?? null });
      return;
    }
    const e = classifyAiError(err, spec.id);
    if (marksUnavailable(e.kind)) await saveHealth(env, spec.id, 'unavailable', e.message);
  } catch (e) {
    console.error('health write failed', String((e as Error)?.message ?? e));
  }
}

async function catalogIds(env: Env): Promise<Set<string> | null> {
  const ai = env.AI as unknown as { models?: (p: Record<string, unknown>) => Promise<{ id?: string; name?: string }[]> } | undefined;
  if (!ai || typeof ai.models !== 'function') return null;
  const ids = new Set<string>();
  try {
    for (let page = 1; page <= 6; page++) {
      const list = await ai.models({ per_page: 100, page });
      if (!Array.isArray(list) || list.length === 0) break;
      for (const m of list) if (typeof m?.name === 'string') ids.add(m.name);
      if (list.length < 100) break;
    }
  } catch (err) {
    console.warn('AI.models() failed', String((err as Error)?.message ?? err));
    return null;
  }
  return ids.size > 0 ? ids : null;
}

/**
 * Verifies model availability against the real providers (Workers AI account, Groq key):
 *  1. catalog lookup (env.AI.models for Workers AI, GET /models for Groq) when supported, then
 *  2. a minimal real inference for text models (the only proof that the model really answers for *this* account/key).
 * ASR/image models are not probed (they would cost money per check) — they are "available" only if the catalog lists them.
 * Models of a provider that is not connected are not touched: they are shown as "not connected" without any verdict.
 */
export async function refreshHealth(env: Env, only?: string[]): Promise<HealthRow[]> {
  if (!anyProviderConnected(env)) return [];
  const targets = MODELS.filter((m) => (!only || only.includes(m.id)) && providerConnected(env, m.provider));
  const [workersCatalog, groqIds] = await Promise.all([
    targets.some((m) => m.provider === 'workers-ai') ? catalogIds(env) : null,
    targets.some((m) => m.provider === 'groq') ? groqCatalog(env) : null,
  ]);
  const probe = async (spec: ModelSpec) => {
    if (isDeprecated(spec)) return saveHealth(env, spec.id, 'unavailable', `Deprecated on ${spec.deprecatedOn}`);
    const catalog = spec.provider === 'groq' ? groqIds : workersCatalog;
    const listed = catalog ? catalog.has(spec.id) : null;
    if (spec.api === 'asr' || spec.api === 'image') {
      if (listed === true) return saveHealth(env, spec.id, 'available', null, { catalogListed: true });
      if (listed === false) return saveHealth(env, spec.id, 'unavailable', 'Not listed in the Workers AI catalog', { catalogListed: false });
      return saveHealth(env, spec.id, 'unknown', 'Not verified (cannot be probed without cost)');
    }
    const started = Date.now();
    try {
      const input: Record<string, unknown> = { messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 24, ...(spec.tune?.('health') ?? {}) };
      let out: unknown;
      if (spec.provider === 'groq') {
        out = await groqRun(env)(spec.id, input, { signal: AbortSignal.timeout(30_000) });
        if (!Array.isArray((out as { choices?: unknown })?.choices) || (out as { choices: unknown[] }).choices.length === 0) throw new Error('Groq answered without a completion');
      } else {
        const options: Record<string, unknown> = { tags: ['amin-chat', 'purpose:health'] };
        if (env.AI_GATEWAY_ID) options.gateway = { id: env.AI_GATEWAY_ID };
        out = await (env.AI as unknown as { run(id: string, i: unknown, o?: unknown): Promise<unknown> }).run(spec.id, input, options);
        if (out === undefined || out === null) throw new Error('empty response');
      }
      await saveHealth(env, spec.id, 'available', null, { catalogListed: listed, latencyMs: Date.now() - started });
    } catch (err) {
      const e = classifyAiError(err, spec.id);
      // A transient problem (capacity, 5xx, timeout) says nothing lasting: keep the model usable but unverified.
      if (marksUnavailable(e.kind) || e.kind === 'bad_request') await saveHealth(env, spec.id, 'unavailable', e.message, { catalogListed: listed });
      else await saveHealth(env, spec.id, 'unknown', `Probe failed (${e.kind}): ${e.message}`, { catalogListed: listed });
    }
  };
  await Promise.all(targets.map(probe));
  return [...(await loadHealth(env)).values()];
}

export async function ensureFreshHealth(env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
  if (!anyProviderConnected(env)) return;
  const health = await loadHealth(env);
  const stale = MODELS.some((m) => {
    if (!providerConnected(env, m.provider)) return false;
    const h = health.get(m.id);
    return !h || Date.now() - h.checked_at > MODEL_HEALTH_TTL_MS;
  });
  if (!stale) return;
  const work = refreshHealth(env).catch((e) => console.error('health refresh failed', String((e as Error)?.message ?? e)));
  if (ctx) ctx.waitUntil(work);
  else await work;
}

/** `connected`: the model's own provider has credentials in this environment. */
export function toModelDto(spec: ModelSpec, row: HealthRow | undefined, connected: boolean): ModelDto {
  let status: ModelDto['status'];
  let reason: string | null;
  let reasonCode: ModelDto['reasonCode'] = null;
  if (!connected) {
    status = 'unavailable';
    reason = `${PROVIDER_LABEL[spec.provider]} is not connected in this environment`;
    reasonCode = 'not_connected';
  } else if (isDeprecated(spec)) {
    status = 'unavailable';
    reason = `Deprecated on ${spec.deprecatedOn}`;
    reasonCode = 'deprecated';
  } else if (!row) {
    status = 'unknown';
    reason = 'Not verified yet';
    reasonCode = 'unverified';
  } else {
    status = row.status;
    reason = row.reason;
    reasonCode = row.status === 'available' ? null : 'check_failed';
    // A verdict older than the TTL is no longer proof of anything.
    if (row.status === 'available' && Date.now() - row.checked_at > MODEL_HEALTH_TTL_MS * 3) {
      status = 'unknown';
      reason = 'Verification is outdated';
      reasonCode = 'stale';
    }
  }
  return {
    id: spec.id,
    label: spec.label,
    vendor: spec.vendor,
    provider: spec.provider,
    roles: spec.roles,
    capabilities: spec.capabilities,
    contextWindow: spec.contextWindow,
    pricing: spec.pricing,
    deprecatedOn: spec.deprecatedOn ?? null,
    status,
    reason,
    reasonCode,
    checkedAt: row?.checked_at ?? null,
    latencyMs: row?.latency_ms ?? null,
    selectable: status !== 'unavailable' && SELECTABLE_CHAT_MODELS.includes(spec.id),
  };
}

export async function modelsResponse(env: Env): Promise<ModelsResponse> {
  const health = await loadHealth(env);
  const models = MODELS.map((m) => toModelDto(m, health.get(m.id), providerConnected(env, m.provider)));
  const defaults = {} as Record<ModelRole, string | null>;
  for (const role of MODEL_ROLES) {
    // The default shown to the user is the first model that is verified available — never an unverified one.
    const first = ROLE_PRIORITY[role].map((id) => models.find((m) => m.id === id)).find((m) => m?.status === 'available');
    defaults[role] = first?.id ?? null;
  }
  const checked = [...health.values()].reduce((max, r) => Math.max(max, r.checked_at), 0);
  return { providers: providerList(env), models, defaults, checkedAt: checked || null };
}

export { getModel };
