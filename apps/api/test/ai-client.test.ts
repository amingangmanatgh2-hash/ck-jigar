import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { AiClient } from '../src/ai/client';
import { loadHealth, modelsResponse, refreshHealth, toModelDto, type HealthRow } from '../src/ai/health';
import { MODELS } from '../src/ai/models';
import { MODEL_HEALTH_TTL_MS } from '../src/config/limits';
import { usageSummary } from '../src/ai/usage';
import { MODEL, calls, fakeAi, script } from './ai-helpers';
import { registerUser } from './helpers';

const ask = (client: AiClient, userId: string, extra: Record<string, unknown> = {}) =>
  client.chat({ userId, role: 'chat', purpose: 'chat', messages: [{ role: 'user', content: 'سلام' }], ...extra } as never);

describe('AiClient (against the scripted Workers AI double)', () => {
  let userId: string;
  let client: AiClient;
  beforeEach(async () => {
    userId = (await registerUser('aic')).id;
    client = new AiClient(env);
    await env.DB.prepare('DELETE FROM model_health').run();
    await fakeAi().setCatalog(null);
  });

  it('uses the first model of the role priority list and records real usage numbers', async () => {
    await script([{ respond: { text: 'پاسخ نمونه', usage: { prompt: 21, completion: 7 } } }]);
    const out = await ask(client, userId);
    expect(out).toMatchObject({ text: 'پاسخ نمونه', modelId: MODEL.gemma, fallbackFrom: null, usage: { input: 21, output: 7, estimated: false } });
    const sent = (await calls())[0]!;
    expect(sent.model).toBe(MODEL.gemma);
    expect(sent.purpose).toBe('chat');
    expect(sent.inputs.messages).toEqual([{ role: 'user', content: 'سلام' }]);
    expect(sent.inputs.max_tokens).toBeGreaterThan(256);

    const row = await env.DB.prepare('SELECT * FROM ai_usage WHERE user_id = ?').bind(userId).first<any>();
    expect(row).toMatchObject({ model_id: MODEL.gemma, input_tokens: 21, output_tokens: 7, status: 'ok', estimated: 0, purpose: 'chat' });
    expect((await loadHealth(env)).get(MODEL.gemma)).toMatchObject({ status: 'available' });
  });

  it('estimates usage (and says so) when the model reports none', async () => {
    await script([{ respond: { text: 'x'.repeat(400), noUsage: true } }]);
    const out = await ask(client, userId);
    expect(out.usage.estimated).toBe(true);
    expect(out.usage.output).toBeGreaterThan(50);
    const row = await env.DB.prepare('SELECT estimated FROM ai_usage WHERE user_id = ?').bind(userId).first<any>();
    expect(row.estimated).toBe(1);
  });

  it('streams visible text in order and strips <think> reasoning', async () => {
    await script([{ respond: { text: '<think>private chain of thought</think>سلام! چطور کمک کنم؟ 😊', usage: { prompt: 5, completion: 9 } } }]);
    const deltas: string[] = [];
    const out = await client.chatStream({ userId, role: 'chat', purpose: 'chat', messages: [{ role: 'user', content: 'hi' }] }, (t) => void deltas.push(t));
    expect(out.text).toBe('سلام! چطور کمک کنم؟ 😊');
    expect(deltas.join('')).toBe(out.text);
    expect(deltas.length).toBeGreaterThan(2);
    expect(out.usage).toMatchObject({ input: 5, output: 9, estimated: false });
    const sent = (await calls())[0]!;
    expect(sent.inputs.stream).toBe(true);
    expect(sent.inputs.stream_options).toEqual({ include_usage: true });
  });

  it('normalises legacy-shaped answers', async () => {
    await script([
      { when: { model: MODEL.gemma }, respond: { error: '5007: No such model' } },
      { when: { model: MODEL.qwen }, respond: { error: '3040: Capacity temporarily exceeded' } },
      { when: { model: MODEL.gptOss120 }, respond: { error: '3040: Capacity temporarily exceeded' } },
      { when: { model: MODEL.llama }, respond: { text: 'legacy answer', legacy: true } },
    ]);
    const out = await ask(client, userId);
    expect(out).toMatchObject({ text: 'legacy answer', modelId: MODEL.llama });
  });

  it('falls back to the next model, logs it, and stops using a model that no longer exists', async () => {
    await script([
      { when: { model: MODEL.gemma }, respond: { error: '5007: No such model `@cf/google/gemma-4-26b-a4b-it` or task' } },
      { respond: { text: 'from the fallback' } },
    ]);
    const first = await ask(client, userId);
    expect(first).toMatchObject({ text: 'from the fallback', modelId: MODEL.qwen, fallbackFrom: MODEL.gemma });
    expect((await loadHealth(env)).get(MODEL.gemma)).toMatchObject({ status: 'unavailable' });
    expect((await loadHealth(env)).get(MODEL.qwen)).toMatchObject({ status: 'available' });

    await fakeAi().clearCalls();
    const second = await ask(client, userId);
    expect(second.modelId).toBe(MODEL.qwen);
    // the unavailable model is skipped entirely — not even tried again
    expect((await calls()).map((c) => c.model)).toEqual([MODEL.qwen]);

    const stats = await usageSummary(env, userId);
    const gemma = stats.byModel.find((m) => m.modelId === MODEL.gemma)!;
    const qwen = stats.byModel.find((m) => m.modelId === MODEL.qwen)!;
    expect(gemma.errors).toBe(1);
    expect(qwen.fallbacks).toBe(1);
    expect(qwen.requests).toBe(2);
  });

  it('treats capacity errors as transient: falls back without marking the model unavailable', async () => {
    await script([
      { when: { model: MODEL.gemma }, respond: { error: '3040: Capacity temporarily exceeded, please try again.' } },
      { respond: { text: 'ok' } },
    ]);
    const out = await ask(client, userId);
    expect(out.modelId).toBe(MODEL.qwen);
    expect((await loadHealth(env)).get(MODEL.gemma)).toBeUndefined();
  });

  it('retries once without model-specific tuning parameters when the model rejects them', async () => {
    await script([
      { when: { model: MODEL.qwen }, respond: { error: 'AiError: invalid input: unknown field reasoning_effort' }, times: 1 },
      { respond: { text: 'fine without tuning' } },
    ]);
    const out = await ask(client, userId, { modelId: MODEL.qwen });
    expect(out).toMatchObject({ text: 'fine without tuning', modelId: MODEL.qwen });
    const sent = await calls();
    expect(sent).toHaveLength(2);
    expect(sent[0]!.inputs.reasoning_effort).toBe('medium');
    expect(sent[1]!.inputs.reasoning_effort).toBeUndefined();
  });

  it('honours an explicit model choice only for registered, usable models', async () => {
    await script([{ respond: { text: 'ok' } }]);
    expect((await ask(client, userId, { modelId: MODEL.gptOss120 })).modelId).toBe(MODEL.gptOss120);
    expect((await ask(client, userId, { modelId: '@cf/not/registered' })).modelId).toBe(MODEL.gemma);
    expect((await ask(client, userId, { modelId: MODEL.whisper })).modelId).toBe(MODEL.gemma);
  });

  it('does not fall back (and says so) when the Cloudflare account allocation is exhausted', async () => {
    await script([{ respond: { error: '3036: You have reached your daily free allocation of 10,000 neurons' } }]);
    await expect(ask(client, userId)).rejects.toMatchObject({ code: 'AI_ACCOUNT_LIMIT', status: 503 });
    expect(await calls()).toHaveLength(1);
  });

  it('fails clearly when every model fails', async () => {
    await script([{ respond: { error: 'InferenceUpstreamError: internal error' } }]);
    await expect(ask(client, userId)).rejects.toMatchObject({ code: 'AI_FAILED', status: 502 });
    expect((await calls()).length).toBeGreaterThanOrEqual(4);
  });

  it('treats an empty answer as a failure and tries the next model', async () => {
    await script([
      { when: { model: MODEL.gemma }, respond: { text: '' } },
      { respond: { text: 'non-empty' } },
    ]);
    expect((await ask(client, userId)).modelId).toBe(MODEL.qwen);
  });

  it('enforces the per-user quota BEFORE calling any model', async () => {
    await env.DB.prepare('INSERT INTO user_quotas (user_id, daily_tokens, updated_at) VALUES (?, 100, ?)').bind(userId, Date.now()).run();
    await script([{ respond: { text: 'x', usage: { prompt: 80, completion: 40 } } }]);
    await ask(client, userId); // 120 tokens used now
    await fakeAi().clearCalls();
    await expect(ask(client, userId)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', status: 429 });
    expect(await calls()).toHaveLength(0);
  });

  it('aborts a streaming call mid-way and reports cancellation', async () => {
    await script([{ respond: { text: 'لورم '.repeat(60), chunkDelayMs: 15 } }]);
    const controller = new AbortController();
    const deltas: string[] = [];
    const p = client.chatStream({ userId, role: 'chat', purpose: 'chat', signal: controller.signal, messages: [{ role: 'user', content: 'long' }] }, (t) => {
      deltas.push(t);
      if (deltas.length === 3) controller.abort(new Error('user cancelled'));
    });
    await expect(p).rejects.toMatchObject({ code: 'AI_ABORTED' });
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    expect(deltas.length).toBeLessThan(40);
  });

  it('does not silently switch models after text was already streamed to the user', async () => {
    await script([{ respond: { text: 'partial answer that breaks', failAfterChunks: 2, error: 'InferenceUpstreamError: stream broke' } }]);
    const deltas: string[] = [];
    await expect(client.chatStream({ userId, role: 'chat', purpose: 'chat', messages: [{ role: 'user', content: 'x' }] }, (t) => void deltas.push(t))).rejects.toMatchObject({ code: 'AI_FAILED' });
    expect(deltas.length).toBe(2);
    expect((await calls()).length).toBe(1);
  });

  it('times out silent models and falls back', async () => {
    await script([
      { when: { model: MODEL.gemma }, respond: { text: 'too late', delayMs: 400 } },
      { respond: { text: 'quick' } },
    ]);
    const out = await ask(client, userId, { timeoutMs: 80 });
    expect(out).toMatchObject({ text: 'quick', modelId: MODEL.qwen });
  });

  it('routes image input to vision-capable models only', async () => {
    await script([{ respond: { text: 'a cat' } }]);
    const out = await client.chat({
      userId, role: 'chat', purpose: 'vision', needsVision: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    });
    expect(out.modelId).toBe(MODEL.gemma);
    expect((await calls())[0]!.hasImage).toBe(true);
    await script([{ when: { model: MODEL.gemma }, respond: { error: '5007: No such model' } }, { respond: { text: 'still vision' } }]);
    await env.DB.prepare('DELETE FROM model_health').run();
    const second = await client.chat({ userId, role: 'chat', purpose: 'vision', needsVision: true, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] });
    expect(second.modelId).toBe(MODEL.qwen); // gpt-oss / llama have no vision and are never offered images
  });

  it('transcribes audio with the speech model and reports an honest error for silence', async () => {
    await script([{ respond: { asr: 'سلام این یک آزمایش است' } }]);
    const ok = await client.transcribe(userId, new Uint8Array([1, 2, 3]), { language: 'fa' });
    expect(ok).toEqual({ text: 'سلام این یک آزمایش است', modelId: MODEL.whisper });
    const sent = (await calls())[0]!;
    expect(sent.inputs.audio).toBe('AQID');
    expect(sent.inputs.language).toBe('fa');
    await script([{ respond: { asr: '' } }]);
    await expect(client.transcribe(userId, new Uint8Array([1]))).rejects.toMatchObject({ code: 'NO_SPEECH' });
  });

  it('generates images and sniffs their type', async () => {
    await script([{ respond: { image: true } }]);
    const img = await client.generateImage(userId, 'a red apple');
    expect(img.mime).toBe('image/png');
    expect(img.modelId).toBe(MODEL.flux);
    expect(img.bytes.byteLength).toBeGreaterThan(100);
    expect((await calls())[0]!.inputs.prompt).toBe('a red apple');
  });

  it('converts documents through toMarkdown', async () => {
    const md = await client.toMarkdown('notes.txt', new Blob(['hello world']));
    expect(md.text).toContain('hello world');
    await expect(client.toMarkdown('bad.fail', new Blob(['x']))).rejects.toMatchObject({ code: 'CONVERSION_FAILED' });
  });
});

