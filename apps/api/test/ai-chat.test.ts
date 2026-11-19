import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { MODEL, calls, script, type Rule } from './ai-helpers';
import { api, ask, createThread, directChat, getAdmin, json, openSocket, registerUser, sendAi, sendText, threadMessages, waitFor, waitForRun, type TestUser } from './helpers';

/** A model that failed on purpose in one test must not stay "unavailable" for the next one (D1 state lives for the whole file). */
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM model_health').run();
});

const answer = (text: string, extra: Partial<Rule['respond']> = {}): Rule => ({ when: { purpose: 'chat' }, respond: { text, ...extra } });
const title = (text: string): Rule => ({ when: { purpose: 'title' }, respond: { text } });

async function uploadFile(user: TestUser, name: string, content: string | Uint8Array, mime = 'text/plain'): Promise<any> {
  const form = new FormData();
  form.set('file', new File([content as unknown as ArrayBuffer], name, { type: mime }));
  const res = await api('POST', '/api/files', { token: user.token, body: form });
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return (await json(res)).file;
}

describe('AMIN AI — access and isolation', () => {
  it('requires authentication on every AI endpoint', async () => {
    for (const [method, path] of [
      ['GET', '/api/ai/agents'], ['GET', '/api/ai/models'], ['GET', '/api/ai/usage'], ['GET', '/api/ai/threads'], ['POST', '/api/ai/threads'],
      ['GET', '/api/ai/search?q=x'], ['GET', '/api/ai/runs'], ['GET', '/api/ai/approvals'], ['GET', '/api/ai/memory'], ['GET', '/api/ai/todos'],
      ['POST', '/api/ai/transcribe'], ['GET', '/api/admin/overview'],
    ] as const) {
      const res = await api(method, path);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('keeps threads, runs and files private to their owner', async () => {
    const alice = await registerUser('alice');
    const bob = await registerUser('bob');
    await script([answer('Private answer.'), title('Secret plans')]);
    const thread = await createThread(alice);
    const { run, userMessage } = await ask(alice, thread.id, { body: 'my secret plan', agentId: 'general' });

    for (const [method, path] of [
      ['GET', `/api/ai/threads/${thread.id}`], ['GET', `/api/ai/threads/${thread.id}/messages`], ['DELETE', `/api/ai/threads/${thread.id}`],
      ['GET', `/api/ai/runs/${run.id}`], ['GET', `/api/ai/runs/${run.id}/events`], ['POST', `/api/ai/runs/${run.id}/cancel`],
    ] as const) {
      const res = await api(method, path, { token: bob.token });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await api('POST', `/api/ai/threads/${thread.id}/messages`, { token: bob.token, json: { body: 'hi' } })).status).toBe(404);
    expect((await json(await api('GET', '/api/ai/threads', { token: bob.token }))).threads).toEqual([]);
    // the AI conversation itself is invisible to the other user as well
    expect((await api('GET', `/api/conversations/${userMessage.conversationId}`, { token: bob.token })).status).toBe(404);
    // the human-chat endpoints refuse the AI conversation
    expect((await api('POST', `/api/conversations/${userMessage.conversationId}/messages`, { token: alice.token, json: { body: 'x' } })).status).toBe(400);
  });
});

describe('AMIN AI — conversation', () => {
  beforeEach(async () => {
    await script([]);
  });

  it('answers, streams deltas over the WebSocket, stores history and titles the thread', async () => {
    const user = await registerUser('chat');
    const socket = await openSocket(user);
    const reply = 'Boil the pasta for nine minutes, then drain it and keep a cup of the water for the sauce.';
    await script([title('"Boiling pasta."'), answer(reply)]);
    const thread = await createThread(user);

    const { status, data } = await sendAi(user, thread.id, { body: 'How long do I boil pasta?', agentId: 'general' });
    expect(status).toBe(201);
    expect(data.userMessage.body).toBe('How long do I boil pasta?');
    expect(data.assistantMessage.status).toBe('streaming');
    expect(data.run.status).toBe('pending');

    const run = await waitForRun(user, data.run.id);
    expect(run.status).toBe('completed');
    expect(run.resolvedAgentId ?? null).toBeNull(); // explicit agent: no routing
    expect(run.steps).toEqual([]);

    const messages = await threadMessages(user, thread.id);
    expect(messages.map((m) => m.body)).toEqual(['How long do I boil pasta?', reply]);
    expect(messages[1].status).toBe('sent');
    expect(messages[1].meta.ai.modelId).toBe(MODEL.gemma);
    expect(messages[1].meta.ai.runId).toBe(run.id);

    // live streaming: the deltas add up to exactly the final answer, and the final message arrives as an update
    await socket.waitFor((e) => e.type === 'message.updated' && e.message.id === data.assistantMessage.id && e.message.status === 'sent');
    const deltas = socket.events.filter((e) => e.type === 'run.delta' && e.runId === run.id && e.messageId === data.assistantMessage.id);
    const streamed = deltas.map((e) => e.text).join('');
    expect(streamed).toBe(reply);
    // every piece says where it belongs, so a client that joined late (or got pieces out of order) can place it
    let position = 0;
    for (const d of deltas) {
      expect(d.offset).toBe(position);
      position += d.text.length;
    }
    expect(position).toBe(reply.length);
    expect(socket.events.some((e) => e.type === 'run.updated' && e.run.id === run.id && e.run.status === 'completed')).toBe(true);
    socket.close();

    // the request really went to the chat model with the system prompt, current time and the user's text
    const sent = (await calls()).filter((c) => c.purpose === 'chat');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.model).toBe(MODEL.gemma);
    expect(sent[0]!.system).toContain('AMIN AI');
    expect(sent[0]!.system).toMatch(/Current date and time/);
    expect(sent[0]!.user).toBe('How long do I boil pasta?');

    // auto title (quotes and final punctuation are stripped)
    const t = await waitFor(async () => {
      const res = await json(await api('GET', `/api/ai/threads/${thread.id}`, { token: user.token }));
      return res.thread.title ? res.thread : null;
    });
    expect(t.title).toBe('Boiling pasta');
    const list = (await json(await api('GET', '/api/ai/threads', { token: user.token }))).threads;
    expect(list[0]).toMatchObject({ id: thread.id, title: 'Boiling pasta', messageCount: 2 });
  });

  it('shows AMIN AI as a permanent contact with a verified badge, before any message was sent', async () => {
    const user = await registerUser('contact');
    const list = (await json(await api('GET', '/api/conversations', { token: user.token }))).conversations;
    const ai = list.find((c: any) => c.type === 'ai');
    expect(ai).toBeTruthy();
    expect(ai.peer).toMatchObject({ id: 'usr_amin_ai', displayName: 'AMIN AI', verified: true, kind: 'ai' });
    // the same conversation is used for every thread (one contact, many conversations)
    const t1 = await createThread(user);
    const t2 = await createThread(user);
    expect(t1.id).not.toBe(t2.id);
    const again = (await json(await api('GET', '/api/conversations', { token: user.token }))).conversations.filter((c: any) => c.type === 'ai');
    expect(again).toHaveLength(1);
  });

  it('sends earlier turns as history so the model has the context of the conversation', async () => {
    const user = await registerUser('ctx');
    await script([answer('Nice to meet you, Sara.')]);
    const thread = await createThread(user);
    await ask(user, thread.id, { body: 'My name is Sara.', agentId: 'general' });
    await script([answer('Your name is Sara.')]);
    await ask(user, thread.id, { body: 'What is my name?', agentId: 'general' });
    const call = (await calls()).find((c) => c.purpose === 'chat')!;
    const roles = (call.inputs.messages as any[]).map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    expect(call.all).toContain('My name is Sara.');
    expect(call.all).toContain('Nice to meet you, Sara.');
  });

  it('regenerates only the latest answer, keeping its id', async () => {
    const user = await registerUser('regen');
    await script([answer('First answer.')]);
    const thread = await createThread(user);
    const first = await ask(user, thread.id, { body: 'Tell me something', agentId: 'general' });
    await ask(user, thread.id, { body: 'And another thing', agentId: 'general' });

    // the first answer is no longer the newest one
    const old = await api('POST', `/api/ai/runs/${first.run.id}/retry`, { token: user.token });
    expect(old.status).toBe(409);

    await script([answer('Second try.')]);
    const res = await api('POST', `/api/ai/threads/${thread.id}/regenerate`, { token: user.token, json: {} });
    expect(res.status).toBe(202);
    const data = await json(res);
    await waitForRun(user, data.run.id);
    const messages = await threadMessages(user, thread.id);
    expect(messages).toHaveLength(4);
    expect(messages[3].body).toBe('Second try.');
    expect(messages[3].id).toBe(data.assistantMessage.id);
    expect(messages[3].meta.ai.regenerations).toBe(1);
  });

  it('edits a prompt: later messages disappear and a new answer is generated', async () => {
    const user = await registerUser('edit');
    await script([answer('Answer one.')]);
    const thread = await createThread(user);
    const first = await ask(user, thread.id, { body: 'Question one', agentId: 'general' });
    await script([answer('Answer two.')]);
    await ask(user, thread.id, { body: 'Question two', agentId: 'general' });

    await script([answer('Answer to the edited question.')]);
    const res = await api('PUT', `/api/ai/threads/${thread.id}/messages/${first.userMessage.id}`, { token: user.token, json: { body: 'Question one, rephrased' } });
    expect(res.status).toBe(202);
    const data = await json(res);
    await waitForRun(user, data.run.id);
    const messages = await threadMessages(user, thread.id);
    expect(messages.map((m) => m.body)).toEqual(['Question one, rephrased', 'Answer to the edited question.']);
    expect(messages[0].editedAt).toBeTruthy();

    // other people's messages cannot be edited, and unknown ones are 404
    const eve = await registerUser('eve');
    expect((await api('PUT', `/api/ai/threads/${thread.id}/messages/${first.userMessage.id}`, { token: eve.token, json: { body: 'x' } })).status).toBe(404);
    expect((await api('PUT', `/api/ai/threads/${thread.id}/messages/msg_doesnotexist`, { token: user.token, json: { body: 'x' } })).status).toBe(404);
  });

  it('cancels a running answer and keeps the part that was already written', async () => {
    const user = await registerUser('cancel');
    await script([answer('One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen', { chunkDelayMs: 120 })]);
    const thread = await createThread(user);
    const { status, data } = await sendAi(user, thread.id, { body: 'Count slowly', agentId: 'general' });
    expect(status).toBe(201);
    // wait until some text has been persisted/streamed, then cancel
    const socket = await openSocket(user);
    await waitFor(async () => (await calls()).length > 0);
    await new Promise((r) => setTimeout(r, 500));
    const cancel = await api('POST', `/api/ai/runs/${data.run.id}/cancel`, { token: user.token });
    expect(cancel.status).toBe(200);
    const run = await waitForRun(user, data.run.id);
    const log = run.status === 'cancelled' ? '' : JSON.stringify(await json(await api('GET', `/api/ai/runs/${data.run.id}/events`, { token: user.token })));
    expect(run.status, log).toBe('cancelled');
    const messages = await threadMessages(user, thread.id);
    expect(messages[1].status).toBe('cancelled');
    socket.close();
    // a cancelled answer can be regenerated
    await script([answer('Short answer.')]);
    const re = await json(await api('POST', `/api/ai/threads/${thread.id}/regenerate`, { token: user.token, json: {} }));
    await waitForRun(user, re.run.id);
    expect((await threadMessages(user, thread.id))[1].body).toBe('Short answer.');
  });

  it('does not allow two answers at the same time in one thread', async () => {
    const user = await registerUser('busy');
    await script([answer('A slow answer that takes a little while to finish writing.', { chunkDelayMs: 150 })]);
    const thread = await createThread(user);
    const first = await sendAi(user, thread.id, { body: 'first', agentId: 'general' });
    expect(first.status).toBe(201);
    const second = await sendAi(user, thread.id, { body: 'second', agentId: 'general' });
    expect(second.status).toBe(409);
    expect(second.data.error.code).toBe('RUN_IN_PROGRESS');
    await api('POST', `/api/ai/runs/${first.data.run.id}/cancel`, { token: user.token });
    await waitForRun(user, first.data.run.id);
  });

  it('marks the answer as failed (and lets the user retry) when no model can answer', async () => {
    const user = await registerUser('fail');
    await script([{ when: { purpose: 'chat' }, respond: { error: '5000: internal server error' } }]);
    const thread = await createThread(user);
    const { finalRun: run, assistantMessage } = await ask(user, thread.id, { body: 'hello there', agentId: 'general' });
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('AI_FAILED');
    const messages = await threadMessages(user, thread.id);
    expect(messages[1].id).toBe(assistantMessage.id);
    expect(messages[1].status).toBe('failed');
    expect(messages[1].meta.ai.error.code).toBe('AI_FAILED');

    await script([answer('Recovered.')]);
    const retry = await api('POST', `/api/ai/runs/${run.id}/retry`, { token: user.token });
    expect(retry.status).toBe(202);
    await waitForRun(user, (await json(retry)).run.id);
    expect((await threadMessages(user, thread.id))[1]).toMatchObject({ body: 'Recovered.', status: 'sent' });
  });

  it('falls back to the next model when the first one fails, and records it', async () => {
    const user = await registerUser('fallback');
    await script([
      { when: { purpose: 'chat', model: MODEL.gemma }, respond: { error: '5007: No such model' } },
      answer('Answered by the fallback model.'),
    ]);
    const thread = await createThread(user);
    const { finalRun } = await ask(user, thread.id, { body: 'hello', agentId: 'general' });
    expect(finalRun.status).toBe('completed');
    const m = (await threadMessages(user, thread.id))[1];
    expect(m.body).toBe('Answered by the fallback model.');
    expect(m.meta.ai.modelId).not.toBe(MODEL.gemma);
    expect(m.meta.ai.fallbackFrom).toBe(MODEL.gemma);
    const usage = await json(await api('GET', '/api/ai/usage', { token: user.token }));
    expect(usage.byModel.some((x: any) => x.fallbacks > 0)).toBe(true);
    expect(usage.today.requests).toBeGreaterThan(0);
  });

  it('enforces the per-user quota before any model is called, and only administrators can change it', async () => {
    const admin = await getAdmin();
    const user = await registerUser('quota');
    await script([answer('First answer.')]);
    const thread = await createThread(user);

    // a regular user cannot touch quotas or the admin overview
    expect((await api('PUT', `/api/admin/users/${user.id}/quota`, { token: user.token, json: { dailyTokens: 5, dailyRequests: null, monthlyTokens: null } })).status).toBe(403);
    expect((await api('GET', '/api/admin/overview', { token: user.token })).status).toBe(403);
    // invalid values are refused
    expect((await api('PUT', `/api/admin/users/${user.id}/quota`, { token: admin.token, json: { dailyTokens: -4, dailyRequests: null, monthlyTokens: null } })).status).toBe(400);
    expect((await api('PUT', '/api/admin/users/usr_nobody/quota', { token: admin.token, json: { dailyTokens: 5, dailyRequests: null, monthlyTokens: null } })).status).toBe(404);

    // one token of allowance: the first request goes through and uses it up
    const set = await api('PUT', `/api/admin/users/${user.id}/quota`, { token: admin.token, json: { dailyTokens: 1, dailyRequests: null, monthlyTokens: null } });
    expect(set.status).toBe(200);
    expect((await json(set)).quota).toMatchObject({ dailyTokens: 1, custom: true });
    const first = await ask(user, thread.id, { body: 'first question', agentId: 'general' });
    expect(first.finalRun.status).toBe('completed');

    const before = (await calls()).length;
    const blocked = await sendAi(user, thread.id, { body: 'second question', agentId: 'general' });
    expect(blocked.status).toBe(429);
    expect(blocked.data.error.code).toBe('QUOTA_EXCEEDED');
    expect((await calls()).length).toBe(before); // no model was called, nothing was stored
    expect(await threadMessages(user, thread.id)).toHaveLength(2);

    const usage = await json(await api('GET', '/api/ai/usage', { token: user.token }));
    expect(usage.quota).toMatchObject({ dailyTokens: 1, custom: true });
    expect(usage.today.tokens).toBeGreaterThanOrEqual(1);

    // the admin sees the usage, then resets the quota to the default and the user can continue
    const adminView = await json(await api('GET', `/api/admin/users/${user.id}/usage`, { token: admin.token }));
    expect(adminView.today.tokens).toBeGreaterThanOrEqual(1);
    const overview = await json(await api('GET', '/api/admin/overview', { token: admin.token }));
    expect(overview.byUser.some((u: any) => u.userId === user.id)).toBe(true);
    const reset = await api('PUT', `/api/admin/users/${user.id}/quota`, { token: admin.token, json: { dailyTokens: null, dailyRequests: null, monthlyTokens: null } });
    expect((await json(reset)).quota.custom).toBe(false);
    await script([answer('Second answer.')]);
    expect((await ask(user, thread.id, { body: 'second question', agentId: 'general' })).finalRun.status).toBe('completed');
  });

  it('validates input and rejects unknown agents and models', async () => {
    const user = await registerUser('valid');
    const thread = await createThread(user);
    expect((await sendAi(user, thread.id, {})).status).toBe(400);
    expect((await sendAi(user, thread.id, { body: '   ' })).status).toBe(400);
    expect((await sendAi(user, thread.id, { body: 'x'.repeat(30_000) })).status).toBe(400);
    expect((await sendAi(user, thread.id, { body: 'hi', agentId: 'hacker' })).status).toBe(400);
    expect((await sendAi(user, thread.id, { body: 'hi', modelId: '@cf/evil/model' })).status).toBe(400);
    expect((await sendAi(user, thread.id, { body: 'hi', fileIds: ['fil_notmine'] })).status).toBeGreaterThanOrEqual(400);
    expect((await api('POST', '/api/ai/threads', { token: user.token, json: { agentId: 'nope' } })).status).toBe(400);
    expect((await api('GET', `/api/ai/threads/${thread.id}/messages?limit=0`, { token: user.token })).status).toBe(400);
    expect((await calls()).filter((c) => c.purpose === 'chat')).toHaveLength(0);
  });
});

describe('AMIN AI — files, images and voice', () => {
  beforeEach(async () => {
    await script([]);
  });

  it('reads an attached text file and gives its content to the model', async () => {
    const user = await registerUser('file');
    await script([answer('The invoice total is 1,250 euros.')]);
    const file = await uploadFile(user, 'invoice.txt', 'Invoice #77\nTotal due: 1,250 EUR\nDue date: 2026-12-01');
    const thread = await createThread(user);
    const { finalRun, userMessage } = await ask(user, thread.id, { body: 'What is the total?', fileIds: [file.id], agentId: 'general' });
    expect(finalRun.status).toBe('completed');
    expect(userMessage.attachments).toHaveLength(1);
    const call = (await calls()).find((c) => c.purpose === 'chat')!;
    expect(call.user).toContain('Total due: 1,250 EUR');
    expect(call.user).toContain('invoice.txt');
  });

  it('sends attached images to a vision model', async () => {
    const user = await registerUser('vision');
    await script([answer('A tiny red square.')]);
    // a minimal but valid PNG (header + IHDR + IDAT + IEND) padded to look like a real image to the size checks
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const file = await uploadFile(user, 'dot.png', png, 'image/png');
    const thread = await createThread(user);
    const { finalRun } = await ask(user, thread.id, { body: 'Describe this picture', fileIds: [file.id], agentId: 'general' });
    expect(finalRun.status).toBe('completed');
    const call = (await calls()).find((c) => c.purpose === 'chat')!;
    expect(call.hasImage).toBe(true);
    expect(call.model).toBe(MODEL.gemma); // gemma 4 is a vision model
  });

  it('refuses to attach files that belong to someone else', async () => {
    const owner = await registerUser('owner');
    const thief = await registerUser('thief');
    const file = await uploadFile(owner, 'private.txt', 'top secret');
    const thread = await createThread(thief);
    const { status } = await sendAi(thief, thread.id, { body: 'read it', fileIds: [file.id], agentId: 'general' });
    expect(status).toBeGreaterThanOrEqual(400);
    expect((await calls()).filter((c) => c.purpose === 'chat')).toHaveLength(0);
  });

  it('transcribes voice input with the speech model', async () => {
    const user = await registerUser('voice');
    await script([{ when: { model: MODEL.whisper }, respond: { asr: 'سلام، یادآوری فردا ساعت نه' } }]);
    const webm = new Uint8Array(400);
    webm.set([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
    const ok = await api('POST', '/api/ai/transcribe?lang=fa', { token: user.token, body: webm, headers: { 'Content-Type': 'audio/webm' } });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ text: 'سلام، یادآوری فردا ساعت نه', modelId: MODEL.whisper });

    const notAudio = await api('POST', '/api/ai/transcribe', { token: user.token, body: new TextEncoder().encode('<html>'.repeat(60)), headers: { 'Content-Type': 'audio/webm' } });
    expect(notAudio.status).toBe(400);
    const wrongType = await api('POST', '/api/ai/transcribe', { token: user.token, body: webm, headers: { 'Content-Type': 'application/json' } });
    expect(wrongType.status).toBe(415);
  });
});

describe('AMIN AI — search over past conversations', () => {
  it('finds messages with full-text search (Persian and English), only in the owner\'s AI conversations', async () => {
    const user = await registerUser('search');
    const other = await registerUser('search2');
    await script([answer('برای سفر به شیراز بهترین فصل بهار است.'), title('سفر')]);
    const thread = await createThread(user);
    await ask(user, thread.id, { body: 'Best season for a trip to Shiraz?', agentId: 'general' });

    const byEnglish = await json(await api('GET', '/api/ai/search?q=shiraz', { token: user.token }));
    expect(byEnglish.hits.length).toBeGreaterThan(0);
    expect(byEnglish.hits[0]).toMatchObject({ threadId: thread.id });
    expect(byEnglish.hits[0].snippet.toLowerCase()).toContain('shiraz');

    const byPersian = await json(await api('GET', '/api/ai/search?q=' + encodeURIComponent('فصل بهار'), { token: user.token }));
    expect(byPersian.hits.length).toBeGreaterThan(0);

    // Arabic letter variants and diacritics are normalised: "بهار" with Arabic kaf/yeh forms still matches
    const variants = await json(await api('GET', '/api/ai/search?q=' + encodeURIComponent('شيراز'), { token: user.token }));
    expect(variants.hits.length).toBeGreaterThan(0);

    const theirs = await json(await api('GET', '/api/ai/search?q=shiraz', { token: other.token }));
    expect(theirs.hits).toEqual([]);
    expect((await api('GET', '/api/ai/search?q=', { token: user.token })).status).toBe(400);

    // deleting the conversation removes it from the index too
    expect((await api('DELETE', `/api/ai/threads/${thread.id}`, { token: user.token })).status).toBe(200);
    const after = await json(await api('GET', '/api/ai/search?q=shiraz', { token: user.token }));
    expect(after.hits).toEqual([]);
    expect((await api('GET', `/api/ai/threads/${thread.id}`, { token: user.token })).status).toBe(404);
  });

  it('searches normal chats the user belongs to when asked, never other people\'s', async () => {
    const a = await registerUser('sa');
    const b = await registerUser('sb');
    const c = await registerUser('sc');
    const chat = await directChat(a, b);
    await sendText(a, chat, 'the quarterly budget meeting is on Tuesday');
    const hit = await json(await api('GET', '/api/ai/search?q=budget&scope=all', { token: b.token }));
    expect(hit.hits.map((h: any) => h.conversationId)).toContain(chat);
    const miss = await json(await api('GET', '/api/ai/search?q=budget&scope=all', { token: c.token }));
    expect(miss.hits).toEqual([]);
    // default scope is the AI conversations only
    const ai = await json(await api('GET', '/api/ai/search?q=budget', { token: b.token }));
    expect(ai.hits).toEqual([]);
  });
});

describe('AMIN AI — agents and models endpoints', () => {
  it('lists the six agents (plus general and auto) with honest tool availability', async () => {
    const user = await registerUser('agents');
    const { agents } = await json(await api('GET', '/api/ai/agents', { token: user.token }));
    expect(agents.map((a: any) => a.id)).toEqual(['auto', 'general', 'personal', 'research', 'coder', 'messenger', 'file', 'creative']);
    const research = agents.find((a: any) => a.id === 'research');
    const search = research.tools.find((t: any) => t.id === 'web_search');
    expect(search.available).toBe(false); // no search provider is configured in the test environment
    expect(search.reason).toMatch(/not connected|SEARCH_PROVIDER/i);
    const messenger = agents.find((a: any) => a.id === 'messenger');
    expect(messenger.tools.find((t: any) => t.id === 'message_send').risk).toBe('sensitive');
    expect(agents.find((a: any) => a.id === 'coder').mode).toBe('direct');
    expect(agents.find((a: any) => a.id === 'personal').mode).toBe('plan');
    // names exist in both languages
    for (const a of agents) expect(a.name.fa && a.name.en).toBeTruthy();
  });

  it('reports model availability and never marks an unverified model as ready', async () => {
    const user = await registerUser('models');
    await script([{ when: { purpose: 'health' }, respond: { text: 'ok' } }]);
    const first = await json(await api('GET', '/api/ai/models', { token: user.token }));
    expect(first.backend).toBe('workers-ai');
    for (const m of first.models) expect(['available', 'unavailable', 'unknown']).toContain(m.status);
    // wait for the background probe, then everything the probe could reach is "available"
    const after = await waitFor(async () => {
      const r = await json(await api('GET', '/api/ai/models', { token: user.token }));
      return r.models.some((m: any) => m.status === 'available') ? r : null;
    });
    expect(after.defaults.chat).toBe(MODEL.gemma);
    expect(after.models.find((m: any) => m.id === MODEL.gemma).selectable).toBe(true);
    // forcing a refresh is an admin action
    expect((await api('POST', '/api/ai/models/refresh', { token: user.token })).status).toBe(403);
  });
});

void env;
void exports;
