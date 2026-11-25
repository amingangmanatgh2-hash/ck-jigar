/**
 * Groq (https://console.groq.com/docs/api-reference#chat-create) — an OpenAI-compatible chat API that answers in a fraction of a second.
 * It is the optional second provider: the fast one for short requests and a fallback for the rest (see ai/models.ts for which model
 * does what). Nothing here is Cloudflare specific; any other OpenAI-compatible provider would be one more file like this one.
 *
 * What is known from Groq's documentation, and used here:
 *   POST {base}/chat/completions, Authorization: Bearer <key>, body = OpenAI chat-completions + `max_completion_tokens`
 *   (`max_tokens` is deprecated there), `reasoning_effort` (gpt-oss: low | medium | high, anything else is a 400) and
 *   `include_reasoning`. A reply is `{choices:[{message:{content}}], usage:{prompt_tokens, completion_tokens}}`; a stream is SSE
 *   `data: {…choices[0].delta.content…}` ending with `data: [DONE]`. Errors are `{error:{message,type}}` with the HTTP codes
 *   400/401/403/404/413/422/429/498/500/502/503 (console.groq.com/docs/errors). GET {base}/models lists the models of the key.
 *
 * Free-tier limits are per model and per ORGANISATION (so shared by every user of this deployment): 30 requests/min, 1000/day and
 * 8000 tokens/min. Refusals (429/413) are therefore normal under load and are handled as ordinary fallbacks, never as failures.
 *
 * The key is read from the Worker secret GROQ_API_KEY only, sent only in the Authorization header of requests to Groq, and never
 * logged, stored, put in an error message or returned by any API.
 */
import type { Env } from '../../env';
import { AiError, type AiErrorKind } from '../errors';
import { getModel } from '../models';
import type { RunFn } from './types';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export const groqKey = (env: Env): string | null => {
  const key = env.GROQ_API_KEY?.trim();
  return key ? key : null;
};

export const groqConnected = (env: Env): boolean => groqKey(env) !== null;

/** The network. Tests bind a fake Groq as `GROQ_API`; in production that binding does not exist. */
const transport =
  (env: Env): typeof fetch =>
  (input, init) =>
    env.GROQ_API ? (env.GROQ_API.fetch(input as never, init as never) as unknown as Promise<Response>) : fetch(input, init);

/**
 * Reasoning models spend part of `max_completion_tokens` on thinking that is never shown. Without headroom a small cap (a 48-token
 * title) is used up by the thinking and the answer comes back empty. Only generated tokens are billed, so headroom costs nothing.
 */
const REASONING_HEADROOM: Record<string, number> = { low: 400, medium: 1000, high: 2500 };

/**
 * Request fields that only TUNE the model. If Groq refuses one of them (a 400 that names it) the call is repeated once without them:
 * a refused nicety must not cost the answer. (`stream_options` is never sent: Groq reports the usage in the last chunk anyway.)
 */
export const OPTIONAL_PARAMS = ['include_reasoning', 'reasoning_effort', 'reasoning_format', 'stream_options'] as const;
const OPTIONAL_PARAM_RE = new RegExp(OPTIONAL_PARAMS.join('|'));

/** Our neutral request (Workers AI style names) → the body Groq expects. Pure, so it is unit-tested. */
export function groqRequestBody(modelId: string, input: Record<string, unknown>, opts: { stripTuning?: boolean } = {}): Record<string, unknown> {
  const { max_tokens, ...rest } = input;
  const body: Record<string, unknown> = { ...rest, model: modelId };
  for (const name of OPTIONAL_PARAMS.filter((n) => n === 'stream_options' || opts.stripTuning)) delete body[name];
  const cap = Number(max_tokens);
  if (Number.isFinite(cap) && cap > 0) {
    const effort = !opts.stripTuning && typeof rest.reasoning_effort === 'string' ? rest.reasoning_effort : 'medium'; // medium: the models' own default
    const headroom = getModel(modelId)?.capabilities.reasoning ? (REASONING_HEADROOM[effort] ?? REASONING_HEADROOM.medium!) : 0;
    body.max_completion_tokens = Math.round(cap) + headroom;
  }
  return body;
}

