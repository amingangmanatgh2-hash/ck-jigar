import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENTS } from '../src/agents/registry';
import { heuristicAgent } from '../src/agents/planner';
import { TOOLS } from '../src/agents/tools';
import { chatOpenTool, fold, matchScore } from '../src/agents/tools/navigation';
import { ToolError } from '../src/agents/tools/types';
import { MODEL, calls, fakeAi, script } from './ai-helpers';
import { GROQ, fakeGroq, groqCalls, groqOff, groqOn, groqScript } from './groq-helpers';
import { api, createThread, directChat, json, registerUser, sendAi, waitForRun, type TestUser } from './helpers';

const open = (user: TestUser, person: string, secret = false) => chatOpenTool.run({ env, user: { id: user.id } } as never, { person, secret });
const conversationCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM conversations').first<{ n: number }>())!.n;

async function named(prefix: string, displayName: string): Promise<TestUser> {
  const user = await registerUser(prefix, { displayName });
  return { ...user, displayName };
}

describe('matching names (Persian and Latin)', () => {
  it('ignores case, a leading @, Arabic/Persian letter variants, vowel marks and half-spaces', () => {
    expect(fold('  @Amin_CK ')).toBe('amin_ck');
    expect(fold('امين')).toBe(fold('امین')); // Arabic yeh = Persian yeh
    expect(fold('علي')).toBe('علی');
    expect(fold('كريم')).toBe('کریم'); // Arabic kaf and yeh
    expect(fold('گفت\u200cوگو')).toBe('گفتوگو'); // half-space
    expect(fold('مُحَمَّد')).toBe('محمد'); // vowel marks
  });

  it('ranks an exact name above a word, a word above a fragment, and finds nothing otherwise', () => {
    expect(matchScore('amin', ['amin'])).toBe(3);
    expect(matchScore('amin', ['Amin Rezaei'])).toBe(2);
    expect(matchScore('amin', ['Aminreza'])).toBe(2); // the beginning of a name
    expect(matchScore('min', ['Amin'])).toBe(1);
    expect(matchScore('sara', ['Amin'])).toBe(0);
    expect(matchScore('', ['Amin'])).toBe(0);
    expect(matchScore('امين', ['امین رضایی'])).toBe(2);
    expect(matchScore('amin', ['x', 'amin_ck', 'Amin Rezaei'])).toBe(2);
  });
});

