import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { calls, script, type Rule } from './ai-helpers';
import { api, createThread, json, registerUser, sendAi, threadMessages, waitForRun, type TestUser } from './helpers';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM model_health').run();
  await script([]);
});

const finalAnswer = (text: string): Rule => ({ when: { purpose: 'chat' }, respond: { text } });
const titleRule: Rule = { when: { purpose: 'title' }, respond: { text: 'Title' } };
const plan = (steps: unknown[]): Rule => ({ when: { purpose: 'plan' }, respond: { json: { summary: 'plan', steps } } });

async function memory(user: TestUser) {
  return json(await api('GET', '/api/ai/memory', { token: user.token }));
}
async function addItem(user: TestUser, content: string, extra: Record<string, unknown> = {}) {
  const res = await api('POST', '/api/ai/memory/items', { token: user.token, json: { content, ...extra } });
  expect(res.status).toBe(201);
  return (await json(res)).item;
}
async function ask(user: TestUser, body: string, agentId = 'general', threadId?: string) {
  const thread = threadId ? { id: threadId } : await createThread(user);
  const res = await sendAi(user, thread.id, { body, agentId });
  expect(res.status).toBe(201);
  const run = await waitForRun(user, res.data.run.id);
  return { thread, run, res };
}
const lastChatCall = async () => {
  const list = (await calls()).filter((c) => c.purpose === 'chat');
  return list[list.length - 1]!;
};