describe('model availability', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM model_health').run();
  });

  it('shows nothing as ready before anything has been verified', async () => {
    const res = await modelsResponse(env);
    expect(res.providers).toEqual([
      { id: 'workers-ai', label: 'Cloudflare Workers AI', connected: true },
      { id: 'groq', label: 'Groq', connected: false },
    ]);
    // Workers AI is connected but nothing was checked yet; Groq has no key in this suite, so its models are not offered at all
    const cf = res.models.filter((m) => m.provider === 'workers-ai');
    expect(cf.length).toBeGreaterThan(0);
    expect(cf.every((m) => m.status === 'unknown')).toBe(true);
    expect(cf.every((m) => m.reasonCode === 'unverified')).toBe(true);
    const groq = res.models.filter((m) => m.provider === 'groq');
    expect(groq.length).toBeGreaterThan(0);
    expect(groq.every((m) => m.status === 'unavailable' && m.reasonCode === 'not_connected' && !m.selectable)).toBe(true);
    expect(Object.values(res.defaults).every((d) => d === null)).toBe(true);
    expect(res.models.every((m) => m.selectable === (m.roles.includes('chat') || m.roles.includes('fast') || m.roles.includes('code')) || !m.selectable)).toBe(true);
  });

  it('verifies models with real probes + the catalog, and never marks failing models as ready', async () => {
    await fakeAi().setCatalog([MODEL.gemma, MODEL.qwen, MODEL.gptOss20, MODEL.llama, MODEL.whisper]);
    await script([
      { when: { model: MODEL.qwen, purpose: 'health' }, respond: { error: '5007: No such model' } },
      { when: { model: MODEL.gptOss120 }, respond: { error: '3040: Capacity temporarily exceeded' } },
      { respond: { text: 'ok' } },
    ]);
    await refreshHealth(env);
    const res = await modelsResponse(env);
    const by = Object.fromEntries(res.models.map((m) => [m.id, m]));
    expect(by[MODEL.gemma]).toMatchObject({ status: 'available', selectable: true });
    expect(by[MODEL.qwen]).toMatchObject({ status: 'unavailable', selectable: false });
    expect(by[MODEL.qwen]!.reason).toContain('No such model');
    // the UI translates the code, never the server's English sentence
    expect(by[MODEL.gemma]!.reasonCode).toBeNull();
    expect(by[MODEL.qwen]!.reasonCode).toBe('check_failed');
    // transient trouble ≠ ready, but also not "gone"
    expect(by[MODEL.gptOss120]!.status).toBe('unknown');
    // catalog-only verification for speech/image models
    expect(by[MODEL.whisper]!.status).toBe('available');
    expect(by[MODEL.flux]!.status).toBe('unavailable');
    expect(by[MODEL.flux]!.reason).toContain('catalog');
    expect(res.defaults.chat).toBe(MODEL.gemma);
    expect(res.defaults.image).toBeNull();
    // availability probing is itself recorded as usage-free (no user) — it must not need a user row
  });

  it('reports every model unavailable when no Workers AI binding exists', async () => {
    const res = await modelsResponse({ ...env, AI: undefined } as never);
    expect(res.providers.every((p) => !p.connected)).toBe(true);
    expect(res.models.every((m) => m.status === 'unavailable')).toBe(true);
    expect(res.models.every((m) => m.reasonCode === 'not_connected')).toBe(true);
    await expect(new AiClient({ ...env, AI: undefined } as never).chat({ userId: 'u', role: 'chat', purpose: 'chat', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
      code: 'AI_NOT_CONNECTED',
      status: 503,
    });
  });
});

describe('toModelDto reason codes', () => {
  const spec = MODELS.find((m) => m.id === MODEL.gemma)!;
  const fresh: HealthRow = { model_id: spec.id, status: 'available', reason: null, catalog_listed: 1, checked_at: Date.now(), latency_ms: 120 };

  it('is null for a freshly verified model and says why otherwise', () => {
    expect(toModelDto(spec, fresh, true)).toMatchObject({ status: 'available', reasonCode: null, selectable: true });
    expect(toModelDto(spec, { ...fresh, status: 'unavailable', reason: 'gone' }, true)).toMatchObject({ status: 'unavailable', reasonCode: 'check_failed', selectable: false });
  });

  it('treats an old "available" verdict as unknown (stale), not as ready', () => {
    const old = { ...fresh, checked_at: Date.now() - MODEL_HEALTH_TTL_MS * 4 };
    expect(toModelDto(spec, old, true)).toMatchObject({ status: 'unknown', reasonCode: 'stale' });
  });

  it('marks a deprecated model unavailable even when it still answers', () => {
    expect(toModelDto({ ...spec, deprecatedOn: '2020-01-01' }, fresh, true)).toMatchObject({ status: 'unavailable', reasonCode: 'deprecated', selectable: false });
  });
});