describe('chat_open — find a chat for the user to open', () => {
  let alice: TestUser;
  beforeEach(async () => {
    alice = await named('alice', 'Alice Owner');
  });

  it('is a read-only tool that never sends, creates or changes anything', async () => {
    expect(chatOpenTool.risk).toBe('read');
    const bob = await named('bob', 'Bob Builder');
    await directChat(alice, bob);
    await registerUser('outsider', { displayName: 'Yuri Outsider' });
    const before = await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) AS n FROM conversations'),
      env.DB.prepare('SELECT COUNT(*) AS n FROM messages'),
      env.DB.prepare('SELECT COUNT(*) AS n FROM conversation_members'),
    ]);
    await open(alice, 'Bob');
    await open(alice, 'Yuri'); // a person with no chat yet: only a pointer comes back
    await open(alice, 'nobody-at-all');
    const after = await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) AS n FROM conversations'),
      env.DB.prepare('SELECT COUNT(*) AS n FROM messages'),
      env.DB.prepare('SELECT COUNT(*) AS n FROM conversation_members'),
    ]);
    expect(after.map((r) => r.results)).toEqual(before.map((r) => r.results));
  });

  it('finds an existing chat by display name and hands back a pointer to it', async () => {
    const bob = await named('bob', 'Bob Builder');
    const chat = await directChat(alice, bob);
    const result = await open(alice, 'bob');
    expect(result.action).toEqual({ type: 'open_chat', conversationId: chat, userId: bob.id, title: 'Bob Builder' });
    expect(result.text).toContain('Nothing was sent');
    expect(result.text).toContain('Bob Builder');
    expect(result.data).toMatchObject({ matches: [{ id: chat, label: 'Bob Builder', type: 'direct', e2ee: false }] });
  });

  it('finds a chat by @username, in any case', async () => {
    const bob = await named('bob', 'Bob Builder');
    const chat = await directChat(alice, bob);
    expect((await open(alice, `@${bob.username.toUpperCase()}`)).action).toMatchObject({ conversationId: chat });
  });

  it('matches Persian names whichever way the letters were typed', async () => {
    const amin = await named('amin', 'امین رضایی');
    const chat = await directChat(alice, amin);
    expect((await open(alice, 'امين')).action).toMatchObject({ type: 'open_chat', conversationId: chat, title: 'امین رضایی' }); // Arabic yeh
    expect((await open(alice, 'رضایی')).action).toMatchObject({ conversationId: chat });
  });

  it('asks which one when several chats match equally, and opens nothing', async () => {
    const sara1 = await named('sara', 'Sara Ahmadi');
    const sara2 = await named('sara', 'Sara Karimi');
    await directChat(alice, sara1);
    await directChat(alice, sara2);
    const result = await open(alice, 'Sara');
    expect(result.action).toBeUndefined();
    expect(result.text).toMatch(/Several chats match/);
    expect(result.text).toContain('Sara Ahmadi');
    expect(result.text).toContain('Sara Karimi');
    expect(result.text).toMatch(/Ask the user which one/);
    // a more precise name settles it
    expect((await open(alice, 'Sara Karimi')).action).toMatchObject({ userId: sara2.id });
  });

  it('prefers the better match: an exact name beats a longer name that merely contains it', async () => {
    const exact = await named('exact', 'Amin');
    const longer = await named('longer', 'Amin Reza Hosseini');
    const chat = await directChat(alice, exact);
    await directChat(alice, longer);
    expect((await open(alice, 'Amin')).action).toMatchObject({ conversationId: chat, title: 'Amin' });
  });

  it('opens a group by its title', async () => {
    const bob = await named('bob', 'Bob Builder');
    const res = await api('POST', '/api/conversations/group', { token: alice.token, json: { title: 'Family Group', memberIds: [bob.id] } });
    const groupId = (await json(res)).conversation.id as string;
    const result = await open(alice, 'family');
    expect(result.action).toEqual({ type: 'open_chat', conversationId: groupId, userId: null, title: 'Family Group' });
  });

  it('opens the normal chat by default and the secret one only when asked, and says that the other exists', async () => {
    const bob = await named('bob', 'Bob Builder');
    await api('PUT', '/api/users/me/e2ee-key', { token: alice.token, json: { jwk: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) } } });
    await api('PUT', '/api/users/me/e2ee-key', { token: bob.token, json: { jwk: { kty: 'EC', crv: 'P-256', x: 'C'.repeat(43), y: 'D'.repeat(43) } } });
    const normal = await directChat(alice, bob, false);
    const secret = await directChat(alice, bob, true);
    expect(normal).not.toBe(secret);
    const byDefault = await open(alice, 'Bob');
    expect(byDefault.action).toMatchObject({ conversationId: normal });
    expect(byDefault.text).toMatch(/also a secret chat/);
    expect((await open(alice, 'Bob', true)).action).toMatchObject({ conversationId: secret });
  });

  it('offers to start a chat with a person who is in the directory but has no chat yet — creating nothing', async () => {
    const zed = await named('zed', 'Zed Stranger');
    const before = await conversationCount();
    const result = await open(alice, 'Zed');
    expect(result.action).toEqual({ type: 'open_chat', conversationId: null, userId: zed.id, title: 'Zed Stranger' });
    expect(result.text).toMatch(/no chat with .* yet/i);
    expect(result.text).toMatch(/nothing was created or sent/i);
    expect(await conversationCount()).toBe(before);
  });

  it('lists the candidates when several people match and none has a chat', async () => {
    const tag = `qq${Date.now().toString(36)}`;
    await named(tag, `${tag} Alpha`);
    await named(tag, `${tag} Beta`);
    const result = await open(alice, tag);
    expect(result.action).toBeUndefined();
    expect(result.text).toContain('several people match');
  });

  it('never exposes other people\'s chats: a chat between two others is not matched, only the person is offered', async () => {
    const carol = await named('carol', 'Carol Private');
    const dave = await named('dave', 'Dave Private');
    const theirChat = await directChat(carol, dave);
    const result = await open(alice, 'Dave');
    expect(result.action).toEqual({ type: 'open_chat', conversationId: null, userId: dave.id, title: 'Dave Private' });
    expect(JSON.stringify(result)).not.toContain(theirChat);
  });

  it('finds nobody for a name that matches nothing, and refuses a query that is too short', async () => {
    const result = await open(alice, 'definitely-not-a-person-xyz');
    expect(result.action).toBeUndefined();
    expect(result.text).toMatch(/No chat or person matches/);
    await expect(open(alice, 'a')).rejects.toBeInstanceOf(ToolError);
    await expect(open(alice, 'a')).rejects.toMatchObject({ code: 'PERSON_REQUIRED' });
    await expect(open(alice, '@')).rejects.toMatchObject({ code: 'PERSON_REQUIRED' });
  });

  it('does not offer the AMIN AI conversation itself as "a chat to open"', async () => {
    const result = await open(alice, 'AMIN AI');
    expect(result.action).toBeUndefined();
  });

  it('treats SQL wildcards in the name as plain characters', async () => {
    await named('wild', 'Wild Person');
    const result = await open(alice, '%%');
    expect(result.action).toBeUndefined();
    expect(result.text).toMatch(/No chat or person matches/);
  });
});