/** HTTP status (+ Groq's error code and message) → the error kinds the fallback logic understands. */
export function groqErrorKind(status: number, code: string, detail: string): AiErrorKind {
  if (status === 401 || status === 403) return 'access';
  if (/terms_required|permission|blocked|not_allowed|restricted/i.test(code)) return 'access';
  if (status === 404 || /model_not_found|model_decommissioned|model_deprecated/i.test(code)) return 'model_unavailable';
  if (status === 400 && /decommission|has been deprecated|does not exist|model.{0,30}not found/i.test(detail)) return 'model_unavailable';
  if (status === 413) return 'too_large';
  if (status === 429 || status === 498 || status === 503) return 'capacity';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 400 || status === 422) return 'bad_request';
  if (status >= 500) return 'server';
  return 'unknown';
}

/** Builds the error for a non-2xx answer. The text comes from Groq's error object; the key never appears in it. */
export async function groqHttpError(res: Response, modelId: string): Promise<AiError> {
  let detail = '';
  let code = '';
  try {
    const text = (await res.text()).slice(0, 2000);
    try {
      const json = JSON.parse(text) as { error?: { message?: unknown; code?: unknown; type?: unknown }; message?: unknown };
      detail = String(json?.error?.message ?? json?.message ?? '');
      code = String(json?.error?.code ?? json?.error?.type ?? '');
    } catch {
      detail = text.replace(/\s+/g, ' ').trim();
    }
  } catch {
    // the body is only a courtesy
  }
  const retryAfter = Number(res.headers.get('retry-after'));
  const message = `Groq ${res.status}${code ? ` (${code})` : ''}: ${detail || res.statusText || 'no details'}`.slice(0, 400);
  return new AiError(groqErrorKind(res.status, code, detail), message, modelId, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.round(retryAfter * 1000) : undefined);
}

/**
 * `(model, input, options)` → the parsed reply, or the SSE byte stream when `input.stream` is true (the same contract as the Workers
 * AI binding, so AiClient treats both alike). `options.signal` aborts the HTTP request itself, which stops the tokens being billed.
 */
export function groqRun(env: Env): RunFn {
  const send = transport(env);
  return async (id, input, options) => {
    const key = groqKey(env);
    if (!key) throw new AiError('access', 'Groq is not connected: the GROQ_API_KEY secret is not set', id);
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
    const post = async (body: Record<string, unknown>): Promise<Response> => {
      try {
        return await send(`${GROQ_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: body.stream === true ? 'text/event-stream' : 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        // An abort is the caller's doing (cancel or deadline): let it through to be classified as such.
        if (signal?.aborted) throw err;
        throw new AiError('server', `Groq could not be reached: ${String((err as Error)?.message ?? err).slice(0, 200)}`, id);
      }
    };
    let body = groqRequestBody(id, input as Record<string, unknown>);
    let res = await post(body);
    if (!res.ok) {
      const err = await groqHttpError(res, id);
      const refusedTuning = err.kind === 'bad_request' && OPTIONAL_PARAM_RE.test(err.message) && OPTIONAL_PARAMS.some((n) => n in (input as object));
      if (!refusedTuning) throw err;
      body = groqRequestBody(id, input as Record<string, unknown>, { stripTuning: true });
      res = await post(body);
      if (!res.ok) throw await groqHttpError(res, id);
    }
    if (body.stream === true) {
      if (!res.body) throw new AiError('empty', 'Groq sent no stream', id);
      return res.body;
    }
    try {
      return await res.json();
    } catch {
      throw new AiError('server', 'Groq sent an answer that is not JSON', id);
    }
  };
}

/**
 * The model ids this key may use (GET /models), or null when the list cannot be read. A failure here is not fatal: the probe call
 * that follows says what is wrong (a rejected key shows up there as a 401).
 */
export async function groqCatalog(env: Env): Promise<Set<string> | null> {
  const key = groqKey(env);
  if (!key) return null;
  try {
    const res = await transport(env)(`${GROQ_BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { id?: unknown; active?: unknown }[] };
    const ids = new Set<string>();
    for (const m of json?.data ?? []) if (typeof m?.id === 'string' && m.active !== false) ids.add(m.id);
    return ids.size > 0 ? ids : null;
  } catch {
    return null;
  }
}
