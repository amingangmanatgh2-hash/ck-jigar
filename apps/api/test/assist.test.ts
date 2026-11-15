import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { executeRun } from '../src/agents/executor';
import { createAssistantPlaceholder } from '../src/services/ai-chat';
import { createRun } from '../src/services/runs';
import { MODEL, calls, script, type Rule } from './ai-helpers';
import { api, createThread, directChat, json, openSocket, registerUser, sendAi, sendText, threadMessages, waitFor, waitForRun, type TestUser } from './helpers';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM model_health').run();
  await script([]);
});

const answer = (text: string, purpose = 'assist'): Rule => ({ when: { purpose }, respond: { text } });

async function setDirectAccess(user: TestUser, chat: string, access: 'off' | 'mention' | 'context') {
  const res = await api('PUT', `/api/conversations/${chat}/ai`, { token: user.token, json: { access } });
  expect(res.status).toBe(200);
}

async function makeGroup(owner: TestUser, members: TestUser[], policy?: { level: string; invokeRoles?: string }) {
  const g = (await json(await api('POST', '/api/conversations/group', { token: owner.token, json: { title: 'Team', memberIds: members.map((m) => m.id) } }))).conversation;
  if (policy) {
    const res = await api('PUT', `/api/conversations/${g.id}/ai-policy`, { token: owner.token, json: policy });
    expect(res.status).toBe(200);
  }
  return g.id as string;
}

async function chatMessages(user: TestUser, chat: string): Promise<any[]> {
  return (await json(await api('GET', `/api/conversations/${chat}/messages?limit=100`, { token: user.token }))).messages;
}

/** Waits until the AI reply to a mention is final and returns it. */
async function aiReply(user: TestUser, chat: string, messageId: string) {
  return waitFor(async () => {
    const m = (await chatMessages(user, chat)).find((x) => x.id === messageId);
    return m && m.status !== 'streaming' ? m : null;
  });
}