describe('the Quick agent', () => {
  it('is read-only by construction: it can open chats and look things up, never send, write or delete', () => {
    const agent = AGENTS.quick;
    expect(agent.modelRole).toBe('fast');
    expect(agent.tools).toContain('chat_open');
    for (const id of agent.tools) expect(TOOLS[id]?.risk, `${id} must be read-only`).toBe('read');
    expect(agent.maxAnswerTokens).toBeLessThanOrEqual(1000);
    expect(agent.name.fa && agent.name.en && agent.description.fa && agent.description.en).toBeTruthy();
  });

  it('is recognised in both languages — and "open a chat" is not mistaken for "send a message"', () => {
    for (const text of [
      'open my chat with Amin',
      'Open the chat with Sara',
      'show me the conversation with Ali',
      'take me to the dm with bob',
      'چت با امین رو باز کن',
      'گفتگوی امین را باز کن',
      'گفت\u200cوگوی علی رو نشونم بده',
      'باز کن چت سارا',
      'برو به گفتگو با علی',
    ]) expect(heuristicAgent(text), text).toBe('quick');
    for (const text of ['send a message to Amin saying hi', 'پیام بده به امین که دیر میرسم', 'what is a chat', 'reply to Sara', 'یادآور بذار برای فردا']) {
      expect(heuristicAgent(text), text).not.toBe('quick');
    }
    expect(heuristicAgent('پیام بده به امین')).toBe('messenger');
  });
});