describe('AMIN AI memory — manageable and private', () => {
  it('starts empty, with safe defaults', async () => {
    const user = await registerUser('mem');
    const m = await memory(user);
    expect(m.items).toEqual([]);
    expect(m.suggestions).toEqual([]);
    expect(m.settings).toEqual({ enabled: true, autoSuggest: true, allowHistoryRecall: false });
  });

  it('lets the user add, view, edit and delete items (and keeps them private)', async () => {
    const alice = await registerUser('alice');
    const bob = await registerUser('bob');
    const item = await addItem(alice, 'I prefer concise answers', { kind: 'preference' });
    expect(item).toMatchObject({ kind: 'preference', content: 'I prefer concise answers', source: 'user' });
    const dup = await addItem(alice, '  i prefer CONCISE answers '); // duplicates are merged, not stored twice
    expect(dup.id).toBe(item.id);
    expect((await memory(alice)).items).toHaveLength(1);

    // edit
    const upd = await api('PATCH', `/api/ai/memory/items/${item.id}`, { token: alice.token, json: { content: 'I prefer very concise answers', project: 'Apollo' } });
    expect(upd.status).toBe(200);
    expect((await json(upd)).item).toMatchObject({ content: 'I prefer very concise answers', project: 'Apollo' });

    // isolation: Bob sees nothing, cannot edit, read or delete Alice's item
    expect((await memory(bob)).items).toEqual([]);
    expect((await api('PATCH', `/api/ai/memory/items/${item.id}`, { token: bob.token, json: { content: 'hacked' } })).status).toBe(404);
    expect((await api('DELETE', `/api/ai/memory/items/${item.id}`, { token: bob.token })).status).toBe(404);
    expect((await memory(alice)).items[0].content).toBe('I prefer very concise answers');

    // validation
    expect((await api('POST', '/api/ai/memory/items', { token: alice.token, json: { content: '   ' } })).status).toBe(400);
    expect((await api('POST', '/api/ai/memory/items', { token: alice.token, json: { content: 'x'.repeat(601) } })).status).toBe(400);
    expect((await api('POST', '/api/ai/memory/items', { token: alice.token, json: { content: 'ok', kind: 'secret' } })).status).toBe(400);
    expect((await api('PATCH', '/api/ai/memory/settings', { token: alice.token, json: { enabled: 'yes' } })).status).toBe(400);
    expect((await api('PATCH', '/api/ai/memory/settings', { token: alice.token, json: { unknownFlag: true } })).status).toBe(400);
    expect((await api('GET', '/api/ai/memory')).status).toBe(401);

    // delete
    expect((await api('DELETE', `/api/ai/memory/items/${item.id}`, { token: alice.token })).status).toBe(200);
    expect((await memory(alice)).items).toEqual([]);
    expect((await api('DELETE', `/api/ai/memory/items/${item.id}`, { token: alice.token })).status).toBe(404);
  });

  it('caps the number of items', async () => {
    const user = await registerUser('cap');
    const stmts = Array.from({ length: 200 }, (_, i) =>
      env.DB.prepare("INSERT INTO memories (id, user_id, kind, content, source, created_at, updated_at) VALUES (?, ?, 'fact', ?, 'user', ?, ?)").bind(`mem_cap${i}`, user.id, `fact number ${i}`, Date.now(), Date.now()),
    );
    await env.DB.batch(stmts);
    const res = await api('POST', '/api/ai/memory/items', { token: user.token, json: { content: 'one more' } });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('MEMORY_FULL');
  });

  it('uses approved memory in the user\'s own conversations — and only there, and only while memory is on', async () => {
    const user = await registerUser('use');
    await addItem(user, 'The user is a vegetarian who lives in Lyon', { kind: 'fact' });
    await addItem(user, 'Project Apollo uses PostgreSQL 16', { kind: 'project', project: 'Apollo' });
    await script([finalAnswer('Noted.'), titleRule]);

    await ask(user, 'Suggest a dinner idea for tonight');
    let call = await lastChatCall();
    expect(call.system).toContain('vegetarian who lives in Lyon');
    expect(call.system).toMatch(/memory|remember/i);

    // project info is recalled when the question concerns that project
    await ask(user, 'Which database does Apollo use?');
    call = await lastChatCall();
    expect(call.system).toContain('Project Apollo uses PostgreSQL 16');

    // turning memory off removes it from every prompt immediately, without deleting anything
    await api('PATCH', '/api/ai/memory/settings', { token: user.token, json: { enabled: false } });
    await ask(user, 'Suggest another dinner idea');
    call = await lastChatCall();
    expect(call.system).not.toContain('vegetarian');
    expect(call.system).not.toContain('PostgreSQL');
    expect((await memory(user)).items).toHaveLength(2); // still there, just not used
    await api('PATCH', '/api/ai/memory/settings', { token: user.token, json: { enabled: true } });
    await ask(user, 'Dinner idea once more');
    expect((await lastChatCall()).system).toContain('vegetarian');
  });

  it('never leaks one user\'s memory into another user\'s prompts', async () => {
    const alice = await registerUser('alice');
    const bob = await registerUser('bob');
    await addItem(alice, 'ALICE-PRIVATE-FACT: her passport expires in 2028');
    await script([finalAnswer('Hello.'), titleRule]);
    await ask(bob, 'What do you know about me? Tell me everything you remember.');
    const call = await lastChatCall();
    expect(call.all).not.toContain('ALICE-PRIVATE-FACT');
    expect(call.all).not.toContain('passport');
    // and the approval of a suggestion belongs to its owner only
    await env.DB.prepare("INSERT INTO memory_suggestions (id, user_id, kind, content, status, created_at) VALUES ('sug_alice1', ?, 'fact', 'Alice likes tea', 'pending', ?)").bind(alice.id, Date.now()).run();
    expect((await api('POST', '/api/ai/memory/suggestions/sug_alice1/decision', { token: bob.token, json: { decision: 'approve' } })).status).toBe(404);
    expect((await memory(bob)).items).toEqual([]);
  });

  it('keeps temporary conversation memory separate: a new conversation does not see an old one unless something was approved', async () => {
    const user = await registerUser('temp');
    await script([finalAnswer('Understood.'), titleRule]);
    const first = await ask(user, 'My cat is called TEMP-FLUFFY-77 and I will move to Oslo');
    // the same conversation remembers it (temporary, conversation-level memory)
    await ask(user, 'What was my cat called?', 'general', first.thread.id);
    expect((await lastChatCall()).all).toContain('TEMP-FLUFFY-77');
    // a different conversation starts clean
    await ask(user, 'What was my cat called?');
    const fresh = await lastChatCall();
    expect(fresh.all).not.toContain('TEMP-FLUFFY-77');
    expect(fresh.all).not.toContain('Oslo');
    // nothing was copied into permanent memory by itself
    expect((await memory(user)).items).toEqual([]);
  });

  it('turns suggestions into memory only on approval, with edits, once', async () => {
    const user = await registerUser('sug');
    await script([plan([{ title: 'Remember', tool: 'memory_propose', args: { kind: 'project', content: 'Apollo launches in March', project: 'Apollo' } }]), finalAnswer('Suggested.'), titleRule]);
    await ask(user, 'Remember that Apollo launches in March', 'personal');
    const m = await memory(user);
    expect(m.items).toEqual([]);
    expect(m.suggestions).toHaveLength(1);
    const sug = m.suggestions[0];
    expect(sug).toMatchObject({ kind: 'project', project: 'Apollo', status: 'pending' });

    // approve with an edit
    const res = await api('POST', `/api/ai/memory/suggestions/${sug.id}/decision`, { token: user.token, json: { decision: 'approve', content: 'Apollo launches on 12 March' } });
    expect(res.status).toBe(200);
    const out = await json(res);
    expect(out.memory).toMatchObject({ content: 'Apollo launches on 12 March', source: 'ai_approved', project: 'Apollo' });
    const after = await memory(user);
    expect(after.items).toHaveLength(1);
    expect(after.suggestions).toEqual([]);
    // the same suggestion cannot be approved twice
    const again = await api('POST', `/api/ai/memory/suggestions/${sug.id}/decision`, { token: user.token, json: { decision: 'approve' } });
    expect(again.status).toBe(409);
    expect((await memory(user)).items).toHaveLength(1);

    // rejecting stores nothing
    await env.DB.prepare("INSERT INTO memory_suggestions (id, user_id, kind, content, status, created_at) VALUES ('sug_rej1', ?, 'fact', 'Likes jazz', 'pending', ?)").bind(user.id, Date.now()).run();
    const rej = await api('POST', '/api/ai/memory/suggestions/sug_rej1/decision', { token: user.token, json: { decision: 'reject' } });
    expect((await json(rej)).memory).toBeNull();
    expect((await memory(user)).items).toHaveLength(1);

    // an already-remembered fact is not suggested again
    await script([plan([{ title: 'Remember', tool: 'memory_propose', args: { kind: 'project', content: 'Apollo launches on 12 March' } }]), finalAnswer('It is already remembered.'), titleRule]);
    await ask(user, 'Remember that Apollo launches on 12 March', 'personal');
    expect((await memory(user)).suggestions).toEqual([]);
  });

  it('honours the switches: no memory tools when memory or suggestions are off, no history recall without permission', async () => {
    const user = await registerUser('switch');
    const toolOf = async (id: string) => {
      const agents = (await json(await api('GET', '/api/ai/agents', { token: user.token }))).agents;
      return agents.find((a: any) => a.id === 'personal').tools.find((t: any) => t.id === id);
    };
    expect(await toolOf('memory_propose')).toMatchObject({ available: true });
    expect(await toolOf('history_search')).toMatchObject({ available: false });
    expect((await toolOf('history_search')).reason).toMatch(/not allowed/);

    // suggestions off → the planner is not even offered memory_propose, and a plan that uses it fails
    await api('PATCH', '/api/ai/memory/settings', { token: user.token, json: { autoSuggest: false } });
    expect(await toolOf('memory_propose')).toMatchObject({ available: false });
    await script([plan([{ title: 'Remember', tool: 'memory_propose', args: { kind: 'fact', content: 'Likes sailing' } }]), finalAnswer('I could not.'), titleRule]);
    const { run } = await ask(user, 'Remember that I like sailing', 'personal');
    expect((await calls()).find((c) => c.purpose === 'plan')!.system).not.toContain('- memory_propose:');
    expect(run.steps).toEqual([]);
    expect((await memory(user)).suggestions).toEqual([]);
    // the final answer is told why the tool could not be used, so it can tell the user how to enable it
    expect((await lastChatCall()).system).toMatch(/memory_propose \(the user turned off memory suggestions/);

    // memory off entirely
    await api('PATCH', '/api/ai/memory/settings', { token: user.token, json: { autoSuggest: true, enabled: false } });
    expect(await toolOf('memory_propose')).toMatchObject({ available: false });
    expect((await toolOf('memory_propose')).reason).toMatch(/turned memory off/);
  });

  it('recalls past conversations only with permission, and only the user\'s own', async () => {
    const user = await registerUser('recall');
    const other = await registerUser('someone');
    await script([finalAnswer('Noted.'), titleRule]);
    await ask(user, 'The warehouse access code is ZEBRA-4471, keep it in mind');
    await ask(other, 'The warehouse access code is ELEPHANT-9000');

    const search = plan([{ title: 'Look in past conversations', tool: 'history_search', args: { query: 'warehouse access code' } }]);
    // without permission: the tool is withheld
    await script([search, finalAnswer('I am not allowed to search past conversations.'), titleRule]);
    const denied = await ask(user, 'What was the warehouse access code I told you before?', 'personal');
    expect(denied.run.steps).toEqual([]);
    expect(JSON.stringify(await calls())).not.toContain('ZEBRA-4471\\n'); // never retrieved

    // with permission
    await api('PATCH', '/api/ai/memory/settings', { token: user.token, json: { allowHistoryRecall: true } });
    await script([search, finalAnswer('It was ZEBRA-4471.'), titleRule]);
    const allowed = await ask(user, 'What was the warehouse access code I told you before?', 'personal');
    expect(allowed.run.status).toBe('completed');
    expect(allowed.run.steps[0]).toMatchObject({ tool: 'history_search', status: 'completed' });
    const out = allowed.run.steps[0].output.text as string;
    expect(out).toContain('ZEBRA');
    expect(out).not.toContain('ELEPHANT'); // other users' conversations are unreachable
    expect(JSON.stringify(allowed.run)).not.toContain('ELEPHANT');
  });

  it('erases everything on request, but only with an explicit confirmation', async () => {
    const user = await registerUser('erase');
    const keep = await registerUser('keep');
    await addItem(user, 'Fact one');
    await addItem(user, 'Fact two');
    await addItem(keep, "Somebody else's fact");
    await env.DB.prepare("INSERT INTO memory_suggestions (id, user_id, kind, content, status, created_at) VALUES ('sug_er1', ?, 'fact', 'Pending thing', 'pending', ?)").bind(user.id, Date.now()).run();

    expect((await api('DELETE', '/api/ai/memory', { token: user.token })).status).toBe(400);
    expect((await api('DELETE', '/api/ai/memory', { token: user.token, json: { confirm: false } })).status).toBe(400);
    expect((await memory(user)).items).toHaveLength(2);

    const res = await api('DELETE', '/api/ai/memory', { token: user.token, json: { confirm: true } });
    expect(res.status).toBe(200);
    expect((await json(res)).deleted).toEqual({ memories: 2, suggestions: 1 });
    const gone = await memory(user);
    expect(gone.items).toEqual([]);
    expect(gone.suggestions).toEqual([]);
    expect((await memory(keep)).items).toHaveLength(1); // other accounts untouched

    // a deleted memory is really gone from later prompts
    await script([finalAnswer('Hi.'), titleRule]);
    await ask(user, 'Tell me what you remember about me');
    expect((await lastChatCall()).all).not.toContain('Fact one');
  });

  it('does not put memory into answers given inside other people\'s chats', async () => {
    // the permanent memory of a person is theirs: when they invoke @AMINAI in a group, the other members' chat must not get it
    const owner = await registerUser('own');
    const member = await registerUser('mem');
    await addItem(owner, 'OWNER-PRIVATE-NOTE: has a surprise party planned');
    const group = (await json(await api('POST', '/api/conversations/group', { token: owner.token, json: { title: 'Family', memberIds: [member.id] } }))).conversation.id;
    await api('PUT', `/api/conversations/${group}/ai-policy`, { token: owner.token, json: { level: 'context' } });
    await script([{ when: { purpose: 'assist' }, respond: { text: 'Sure.' } }]);
    const sent = await api('POST', `/api/conversations/${group}/messages`, { token: owner.token, json: { body: '@AMINAI what do you know about me?' } });
    const data = await json(sent);
    expect(data.ai.triggered).toBe(true);
    await waitForRun(owner, data.ai.runId);
    const call = (await calls()).find((c) => c.purpose === 'assist')!;
    expect(call.all).not.toContain('OWNER-PRIVATE-NOTE');
    expect(call.all).not.toContain('surprise party');
    void threadMessages;
  });
});