describe('@AMINAI in direct chats — permission first', () => {
  it('does nothing without permission, tells only the sender, and never calls a model', async () => {
    const alice = await registerUser('a');
    const bob = await registerUser('b');
    const chat = await directChat(alice, bob);
    await script([answer('should never be produced')]);

    const sent = await sendText(alice, chat, '@AMINAI summarize our chat');
    expect(sent.ai.triggered).toBe(false);
    expect(sent.ai.denied).toMatchObject({ code: 'AI_OFF', canEnable: true });
    const msgs = await chatMessages(bob, chat);
    expect(msgs).toHaveLength(1); // nothing was posted by the AI, and no hint about the denial reaches the other person
    expect(msgs[0].senderId).toBe(alice.id);
    expect(await calls()).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE kind = 'assist'").first<any>()).n).toBe(0);

    // an e-mail address or a plain word does not count as a mention
    for (const text of ['write to info@aminai.com please', 'we talked about aminai yesterday']) {
      const r = await sendText(alice, chat, text);
      expect(r.ai).toEqual({ triggered: false });
    }
  });

  it('"mention" level: the assistant sees only the message that mentions it, and replies in the chat for both people', async () => {
    const alice = await registerUser('a');
    const bob = await registerUser('b');
    const chat = await directChat(alice, bob);
    await sendText(bob, chat, 'PRIVATE-EARLIER: my salary is secret');
    await setDirectAccess(alice, chat, 'mention');
    const bobSocket = await openSocket(bob);
    const aliceSocket = await openSocket(alice);
    await script([answer('Sure — here is a friendly greeting: "Good morning!"')]);

    const sent = await sendText(alice, chat, '@AMINAI write a friendly greeting for Bob');
    expect(sent.ai.triggered).toBe(true);
    const reply = await aiReply(alice, chat, sent.ai.messageId);
    expect(reply).toMatchObject({ senderId: 'usr_amin_ai', status: 'sent', replyToId: sent.message.id });
    expect(reply.body).toContain('Good morning');
    expect(reply.meta.ai).toMatchObject({ agentId: 'general', invokedBy: alice.id, runId: sent.ai.runId });

    // what the model got: the request, but not the earlier messages
    const call = (await calls()).find((c) => c.purpose === 'assist')!;
    expect(call.user).toContain('write a friendly greeting for Bob');
    expect(call.user).not.toContain('PRIVATE-EARLIER');
    expect(call.all).not.toContain('PRIVATE-EARLIER');
    expect(call.system).toMatch(/AMIN AI/);
    expect(call.system).toMatch(/mention/i);

    // bob sees the reply stream (it is a message in the shared chat); only alice gets the run details
    await bobSocket.waitFor((e) => e.type === 'message.updated' && e.message.id === sent.ai.messageId && e.message.status === 'sent');
    expect(bobSocket.events.some((e) => e.type === 'run.delta' && e.runId === sent.ai.runId)).toBe(true);
    expect(bobSocket.events.some((e) => e.type === 'run.updated')).toBe(false);
    await aliceSocket.waitFor((e) => e.type === 'run.updated' && e.run.id === sent.ai.runId && e.run.status === 'completed');
    bobSocket.close();
    aliceSocket.close();

    // usage is charged to the person who invoked the assistant
    const usage = await json(await api('GET', '/api/ai/usage', { token: alice.token }));
    const bobUsage = await json(await api('GET', '/api/ai/usage', { token: bob.token }));
    expect(usage.today.requests).toBeGreaterThan(0);
    expect(bobUsage.today.requests).toBe(0);
  });

  it('"context" level: the assistant reads recent messages of this chat, with names and times', async () => {
    const alice = await registerUser('a');
    const bob = await registerUser('b');
    const chat = await directChat(alice, bob);
    await sendText(bob, chat, 'Can we move the meeting to Thursday?');
    await sendText(alice, chat, 'Thursday works, 10:00?');
    await setDirectAccess(alice, chat, 'context');
    await script([answer('Bob proposed Thursday and Alice suggested 10:00.')]);

    const sent = await sendText(alice, chat, '@AMINAI summarize the conversation');
    const reply = await aiReply(alice, chat, sent.ai.messageId);
    expect(reply.body).toContain('Thursday');
    const call = (await calls()).find((c) => c.purpose === 'assist')!;
    expect(call.user).toContain('Can we move the meeting to Thursday?');
    expect(call.user).toContain('Thursday works, 10:00?');
    expect(call.user).toContain(bob.displayName);
    expect(call.user).toContain(alice.displayName);
    expect(call.user).toMatch(/summarize the conversation/);
    expect(call.user).not.toContain('@AMINAI'); // the mention itself is stripped from the instruction
  });

  it('either participant can veto the assistant, even after the other one allowed it', async () => {
    const alice = await registerUser('a');
    const bob = await registerUser('b');
    const chat = await directChat(alice, bob);
    await setDirectAccess(alice, chat, 'context');
    await api('PUT', `/api/conversations/${chat}/ai`, { token: bob.token, json: { blocked: true } });
    await script([answer('no')]);
    const sent = await sendText(alice, chat, '@AMINAI what did Bob say?');
    expect(sent.ai).toMatchObject({ triggered: false, denied: { code: 'AI_BLOCKED', canEnable: false } });
    expect(await calls()).toHaveLength(0);
    // the other participant cannot invoke it either
    const bobTry = await sendText(bob, chat, '@AMINAI hello');
    expect(bobTry.ai.denied).toBeTruthy();
  });

  it('stops when access is revoked between the mention and the moment the assistant starts working', async () => {
    const alice = await registerUser('a');
    const bob = await registerUser('b');
    const chat = await directChat(alice, bob);
    await setDirectAccess(alice, chat, 'context');
    const trigger = (await sendText(alice, chat, 'hello @AMINAI summarize')).message;
    // simulate the delay: create the run by hand, revoke the permission, then let the executor pick it up
    const placeholder = await createAssistantPlaceholder(env, { conversationId: chat, threadId: null, agentId: 'general', invokedBy: alice.id, replyToId: trigger.id });
    const run = await createRun(env, {
      userId: alice.id, kind: 'assist', agentId: 'general', goal: trigger.body, conversationId: chat, triggerMessageId: trigger.id, resultMessageId: placeholder.id,
      options: { locale: 'en', access: { level: 'context', adminAssist: false } },
    });
    await api('PUT', `/api/conversations/${chat}/ai`, { token: alice.token, json: { access: 'off' } });
    await script([answer('must not run')]);
    await executeRun(env, run.id, new AbortController().signal);
    const after = await env.DB.prepare('SELECT status, error_code FROM runs WHERE id = ?').bind(run.id).first<any>();
    expect(after).toEqual({ status: 'failed', error_code: 'AI_ACCESS_REVOKED' });
    expect((await calls()).filter((c) => c.purpose === 'assist')).toHaveLength(0);
    const msg = (await chatMessages(alice, chat)).find((m) => m.id === placeholder.id);
    expect(msg.status).toBe('failed');
  });

  it('describes an attached image and reads an attached document when the assistant is mentioned', async () => {
    const alice = await registerUser('a');
    const bob = await registerUser('b');
    const chat = await directChat(alice, bob);
    await setDirectAccess(alice, chat, 'mention');
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0));
    const upload = async (name: string, data: string | ArrayBuffer, type: string) => {
      const form = new FormData();
      form.set('file', new File([data], name, { type }));
      return (await json(await api('POST', '/api/files', { token: alice.token, body: form }))).file;
    };
    const img = await upload('photo.png', png as unknown as ArrayBuffer, 'image/png');
    await script([answer('A one-pixel red image.')]);
    const first = await sendText(alice, chat, '@AMINAI describe this picture', { fileIds: [img.id] });
    await aiReply(alice, chat, first.ai.messageId);
    expect((await calls()).find((c) => c.purpose === 'assist')!.hasImage).toBe(true);

    await script([answer('The contract ends in March.')]);
    const doc = await upload('contract.txt', 'Contract term: ends 31 March 2027. Notice period: 60 days.', 'text/plain');
    const second = await sendText(alice, chat, '@AMINAI when does this contract end?', { fileIds: [doc.id] });
    await aiReply(alice, chat, second.ai.messageId);
    expect((await calls()).find((c) => c.purpose === 'assist')!.user).toContain('ends 31 March 2027');
  });

  it('applies the invoker\'s quota and rate limit without blocking the message itself', async () => {
    const alice = await registerUser('a');
    const bob = await registerUser('b');
    const chat = await directChat(alice, bob);
    await setDirectAccess(alice, chat, 'mention');
    await env.DB.prepare('INSERT INTO user_quotas (user_id, daily_tokens, daily_requests, monthly_tokens, updated_at) VALUES (?, 0, NULL, NULL, ?)').bind(alice.id, Date.now()).run();
    await script([answer('no')]);
    const sent = await sendText(alice, chat, '@AMINAI hello');
    expect(sent.message.body).toBe('@AMINAI hello'); // the human message was delivered
    expect(sent.ai).toMatchObject({ triggered: false, denied: { code: 'QUOTA_EXCEEDED' } });
    expect(await calls()).toHaveLength(0);
  });
});

