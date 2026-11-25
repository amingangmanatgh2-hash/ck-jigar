import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiError } from '../src/ai/errors';
import { getModel, MODELS, rolePriority, validateRegistry } from '../src/ai/models';
import { GROQ_BASE_URL, OPTIONAL_PARAMS, groqCatalog, groqConnected, groqErrorKind, groqRequestBody, groqRun } from '../src/ai/providers/groq';
import { fakeGroq, groqCalls, groqOff, groqOn, groqScript, GROQ, GROQ_KEY, withEnv } from './groq-helpers';

const messages = [{ role: 'user', content: 'سلام' }];

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

const run = (over: Parameters<typeof withEnv>[0] = {}) => groqRun(withEnv(over));

describe('Groq request body (pure)', () => {
  it('speaks Groq: max_completion_tokens (with room for the hidden reasoning), no max_tokens, no stream_options', () => {
    const body = groqRequestBody(GROQ.oss20, { messages, max_tokens: 200, temperature: 0.2, reasoning_effort: 'low', include_reasoning: false, stream: true, stream_options: { include_usage: true } });
    expect(body).toMatchObject({ model: GROQ.oss20, messages, temperature: 0.2, reasoning_effort: 'low', include_reasoning: false, stream: true });
    expect(body.max_completion_tokens).toBe(200 + 400); // low effort: +400 for thinking that is never shown
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('stream_options');
    expect(groqRequestBody(GROQ.oss120, { messages, max_tokens: 1000, reasoning_effort: 'medium' }).max_completion_tokens).toBe(2000);
    expect(groqRequestBody(GROQ.oss120, { messages, max_tokens: 1000, reasoning_effort: 'high' }).max_completion_tokens).toBe(3500);
  });

  it('sends no cap when none was asked for, and drops the tuning when told to', () => {
    expect(groqRequestBody(GROQ.oss20, { messages })).not.toHaveProperty('max_completion_tokens');
    const plain = groqRequestBody(GROQ.oss20, { messages, max_tokens: 100, reasoning_effort: 'low', include_reasoning: false }, { stripTuning: true });
    for (const name of OPTIONAL_PARAMS) expect(plain).not.toHaveProperty(name);
    expect(plain.max_completion_tokens).toBe(100 + 1000); // the models' own default effort is medium
  });
});

describe('Groq error mapping', () => {
  it.each([
    [401, 'invalid_api_key', 'Invalid API Key', 'access'],
    [403, '', 'Forbidden', 'access'],
    [400, 'terms_required', 'You must accept the terms', 'access'],
    [404, 'model_not_found', 'The model does not exist', 'model_unavailable'],
    [400, '', 'The model `x` has been decommissioned and is no longer supported', 'model_unavailable'],
    [413, '', 'Request too large for model on tokens per minute (TPM)', 'too_large'],
    [429, 'rate_limit_exceeded', 'Rate limit reached', 'capacity'],
    [498, '', 'Flex tier capacity exceeded', 'capacity'],
    [503, '', 'Service unavailable', 'capacity'],
    [408, '', 'timeout', 'timeout'],
    [504, '', 'gateway timeout', 'timeout'],
    [400, '', '`reasoning_effort` is not supported', 'bad_request'],
    [422, '', 'Unprocessable', 'bad_request'],
    [500, '', 'internal', 'server'],
    [502, '', 'bad gateway', 'server'],
    [418, '', 'teapot', 'unknown'],
  ])('HTTP %i (%s: %s) → %s', (status, code, detail, kind) => {
    expect(groqErrorKind(status, code, detail)).toBe(kind);
  });
});

