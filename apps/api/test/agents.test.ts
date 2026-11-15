import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { payloadHash } from '../src/agents/approvals';
import { deliverDueReminders, expireApprovals, recoverStaleRuns, resumeLostDecisions } from '../src/cron';
import { resumeRun } from '../src/services/run-control';
import { MODEL, calls, script, type Rule } from './ai-helpers';
import { api, createThread, directChat, getRunDto, json, openSocket, registerUser, sendAi, threadMessages, waitFor, waitForRun, type TestUser } from './helpers';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM model_health').run();
  await script([]);
});

/* ------------------------------------------------------------------------------------------------ scripting helpers */

const route = (agent: string): Rule => ({ when: { purpose: 'route' }, respond: { json: { agent, reason: 'test routing' } } });
const plan = (steps: unknown[], summary = 'Test plan'): Rule => ({ when: { purpose: 'plan' }, respond: { json: { summary, steps } } });
const derived = (args: unknown): Rule => ({ when: { purpose: 'args' }, respond: { json: args } });
const finalAnswer = (text: string): Rule => ({ when: { purpose: 'chat' }, respond: { text } });
const titleRule: Rule = { when: { purpose: 'title' }, respond: { text: 'Test title' } };

const futureDate = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function newUser(prefix: string): Promise<TestUser> {
  const user = await registerUser(prefix);
  // deterministic locale and zone for every assertion about wording and times
  const res = await api('PATCH', '/api/auth/me', { token: user.token, json: { locale: 'en', timezone: 'UTC' } });
  expect(res.status).toBe(200);
  return user;
}

async function start(user: TestUser, body: string, agentId = 'auto', extra: Record<string, unknown> = {}) {
  const thread = await createThread(user);
  const { status, data } = await sendAi(user, thread.id, { body, agentId, ...extra });
  if (status !== 201) throw new Error(`send failed: ${status} ${JSON.stringify(data)}`);
  return { thread, ...data } as { thread: any; userMessage: any; assistantMessage: any; run: any };
}

async function eventsOf(user: TestUser, runId: string): Promise<any[]> {
  return (await json(await api('GET', `/api/ai/runs/${runId}/events`, { token: user.token }))).events;
}