describe('@AMINAI in secret (end-to-end encrypted) chats — the user selects what to share', () => {
  const jwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) };

  async function secretChat() {
    const a = await registerUser('s');
    const b = await registerUser('t');
    for (const u of [a, b]) await api('PUT', '/api/users/me/e2ee-key', { token: u.token, json: { jwk } });
    const chat = await directChat(a, b, true);
    return { a, b, chat };
  }

  it('never reads a secret chat; only the excerpts the user selected and sent reach the model', async () => {
    const { a, chat } = await secretChat();
    // ciphertext is all the server holds
    const cipher = { v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'c2VjcmV0LXRleHQ=' };
    const m = await api('POST', `/api/conversations/${chat}/messages`, { token: a.token, json: { cipher } });
    expect(m.status).toBe(201);
    expect((await json(m)).ai).toEqual({ triggered: false });

    await script([answer('The two messages agree on Friday.', 'chat')]);
    const thread = await createThread(a);
    const res = await sendAi(a, thread.id, {
      body: 'Is there a conflict between these messages?',
      agentId: 'general',
      shared: {
        conversationId: chat,
        excerpts: [
          { sender: 'Sara', text: 'Let us meet on Friday', at: Date.now() - 60_000 },
          { sender: 'Me', text: 'Friday is fine', at: Date.now() },
        ],
      },
    });
    expect(res.status).toBe(201);
    expect(res.data.userMessage.meta.shared).toMatchObject({ e2ee: true, count: 2 });
    const run = await waitForRun(a, res.data.run.id);
    expect(run.status).toBe('completed');
    const call = (await calls()).find((c) => c.purpose === 'chat')!;
    expect(call.user).toContain('Let us meet on Friday');
    expect(call.user).toContain('Friday is fine');
    expect(call.user).toMatch(/secret, end-to-end encrypted chat/);
    expect(call.all).not.toContain('c2VjcmV0LXRleHQ='); // ciphertext is never forwarded

    // the shared excerpts are stored in the AI conversation of the user only
    const stored = (await threadMessages(a, thread.id))[0];
    expect(stored.meta.shared.excerpts.map((e: any) => e.text)).toEqual(['Let us meet on Friday', 'Friday is fine']);
  });

  it('validates the selection: members only, excerpts for secret chats, ids for normal chats', async () => {
    const { a, b, chat } = await secretChat();
    const outsider = await registerUser('o');
    const thread = await createThread(a);
    const excerpt = [{ sender: 'X', text: 'hello there' }];
    // outsider cannot select from a chat they are not in
    const t2 = await createThread(outsider);
    expect((await sendAi(outsider, t2.id, { body: 'review', shared: { conversationId: chat, excerpts: excerpt } })).status).toBe(404);
    // secret chat: ids are refused (the server cannot read it), and empty selections are refused
    expect((await sendAi(a, thread.id, { body: 'review', shared: { conversationId: chat, messageIds: ['msg_x'] } })).status).toBe(400);
    expect((await sendAi(a, thread.id, { body: 'review', shared: { conversationId: chat, excerpts: [] } })).status).toBe(400);
    // normal chat: excerpts are refused (the server reads the messages itself, so a user cannot fabricate "chat content")
    const normal = await directChat(a, b);
    expect((await sendAi(a, thread.id, { body: 'review', shared: { conversationId: normal, excerpts: excerpt } })).status).toBe(400);
    // limits
    const many = Array.from({ length: 80 }, (_, i) => ({ sender: 'X', text: `m${i}` }));
    expect((await sendAi(a, thread.id, { body: 'review', shared: { conversationId: chat, excerpts: many } })).status).toBe(400);
    expect((await calls()).filter((c) => c.purpose === 'chat')).toHaveLength(0);
  });

  it('lets the user hand selected messages of a normal chat to the assistant even when chat access is off, but respects a block', async () => {
    const a = await registerUser('p');
    const b = await registerUser('q');
    const chat = await directChat(a, b);
    const m1 = (await sendText(b, chat, 'The invoice number is INV-4471')).message;
    await sendText(b, chat, 'unselected: something else');
    const m3 = (await sendText(a, chat, 'Thanks, I will pay by Friday')).message;
    await script([answer('Invoice INV-4471 will be paid by Friday.', 'chat')]);
    const thread = await createThread(a);
    const res = await sendAi(a, thread.id, { body: 'Summarize what was agreed', shared: { conversationId: chat, messageIds: [m1.id, m3.id] } });
    expect(res.status).toBe(201);
    expect((await waitForRun(a, res.data.run.id)).status).toBe('completed');
    const call = (await calls()).find((c) => c.purpose === 'chat')!;
    expect(call.user).toContain('INV-4471');
    expect(call.user).toContain('pay by Friday');
    expect(call.user).not.toContain('unselected');

    // once the other participant blocks AI processing, their messages can no longer be shared
    await api('PUT', `/api/conversations/${chat}/ai`, { token: b.token, json: { blocked: true } });
    const denied = await sendAi(a, thread.id, { body: 'Again', shared: { conversationId: chat, messageIds: [m1.id] } });
    expect(denied.status).toBe(403);
    expect(denied.data.error.code).toBe('AI_BLOCKED');
  });
});

