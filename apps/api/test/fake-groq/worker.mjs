/**
 * TEST DOUBLE for Groq's OpenAI-compatible API (https://api.groq.com/openai/v1) — used ONLY by the Vitest integration tests
 * (wired as the `GROQ_API` service binding in vitest.config.ts). It is never part of the Worker bundle and never reachable from a
 * deployed Worker: in production the binding does not exist and the real https://api.groq.com is called.
 *
 * It enforces the rules Groq documents (console.groq.com/docs/api-reference, /docs/errors, /docs/reasoning), so a request the real API
 * would refuse is refused here too:
 *   - Authorization: Bearer <key> with a known key, otherwise 401 {error:{message:"Invalid API Key", type, code:"invalid_api_key"}}
 *   - the model must be in the catalog, otherwise 404 model_not_found
 *   - reasoning_effort of gpt-oss is low | medium | high (anything else: 400); include_reasoning and reasoning_format are mutually exclusive
 *   - n must be 1; stream_options only with stream
 *   - 429 with Retry-After, 413, 5xx, dropped streams — injected per test
 * Replies are OpenAI chat-completions JSON, or SSE `data: {…}` chunks ending with `data: [DONE]`; the last chunk carries the usage the way
 * Groq does (`x_groq.usage`). Reasoning models send their thinking in a separate `reasoning` field, never in `content`.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';

const KEY = 'test-groq-key';
const ALL_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'whisper-large-v3-turbo'];

const fresh = () => ({
  validKeys: [KEY],
  catalog: [...ALL_MODELS], // ids in GET /models; a chat call for another id is a 404
  listFails: 0, // answer the next N GET /models with 500
  rejectParams: [], // names of request fields the "API" refuses with a 400 (to test the retry without optional tuning)
  failures: [], // queue consumed by chat calls: { status, retryAfter?, message?, code?, type?, times? }
});

let cfg = fresh();
let rules = [];
let calls = [];
let listCalls = 0;

const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ') : '');

const jsonResponse = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const groqError = (status, message, code, type = 'invalid_request_error', headers = {}) => jsonResponse({ error: { message, type, ...(code ? { code } : {}) } }, status, headers);
const sse = (obj) => enc.encode('data: ' + (typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n\n');

function pieces(text) {
  const chars = Array.from(text);
  const out = [];
  for (let i = 0; i < chars.length; i += 4) out.push(chars.slice(i, i + 4).join(''));
  return out;
}

function describe(body, key) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n');
  const users = messages.filter((m) => m.role === 'user');
  const user = users.length ? textOf(users[users.length - 1].content) : '';
  return { model: body.model, system, user, all: messages.map((m) => textOf(m.content)).join('\n'), stream: body.stream === true, body, key };
}

function matches(when, d) {
  if (!when) return true;
  if (when.model && d.model !== when.model) return false;
  if (when.notModel && d.model === when.notModel) return false;
  if (when.system && !d.system.includes(when.system)) return false;
  if (when.user && !d.user.includes(when.user)) return false;
  if (when.any && !d.all.includes(when.any)) return false;
  if (when.stream !== undefined && d.stream !== when.stream) return false;
  return true;
}

export class FakeGroq extends WorkerEntrypoint {
  /* ---- control (RPC from the tests) */
  async reset(patch) {
    cfg = { ...fresh(), ...(patch ?? {}) };
    rules = [];
    calls = [];
    listCalls = 0;
    return true;
  }
  async configure(patch) {
    cfg = { ...cfg, ...patch };
    return true;
  }
  async setRules(newRules) {
    rules = (newRules ?? []).map((r) => ({ ...r, used: 0 }));
    return true;
  }
  async getCalls() {
    return calls.map(({ model, system, user, all, stream, body, key, cancelled }) => ({ model, system, user, all, stream, body, key, cancelled: cancelled === true }));
  }
  async clearCalls() {
    calls = [];
    listCalls = 0;
    return true;
  }
  async listCallCount() {
    return listCalls;
  }

  /* ---- the HTTP surface the Worker talks to */
  async fetch(request) {
    const url = new URL(request.url);
    if (url.host !== 'api.groq.com') return new Response('unknown host ' + url.host, { status: 502 });
    const auth = request.headers.get('authorization') ?? '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    if (request.method === 'GET' && url.pathname === '/openai/v1/models') {
      listCalls++;
      if (!cfg.validKeys.includes(key)) return groqError(401, 'Invalid API Key', 'invalid_api_key');
      if (cfg.listFails > 0) {
        cfg.listFails--;
        return groqError(500, 'The server had an error while processing your request.', undefined, 'internal_server_error');
      }
      return jsonResponse({ object: 'list', data: cfg.catalog.map((id) => ({ id, object: 'model', active: true, owned_by: 'x', context_window: 131072 })) });
    }
    if (request.method === 'POST' && url.pathname === '/openai/v1/chat/completions') return this.chat(request, key);
    return groqError(404, `Unknown request URL: ${request.method} ${url.pathname}`, 'unknown_url');
  }

  async chat(request, key) {
    let body;
    const raw = await request.text();
    try {
      body = JSON.parse(raw);
    } catch {
      return groqError(400, 'Invalid JSON body');
    }
    const d = describe(body, key);
    calls.push(d);

    if (!cfg.validKeys.includes(key)) return groqError(401, 'Invalid API Key', 'invalid_api_key');

    // injected failures come first (rate limits, outages) — like real life they can hit any request
    const f = cfg.failures[0];
    if (f) {
      f.times = (f.times ?? 1) - 1;
      if (f.times <= 0) cfg.failures.shift();
      const headers = f.retryAfter !== undefined ? { 'retry-after': String(f.retryAfter) } : {};
      return groqError(f.status, f.message ?? 'injected failure', f.code, f.type ?? (f.status === 429 ? 'tokens' : 'internal_server_error'), headers);
    }

    if (typeof body.model !== 'string' || !cfg.catalog.includes(body.model)) {
      return groqError(404, `The model \`${body.model}\` does not exist or you do not have access to it.`, 'model_not_found');
    }
    for (const name of cfg.rejectParams) if (name in body) return groqError(400, `\`${name}\` is not supported with this model`, undefined);
    if (!Array.isArray(body.messages) || body.messages.length === 0) return groqError(400, '`messages` must be a non-empty array');
    if (body.n !== undefined && body.n !== 1) return groqError(400, '`n` must be at most 1');
    if ('include_reasoning' in body && 'reasoning_format' in body) return groqError(400, '`include_reasoning` and `reasoning_format` are mutually exclusive');
    if (body.reasoning_effort !== undefined && body.model.startsWith('openai/gpt-oss') && !['low', 'medium', 'high'].includes(body.reasoning_effort)) {
      return groqError(400, `\`reasoning_effort\` must be one of low, medium, high for this model`);
    }
    if (body.stream_options !== undefined && body.stream !== true) return groqError(400, '`stream_options` is only allowed when `stream` is true');
    if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) return groqError(400, 'use max_completion_tokens, not both');

    const rule = rules.find((x) => (x.times === undefined || x.used < x.times) && matches(x.when, d));
    if (rule) rule.used++;
    const resp = rule?.respond ?? { text: 'default fake groq answer' };
    if (resp.delayMs) await sleep(resp.delayMs);
    if (resp.status) {
      const headers = resp.retryAfter !== undefined ? { 'retry-after': String(resp.retryAfter) } : {};
      return groqError(resp.status, resp.message ?? 'scripted failure', resp.code, undefined, headers);
    }

    const text = resp.json !== undefined ? JSON.stringify(resp.json) : (resp.text ?? '');
    const cap = body.max_completion_tokens ?? body.max_tokens;
    // A reasoning model spends the cap on thinking first: with no room left the answer is empty (finish_reason "length").
    const thinking = resp.reasoningTokens ?? 0;
    const empty = resp.emptyIfCapBelow !== undefined && typeof cap === 'number' && cap < resp.emptyIfCapBelow;
    const answer = empty ? '' : text;
    const usage = resp.noUsage
      ? undefined
      : { queue_time: 0.01, prompt_tokens: resp.usage?.prompt ?? 11, completion_tokens: resp.usage?.completion ?? Math.max(1, Math.ceil(answer.length / 4)) + thinking, total_tokens: 0, prompt_time: 0.001, completion_time: 0.01, total_time: 0.011 };
    const finish = empty ? 'length' : 'stop';
    const id = 'chatcmpl-fake-' + calls.length;

    if (body.stream === true && !resp.noStream) {
      let cancelled = false;
      const stream = new ReadableStream({
        async start(c) {
          const send = (obj) => {
            if (!cancelled) c.enqueue(sse(obj));
          };
          send({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
          if (resp.reasoning) send({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { reasoning: resp.reasoning }, finish_reason: null }] });
          let n = 0;
          for (const p of pieces(answer)) {
            if (cancelled) return;
            if (resp.failAfterChunks !== undefined && n >= resp.failAfterChunks) {
              send({ error: { message: resp.error ?? 'stream broke', type: 'server_error' } });
              c.close();
              return;
            }
            send({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
            n++;
            if (resp.chunkDelayMs) await sleep(resp.chunkDelayMs);
          }
          if (cancelled) return;
          send({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }], ...(usage ? { x_groq: { id: 'req_fake', usage } } : {}) });
          send('[DONE]');
          c.close();
        },
        cancel() {
          cancelled = true;
          calls[calls.length - 1].cancelled = true;
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const message = { role: 'assistant', content: answer, ...(resp.reasoning ? { reasoning: resp.reasoning } : {}) };
    return jsonResponse({ id, object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: finish }], ...(usage ? { usage, x_groq: { id: 'req_fake' } } : {}) });
  }
}

export default {
  fetch() {
    return new Response('use the FakeGroq entrypoint', { status: 500 });
  },
};