describe('Groq model registry', () => {
  it('has only valid entries, Groq first for quick tasks and Workers AI first for conversation', () => {
    expect(validateRegistry()).toEqual([]);
    expect(rolePriority('fast')[0]!.provider).toBe('groq');
    for (const role of ['chat', 'code', 'vision'] as const) expect(rolePriority(role)[0]!.provider).toBe('workers-ai');
    // Groq is also a way out when Workers AI is spent: it appears in the chat and code lists
    expect(rolePriority('chat').some((m) => m.provider === 'groq')).toBe(true);
    expect(rolePriority('code').some((m) => m.provider === 'groq')).toBe(true);
    // never for what Groq cannot do here
    for (const role of ['vision', 'asr', 'image'] as const) expect(rolePriority(role).every((m) => m.provider === 'workers-ai')).toBe(true);
  });

  it('keeps provider ids and model ids apart (@cf/ is Workers AI only)', () => {
    for (const m of MODELS) expect(m.id.startsWith('@cf/')).toBe(m.provider === 'workers-ai');
    expect(getModel(GROQ.oss20)).toMatchObject({ provider: 'groq', capabilities: { vision: false } });
    expect(MODELS.filter((m) => m.provider === 'groq').every((m) => m.maxInputTokens === 5000)).toBe(true);
  });
});