describe('AMIN AI in groups — admins control the access level', () => {
  it('follows the group level and invoke roles set by the admins', async () => {
    const owner = await registerUser('o');
    const member = await registerUser('m');
    const group = await makeGroup(owner, [member]); // default: off
    await script([answer('Hello team!')]);

    // off
    let r = await sendText(member, group, '@AMINAI hi');
    expect(r.ai.denied).toMatchObject({ code: 'AI_OFF' });
    expect(await calls()).toHaveLength(0);

    // mention: everyone may invoke it, nobody's history is read
    await sendText(owner, group, 'EARLIER-GROUP-MESSAGE budget is 5000');
    await api('PUT', `/api/conversations/${group}/ai-policy`, { token: owner.token, json: { level: 'mention', invokeRoles: 'all' } });
    r = await sendText(member, group, '@AMINAI say hello to the team');
    expect(r.ai.triggered).toBe(true);
    await aiReply(member, group, r.ai.messageId);
    let call = (await calls()).find((c) => c.purpose === 'assist')!;
    expect(call.user).not.toContain('EARLIER-GROUP-MESSAGE');

    // context: it may read recent messages
    await script([answer('The budget is 5000.')]);
    await api('PUT', `/api/conversations/${group}/ai-policy`, { token: owner.token, json: { level: 'context' } });
    r = await sendText(member, group, '@AMINAI what is the budget?');
    const reply = await aiReply(member, group, r.ai.messageId);
    expect(reply.body).toContain('5000');
    call = (await calls()).find((c) => c.purpose === 'assist')!;
    expect(call.user).toContain('EARLIER-GROUP-MESSAGE budget is 5000');
    expect(call.user).toContain(owner.displayName);

    // admins only
    await api('PUT', `/api/conversations/${group}/ai-policy`, { token: owner.token, json: { level: 'context', invokeRoles: 'admins' } });
    const denied = await sendText(member, group, '@AMINAI hello again');
    expect(denied.ai.denied).toMatchObject({ code: 'AI_ADMINS_ONLY' });
    const ok = await sendText(owner, group, '@AMINAI hello from the admin');
    expect(ok.ai.triggered).toBe(true);
    await aiReply(owner, group, ok.ai.messageId);

    // every member sees the replies, and the policy changes were announced in the chat
    const seen = await chatMessages(member, group);
    expect(seen.filter((m) => m.senderId === 'usr_amin_ai')).toHaveLength(3);
    expect(seen.filter((m) => m.meta?.system?.code === 'ai_policy_changed').length).toBeGreaterThanOrEqual(3);
  });

  it('assist level: only an admin gets poll/announcement help, and nothing is published without their approval', async () => {
    const owner = await registerUser('o');
    const member = await registerUser('m');
    const group = await makeGroup(owner, [member], { level: 'assist', invokeRoles: 'all' });
    await script([
      { when: { purpose: 'plan' }, respond: { json: { summary: 'Publish a lunch poll', steps: [{ title: 'Publish the poll', tool: 'poll_create', args: { question: 'Where should we have lunch?', options: ['Pizza', 'Sushi', 'Kebab'] } }] } } },
      answer('I prepared the poll.'),
    ]);

    const sent = await sendText(owner, group, '@AMINAI create a poll: where should we have lunch? Pizza, Sushi or Kebab');
    expect(sent.ai.triggered).toBe(true);
    const parked = await waitForRun(owner, sent.ai.runId, ['awaiting_approval', 'completed', 'failed']);
    expect(parked.status).toBe('awaiting_approval');
    expect(parked.kind).toBe('assist');
    expect(parked.approvals[0]).toMatchObject({ action: 'poll_create', status: 'pending' });
    expect(parked.approvals[0].summary).toContain('Where should we have lunch?');
    expect((await chatMessages(member, group)).filter((m) => m.kind === 'poll')).toHaveLength(0);

    // everyone sees that AMIN AI is waiting for its invoker's approval; the member cannot approve anything
    const waiting = (await chatMessages(member, group)).find((m) => m.id === sent.ai.messageId);
    expect(waiting).toMatchObject({ status: 'streaming' });
    expect(waiting.meta.ai.waiting).toBe('approval');
    expect((await api('POST', `/api/ai/approvals/${parked.approvals[0].id}/decision`, { token: member.token, json: { decision: 'approve' } })).status).toBe(404);
    expect((await json(await api('GET', '/api/ai/approvals', { token: member.token }))).approvals).toEqual([]);

    // the admin edits the question and approves: the poll appears in the group
    const ok = await api('POST', `/api/ai/approvals/${parked.approvals[0].id}/decision`, { token: owner.token, json: { decision: 'approve', edits: { question: 'Lunch on Friday: where?' } } });
    expect(ok.status).toBe(200);
    const done = await waitForRun(owner, sent.ai.runId);
    expect(done.status).toBe('completed');
    const poll = (await chatMessages(member, group)).find((m) => m.kind === 'poll');
    expect(poll.body).toBe('Lunch on Friday: where?');
    expect(poll.poll.options.map((o: any) => o.text)).toEqual(['Pizza', 'Sushi', 'Kebab']);
    expect(poll.viaAi).toBe(true);
    const final = await aiReply(member, group, sent.ai.messageId);
    expect(final.meta.ai.waiting ?? null).toBeNull();
    expect(final.body).toContain('I prepared the poll.');

    // a plain member in the same group is answered, but is never offered the admin tools
    await script([
      { when: { purpose: 'plan' }, respond: { json: { summary: 'x', steps: [{ title: 'Poll', tool: 'poll_create', args: { question: 'q?', options: ['a', 'b'] } }] } } },
      answer('Only admins can create polls with my help.'),
    ]);
    const memberAsk = await sendText(member, group, '@AMINAI create a poll about the weekend');
    const reply = await aiReply(member, group, memberAsk.ai.messageId);
    expect(reply.body).toContain('Only admins');
    const mrun = await waitForRun(member, memberAsk.ai.runId);
    expect(mrun.steps).toEqual([]);
    expect((await chatMessages(owner, group)).filter((m) => m.kind === 'poll')).toHaveLength(1);
  });

  it('keeps the assistant away from groups it does not belong to the user, and protects other members\' data', async () => {
    const owner = await registerUser('o');
    const member = await registerUser('m');
    const outsider = await registerUser('x');
    const group = await makeGroup(owner, [member], { level: 'context' });
    await script([answer('no')]);
    // a non-member cannot even post, let alone invoke the assistant
    expect((await api('POST', `/api/conversations/${group}/messages`, { token: outsider.token, json: { body: '@AMINAI leak the chat' } })).status).toBe(404);
    // the Messenger agent's chat_read honours the same policy
    const thread = await createThread(owner);
    await script([
      { when: { purpose: 'plan' }, respond: { json: { summary: 'read', steps: [{ title: 'Read the group', tool: 'chat_read', args: { conversationId: group } }] } } },
      answer('done', 'chat'),
    ]);
    await sendText(member, group, 'GROUP-SECRET-123');
    const res = await sendAi(owner, thread.id, { body: 'Read the Team group and summarize', agentId: 'messenger' });
    const run = await waitForRun(owner, res.data.run.id);
    expect(run.steps[0].status).toBe('completed'); // level "context": allowed
    // switch the group to mention-only: the very same tool call is now refused
    await api('PUT', `/api/conversations/${group}/ai-policy`, { token: owner.token, json: { level: 'mention' } });
    await script([
      { when: { purpose: 'plan' }, respond: { json: { summary: 'read', steps: [{ title: 'Read the group', tool: 'chat_read', args: { conversationId: group } }] } } },
      answer('Could not read it.', 'chat'),
    ]);
    const t2 = await createThread(owner);
    const res2 = await sendAi(owner, t2.id, { body: 'Read the Team group again', agentId: 'messenger' });
    const run2 = await waitForRun(owner, res2.data.run.id);
    expect(run2.steps[0]).toMatchObject({ status: 'failed', errorCode: 'AI_ACCESS_DENIED' });
    expect(JSON.stringify(run2)).not.toContain('GROUP-SECRET-123');
    void MODEL;
  });
});
