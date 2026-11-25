import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PollResponse } from '@aminchat/shared';
import { isAllowedOrigin } from '../src/middleware/common';
import { clientIp } from '../src/middleware/rate-limit';
import { script, type Rule } from './ai-helpers';
import { api, createThread, directChat, freshIp, json, registerUser, sendAi, sendText, waitFor, waitForRun, type TestUser } from './helpers';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM model_health').run();
  await script([]);
});

const answer = (text: string): Rule => ({ when: { purpose: 'chat' }, respond: { text } });
const hub = (user: TestUser) => env.USER_HUB.get(env.USER_HUB.idFromName(user.id));
const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

describe('idempotent sends (retries, outbox flush, switching server address)', () => {
  it('stores a message once however many times the client repeats it', async () => {
    const alice = await registerUser('idem_a');
    const bob = await registerUser('idem_b');
    const chat = await directChat(alice, bob);
    const clientId = 'c_' + Math.random().toString(36).slice(2, 12);

    const first = await api('POST', `/api/conversations/${chat}/messages`, { token: alice.token, json: { body: 'on my way', clientId } });
    expect(first.status).toBe(201);
    const a = await json(first);
    expect(a.duplicate).toBeUndefined();
    expect(a.message.clientId).toBe(clientId); // the sender gets its token back to match the pending copy

    const again = await api('POST', `/api/conversations/${chat}/messages`, { token: alice.token, json: { body: 'on my way', clientId } });
    expect(again.status).toBe(200);
    const b = await json(again);
    expect(b.duplicate).toBe(true);
    expect(b.message.id).toBe(a.message.id);
    expect(b.ai).toEqual({ triggered: false });
    expect(await count('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', chat)).toBe(1);

    // even when the retry carries different content (an edit made in the meantime must not create a second message)
    const edited = await json(await api('POST', `/api/conversations/${chat}/messages`, { token: alice.token, json: { body: 'on my way!!', clientId } }));
    expect(edited.message.id).toBe(a.message.id);
    expect(edited.message.body).toBe('on my way');

    // the token is the sender's own business: the other person never sees it
    const list = await json(await api('GET', `/api/conversations/${chat}/messages`, { token: bob.token }));
    expect(list.messages).toHaveLength(1);
    expect(list.messages[0].clientId).toBeUndefined();
  });

  it('survives two identical requests racing each other', async () => {
    const alice = await registerUser('race_a');
    const bob = await registerUser('race_b');
    const chat = await directChat(alice, bob);
    const clientId = 'race_' + Math.random().toString(36).slice(2, 12);
    const send = () => api('POST', `/api/conversations/${chat}/messages`, { token: alice.token, json: { body: 'once', clientId } });
    const results = await Promise.all([send(), send(), send()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    const ids = new Set((await Promise.all(results.map((r) => json(r)))).map((d) => d.message.id));
    expect(ids.size).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', chat)).toBe(1);
  });

  it('scopes the token to sender and conversation, validates it, and never leaks messages across people', async () => {
    const alice = await registerUser('scope_a');
    const bob = await registerUser('scope_b');
    const carol = await registerUser('scope_c');
    const ab = await directChat(alice, bob);
    const ac = await directChat(alice, carol);
    const clientId = 'same_' + Math.random().toString(36).slice(2, 12);

    const m1 = (await sendText(alice, ab, 'to bob', { clientId })).message;
    const m2 = (await sendText(alice, ac, 'to carol', { clientId })).message; // other conversation: independent
    const m3 = (await sendText(bob, ab, 'from bob', { clientId })).message; // other sender: independent
    expect(new Set([m1.id, m2.id, m3.id]).size).toBe(3);

    // a stranger cannot use a token to read somebody else's message
    const stranger = await api('POST', `/api/conversations/${ab}/messages`, { token: carol.token, json: { body: 'x', clientId } });
    expect(stranger.status).toBe(404);
    expect(JSON.stringify(await json(stranger))).not.toContain('to bob');

    for (const bad of ['short', 'has space inside', 'x'.repeat(65), 'ünïcode-token']) {
      const res = await api('POST', `/api/conversations/${ab}/messages`, { token: alice.token, json: { body: 'x', clientId: bad } });
      expect(res.status, bad).toBe(400);
    }
  });

  it('does not ask the model twice when the same AMIN AI request is repeated', async () => {
    const user = await registerUser('idem_ai');
    await script([answer('Nine minutes.')]);
    const thread = await createThread(user);
    const clientId = 'ai_' + Math.random().toString(36).slice(2, 12);

    const first = await sendAi(user, thread.id, { body: 'How long do I boil pasta?', agentId: 'general', clientId });
    expect(first.status).toBe(201);
    const second = await sendAi(user, thread.id, { body: 'How long do I boil pasta?', agentId: 'general', clientId });
    expect(second.status).toBe(200);
    expect(second.data.duplicate).toBe(true);
    expect(second.data.run.id).toBe(first.data.run.id);
    expect(second.data.userMessage.id).toBe(first.data.userMessage.id);
    expect(second.data.assistantMessage.id).toBe(first.data.assistantMessage.id);

    await waitForRun(user, first.data.run.id);
    const third = await sendAi(user, thread.id, { body: 'How long do I boil pasta?', agentId: 'general', clientId });
    expect(third.status).toBe(200); // still the first turn, now finished
    expect(third.data.run.status).toBe('completed');
    expect(await count('SELECT COUNT(*) AS n FROM runs WHERE thread_id = ?', thread.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND sender_id = ?", thread.id, user.id)).toBe(1);

    // concurrent duplicates resolve to one turn as well
    const clientId2 = 'ai2_' + Math.random().toString(36).slice(2, 12);
    const both = await Promise.all([1, 2].map(() => sendAi(user, thread.id, { body: 'And for rice?', agentId: 'general', clientId: clientId2 })));
    expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(both[0]!.data.run.id).toBe(both[1]!.data.run.id);
    await waitForRun(user, both[0]!.data.run.id);
    expect(await count('SELECT COUNT(*) AS n FROM runs WHERE thread_id = ?', thread.id)).toBe(2);
  });
});

describe('realtime long-poll (when WebSockets do not work)', () => {
  const poll = async (user: TestUser, cursor?: { epoch: string; seq: number }, wait = 0): Promise<PollResponse> => {
    const q = new URLSearchParams({ wait: String(wait), ...(cursor ? { epoch: cursor.epoch, seq: String(cursor.seq) } : {}) });
    const res = await api('GET', `/api/realtime/poll?${q}`, { token: user.token });
    expect(res.status).toBe(200);
    return json<PollResponse>(res);
  };

  it('requires authentication and validates its parameters', async () => {
    expect((await api('GET', '/api/realtime/poll')).status).toBe(401);
    const user = await registerUser('poll_v');
    for (const q of ['wait=26', 'wait=-1', 'wait=abc', 'epoch=bad%20epoch&seq=1', 'epoch=abcdef&seq=-3']) {
      expect((await api('GET', `/api/realtime/poll?${q}`, { token: user.token })).status, q).toBe(400);
    }
  });

  it('hands out a cursor, then delivers what happens afterwards — and only to the right user', async () => {
    const alice = await registerUser('poll_a');
    const bob = await registerUser('poll_b');
    const eve = await registerUser('poll_e');
    const chat = await directChat(alice, bob);

    const start = await poll(bob);
    expect(start).toMatchObject({ seq: 0, events: [], reset: false });
    expect(start.epoch).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    await poll(eve); // somebody else polling must not receive Bob's events

    const sent = (await sendText(alice, chat, 'hello bob')).message;
    const got = await poll(bob, start);
    expect(got.reset).toBe(false);
    expect(got.events.map((e) => e.type)).toContain('message.created');
    const created = got.events.find((e) => e.type === 'message.created') as any;
    expect(created.message.id).toBe(sent.id);
    expect(created.message.body).toBe('hello bob');
    expect(got.seq).toBeGreaterThan(start.seq);

    // nothing is delivered twice: polling again from the new cursor is empty
    expect(await poll(bob, got)).toMatchObject({ events: [], seq: got.seq, reset: false });
    // Eve saw nothing of it
    const eveNow = await poll(eve, { epoch: start.epoch, seq: 0 }).catch(() => null);
    expect(JSON.stringify(eveNow)).not.toContain('hello bob');
  });

  it('holds the request open and answers as soon as something happens, carrying a whole burst', async () => {
    const alice = await registerUser('long_a');
    const bob = await registerUser('long_b');
    const chat = await directChat(alice, bob);
    const start = await poll(bob);

    const started = Date.now();
    const waiting = poll(bob, start, 10);
    await new Promise((r) => setTimeout(r, 150));
    await sendText(alice, chat, 'one');
    await sendText(alice, chat, 'two');
    const got = await waiting;
    expect(Date.now() - started).toBeLessThan(5000); // it did not sit out the whole 10 s
    const bodies = got.events.filter((e) => e.type === 'message.created').map((e: any) => e.message.body);
    expect(bodies[0]).toBe('one');
    // 'two' either rode along or is waiting in the buffer for the next call — it must not be lost
    const rest = bodies.includes('two') ? [] : (await poll(bob, got)).events.filter((e) => e.type === 'message.created').map((e: any) => e.message.body);
    expect([...bodies, ...rest]).toEqual(['one', 'two']);
  });

  it('times out quietly when nothing happens', async () => {
    const bob = await registerUser('quiet_b');
    const start = await poll(bob);
    const t0 = Date.now();
    const res = await poll(bob, start, 1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(res).toMatchObject({ events: [], seq: start.seq, reset: false, epoch: start.epoch });
  });

  it('tells the client to resync when the buffer cannot prove completeness', async () => {
    const bob = await registerUser('reset_b');
    const start = await poll(bob);

    // unknown epoch (the object was evicted and restarted, or the cursor is made up)
    const foreign = await poll(bob, { epoch: 'some_other_epoch', seq: 5 });
    expect(foreign).toMatchObject({ reset: true, events: [], epoch: start.epoch });
    // a cursor from the future
    expect((await poll(bob, { epoch: start.epoch, seq: start.seq + 999 })).reset).toBe(true);

    // the poller fell behind further than the buffer holds
    const flood = Array.from({ length: 450 }, (_, i) => ({ type: 'typing' as const, conversationId: 'conv_x', userId: `u${i}` }));
    await hub(bob).publish(flood);
    const behind = await poll(bob, start);
    expect(behind).toMatchObject({ reset: true, events: [] });
    // after the resync it continues from the head without further resets
    await hub(bob).publish({ type: 'typing', conversationId: 'conv_x', userId: 'late' });
    const next = await poll(bob, { epoch: behind.epoch, seq: behind.seq });
    expect(next.reset).toBe(false);
    expect(next.events).toHaveLength(1);
  });

  it('keeps only a bounded buffer and buffers nothing for users who never poll', async () => {
    const idle = await registerUser('idle_b');
    await hub(idle).publish({ type: 'typing', conversationId: 'c', userId: 'x' });
    expect((await poll(idle)).seq).toBe(0); // nothing was buffered before the first poll

    const bob = await registerUser('bounded_b');
    const start = await poll(bob);
    await hub(bob).publish(Array.from({ length: 1000 }, (_, i) => ({ type: 'typing' as const, conversationId: 'c', userId: `u${i}` })));
    const head = await poll(bob, { epoch: start.epoch, seq: 600 }); // still inside the newest 400
    expect(head.reset).toBe(false);
    expect(head.events).toHaveLength(400);
    expect(head.seq).toBe(1000);
  });

  it('delivers an AI answer as ordered deltas, like the WebSocket does', async () => {
    const user = await registerUser('poll_ai');
    const reply = 'Boil the pasta for nine minutes, then drain it and keep a cup of the water for the sauce.';
    await script([answer(reply)]);
    const thread = await createThread(user);
    let cursor = await poll(user);
    const { data } = await sendAi(user, thread.id, { body: 'How long do I boil pasta?', agentId: 'general' });

    const deltas: { offset: number; text: string }[] = [];
    await waitFor(async () => {
      const r = await poll(user, cursor, 2);
      expect(r.reset).toBe(false);
      cursor = r;
      for (const e of r.events) if (e.type === 'run.delta' && e.runId === data.run.id) deltas.push({ offset: e.offset, text: e.text });
      return r.events.some((e) => e.type === 'run.updated' && e.run.status === 'completed');
    });
    let position = 0;
    for (const d of deltas) {
      expect(d.offset).toBe(position);
      position += d.text.length;
    }
    expect(deltas.map((d) => d.text).join('')).toBe(reply);
  });
});

describe('advertised endpoints and relays', () => {
  it('advertises the configured alternative addresses on the public health check', async () => {
    const res = await api('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store'); // a relay must never serve a stale health answer
    const body = await json(res);
    expect(body).toMatchObject({ ok: true, service: 'amin-chat' });
    // normalised to origins, de-duplicated, non-http(s) dropped
    expect(body.endpoints).toEqual(['https://relay-a.example.test', 'https://relay-b.example.test:8443']);
  });

  it('says, without logging in, which AI services have credentials — yes or no, never a value', async () => {
    const before = await json(await api('GET', '/api/health'));
    expect(before.ai).toEqual({ 'workers-ai': true, groq: false }); // the test environment binds Workers AI and has no Groq key
    const SECRET = 'gsk_HEALTH_LEAK_CHECK_1234567890';
    (env as unknown as Record<string, unknown>).GROQ_API_KEY = SECRET;
    try {
      const res = await api('GET', '/api/health');
      const text = await res.text();
      expect(JSON.parse(text).ai).toEqual({ 'workers-ai': true, groq: true });
      expect(text).not.toContain('HEALTH_LEAK');
    } finally {
      delete (env as unknown as Record<string, unknown>).GROQ_API_KEY;
    }
    expect((await json(await api('GET', '/api/health'))).ai.groq).toBe(false);
  });

  it('trusts its own relays as browser origins, and nobody else', async () => {
    const preflight = (origin: string) => api('OPTIONS', '/api/auth/login', { headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
    const ok = await preflight('https://relay-a.example.test');
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://relay-a.example.test');
    expect((await preflight('https://relay-b.example.test:8443')).status).toBe(204);
    expect((await preflight('https://evil.example.test')).status).toBe(403);
    expect((await preflight('https://relay-b.example.test')).status).toBe(403); // another port is another origin
    expect(isAllowedOrigin({ ENVIRONMENT: 'production', PUBLIC_ENDPOINTS: 'https://r.example' } as never, 'https://r.example', 'https://self')).toBe(true);
    expect(isAllowedOrigin({ ENVIRONMENT: 'production' } as never, 'https://r.example', 'https://self')).toBe(false);
  });
});

describe('client address behind a relay', () => {
  /** `secret` = what the Worker has configured (null = nothing configured). */
  const req = (headers: Record<string, string>, secret: string | null = 'test-relay-secret') => {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { env: secret === null ? {} : { RELAY_SECRET: secret }, req: { header: (n: string) => lower[n.toLowerCase()] } };
  };

  it('uses the forwarded address only from a request that proves it comes from a relay', () => {
    const base = { 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': '198.51.100.7, 10.0.0.1' };
    expect(clientIp(req({ ...base, 'X-Relay-Secret': 'test-relay-secret' }))).toBe('198.51.100.7');
    expect(clientIp(req({ ...base }))).toBe('203.0.113.9'); // no proof: cannot be spoofed
    expect(clientIp(req({ ...base, 'X-Relay-Secret': 'wrong' }))).toBe('203.0.113.9');
    expect(clientIp(req({ ...base, 'X-Relay-Secret': 'test-relay-secret' }, null))).toBe('203.0.113.9'); // no secret configured: feature off
    expect(clientIp(req({ 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': 'not an ip', 'X-Relay-Secret': 'test-relay-secret' }))).toBe('203.0.113.9');
    expect(clientIp(req({ 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': '2001:db8::1', 'X-Relay-Secret': 'test-relay-secret' }))).toBe('2001:db8::1');
    expect(clientIp(req({}))).toBe('unknown');
  });

  it('gives every user behind a relay their own rate-limit bucket (and shares one without the secret)', async () => {
    const relayIp = freshIp();
    const loginFrom = (clientAddress: string, withSecret: boolean) =>
      api('POST', '/api/auth/login', { headers: { 'CF-Connecting-IP': relayIp, 'X-Forwarded-For': clientAddress, ...(withSecret ? { 'X-Relay-Secret': 'test-relay-secret' } : {}) }, json: { username: `nobody_${Math.random().toString(36).slice(2, 8)}`, password: 'wrong-password-here' } });

    // 30 attempts per 10 minutes per address. Exhaust the budget of the relay's own address without the secret…
    for (let i = 0; i < 30; i++) expect((await loginFrom('198.51.100.1', false)).status).toBe(401);
    expect((await loginFrom('198.51.100.1', false)).status).toBe(429);
    expect((await loginFrom('198.51.100.2', false)).status).toBe(429); // everybody behind the relay is lumped together…
    // …but with the secret the relay's users are told apart: a fresh client address still has its full budget
    expect((await loginFrom('198.51.100.3', true)).status).toBe(401);
    expect((await loginFrom('198.51.100.4', true)).status).toBe(401);
  });
});