async function messageCount(conversationId: string, viaAi = true): Promise<number> {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND via_ai = ? AND deleted_at IS NULL').bind(conversationId, viaAi ? 1 : 0).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Final-answer prompt the model received (the operation log it must rely on). */
async function finalSystemPrompt(): Promise<string> {
  const c = (await calls()).filter((x) => x.purpose === 'chat');
  return c[c.length - 1]?.system ?? '';
}

/** Sets up alice → bob, runs the Messenger agent up to the approval card and returns everything needed to continue. */
async function parkedSend(opts: { text?: string } = {}) {
  const alice = await newUser('alice');
  const bob = await registerUser('bob');
  const chat = await directChat(alice, bob);
  const text = opts.text ?? 'I will be late, sorry!';
  await script([
    plan([
      { title: 'Look at the chats', tool: 'chat_list', args: {} },
      { title: 'Send the message to Bob', tool: 'message_send', args: {}, deferred: true },
    ]),
    derived({ conversationId: chat, text }),
    finalAnswer('Final answer written from the operation log.'),
    titleRule,
  ]);
  const started = await start(alice, 'Tell Bob I will be late', 'messenger');
  const run = await waitForRun(alice, started.run.id, ['awaiting_approval', 'failed', 'completed', 'cancelled']);
  expect(run.status).toBe('awaiting_approval');
  const approval = run.approvals[0];
  return { alice, bob, chat, text, started, run, approval };
}

/* ------------------------------------------------------------------------------------------------ routing, planning, personal tools */

describe('task engine — routing, planning and execution', () => {
  it('routes automatically, plans, runs tools and reports only what the tools confirmed', async () => {
    const user = await newUser('plan');
    const socket = await openSocket(user);
    const due = futureDate(2);
    await script([
      route('personal'),
      plan(
        [
          { title: 'Add the task', tool: 'todo_add', args: { title: 'Buy milk', due, priority: 'high' } },
          { title: 'Remind me', tool: 'reminder_set', args: { text: 'Buy milk', at: `${due} 09:30` } },
        ],
        'Create the task and a reminder',
      ),
      finalAnswer('I added the task and set the reminder.'),
      titleRule,
    ]);
    const started = await start(user, 'Add "buy milk" to my to-do list and remind me about it on the day', 'auto');
    expect(started.run.agentId).toBe('auto');
    const run = await waitForRun(user, started.run.id);

    expect(run.status).toBe('completed');
    expect(run.resolvedAgentId).toBe('personal');
    expect(run.planSummary).toBe('Create the task and a reminder');
    expect(run.steps.map((s: any) => [s.tool, s.status, s.verified])).toEqual([
      ['todo_add', 'completed', true],
      ['reminder_set', 'completed', true],
    ]);
    expect(run.steps[0].risk).toBe('write');
    expect(run.steps[0].attempts).toBe(1);

    // the effects are real
    const todo = await env.DB.prepare('SELECT title, priority, status, due_at FROM todos WHERE user_id = ?').bind(user.id).first<any>();
    expect(todo).toMatchObject({ title: 'Buy milk', priority: 'high', status: 'open' });
    expect(new Date(todo.due_at).toISOString().slice(0, 10)).toBe(due);
    const reminder = await env.DB.prepare('SELECT text, remind_at, status FROM reminders WHERE user_id = ?').bind(user.id).first<any>();
    expect(reminder).toMatchObject({ text: 'Buy milk', status: 'scheduled', remind_at: Date.parse(`${due}T09:30:00Z`) });

    // the model wrote its final answer from the confirmed operation log
    const system = await finalSystemPrompt();
    expect(system).toContain('[COMPLETED, confirmed]');
    expect(system).toContain('Task saved: "Buy milk"');
    expect(system).toContain('Reminder scheduled for');
    const planCall = (await calls()).find((c) => c.purpose === 'plan')!;
    expect(planCall.system).toContain('todo_add');
    expect(planCall.system).toContain('reminder_set');
    expect(planCall.system).not.toContain('- message_send:'); // another agent's tool is never offered

    // the operation log and live statuses
    const types = (await eventsOf(user, run.id)).map((e) => e.type);
    for (const t of ['run.started', 'route', 'plan', 'step.started', 'step.completed', 'answer', 'run.finished']) expect(types).toContain(t);
    await socket.waitFor((e) => e.type === 'run.updated' && e.run.id === run.id && e.run.status === 'completed');
    const seen = socket.events.filter((e) => e.type === 'run.updated' && e.run.id === run.id).map((e) => e.run.status);
    expect(seen).toContain('planning');
    expect(seen).toContain('running');
    expect(socket.events.filter((e) => e.type === 'run.step' && e.runId === run.id && e.step.status === 'completed')).toHaveLength(2);
    socket.close();

    // visible in the task list
    const list = (await json(await api('GET', '/api/ai/runs?status=finished', { token: user.token }))).runs;
    expect(list.map((r: any) => r.id)).toContain(run.id);
    expect((await json(await api('GET', '/api/ai/todos', { token: user.token }))).todos[0]).toMatchObject({ title: 'Buy milk', priority: 'high' });
    expect((await json(await api('GET', '/api/ai/reminders', { token: user.token }))).reminders).toHaveLength(1);
  });

  it('falls back to keyword routing when the router model gives no usable answer', async () => {
    const user = await newUser('route');
    await script([{ when: { purpose: 'route' }, respond: { text: 'I think maybe personal?' } }, finalAnswer('ok'), titleRule]);
    const started = await start(user, 'Please fix this bug in my python function: it crashes with an exception');
    const run = await waitForRun(user, started.run.id);
    expect(run.status).toBe('completed');
    expect(run.resolvedAgentId).toBe('coder');
    const ev = (await eventsOf(user, run.id)).find((e) => e.type === 'route');
    expect(ev.data).toMatchObject({ agent: 'coder', viaLlm: false });
    // the coding agent works in direct mode with the code model: no plan was requested
    expect((await calls()).filter((c) => c.purpose === 'plan')).toHaveLength(0);
    expect((await calls()).find((c) => c.purpose === 'chat')!.model).toBe(MODEL.qwen);
  });

  it('delivers due reminders exactly once, as a message from AMIN AI', async () => {
    const user = await newUser('remind');
    const due = futureDate(1);
    await script([plan([{ title: 'Remind', tool: 'reminder_set', args: { text: 'Call the dentist', at: `${due} 08:00` } }]), finalAnswer('Reminder set.'), titleRule]);
    const started = await start(user, 'Remind me to call the dentist tomorrow at 8', 'personal');
    await waitForRun(user, started.run.id);

    // nothing is due yet
    await deliverDueReminders(env);
    expect((await json(await api('GET', '/api/ai/reminders', { token: user.token }))).reminders).toHaveLength(1);

    const later = Date.now() + 3 * 86_400_000;
    expect(await deliverDueReminders(env, later)).toBeGreaterThanOrEqual(1);
    expect(await deliverDueReminders(env, later)).toBe(0); // second run: nothing left, and no duplicate message
    const row = await env.DB.prepare('SELECT status, delivery_message_id FROM reminders WHERE user_id = ?').bind(user.id).first<any>();
    expect(row.status).toBe('delivered');
    const msg = await env.DB.prepare('SELECT sender_id, body, thread_id FROM messages WHERE id = ?').bind(row.delivery_message_id).first<any>();
    expect(msg).toMatchObject({ sender_id: 'usr_amin_ai', body: '⏰ Reminder: Call the dentist' });
    const inThread = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND body LIKE '%Call the dentist%'").bind(msg.thread_id).first<{ n: number }>();
    expect(inThread?.n).toBe(1);
    // the user can cancel a scheduled reminder, but not someone else's
    expect((await json(await api('GET', '/api/ai/reminders?status=all', { token: user.token }))).reminders[0].status).toBe('delivered');
  });

  it('never claims success when a step failed, and skips the steps that depended on it', async () => {
    const user = await newUser('honest');
    await script([
      plan([
        { title: 'Set a reminder in the past', tool: 'reminder_set', args: { text: 'Too late', at: '2020-01-01 10:00' } },
        { title: 'Add a task', tool: 'todo_add', args: { title: 'Should never exist' } },
      ]),
      finalAnswer('Sorry, that did not work.'),
      titleRule,
    ]);
    const started = await start(user, 'Remind me about something in 2020', 'personal');
    const run = await waitForRun(user, started.run.id);
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('TIME_IN_PAST');
    expect(run.steps.map((s: any) => s.status)).toEqual(['failed', 'skipped']);
    expect(run.steps[0].attempts).toBe(1); // a validation error is never retried
    expect(run.steps[0].errorCode).toBe('TIME_IN_PAST');

    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?').bind(user.id).first<any>()).n).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM todos WHERE user_id = ?').bind(user.id).first<any>()).n).toBe(0);

    const system = await finalSystemPrompt();
    expect(system).toContain('[FAILED]');
    expect(system).toContain('[NOT DONE');
    expect(system).not.toContain('[COMPLETED');
    // the stored reply carries an explicit note even if the model's wording were over-optimistic
    const reply = (await threadMessages(user, started.thread.id))[1];
    expect(reply.body).toContain('Sorry, that did not work.');
    expect(reply.body).toMatch(/The step "Set a reminder in the past" failed/);
    expect(reply.body).toMatch(/Add a task: not executed/);
    expect(reply.meta.ai.agentId).toBe('personal');
  });

  it('retries a step that failed for a temporary reason and records the attempts', async () => {
    const user = await newUser('retry');
    const failing: Rule = { when: { purpose: 'tool' }, respond: { error: '5000: internal server error' }, times: 5 }; // every candidate model fails once
    await script([
      plan([{ title: 'Write the text', tool: 'compose', args: { instruction: 'Write one friendly sentence' } }]),
      failing,
      { when: { purpose: 'tool' }, respond: { text: 'Have a wonderful day!' } },
      finalAnswer('Here it is: Have a wonderful day!'),
      titleRule,
    ]);
    const started = await start(user, 'Write me a friendly sentence', 'personal');
    const run = await waitForRun(user, started.run.id, undefined, 30_000);
    expect(run.status).toBe('completed');
    expect(run.steps[0]).toMatchObject({ tool: 'compose', status: 'completed', attempts: 2 });
    const errors = (await eventsOf(user, run.id)).filter((e) => e.type === 'step.error');
    expect(errors).toHaveLength(1);
    expect(errors[0].data).toMatchObject({ attempt: 1, retryable: true });
    expect(run.steps[0].output?.text ?? '').toContain('wonderful');
  });

  it('does not retry forever: a step that keeps failing ends as failed after 3 attempts', async () => {
    const user = await newUser('giveup');
    await script([
      plan([{ title: 'Write the text', tool: 'compose', args: { instruction: 'Write something' } }]),
      { when: { purpose: 'tool' }, respond: { error: '5000: internal server error' } },
      finalAnswer('I could not write it.'),
      titleRule,
    ]);
    const started = await start(user, 'Write something', 'personal');
    const run = await waitForRun(user, started.run.id, undefined, 40_000);
    expect(run.status).toBe('failed');
    expect(run.steps[0]).toMatchObject({ status: 'failed', attempts: 3, errorCode: 'AI_FAILED' });
    expect((await finalSystemPrompt())).toContain('[FAILED]');
  });

  it('passes the output of one step to the next one with {{step.N.text}}', async () => {
    const user = await newUser('chain');
    await script([
      plan([
        { title: 'Draft the note', tool: 'compose', args: { instruction: 'Write a short note about the weekly meeting' } },
        { title: 'Save it as a task', tool: 'todo_add', args: { title: 'Meeting', notes: '{{step.1.text}}' } },
      ]),
      { when: { purpose: 'tool' }, respond: { text: 'Weekly meeting: Monday 10:00, bring the report.' } },
      finalAnswer('Saved.'),
      titleRule,
    ]);
    const started = await start(user, 'Draft a note about the weekly meeting and save it as a task', 'personal');
    const run = await waitForRun(user, started.run.id);
    expect(run.status).toBe('completed');
    const todo = await env.DB.prepare('SELECT title, notes FROM todos WHERE user_id = ?').bind(user.id).first<any>();
    expect(todo).toEqual({ title: 'Meeting', notes: 'Weekly meeting: Monday 10:00, bring the report.' });
  });

  it('repairs invalid planned arguments once, then fails the step instead of guessing again', async () => {
    const user = await newUser('repair');
    await script([
      plan([{ title: 'Add a task', tool: 'todo_add', args: { title: '' } }]), // invalid: empty title
      derived({ title: 'Water the plants' }),
      finalAnswer('Added.'),
      titleRule,
    ]);
    const ok = await start(user, 'Add a task to water the plants', 'personal');
    const okRun = await waitForRun(user, ok.run.id);
    expect(okRun.status).toBe('completed');
    expect((await env.DB.prepare('SELECT title FROM todos WHERE user_id = ?').bind(user.id).first<any>()).title).toBe('Water the plants');

    await script([plan([{ title: 'Add a task', tool: 'todo_add', args: { title: '' } }]), derived({ nonsense: true }), finalAnswer('Could not.'), titleRule]);
    const bad = await start(user, 'Add something', 'personal');
    const badRun = await waitForRun(user, bad.run.id);
    expect(badRun.status).toBe('failed');
    expect(badRun.steps[0]).toMatchObject({ status: 'failed', errorCode: 'INVALID_ARGS', attempts: 0 });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM todos WHERE user_id = ?').bind(user.id).first<any>()).n).toBe(1);
  });

  it('answers directly when the plan is unusable, and agents cannot use tools they do not own', async () => {
    const user = await newUser('bounds');
    // 1. a plan that uses a tool of another agent is rejected (twice), then the agent answers without tools
    await script([
      plan([{ title: 'Send a message', tool: 'message_send', args: { conversationId: 'cnv_x', text: 'hi' } }]),
      finalAnswer('I can only manage tasks here.'),
      titleRule,
    ]);
    const a = await start(user, 'Please do something', 'personal');
    const runA = await waitForRun(user, a.run.id);
    expect(runA.status).toBe('completed');
    expect(runA.steps).toEqual([]);
    expect((await calls()).filter((c) => c.purpose === 'plan')).toHaveLength(2);
    expect((await calls()).find((c) => c.purpose === 'plan')!.system).not.toContain('- message_send:');
    expect((await eventsOf(user, runA.id)).some((e) => e.type === 'plan.invalid')).toBe(true);

    // 2. garbage instead of JSON
    await script([{ when: { purpose: 'plan' }, respond: { text: 'Sure! I will do it.' } }, finalAnswer('Done thinking.'), titleRule]);
    const b = await start(user, 'Do the thing', 'personal');
    expect((await waitForRun(user, b.run.id)).status).toBe('completed');

    // 3. too many steps
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Task ${i}`, tool: 'todo_add', args: { title: `t${i}` } }));
    await script([plan(many), finalAnswer('Too much.'), titleRule]);
    const c = await start(user, 'Add twelve tasks', 'personal');
    const runC = await waitForRun(user, c.run.id);
    expect(runC.steps).toEqual([]);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM todos WHERE user_id = ?').bind(user.id).first<any>()).n).toBe(0);
  });

  it('tells the model which tools are unavailable and never plans with them (web search without a provider)', async () => {
    const user = await newUser('research');
    await script([plan([{ title: 'Search', tool: 'web_search', args: { query: 'workers ai pricing' } }]), finalAnswer('General knowledge answer, no sources.'), titleRule]);
    const started = await start(user, 'Research Workers AI pricing and cite sources', 'research');
    const run = await waitForRun(user, started.run.id);
    expect(run.status).toBe('completed');
    expect(run.steps).toEqual([]);
    const planCall = (await calls()).find((c) => c.purpose === 'plan')!;
    expect(planCall.system).not.toContain('web_search');
    const system = await finalSystemPrompt();
    expect(system).toMatch(/not available right now/);
    expect(system).toContain('web_search');
    expect(system).toMatch(/If no search tool is connected, say plainly/);
  });
});

/* ------------------------------------------------------------------------------------------------ approvals */

describe('approval system — sensitive actions', () => {
  it('parks the run for approval, sends nothing until the user approves, and applies edits', async () => {
    const socket = await openSocket(await registerUser('unused')); // keep the helper exercised
    socket.close();
    const { alice, bob, chat, started, run, approval } = await parkedSend();

    // the card shows exactly what would happen
    expect(approval).toMatchObject({ action: 'message_send', status: 'pending', editable: ['text'] });
    expect(approval.summary).toContain('Send to');
    expect(approval.payload).toMatchObject({ conversationId: chat, text: 'I will be late, sorry!' });
    expect(run.steps.map((s: any) => s.status)).toEqual(['completed', 'awaiting_approval']);
    expect(run.steps[1].risk).toBe('sensitive');
    expect(await messageCount(chat)).toBe(0); // nothing was sent
    expect((await calls()).filter((c) => c.purpose === 'chat')).toHaveLength(0); // no final answer yet
    expect((await json(await api('GET', '/api/ai/approvals', { token: alice.token }))).approvals.map((a: any) => a.id)).toEqual([approval.id]);

    // only the owner can see or decide it
    expect((await json(await api('GET', '/api/ai/approvals', { token: bob.token }))).approvals).toEqual([]);
    expect((await api('POST', `/api/ai/approvals/${approval.id}/decision`, { token: bob.token, json: { decision: 'approve' } })).status).toBe(404);
    // only the fields the tool declared editable can change, and edits are validated
    const decide = (json: unknown) => api('POST', `/api/ai/approvals/${approval.id}/decision`, { token: alice.token, json });
    const bad1 = await decide({ decision: 'approve', edits: { conversationId: 'cnv_other' } });
    expect(bad1.status).toBe(400);
    expect((await json(bad1)).error.code).toBe('FIELD_NOT_EDITABLE');
    expect((await decide({ decision: 'approve', edits: { text: '' } })).status).toBe(400);
    expect((await decide({ decision: 'maybe' })).status).toBe(400);
    expect(await messageCount(chat)).toBe(0);

    // approve with an edited text
    const ok = await decide({ decision: 'approve', edits: { text: 'I will be 15 minutes late.' } });
    expect(ok.status).toBe(200);
    expect((await json(ok)).approval.status).toBe('approved');
    const done = await waitForRun(alice, started.run.id);
    expect(done.status).toBe('completed');
    expect(done.steps.map((s: any) => [s.status, s.verified])).toEqual([['completed', false], ['completed', true]]); // reading is not an effect: only the send is confirmed

    const sent = await env.DB.prepare('SELECT sender_id, body, via_ai, meta FROM messages WHERE conversation_id = ? AND via_ai = 1').bind(chat).first<any>();
    expect(sent).toMatchObject({ sender_id: alice.id, body: 'I will be 15 minutes late.', via_ai: 1 });
    expect(JSON.parse(sent.meta).ai.runId).toBe(started.run.id);
    expect(await messageCount(chat)).toBe(1);
    // Bob really receives it, flagged as sent with AI help
    const bobView = (await json(await api('GET', `/api/conversations/${chat}/messages`, { token: bob.token }))).messages;
    expect(bobView.map((m: any) => [m.body, m.viaAi])).toEqual([['I will be 15 minutes late.', true]]);

    // a decision can only be made once
    const again = await decide({ decision: 'approve' });
    expect(again.status).toBe(409);
    expect((await json(again)).error.code).toBe('ALREADY_DECIDED');
    expect((await finalSystemPrompt())).toContain('[COMPLETED, confirmed]');
    const types = (await eventsOf(alice, started.run.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['approval.requested', 'approval.approved', 'step.completed']));
  });

  it('does nothing when the user declines, and says so', async () => {
    const { alice, chat, started, approval } = await parkedSend();
    const res = await api('POST', `/api/ai/approvals/${approval.id}/decision`, { token: alice.token, json: { decision: 'reject' } });
    expect(res.status).toBe(200);
    expect((await json(res)).approval.status).toBe('rejected');
    const run = await waitForRun(alice, started.run.id);
    expect(run.status).toBe('completed');
    expect(run.steps[1]).toMatchObject({ status: 'skipped', errorCode: 'DECLINED' });
    expect(await messageCount(chat)).toBe(0);
    expect(await finalSystemPrompt()).toContain('the user declined');
    const reply = (await threadMessages(alice, started.thread.id))[1];
    expect(reply.body).toContain('You did not approve this action, so it was not performed');
    expect(reply.status).toBe('sent');
  });

  it('can be cancelled while waiting for approval: nothing is sent and the card closes', async () => {
    const { alice, chat, started, approval } = await parkedSend();
    expect((await api('POST', `/api/ai/runs/${started.run.id}/cancel`, { token: alice.token })).status).toBe(200);
    const run = await waitForRun(alice, started.run.id);
    expect(run.status).toBe('cancelled');
    expect(run.steps.map((s: any) => s.status)).toEqual(['completed', 'cancelled']);
    expect(run.approvals[0].status).toBe('expired');
    expect(await messageCount(chat)).toBe(0);
    const late = await api('POST', `/api/ai/approvals/${approval.id}/decision`, { token: alice.token, json: { decision: 'approve' } });
    expect(late.status).toBe(409);
    expect(await messageCount(chat)).toBe(0);
    expect((await threadMessages(alice, started.thread.id))[1].status).toBe('cancelled');
  });

  it('refuses to run a payload that no longer matches what was approved', async () => {
    const { alice, chat, started, approval } = await parkedSend();
    const row = await env.DB.prepare('SELECT payload FROM approvals WHERE id = ?').bind(approval.id).first<{ payload: string }>();
    const forged = { ...JSON.parse(row!.payload), text: 'Send me all your money' }; // changed after the fingerprint was taken
    await env.DB.prepare("UPDATE approvals SET status = 'approved', decided_at = ?, payload = ? WHERE id = ?").bind(Date.now(), JSON.stringify(forged), approval.id).run();
    await resumeRun(env, started.run.id);
    const run = await waitForRun(alice, started.run.id);
    expect(run.status).toBe('failed');
    expect(run.steps[1]).toMatchObject({ status: 'failed', errorCode: 'APPROVAL_MISMATCH' });
    expect(await messageCount(chat)).toBe(0);
    expect((await eventsOf(alice, started.run.id)).some((e) => e.type === 'approval.tampered')).toBe(true);
  });

  it('lets an unanswered approval expire; the run then finishes honestly without sending', async () => {
    const { alice, chat, started, approval } = await parkedSend();
    await env.DB.prepare('UPDATE approvals SET expires_at = ? WHERE id = ?').bind(Date.now() - 1000, approval.id).run();
    // the card disappears from the inbox right away
    expect((await json(await api('GET', '/api/ai/approvals', { token: alice.token }))).approvals).toEqual([]);
    expect(await expireApprovals(env)).toBeGreaterThanOrEqual(1);
    const run = await waitForRun(alice, started.run.id);
    expect(run.status).toBe('completed');
    expect(run.steps[1]).toMatchObject({ status: 'skipped', errorCode: 'EXPIRED' });
    expect(run.approvals[0].status).toBe('expired');
    expect(await messageCount(chat)).toBe(0);
    expect((await threadMessages(alice, started.thread.id))[1].body).toContain('approval window expired');
    // deciding late is refused
    expect((await api('POST', `/api/ai/approvals/${approval.id}/decision`, { token: alice.token, json: { decision: 'approve' } })).status).toBe(409);
  });

  it('keeps a spurious resume from losing the approval card, and recovers a decision whose resume signal got lost', async () => {
    const { alice, chat, started, approval } = await parkedSend();
    // the process "died" right after the run was flipped to running: the recovery job resumes it
    await env.DB.prepare("UPDATE runs SET status = 'running', heartbeat_at = 1 WHERE id = ?").bind(started.run.id).run();
    const rec = await recoverStaleRuns(env);
    expect(rec.resumed).toBeGreaterThanOrEqual(1);
    const again = await waitFor(async () => {
      const r = await getRunDto(alice, started.run.id);
      return r.status === 'awaiting_approval' && r.status !== 'running' ? r : null;
    });
    expect(again.approvals).toHaveLength(1); // no second card
    expect(again.approvals[0].id).toBe(approval.id);
    expect(await messageCount(chat)).toBe(0);

    // the user decided, but the resume signal never arrived (simulated): the safety net picks it up
    await env.DB.prepare("UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ?").bind(Date.now() - 120_000, approval.id).run();
    expect(await resumeLostDecisions(env)).toBeGreaterThanOrEqual(1);
    const run = await waitForRun(alice, started.run.id);
    expect(run.status).toBe('completed');
    expect(await messageCount(chat)).toBe(1);
  });

  it('fails runs that keep stalling instead of resuming them forever', async () => {
    const { alice, chat, started } = await parkedSend();
    await env.DB.prepare("UPDATE runs SET status = 'running', heartbeat_at = 1, resumes = 3 WHERE id = ?").bind(started.run.id).run();
    const rec = await recoverStaleRuns(env);
    expect(rec.stalled).toBeGreaterThanOrEqual(1);
    const run = await waitForRun(alice, started.run.id);
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('RUN_STALLED');
    expect(run.steps.map((s: any) => s.status)).toEqual(['completed', 'cancelled']);
    expect(run.approvals[0].status).toBe('expired');
    expect(await messageCount(chat)).toBe(0);
  });

  it('does not report a send as done when the message cannot be confirmed', async () => {
    const { alice, chat, started, approval } = await parkedSend();
    // sabotage: whatever is written for this chat is altered by the database right after the insert,
    // so what can be read back differs from what was meant to be sent
    const trigger = `sabotage_${chat.slice(4, 14)}`;
    await env.DB.prepare(
      `CREATE TRIGGER ${trigger} AFTER INSERT ON messages WHEN NEW.conversation_id = '${chat}' AND NEW.via_ai = 1 BEGIN UPDATE messages SET body = body || ' [corrupted]' WHERE id = NEW.id; END`,
    ).run();
    try {
      await api('POST', `/api/ai/approvals/${approval.id}/decision`, { token: alice.token, json: { decision: 'approve' } });
      const run = await waitForRun(alice, started.run.id, undefined, 40_000);
      expect(run.status).toBe('failed');
      expect(run.steps[1]).toMatchObject({ status: 'failed', errorCode: 'NOT_VERIFIED', attempts: 3 });
      expect(run.steps[1].verified).toBe(false);
      const system = await finalSystemPrompt();
      expect(system).toContain('[FAILED]');
      expect(system).not.toContain('Result: Message sent');
      expect((await threadMessages(alice, started.thread.id))[1].body).toMatch(/failed/);
    } finally {
      await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
    }
    // the (sabotaged) row exists, yet the engine refused to call it a success because it read back something else
    expect(await messageCount(chat)).toBe(1);
  });

  it('refuses to send into secret (end-to-end encrypted) chats and into chats the user does not belong to', async () => {
    const alice = await newUser('e2ee');
    const bob = await registerUser('bobby');
    const mallory = await registerUser('mallory');
    const other = await directChat(bob, mallory);
    await script([
      plan([{ title: 'Send', tool: 'message_send', args: { conversationId: other, text: 'hello' } }]),
      finalAnswer('Could not send.'),
      titleRule,
    ]);
    const started = await start(alice, 'Send hello to that chat', 'messenger');
    const run = await waitForRun(alice, started.run.id);
    // the target is validated before any card is shown: the step fails, no approval exists
    expect(run.status).toBe('failed');
    expect(run.steps[0]).toMatchObject({ status: 'failed' });
    expect(run.approvals).toEqual([]);
    expect(await messageCount(other)).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------------------ cancel mid-run, files, memory tool */

describe('task engine — cancel, files and boundaries', () => {
  it('cancels a run in the middle of a tool call', async () => {
    const user = await newUser('cancelstep');
    await script([
      plan([{ title: 'Write the text', tool: 'compose', args: { instruction: 'Write something long' } }]),
      { when: { purpose: 'tool' }, respond: { text: 'never delivered', delayMs: 8000 } },
      finalAnswer('should not be produced'),
      titleRule,
    ]);
    const started = await start(user, 'Write something long', 'personal');
    await waitFor(async () => (await calls()).some((c) => c.purpose === 'tool'));
    const t0 = Date.now();
    expect((await api('POST', `/api/ai/runs/${started.run.id}/cancel`, { token: user.token })).status).toBe(200);
    const run = await waitForRun(user, started.run.id, undefined, 6000);
    expect(Date.now() - t0).toBeLessThan(5000); // did not wait for the slow model
    expect(run.status).toBe('cancelled');
    expect(run.steps[0].status).toBe('cancelled');
    expect((await calls()).filter((c) => c.purpose === 'chat')).toHaveLength(0);
    expect((await threadMessages(user, started.thread.id))[1].status).toBe('cancelled');
  });

  it('reads a file with the File agent and categorizes it only after approval', async () => {
    const user = await newUser('filer');
    const form = new FormData();
    form.set('file', new File(['Invoice 2026-11\nTotal: 480 EUR\nSupplier: ACME'], 'invoice-nov.txt', { type: 'text/plain' }));
    const up = await api('POST', '/api/files', { token: user.token, body: form });
    const file = (await json(up)).file;

    await script([
      plan([
        { title: 'List my files', tool: 'file_list', args: {} },
        { title: 'Read the invoice', tool: 'file_read', args: { fileId: file.id } },
        { title: 'Categorize', tool: 'file_categorize', args: { assignments: [{ fileId: file.id, category: 'Invoices' }] } },
      ]),
      finalAnswer('The invoice is 480 EUR from ACME. I filed it under Invoices.'),
      titleRule,
    ]);
    const started = await start(user, 'Read my invoice and file it under Invoices', 'file');
    const parked = await waitForRun(user, started.run.id, ['awaiting_approval', 'failed', 'completed']);
    expect(parked.status).toBe('awaiting_approval');
    expect(parked.steps.map((s: any) => s.status)).toEqual(['completed', 'completed', 'awaiting_approval']);
    expect(parked.steps[1].output.text).toContain('Total: 480 EUR');
    // nothing is categorized before approval
    expect((await env.DB.prepare('SELECT category FROM files WHERE id = ?').bind(file.id).first<any>()).category).toBeNull();

    const card = parked.approvals[0];
    expect(card.summary).toContain('invoice-nov.txt → Invoices');
    await api('POST', `/api/ai/approvals/${card.id}/decision`, { token: user.token, json: { decision: 'approve', edits: { assignments: [{ fileId: file.id, category: 'Finance' }] } } });
    const run = await waitForRun(user, started.run.id);
    expect(run.status).toBe('completed');
    expect((await env.DB.prepare('SELECT category FROM files WHERE id = ?').bind(file.id).first<any>()).category).toBe('Finance'); // the edited value, not the proposed one
    expect((await finalSystemPrompt())).toContain('Categorized 1 of 1');

    // other people's files are never reachable
    const eve = await newUser('eve');
    await script([plan([{ title: 'Read', tool: 'file_read', args: { fileId: file.id } }]), finalAnswer('Nope.'), titleRule]);
    const steal = await start(eve, 'Read that file', 'file');
    const stolen = await waitForRun(eve, steal.run.id);
    expect(stolen.status).toBe('failed');
    expect(stolen.steps[0]).toMatchObject({ status: 'failed', errorCode: 'FILE_NOT_FOUND' });
    expect(JSON.stringify(stolen)).not.toContain('ACME');
  });

  it('enforces one active run per thread and three per user', async () => {
    const user = await newUser('limits');
    await script([{ when: { purpose: 'chat' }, respond: { text: 'slow slow slow slow slow slow slow slow slow', chunkDelayMs: 400 } }, titleRule]);
    const runs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await start(user, `question ${i}`, 'general');
      runs.push(s.run.id);
    }
    const t4 = await createThread(user);
    const res = await sendAi(user, t4.id, { body: 'one too many', agentId: 'general' });
    expect(res.status).toBe(429);
    expect(res.data.error.code).toBe('RATE_LIMITED');
    expect(res.data.error.details.retryAfterSec).toBeGreaterThan(0);
    for (const id of runs) await api('POST', `/api/ai/runs/${id}/cancel`, { token: user.token });
    for (const id of runs) await waitForRun(user, id);
  });

  it('proposes memories only as suggestions that the user must approve', async () => {
    const user = await newUser('memprop');
    await script([
      plan([{ title: 'Remember the preference', tool: 'memory_propose', args: { kind: 'preference', content: 'Prefers short answers in Persian' } }]),
      finalAnswer('I suggested it; approve it in Memory settings.'),
      titleRule,
    ]);
    const started = await start(user, 'Remember that I like short answers in Persian', 'personal');
    const run = await waitForRun(user, started.run.id);
    expect(run.status).toBe('completed');
    const mem = await json(await api('GET', '/api/ai/memory', { token: user.token }));
    expect(mem.items).toEqual([]); // nothing stored without approval
    expect(mem.suggestions).toHaveLength(1);
    expect(mem.suggestions[0]).toMatchObject({ kind: 'preference', content: 'Prefers short answers in Persian', status: 'pending' });
  });
});