describe('the Quick agent end to end, with Groq answering every model call', () => {
  beforeAll(async () => groqOn());
  afterAll(async () => groqOff());
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM model_health').run();
    await fakeGroq().reset();
    await fakeAi().setCatalog(null);
    await script([]);
  });

  const quickRules = (person: string) => [
    { when: { system: 'You are the planning module' }, respond: { json: { summary: `Open the chat with ${person}`, steps: [{ title: 'Find the chat', tool: 'chat_open', args: { person } }] } } },
    { when: { system: 'You are the quick assistant' }, respond: { text: `Your chat with ${person} is ready: tap the button to open it.` } },
    { when: { system: 'Write a very short title' }, respond: { text: 'Open a chat' } },
  ];

  it('plans, finds the chat, answers — all on Groq — and gives the app a button instead of navigating by itself', async () => {
    const alice = await registerUser('alice');
    const bob = await named('bob', 'Bob Builder');
    const chat = await directChat(alice, bob);
    await groqScript(quickRules('Bob'));
    const thread = await createThread(alice);
    const sent = await sendAi(alice, thread.id, { body: 'open my chat with Bob', agentId: 'quick' });
    expect(sent.status).toBe(201);
    const run = await waitForRun(alice, sent.data.run.id);

    expect(run.status).toBe('completed');
    expect(run.agentId).toBe('quick'); // chosen explicitly: no routing
    expect(run.resolvedAgentId ?? null).toBeNull();
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({ tool: 'chat_open', status: 'completed', risk: 'read', action: { type: 'open_chat', conversationId: chat, userId: bob.id, title: 'Bob Builder' } });
    expect(run.steps[0].output.text).toContain('Nothing was sent');

    // the answer was written by the fast model from the tool's confirmed result
    const answers = (await groqCalls()).filter((c) => c.system.includes('You are the quick assistant'));
    expect(answers).toHaveLength(1);
    expect(answers[0]!.model).toBe(GROQ.oss20);
    expect(answers[0]!.system).toContain('Found the chat with');
    expect(answers[0]!.body.max_completion_tokens).toBeLessThan(2500); // a short answer, not the conversation default

    // Workers AI was not needed for any of it, and nothing was sent into any chat
    expect(await calls()).toHaveLength(0);
    const usage = await env.DB.prepare('SELECT DISTINCT model_id FROM ai_usage WHERE user_id = ? AND status != ?').bind(alice.id, 'error').all<{ model_id: string }>();
    expect(usage.results.map((r) => r.model_id)).toEqual([GROQ.oss20]);
    const sentMessages = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND deleted_at IS NULL').bind(chat).first<{ n: number }>();
    expect(sentMessages!.n).toBe(0);
  });

  it('routes a longer request to the Quick agent through Groq when the router is asked', async () => {
    const alice = await registerUser('alice');
    const bob = await named('bob', 'Bob Builder');
    await directChat(alice, bob);
    await groqScript([
      { when: { system: 'You route requests' }, respond: { json: { agent: 'quick', reason: 'opening a chat' } } },
      ...quickRules('Bob'),
    ]);
    const thread = await createThread(alice);
    const sent = await sendAi(alice, thread.id, { body: 'could you please open the conversation I have with Bob?', agentId: 'auto' });
    const run = await waitForRun(alice, sent.data.run.id);
    expect(run.status).toBe('completed');
    expect(run.resolvedAgentId).toBe('quick');
    expect(run.steps[0].action).toMatchObject({ type: 'open_chat', userId: bob.id });
    const routerCall = (await groqCalls()).find((c) => c.system.includes('You route requests'))!;
    expect(routerCall.model).toBe(GROQ.oss20);
    expect(routerCall.system).toContain('- quick:'); // the router knows about the agent
  });

  it('still completes when Groq is refusing: the very same run is answered by Workers AI', async () => {
    const alice = await registerUser('alice');
    const bob = await named('bob', 'Bob Builder');
    const chat = await directChat(alice, bob);
    await fakeGroq().configure({ failures: [{ status: 429, retryAfter: 60, times: 100 }] });
    await script([
      { when: { purpose: 'plan' }, respond: { json: { summary: 'Open the chat', steps: [{ title: 'Find the chat', tool: 'chat_open', args: { person: 'Bob' } }] } } },
      { when: { purpose: 'chat' }, respond: { text: 'Your chat with Bob is ready.' } },
      { when: { purpose: 'title' }, respond: { text: 'Open a chat' } },
    ]);
    const thread = await createThread(alice);
    const sent = await sendAi(alice, thread.id, { body: 'open my chat with Bob', agentId: 'quick' });
    const run = await waitForRun(alice, sent.data.run.id);
    expect(run.status).toBe('completed');
    expect(run.steps[0].action).toMatchObject({ conversationId: chat });
    const used = await env.DB.prepare("SELECT model_id, status FROM ai_usage WHERE user_id = ? AND status != 'error'").bind(alice.id).all<{ model_id: string; status: string }>();
    expect(used.results.every((r) => r.model_id === MODEL.gemma)).toBe(true);
    expect(used.results.some((r) => r.status === 'fallback')).toBe(true);
  });

  it('lists the agent with honest tool availability', async () => {
    const user = await registerUser('lister');
    const { agents } = await json(await api('GET', '/api/ai/agents', { token: user.token }));
    const quick = agents.find((a: any) => a.id === 'quick');
    expect(quick).toMatchObject({ icon: 'zap', mode: 'plan' });
    expect(quick.tools.map((t: any) => t.id)).toEqual(['chat_open', 'chat_list', 'todo_list', 'reminder_list']);
    expect(quick.tools.every((t: any) => t.available === true && t.risk === 'read')).toBe(true);
  });
});