describe('groqRun (against the fake Groq)', () => {
  beforeAll(async () => groqOn());
  afterAll(async () => groqOff());
  beforeEach(async () => {
    await fakeGroq().reset();
  });

  it('is connected only when the secret is set (a blank value is not a key)', () => {
    expect(groqConnected(withEnv({ GROQ_API_KEY: GROQ_KEY }))).toBe(true);
    expect(groqConnected(withEnv({ GROQ_API_KEY: undefined }))).toBe(false);
    expect(groqConnected(withEnv({ GROQ_API_KEY: '   ' }))).toBe(false);
    expect(GROQ_BASE_URL).toBe('https://api.groq.com/openai/v1');
  });

  it('answers a normal request and sends the key only in the Authorization header', async () => {
    await groqScript([{ respond: { text: 'پاسخ', usage: { prompt: 21, completion: 7 } } }]);
    const out = (await run()(GROQ.oss20, { messages, max_tokens: 50, reasoning_effort: 'low' })) as any;
    expect(out.choices[0].message.content).toBe('پاسخ');
    expect(out.usage).toMatchObject({ prompt_tokens: 21, completion_tokens: 7 });
    const [call] = await groqCalls();
    expect(call).toMatchObject({ model: GROQ.oss20, key: GROQ_KEY, stream: false });
    expect(call!.body.max_completion_tokens).toBe(450);
    expect(JSON.stringify(call!.body)).not.toContain(GROQ_KEY); // never in the body
  });

  it('streams server-sent events and reports usage in the last chunk, with the thinking kept out of the content', async () => {
    await groqScript([{ respond: { text: 'hello there', reasoning: 'secret chain of thought', usage: { prompt: 5, completion: 9 } } }]);
    const stream = (await run()(GROQ.oss20, { messages, max_tokens: 50, stream: true })) as ReadableStream<Uint8Array>;
    const raw = await readAll(stream);
    expect(raw).toContain('data: [DONE]');
    const chunks = raw.split('\n\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
    const content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(content).toBe('hello there');
    expect(content).not.toContain('secret');
    expect(chunks.at(-1).x_groq.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 9 });
    expect((await groqCalls())[0]!.stream).toBe(true);
  });

  it.each([
    [401, 'access', /Groq 401 \(invalid_api_key\): Invalid API Key/],
    [404, 'model_unavailable', /Groq 404 \(model_not_found\)/],
    [413, 'too_large', /Groq 413/],
    [500, 'server', /Groq 500/],
  ])('turns HTTP %i into a %s error that carries the status and Groq\'s own message', async (status, kind, message) => {
    const wording: Record<number, { message?: string; code?: string }> = { 401: { message: 'Invalid API Key', code: 'invalid_api_key' }, 404: { message: 'model gone', code: 'model_not_found' } };
    await fakeGroq().configure({ failures: [{ status, ...wording[status] }] });
    const err = (await run()(GROQ.oss20, { messages }).catch((e) => e)) as AiError;
    expect(err).toBeInstanceOf(AiError);
    expect(err.kind).toBe(kind);
    expect(err.modelId).toBe(GROQ.oss20);
    expect(err.message).toMatch(message);
    expect(err.message).not.toContain(GROQ_KEY);
  });

  it('reads Retry-After from a 429 so the model can be left alone until then', async () => {
    await fakeGroq().configure({ failures: [{ status: 429, retryAfter: 7, message: 'Rate limit reached for model openai/gpt-oss-20b on tokens per minute (TPM)' }] });
    const err = (await run()(GROQ.oss20, { messages }).catch((e) => e)) as AiError;
    expect(err).toMatchObject({ kind: 'capacity', retryAfterMs: 7000 });
    expect(err.message).toContain('tokens per minute');
  });

  it('says so, without calling anyone, when no key is set', async () => {
    await fakeGroq().clearCalls();
    const err = (await run({ GROQ_API_KEY: undefined })(GROQ.oss20, { messages }).catch((e) => e)) as AiError;
    expect(err).toMatchObject({ kind: 'access' });
    expect(err.message).toContain('GROQ_API_KEY');
    expect(await groqCalls()).toHaveLength(0);
  });

  it('rejects a wrong key with a 401 and never repeats it back', async () => {
    const err = (await run({ GROQ_API_KEY: 'gsk_wrong-key-0123456789' })(GROQ.oss20, { messages }).catch((e) => e)) as AiError;
    expect(err.kind).toBe('access');
    expect(err.message).not.toContain('gsk_wrong');
    expect(JSON.stringify(err)).not.toContain('gsk_wrong');
  });

  it('repeats the call once without the tuning parameters when Groq refuses one of them — and only then', async () => {
    await fakeGroq().configure({ rejectParams: ['include_reasoning'] });
    await groqScript([{ respond: { text: 'fine' } }]);
    const tuned = { messages, max_tokens: 100, reasoning_effort: 'low', include_reasoning: false };
    const out = (await run()(GROQ.oss20, tuned)) as any;
    expect(out.choices[0].message.content).toBe('fine');
    const calls = await groqCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toHaveProperty('include_reasoning');
    expect(calls[1]!.body).not.toHaveProperty('include_reasoning');
    expect(calls[1]!.body).not.toHaveProperty('reasoning_effort');
    expect(calls[1]!.body.max_completion_tokens).toBe(1100);

    // a refusal of something that is not a tuning parameter is an error, not a retry loop
    await fakeGroq().reset({ rejectParams: ['temperature'] });
    const err = (await run()(GROQ.oss20, { ...tuned, temperature: 0.2 }).catch((e) => e)) as AiError;
    expect(err.kind).toBe('bad_request');
    expect(await groqCalls()).toHaveLength(1);
  });

  it('reports a network failure as a server error, but lets a cancellation through untouched', async () => {
    const broken = withEnv({ GROQ_API_KEY: GROQ_KEY, GROQ_API: { fetch: async () => { throw new TypeError('fetch failed: ECONNRESET'); } } as never });
    const err = (await groqRun(broken)(GROQ.oss20, { messages }).catch((e) => e)) as AiError;
    expect(err).toMatchObject({ kind: 'server' });
    expect(err.message).toContain('could not be reached');

    const cancelled = AbortSignal.abort();
    const aborted = (await run()(GROQ.oss20, { messages }, { signal: cancelled }).catch((e) => e)) as { name?: string };
    expect(aborted).not.toBeInstanceOf(AiError);
    expect(String(aborted?.name ?? aborted)).toMatch(/Abort/i);
  });

  it('reads the key\'s model list (and treats every failure as "unknown", not as a verdict)', async () => {
    const ids = await groqCatalog(withEnv({ GROQ_API_KEY: GROQ_KEY }));
    expect(ids).toEqual(new Set([GROQ.oss20, GROQ.oss120, 'qwen/qwen3.8-27b', 'whisper-large-v3-turbo']));
    await fakeGroq().configure({ listFails: 1 });
    expect(await groqCatalog(withEnv({ GROQ_API_KEY: GROQ_KEY }))).toBeNull();
    expect(await groqCatalog(withEnv({ GROQ_API_KEY: 'gsk_wrong' }))).toBeNull();
    await fakeGroq().clearCalls();
    expect(await groqCatalog(withEnv({ GROQ_API_KEY: undefined }))).toBeNull();
    expect(await fakeGroq().listCallCount()).toBe(0);
  });
});
