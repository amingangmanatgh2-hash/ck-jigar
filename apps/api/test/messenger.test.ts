import { describe, expect, it } from 'vitest';
import { api, directChat, json, registerUser, sendText } from './helpers';

describe('direct chats & messages', () => {
  it('creates one chat per pair (idempotent) and exchanges messages', async () => {
    const a = await registerUser('ann');
    const b = await registerUser('ben');
    const c1 = await directChat(a, b);
    const c2 = await directChat(b, a);
    expect(c2).toBe(c1);

    await sendText(a, c1, 'سلام بن');
    await sendText(b, c1, 'hello ann');
    const list = await json(await api('GET', `/api/conversations/${c1}/messages`, { token: a.token }));
    expect(list.messages.map((m: any) => m.body)).toEqual(['سلام بن', 'hello ann']);
    expect(list.hasMore).toBe(false);

    const chats = await json(await api('GET', '/api/conversations', { token: b.token }));
    const mine = chats.conversations.find((x: any) => x.id === c1);
    expect(mine.peer.id).toBe(a.id);
    expect(mine.unread).toBe(1);
    expect(mine.lastMessage.preview).toBe('hello ann');

    await api('POST', `/api/conversations/${c1}/read`, { token: b.token });
    const after = await json(await api('GET', '/api/conversations', { token: b.token }));
    expect(after.conversations.find((x: any) => x.id === c1).unread).toBe(0);
  });

  it('hides conversations from non-members (404, not 403)', async () => {
    const a = await registerUser('own');
    const b = await registerUser('peer');
    const spy = await registerUser('spy');
    const c = await directChat(a, b);
    await sendText(a, c, 'private');
    for (const [method, path] of [
      ['GET', `/api/conversations/${c}`],
      ['GET', `/api/conversations/${c}/messages`],
    ] as const) {
      const res = await api(method, path, { token: spy.token });
      expect(res.status).toBe(404);
    }
    const post = await api('POST', `/api/conversations/${c}/messages`, { token: spy.token, json: { body: 'intrude' } });
    expect(post.status).toBe(404);
  });

  it('paginates history with a cursor', async () => {
    const a = await registerUser('pg');
    const b = await registerUser('pgb');
    const c = await directChat(a, b);
    for (let i = 1; i <= 7; i++) await sendText(a, c, `m${i}`);
    const page1 = await json(await api('GET', `/api/conversations/${c}/messages?limit=3`, { token: a.token }));
    expect(page1.messages.map((m: any) => m.body)).toEqual(['m5', 'm6', 'm7']);
    expect(page1.hasMore).toBe(true);
    const page2 = await json(await api('GET', `/api/conversations/${c}/messages?limit=3&before=${page1.messages[0].id}`, { token: a.token }));
    expect(page2.messages.map((m: any) => m.body)).toEqual(['m2', 'm3', 'm4']);
    const page3 = await json(await api('GET', `/api/conversations/${c}/messages?limit=3&before=${page2.messages[0].id}`, { token: a.token }));
    expect(page3.messages.map((m: any) => m.body)).toEqual(['m1']);
    expect(page3.hasMore).toBe(false);
  });

  it('validates message input', async () => {
    const a = await registerUser('val');
    const b = await registerUser('valb');
    const c = await directChat(a, b);
    expect((await api('POST', `/api/conversations/${c}/messages`, { token: a.token, json: { body: '   ' } })).status).toBe(400);
    expect((await api('POST', `/api/conversations/${c}/messages`, { token: a.token, json: { body: 'x'.repeat(8001) } })).status).toBe(400);
    expect((await api('POST', `/api/conversations/${c}/messages`, { token: a.token, json: { cipher: { v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' } } })).status).toBe(400);
    expect((await api('POST', `/api/conversations/${c}/messages`, { token: a.token, json: { body: 'x', replyToId: 'msg_nonexistent' } })).status).toBe(400);
  });

  it('lets only the author edit and delete, and removes deleted content', async () => {
    const a = await registerUser('ed');
    const b = await registerUser('edb');
    const c = await directChat(a, b);
    const { message } = await sendText(a, c, 'first draft');
    const forbidden = await api('PUT', `/api/messages/${message.id}`, { token: b.token, json: { body: 'hacked' } });
    expect(forbidden.status).toBe(403);
    const edited = await json(await api('PUT', `/api/messages/${message.id}`, { token: a.token, json: { body: 'final text' } }));
    expect(edited.message.body).toBe('final text');
    expect(edited.message.editedAt).toBeTypeOf('number');

    expect((await api('DELETE', `/api/messages/${message.id}`, { token: b.token })).status).toBe(403);
    expect((await api('DELETE', `/api/messages/${message.id}`, { token: a.token })).status).toBe(200);
    const list = await json(await api('GET', `/api/conversations/${c}/messages`, { token: b.token }));
    expect(list.messages[0]).toMatchObject({ deleted: true, body: null });
  });

  it('prevents sending to or reading the AMIN AI conversation through the human-chat endpoints', async () => {
    const a = await registerUser('aiw');
    const list = await json(await api('GET', '/api/conversations', { token: a.token }));
    const ai = list.conversations.find((c: any) => c.type === 'ai');
    const res = await api('POST', `/api/conversations/${ai.id}/messages`, { token: a.token, json: { body: 'hi' } });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('USE_AI_ENDPOINT');
  });
});

describe('groups', () => {
  it('creates a group with roles and enforces admin-only actions', async () => {
    const owner = await registerUser('own');
    const m1 = await registerUser('mem');
    const m2 = await registerUser('mem');
    const outsider = await registerUser('out');
    const res = await api('POST', '/api/conversations/group', { token: owner.token, json: { title: 'تیم پروژه', memberIds: [m1.id] } });
    expect(res.status).toBe(201);
    const g = (await json(res)).conversation;
    expect(g.title).toBe('تیم پروژه');
    expect(g.myRole).toBe('owner');
    expect(g.members.map((m: any) => m.role).sort()).toEqual(['member', 'owner']);

    // members cannot add, admins can
    expect((await api('POST', `/api/conversations/${g.id}/members`, { token: m1.token, json: { userIds: [m2.id] } })).status).toBe(403);
    expect((await api('PATCH', `/api/conversations/${g.id}/members/${m1.id}`, { token: m1.token, json: { role: 'admin' } })).status).toBe(403);
    expect((await api('PATCH', `/api/conversations/${g.id}/members/${m1.id}`, { token: owner.token, json: { role: 'admin' } })).status).toBe(200);
    const added = await json(await api('POST', `/api/conversations/${g.id}/members`, { token: m1.token, json: { userIds: [m2.id] } }));
    expect(added.added).toEqual([m2.id]);

    // outsiders see nothing
    expect((await api('GET', `/api/conversations/${g.id}`, { token: outsider.token })).status).toBe(404);

    // an admin cannot remove the owner, a member can leave
    expect((await api('DELETE', `/api/conversations/${g.id}/members/${owner.id}`, { token: m1.token })).status).toBe(403);
    expect((await api('DELETE', `/api/conversations/${g.id}/members/${m2.id}`, { token: m2.token })).status).toBe(200);
    expect((await api('GET', `/api/conversations/${g.id}`, { token: m2.token })).status).toBe(404);
  });

  it('transfers ownership when the owner leaves', async () => {
    const owner = await registerUser('o');
    const m = await registerUser('m');
    const g = (await json(await api('POST', '/api/conversations/group', { token: owner.token, json: { title: 'g', memberIds: [m.id] } }))).conversation;
    expect((await api('DELETE', `/api/conversations/${g.id}/members/${owner.id}`, { token: owner.token })).status).toBe(200);
    const now = (await json(await api('GET', `/api/conversations/${g.id}`, { token: m.token }))).conversation;
    expect(now.myRole).toBe('owner');
  });

  it('supports polls with per-user votes', async () => {
    const a = await registerUser('pa');
    const b = await registerUser('pb');
    const g = (await json(await api('POST', '/api/conversations/group', { token: a.token, json: { title: 'poll', memberIds: [b.id] } }))).conversation;
    const created = await json(await api('POST', `/api/conversations/${g.id}/polls`, { token: a.token, json: { question: 'Lunch?', options: ['Kebab', 'Pizza'], multiple: false } }));
    const poll = created.message;
    expect(poll.kind).toBe('poll');
    const [o1, o2] = poll.poll.options.map((o: any) => o.id);
    expect((await json(await api('POST', `/api/messages/${poll.id}/vote`, { token: a.token, json: { optionIds: [o1] } }))).poll.counts).toMatchObject({ [o1]: 1, [o2]: 0 });
    const v2 = await json(await api('POST', `/api/messages/${poll.id}/vote`, { token: b.token, json: { optionIds: [o1] } }));
    expect(v2.poll.counts[o1]).toBe(2);
    expect(v2.poll.myVotes).toEqual([o1]);
    // re-voting replaces the previous vote
    const v3 = await json(await api('POST', `/api/messages/${poll.id}/vote`, { token: b.token, json: { optionIds: [o2] } }));
    expect(v3.poll.counts).toMatchObject({ [o1]: 1, [o2]: 1 });
    expect((await api('POST', `/api/messages/${poll.id}/vote`, { token: b.token, json: { optionIds: [o1, o2] } })).status).toBe(400);
    expect((await api('POST', `/api/messages/${poll.id}/vote`, { token: b.token, json: { optionIds: ['bogus'] } })).status).toBe(400);
  });
});

describe('AI access settings', () => {
  it('defaults to no access in direct chats and lets either participant block AI entirely', async () => {
    const a = await registerUser('x');
    const b = await registerUser('y');
    const c = await directChat(a, b);
    const get = async (u: typeof a) => (await json(await api('GET', `/api/conversations/${c}`, { token: u.token }))).conversation.ai;

    expect((await get(a)).effective).toMatchObject({ allowed: false, reason: 'off' });

    const on = await json(await api('PUT', `/api/conversations/${c}/ai`, { token: a.token, json: { access: 'context' } }));
    expect(on.conversation.ai.effective).toMatchObject({ allowed: true, level: 'context' });
    // b's own setting is independent
    expect((await get(b)).effective).toMatchObject({ allowed: false, reason: 'off' });

    await api('PUT', `/api/conversations/${c}/ai`, { token: b.token, json: { blocked: true } });
    expect((await get(a)).effective).toMatchObject({ allowed: false, reason: 'blocked' });
    expect((await get(a)).peerBlocked).toBe(true);
  });

  it('only group admins can set the group AI level', async () => {
    const owner = await registerUser('go');
    const m = await registerUser('gm');
    const g = (await json(await api('POST', '/api/conversations/group', { token: owner.token, json: { title: 'ai-group', memberIds: [m.id] } }))).conversation;
    expect(g.ai.groupLevel).toBe('off');
    expect((await api('PUT', `/api/conversations/${g.id}/ai-policy`, { token: m.token, json: { level: 'context' } })).status).toBe(403);
    const ok = await json(await api('PUT', `/api/conversations/${g.id}/ai-policy`, { token: owner.token, json: { level: 'assist', invokeRoles: 'admins' } }));
    expect(ok.conversation.ai).toMatchObject({ groupLevel: 'assist', invokeRoles: 'admins' });
    expect(ok.conversation.ai.effective).toMatchObject({ allowed: true, level: 'context', adminAssist: true });
    const asMember = (await json(await api('GET', `/api/conversations/${g.id}`, { token: m.token }))).conversation.ai.effective;
    expect(asMember).toMatchObject({ allowed: false, reason: 'role' });
  });

  it('refuses to grant AI access in end-to-end encrypted chats', async () => {
    const a = await registerUser('e1');
    const b = await registerUser('e2');
    const jwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) };
    for (const u of [a, b]) expect((await api('PUT', '/api/users/me/e2ee-key', { token: u.token, json: { jwk } })).status).toBe(200);
    const c = await directChat(a, b, true);
    const res = await api('PUT', `/api/conversations/${c}/ai`, { token: a.token, json: { access: 'context' } });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('E2EE_NO_ACCESS');
    const conv = (await json(await api('GET', `/api/conversations/${c}`, { token: a.token }))).conversation;
    expect(conv.ai.effective).toMatchObject({ allowed: false, level: 'none', reason: 'e2ee' });
  });
});

describe('end-to-end encrypted chats', () => {
  const jwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) };
  it('needs published keys, stores only ciphertext and refuses plaintext', async () => {
    const a = await registerUser('k1');
    const b = await registerUser('k2');
    const noKeys = await api('POST', '/api/conversations/direct', { token: a.token, json: { userId: b.id, e2ee: true } });
    expect(noKeys.status).toBe(400);
    expect((await json(noKeys)).error.code).toBe('E2EE_KEY_MISSING');

    await api('PUT', '/api/users/me/e2ee-key', { token: a.token, json: { jwk } });
    await api('PUT', '/api/users/me/e2ee-key', { token: b.token, json: { jwk } });
    const c = await directChat(a, b, true);
    const normal = await directChat(a, b, false);
    expect(normal).not.toBe(c);

    const plain = await api('POST', `/api/conversations/${c}/messages`, { token: a.token, json: { body: 'secret' } });
    expect(plain.status).toBe(400);
    const sent = await api('POST', `/api/conversations/${c}/messages`, { token: a.token, json: { cipher: { v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'c2VjcmV0' } } });
    expect(sent.status).toBe(201);
    const m = (await json(sent)).message;
    expect(m.body).toBeNull();
    expect(m.cipher).toEqual({ v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'c2VjcmV0' });
    const conv = (await json(await api('GET', '/api/conversations', { token: b.token }))).conversations.find((x: any) => x.id === c);
    expect(conv.lastMessage).toMatchObject({ encrypted: true, preview: '' });
  });
});

describe('user search', () => {
  it('finds humans by username or display name, never the AI or self', async () => {
    const a = await registerUser('searcher');
    const target = await registerUser('zebrafish');
    const res = await json(await api('GET', `/api/users/search?q=zebrafish`, { token: a.token }));
    expect(res.users.map((u: any) => u.id)).toContain(target.id);
    const self = await json(await api('GET', `/api/users/search?q=${a.username}`, { token: a.token }));
    expect(self.users.map((u: any) => u.id)).not.toContain(a.id);
    const ai = await json(await api('GET', `/api/users/search?q=aminai`, { token: a.token }));
    expect(ai.users).toHaveLength(0);
    expect((await api('GET', '/api/users/search?q=a', { token: a.token })).status).toBe(400);
  });
});
