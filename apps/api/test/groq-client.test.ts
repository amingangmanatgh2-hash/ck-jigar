import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiClient } from '../src/ai/client';
import { resetCooldowns } from '../src/ai/cooldown';
import { loadHealth, modelsResponse, refreshHealth } from '../src/ai/health';
import { usageSummary } from '../src/ai/usage';
import { MODEL, calls, fakeAi, script } from './ai-helpers';
import { GROQ, fakeGroq, groqCalls, groqOff, groqOn, groqScript, withEnv } from './groq-helpers';
import { api, json, registerUser, waitFor } from './helpers';

const messages = (text = 'سلام') => [{ role: 'user' as const, content: text }];

describe('AiClient with Groq as the second provider', () => {
  let userId: string;
  let client: AiClient;

  beforeAll(async () => groqOn());
  afterAll(async () => groqOff());
  beforeEach(async () => {
    userId = (await registerUser('groq')).id;
    client = new AiClient(env);
    resetCooldowns();
    await env.DB.prepare('DELETE FROM model_health').run();
    await env.DB.prepare('DELETE FROM user_quotas').run();
    await fakeAi().setCatalog(null);
    await script([]);
    await fakeGroq().reset();
    delete (env as unknown as Record<string, unknown>).GROQ_MAX_INPUT_TOKENS;
  });

  /* ------------------------------------------------------------------------------------------------ who answers what */

  it('answers quick, small requests with Groq first, and records its real usage under the Groq model', async () => {
    await groqScript([{ respond: { text: '{"agent":"general"}', usage: { prompt: 33, completion: 6 } } }]);
    const out = await client.chat({ userId, role: 'fast', purpose: 'route', messages: messages('open my chat with Amin') });
    expect(out).toMatchObject({ text: '{"agent":"general"}', modelId: GROQ.oss20, fallbackFrom: null, usage: { input: 33, output: 6, estimated: false } });

    expect(await calls()).toHaveLength(0); // Workers AI was not asked at all
    const [sent] = await groqCalls();
    expect(sent!.model).toBe(GROQ.oss20);
    expect(sent!.body).toMatchObject({ temperature: 0.2, reasoning_effort: 'low', include_reasoning: false, messages: messages('open my chat with Amin') });
    expect(sent!.body.max_completion_tokens).toBeGreaterThan(400); // the requested cap plus room for hidden reasoning
    expect(sent!.body).not.toHaveProperty('max_tokens');

    const row = await env.DB.prepare('SELECT * FROM ai_usage WHERE user_id = ?').bind(userId).first<any>();
    expect(row).toMatchObject({ model_id: GROQ.oss20, input_tokens: 33, output_tokens: 6, status: 'ok', estimated: 0, purpose: 'route' });
    expect((await loadHealth(env)).get(GROQ.oss20)).toMatchObject({ status: 'available' });
    const summary = await usageSummary(env, userId);
    expect(summary.byModel).toEqual([{ modelId: GROQ.oss20, tokens: 39, requests: 1, errors: 0, fallbacks: 0 }]);
  });

  it('keeps conversation on Workers AI first (Groq is not even called)', async () => {
    await script([{ respond: { text: 'پاسخ از کلودفلر' } }]);
    const out = await client.chat({ userId, role: 'chat', purpose: 'chat', messages: messages() });
    expect(out).toMatchObject({ modelId: MODEL.gemma, fallbackFrom: null });
    expect(await groqCalls()).toHaveLength(0);
  });

  it('streams a Groq answer: visible text only (the thinking is dropped), usage from the last chunk', async () => {
    await groqScript([{ respond: { text: 'سلام! چطور کمک کنم؟ 😊', reasoning: 'private chain of thought', usage: { prompt: 12, completion: 14 } } }]);
    const deltas: string[] = [];
    const out = await client.chatStream({ userId, role: 'fast', purpose: 'chat', messages: messages('hi') }, (t) => void deltas.push(t));
    expect(out).toMatchObject({ text: 'سلام! چطور کمک کنم؟ 😊', modelId: GROQ.oss20, usage: { input: 12, output: 14, estimated: false } });
    expect(deltas.join('')).toBe(out.text);
    expect(deltas.length).toBeGreaterThan(2);
    expect(deltas.join('')).not.toContain('private');
    const [sent] = await groqCalls();
    expect(sent!.stream).toBe(true);
    expect(sent!.body).not.toHaveProperty('stream_options');
  });

  it('estimates usage (and says so) when Groq reports none', async () => {
    await groqScript([{ respond: { text: 'x'.repeat(400), noUsage: true } }]);
    const out = await client.chat({ userId, role: 'fast', purpose: 'title', messages: messages() });
    expect(out.usage.estimated).toBe(true);
    expect(out.usage.output).toBeGreaterThan(50);
  });

  /* ------------------------------------------------------------------------------------------------ fallback, both ways */

  it('falls back from Groq to Workers AI when Groq refuses (429), and then leaves the busy models alone until Retry-After', async () => {
    await fakeGroq().configure({ failures: [{ status: 429, retryAfter: 30, times: 2, message: 'Rate limit reached for model on tokens per minute (TPM)' }] });
    await script([{ respond: { text: 'از کلودفلر' } }]);
    const first = await client.chat({ userId, role: 'fast', purpose: 'route', messages: messages() });
    expect(first).toMatchObject({ text: 'از کلودفلر', modelId: MODEL.gemma, fallbackFrom: GROQ.oss20 });
    expect(await groqCalls()).toHaveLength(2); // both Groq models were asked once
    const errors = await env.DB.prepare("SELECT model_id, error_code FROM ai_usage WHERE user_id = ? AND status = 'error' ORDER BY model_id").bind(userId).all<any>();
    expect(errors.results.map((r) => [r.model_id, r.error_code])).toEqual([[GROQ.oss120, 'capacity'], [GROQ.oss20, 'capacity']]);
    // a busy model is not "gone": the models list still treats Groq as usable
    expect((await loadHealth(env)).get(GROQ.oss20)?.status ?? 'unknown').not.toBe('unavailable');

    await fakeGroq().clearCalls();
    const second = await client.chat({ userId, role: 'fast', purpose: 'route', messages: messages() });
    expect(second).toMatchObject({ modelId: MODEL.gemma, fallbackFrom: null }); // nothing was wasted on a refusal that is certain to repeat
    expect(await groqCalls()).toHaveLength(0);

    resetCooldowns(); // …until the pause is over
    await fakeGroq().reset();
    await groqScript([{ respond: { text: 'برگشت به گروک' } }]);
    expect((await client.chat({ userId, role: 'fast', purpose: 'route', messages: messages() })).modelId).toBe(GROQ.oss20);
  });

  it('falls back from Groq on a server error and on an empty answer; the other Groq model gets its turn before Workers AI', async () => {
    await fakeGroq().configure({ failures: [{ status: 500 }] });
    await groqScript([{ respond: { text: 'از مدل دوم گروک' } }]);
    const out = await client.chat({ userId, role: 'fast', purpose: 'plan', messages: messages() });
    expect(out).toMatchObject({ text: 'از مدل دوم گروک', modelId: GROQ.oss120, fallbackFrom: GROQ.oss20 });

    await fakeGroq().reset();
    await groqScript([{ respond: { text: '' } }]);
    await script([{ respond: { text: 'از کلودفلر' } }]);
    const empty = await client.chat({ userId, role: 'fast', purpose: 'plan', messages: messages() });
    expect(empty).toMatchObject({ text: 'از کلودفلر', modelId: MODEL.gemma, fallbackFrom: GROQ.oss20 });
  });

  it('falls back from Workers AI to Groq when the Cloudflare models fail', async () => {
    await script([{ respond: { error: '5007: No such model' } }]); // every Workers AI model is gone
    await groqScript([{ respond: { text: 'از گروک' } }]);
    const out = await client.chat({ userId, role: 'chat', purpose: 'chat', messages: messages() });
    expect(out).toMatchObject({ text: 'از گروک', modelId: GROQ.oss120, fallbackFrom: MODEL.gemma });
    expect((await groqCalls())[0]!.body.reasoning_effort).toBe('medium'); // conversation, not a quick task
  });

  it('keeps answering from Groq when the Workers AI allowance is spent — and does not hammer the other Cloudflare models', async () => {
    await script([{ respond: { error: '3036: you have used up your daily free allocation of 10,000 neurons' } }]);
    await groqScript([{ respond: { text: 'پاسخ از گروک' } }]);
    const out = await client.chat({ userId, role: 'chat', purpose: 'chat', messages: messages() });
    expect(out).toMatchObject({ text: 'پاسخ از گروک', modelId: GROQ.oss120, fallbackFrom: MODEL.gemma });
    expect(await calls()).toHaveLength(1); // one refusal is enough: the account is spent for every Workers AI model
  });

  it('says why when nothing could answer: both providers out', async () => {
    await script([{ respond: { error: '3036: you have used up your daily free allocation of 10,000 neurons' } }]);
    await fakeGroq().configure({ failures: [{ status: 429, retryAfter: 5, times: 5 }] });
    await expect(client.chat({ userId, role: 'chat', purpose: 'chat', messages: messages() })).rejects.toMatchObject({ code: 'AI_BUSY', status: 503 });
    // and, without Groq, the old behaviour is unchanged: the spent allowance ends the call after the first refusal
    resetCooldowns();
    await fakeAi().clearCalls();
    const alone = new AiClient(withEnv({ GROQ_API_KEY: undefined }));
    await expect(alone.chat({ userId, role: 'chat', purpose: 'chat', messages: messages() })).rejects.toMatchObject({ code: 'AI_ACCOUNT_LIMIT' });
    expect(await calls()).toHaveLength(1);
  });

  /* ------------------------------------------------------------------------------------------------ what Groq is never asked */

  it('never calls Groq, and offers none of its models, when the key is not set', async () => {
    const bare = new AiClient(withEnv({ GROQ_API_KEY: undefined }));
    expect((await bare.candidates({ role: 'fast' })).every((m) => m.provider === 'workers-ai')).toBe(true);
    await script([{ respond: { text: 'کلودفلر' } }]);
    expect(await bare.chat({ userId, role: 'fast', purpose: 'route', messages: messages() })).toMatchObject({ modelId: MODEL.gemma });
    expect(await groqCalls()).toHaveLength(0);
  });

  it('works with Groq alone when there is no Workers AI binding', async () => {
    const groqOnly = new AiClient(withEnv({ AI: undefined }));
    expect(groqOnly.connected).toBe(true);
    await groqScript([{ respond: { text: 'فقط گروک' } }]);
    expect(await groqOnly.chat({ userId, role: 'chat', purpose: 'chat', messages: messages() })).toMatchObject({ modelId: GROQ.oss120, text: 'فقط گروک' });
    const neither = new AiClient(withEnv({ AI: undefined, GROQ_API_KEY: undefined }));
    expect(neither.connected).toBe(false);
    await expect(neither.chat({ userId, role: 'chat', purpose: 'chat', messages: messages() })).rejects.toMatchObject({ code: 'AI_NOT_CONNECTED', status: 503 });
  });

  it('does not send Groq a prompt its free tier would refuse (tokens per minute); the limit can be raised', async () => {
    const big = 'word '.repeat(5200); // ~6500 estimated tokens
    await script([{ respond: { text: 'از کلودفلر' } }]);
    const out = await client.chat({ userId, role: 'fast', purpose: 'summary', messages: messages(big) });
    expect(out).toMatchObject({ modelId: MODEL.gemma, fallbackFrom: null });
    expect(await groqCalls()).toHaveLength(0);

    (env as unknown as Record<string, unknown>).GROQ_MAX_INPUT_TOKENS = '20000'; // a paid Groq plan
    await groqScript([{ respond: { text: 'از گروک' } }]);
    expect((await client.chat({ userId, role: 'fast', purpose: 'summary', messages: messages(big) })).modelId).toBe(GROQ.oss20);
  });

  it('never sends images to Groq (its models here cannot see them)', async () => {
    const img = [{ role: 'user' as const, content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }];
    await script([{ respond: { text: 'یک تصویر' } }]);
    const out = await client.chat({ userId, role: 'fast', purpose: 'vision', needsVision: true, messages: img as never });
    expect(out.modelId).toBe(MODEL.gemma);
    expect(await groqCalls()).toHaveLength(0);
  });

  it('gives a reasoning model room to think: a small cap is enough because of the headroom, and an empty answer is not accepted', async () => {
    await groqScript([{ respond: { text: 'کوتاه', emptyIfCapBelow: 500 } }]);
    // route: 200 requested tokens → 600 sent → the model has room to think and answer
    expect(await client.chat({ userId, role: 'fast', purpose: 'route', messages: messages() })).toMatchObject({ text: 'کوتاه', modelId: GROQ.oss20 });
    expect((await groqCalls())[0]!.body.max_completion_tokens).toBe(600);

    // a model that still returns nothing (the thinking used everything) is skipped, not shown as an empty answer
    await fakeGroq().reset();
    await groqScript([{ respond: { text: 'کوتاه', emptyIfCapBelow: 100_000 } }]);
    await script([{ respond: { text: 'از کلودفلر' } }]);
    expect(await client.chat({ userId, role: 'fast', purpose: 'route', messages: messages() })).toMatchObject({ text: 'از کلودفلر', modelId: MODEL.gemma });
  });

  /* ------------------------------------------------------------------------------------------------ limits and cancellation */

  it('enforces the per-user quota BEFORE asking Groq as well', async () => {
    await env.DB.prepare('INSERT INTO user_quotas (user_id, daily_tokens, updated_at) VALUES (?, 100, ?)').bind(userId, Date.now()).run();
    await groqScript([{ respond: { text: 'x', usage: { prompt: 80, completion: 40 } } }]);
    await client.chat({ userId, role: 'fast', purpose: 'route', messages: messages() }); // 120 tokens used now
    await fakeGroq().clearCalls();
    await expect(client.chat({ userId, role: 'fast', purpose: 'route', messages: messages() })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', status: 429 });
    expect(await groqCalls()).toHaveLength(0);
  });

  it('cancels a Groq stream for real: the HTTP request is aborted, so the tokens stop being generated', async () => {
    await groqScript([{ respond: { text: 'لورم '.repeat(80), chunkDelayMs: 15 } }]);
    const controller = new AbortController();
    const deltas: string[] = [];
    const p = client.chatStream({ userId, role: 'fast', purpose: 'chat', signal: controller.signal, messages: messages('long') }, (t) => {
      deltas.push(t);
      if (deltas.length === 3) controller.abort();
    });
    await expect(p).rejects.toMatchObject({ code: 'AI_ABORTED' });
    expect(deltas.length).toBeLessThan(20);
    await waitFor(async () => (await groqCalls())[0]?.cancelled === true);
    // a cancelled answer is not an error and does not mark the model as broken
    expect((await loadHealth(env)).get(GROQ.oss20)?.status ?? 'unknown').not.toBe('unavailable');
  });

  it('does not let a mid-stream failure switch models after text reached the user', async () => {
    await groqScript([{ respond: { text: 'یک دو سه چهار پنج شش', failAfterChunks: 2, error: 'stream broke' } }]);
    const deltas: string[] = [];
    await expect(client.chatStream({ userId, role: 'fast', purpose: 'chat', messages: messages() }, (t) => void deltas.push(t))).rejects.toBeTruthy();
    expect(deltas.length).toBeGreaterThan(0);
    expect(await calls()).toHaveLength(0);
  });

  /* ------------------------------------------------------------------------------------------------ availability */

  it('verifies Groq models with the key\'s model list plus a real call, and shows exactly what it found', async () => {
    await fakeGroq().configure({ catalog: [GROQ.oss20] }); // this key cannot use the 120B model
    await fakeAi().setCatalog([MODEL.gemma]);
    await script([{ respond: { text: 'ok' } }]);
    await groqScript([{ respond: { text: 'ok' } }]);
    await refreshHealth(env);
    const res = await modelsResponse(env);
    const by = Object.fromEntries(res.models.map((m) => [m.id, m]));

    expect(res.providers).toEqual([
      { id: 'workers-ai', label: 'Cloudflare Workers AI', connected: true },
      { id: 'groq', label: 'Groq', connected: true },
    ]);
    expect(by[GROQ.oss20]).toMatchObject({ provider: 'groq', status: 'available', selectable: true, vendor: 'OpenAI' });
    expect(by[GROQ.oss120]).toMatchObject({ provider: 'groq', status: 'unavailable', selectable: false });
    expect(by[GROQ.oss120]!.reason).toMatch(/Groq 404.*model_not_found/);
    expect(by[MODEL.gemma]).toMatchObject({ provider: 'workers-ai', status: 'available' });
    expect(res.defaults.fast).toBe(GROQ.oss20); // the verified quick model
    expect(res.defaults.chat).toBe(MODEL.gemma); // conversation stays on Workers AI
    // the probe was real: a request for exactly the model, with the health-check input and a tiny budget
    const probe = (await groqCalls()).find((c) => c.model === GROQ.oss20)!;
    expect(probe.user).toContain('Reply with the single word: ok');
    expect(probe.body.max_completion_tokens).toBeLessThan(500);
  });

  it('shows every Groq model as unavailable (with Groq\'s own words) when the key is rejected — and leaves Workers AI alone', async () => {
    await fakeGroq().configure({ validKeys: ['some-other-key'] });
    await script([{ respond: { text: 'ok' } }]);
    await refreshHealth(env);
    const res = await modelsResponse(env);
    const groq = res.models.filter((m) => m.provider === 'groq');
    expect(groq.length).toBeGreaterThan(0);
    for (const m of groq) {
      expect(m).toMatchObject({ status: 'unavailable', selectable: false });
      expect(m.reason).toMatch(/Groq 401 \(invalid_api_key\): Invalid API Key/);
    }
    expect(res.models.find((m) => m.id === MODEL.gemma)).toMatchObject({ status: 'available' });
    expect(res.defaults.fast).toBe(MODEL.gemma); // never a Groq model that is known not to work
    // …and a refused key does not stop a quick request from being answered
    await script([{ respond: { text: 'ok, from Cloudflare' } }]);
    expect(await client.chat({ userId, role: 'fast', purpose: 'route', messages: messages() })).toMatchObject({ modelId: MODEL.gemma });
  });

  it('is honest about Groq not being connected: its models are unavailable with a clear reason, and Groq is never probed', async () => {
    const bare = withEnv({ GROQ_API_KEY: undefined });
    await fakeGroq().clearCalls();
    await script([{ respond: { text: 'ok' } }]);
    await refreshHealth(bare);
    const res = await modelsResponse(bare);
    expect(res.providers.find((p) => p.id === 'groq')).toMatchObject({ connected: false });
    for (const m of res.models.filter((x) => x.provider === 'groq')) expect(m).toMatchObject({ status: 'unavailable', reasonCode: 'not_connected', selectable: false });
    expect(await groqCalls()).toHaveLength(0);
    expect(await fakeGroq().listCallCount()).toBe(0);
  });

  /* ------------------------------------------------------------------------------------------------ secrets */

  it('never lets the API key into a response, a stored error, a log line of the run or the usage records', async () => {
    const SECRET = 'gsk_LEAKCHECK_9f8e7d6c5b4a';
    (env as unknown as Record<string, unknown>).GROQ_API_KEY = SECRET;
    await fakeGroq().configure({ validKeys: [SECRET] });
    try {
      // one of each: success, refusal, rejected parameter, server error, then a probe of every model
      await groqScript([{ respond: { text: 'ok' } }]);
      await client.chat({ userId, role: 'fast', purpose: 'route', messages: messages() });
      await fakeGroq().configure({ failures: [{ status: 429, retryAfter: 3 }, { status: 500 }, { status: 401, message: 'Invalid API Key', code: 'invalid_api_key' }] });
      await script([{ respond: { text: 'cf' } }]);
      await client.chat({ userId, role: 'fast', purpose: 'route', messages: messages() }).catch(() => undefined);
      await refreshHealth(env);
      const user = await registerUser('leak');
      const asText = JSON.stringify([
        await env.DB.prepare('SELECT * FROM ai_usage').all(),
        await env.DB.prepare('SELECT * FROM model_health').all(),
        await env.DB.prepare('SELECT * FROM run_events').all(),
        await json(await api('GET', '/api/ai/models', { token: user.token })),
        await json(await api('GET', '/api/ai/usage', { token: user.token })),
      ]);
      expect(asText).not.toContain('LEAKCHECK');
      expect(asText.length).toBeGreaterThan(500); // the scan really looked at something
      for (const call of await groqCalls()) expect(JSON.stringify(call.body)).not.toContain('LEAKCHECK');
    } finally {
      (env as unknown as Record<string, unknown>).GROQ_API_KEY = 'test-groq-key';
    }
  });
});
