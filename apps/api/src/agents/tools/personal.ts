import { z } from 'zod';
import { all, first } from '../../db/helpers';
import { formatLocal, parseUserDateTime } from '../../lib/datetime';
import { ID_PREFIX } from '../../lib/ids';
import { safeJsonParse } from '../../lib/text';
import { createSuggestion, getMemorySettings } from '../../services/memory';
import { searchMessages } from '../../services/threads';
import { ToolError, clip, type ToolDef } from './types';

/** Deterministic id per step: a retried step can never create duplicates. */
const stepScopedId = (prefix: string, stepId: string) => `${prefix}_${stepId.slice(4)}`;

const dateArg = z.string().trim().max(40);

/* ------------------------------------------------------------------------------------------------ todos */

const todoAdd = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(1000).optional(),
  due: dateArg.optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  project: z.string().trim().max(60).optional(),
});

export const todoAddTool: ToolDef<z.infer<typeof todoAdd>> = {
  id: 'todo_add',
  title: { fa: 'افزودن کار', en: 'Add task' },
  description: 'Create a to-do item for the user.',
  argsHint: '{"title": string, "notes"?: string, "due"?: "YYYY-MM-DD" or "YYYY-MM-DD HH:mm" (user local time), "priority"?: "low"|"normal"|"high", "project"?: string}',
  risk: 'write',
  schema: todoAdd,
  async run(ctx, a) {
    let dueAt: number | null = null;
    if (a.due) {
      dueAt = parseUserDateTime(a.due, ctx.user.timezone);
      if (dueAt === null) throw new ToolError('INVALID_TIME', `Could not understand the due date "${a.due}". Use YYYY-MM-DD or YYYY-MM-DD HH:mm.`);
    }
    const open = await first<{ n: number }>(ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM todos WHERE user_id = ? AND status = 'open'").bind(ctx.user.id));
    if ((open?.n ?? 0) >= 500) throw new ToolError('TODO_LIMIT', 'You have too many open tasks (500). Complete or remove some first.');
    const id = stepScopedId(ID_PREFIX.todo, ctx.step.id);
    await ctx.env.DB.prepare(
      `INSERT OR IGNORE INTO todos (id, user_id, title, notes, due_at, priority, status, project, source_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    )
      .bind(id, ctx.user.id, a.title, a.notes ?? null, dueAt, a.priority ?? 'normal', a.project ?? null, ctx.run.id, Date.now())
      .run();
    const row = await first<{ id: string; title: string; due_at: number | null }>(ctx.env.DB.prepare('SELECT id, title, due_at FROM todos WHERE id = ? AND user_id = ?').bind(id, ctx.user.id));
    if (!row) throw new ToolError('NOT_SAVED', 'The task could not be saved.', { retryable: true });
    return {
      text: `Task saved: "${row.title}"${row.due_at ? ` (due ${formatLocal(row.due_at, ctx.user.timezone)})` : ''}`,
      data: { id: row.id, title: row.title, dueAt: row.due_at },
      verified: true,
    };
  },
};

const todoList = z.object({ status: z.enum(['open', 'done', 'all']).optional(), project: z.string().trim().max(60).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

export const todoListTool: ToolDef<z.infer<typeof todoList>> = {
  id: 'todo_list',
  title: { fa: 'فهرست کارها', en: 'List tasks' },
  description: "List the user's to-do items.",
  argsHint: '{"status"?: "open"|"done"|"all" (default open), "project"?: string, "limit"?: number}',
  risk: 'read',
  schema: todoList,
  async run(ctx, a) {
    const status = a.status ?? 'open';
    const binds: unknown[] = [ctx.user.id];
    let where = 'user_id = ?';
    if (status !== 'all') {
      where += ' AND status = ?';
      binds.push(status);
    }
    if (a.project) {
      where += ' AND project = ?';
      binds.push(a.project);
    }
    const rows = await all<{ id: string; title: string; status: string; due_at: number | null; priority: string; project: string | null }>(
      ctx.env.DB.prepare(`SELECT id, title, status, due_at, priority, project FROM todos WHERE ${where} ORDER BY (due_at IS NULL), due_at, created_at DESC LIMIT ?`).bind(...binds, a.limit ?? 50),
    );
    const text = rows.length
      ? rows.map((r) => `- [${r.status === 'done' ? 'x' : ' '}] ${r.title}${r.due_at ? ` — due ${formatLocal(r.due_at, ctx.user.timezone)}` : ''}${r.priority === 'high' ? ' (high priority)' : ''}${r.project ? ` [${r.project}]` : ''} (id: ${r.id})`).join('\n')
      : 'No tasks found.';
    return { text, data: rows };
  },
};

const todoComplete = z.object({ id: z.string().trim().max(64).optional(), title: z.string().trim().max(200).optional() }).refine((v) => v.id || v.title, 'id or title is required');

export const todoCompleteTool: ToolDef<z.infer<typeof todoComplete>> = {
  id: 'todo_complete',
  title: { fa: 'تکمیل کار', en: 'Complete task' },
  description: 'Mark one open to-do item as done (by id, or by a unique part of its title).',
  argsHint: '{"id"?: string, "title"?: string}',
  risk: 'write',
  schema: todoComplete,
  async run(ctx, a) {
    let row: { id: string; title: string } | null = null;
    if (a.id) row = await first(ctx.env.DB.prepare("SELECT id, title FROM todos WHERE id = ? AND user_id = ? AND status = 'open'").bind(a.id, ctx.user.id));
    else {
      const like = `%${a.title!.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      const matches = await all<{ id: string; title: string }>(ctx.env.DB.prepare("SELECT id, title FROM todos WHERE user_id = ? AND status = 'open' AND title LIKE ? ESCAPE '\\' LIMIT 5").bind(ctx.user.id, like));
      if (matches.length > 1) throw new ToolError('AMBIGUOUS', `Several open tasks match "${a.title}": ${matches.map((m) => `"${m.title}"`).join(', ')}. Ask the user which one.`);
      row = matches[0] ?? null;
    }
    if (!row) throw new ToolError('NOT_FOUND', 'No matching open task was found.');
    await ctx.env.DB.prepare("UPDATE todos SET status = 'done', completed_at = ? WHERE id = ? AND user_id = ?").bind(Date.now(), row.id, ctx.user.id).run();
    const check = await first<{ status: string }>(ctx.env.DB.prepare('SELECT status FROM todos WHERE id = ?').bind(row.id));
    if (check?.status !== 'done') throw new ToolError('NOT_SAVED', 'The task could not be updated.', { retryable: true });
    return { text: `Task completed: "${row.title}"`, data: { id: row.id }, verified: true };
  },
};

/* ------------------------------------------------------------------------------------------------ reminders */

const reminderSet = z.object({ text: z.string().trim().min(1).max(300), at: dateArg.min(8) });

export const reminderSetTool: ToolDef<z.infer<typeof reminderSet>> = {
  id: 'reminder_set',
  title: { fa: 'تنظیم یادآور', en: 'Set reminder' },
  description: 'Schedule a reminder. AMIN AI will post it in the Reminders conversation at the given time.',
  argsHint: '{"text": string, "at": "YYYY-MM-DD HH:mm" (user local time, must be in the future)}',
  risk: 'write',
  schema: reminderSet,
  async run(ctx, a) {
    const at = parseUserDateTime(a.at, ctx.user.timezone);
    if (at === null) throw new ToolError('INVALID_TIME', `Could not understand the time "${a.at}". Use YYYY-MM-DD HH:mm.`);
    const now = Date.now();
    if (at < now + 30_000) throw new ToolError('TIME_IN_PAST', 'The reminder time is in the past. Ask the user for a future time.');
    if (at > now + 366 * 86_400_000) throw new ToolError('TIME_TOO_FAR', 'Reminders can be at most one year ahead.');
    const count = await first<{ n: number }>(ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND status = 'scheduled'").bind(ctx.user.id));
    if ((count?.n ?? 0) >= 100) throw new ToolError('REMINDER_LIMIT', 'You already have 100 scheduled reminders.');
    const id = stepScopedId(ID_PREFIX.reminder, ctx.step.id);
    await ctx.env.DB.prepare(`INSERT OR IGNORE INTO reminders (id, user_id, text, remind_at, status, source_run_id, created_at) VALUES (?, ?, ?, ?, 'scheduled', ?, ?)`)
      .bind(id, ctx.user.id, a.text, at, ctx.run.id, now)
      .run();
    const row = await first<{ id: string; remind_at: number; status: string }>(ctx.env.DB.prepare('SELECT id, remind_at, status FROM reminders WHERE id = ? AND user_id = ?').bind(id, ctx.user.id));
    if (!row || row.status !== 'scheduled') throw new ToolError('NOT_SAVED', 'The reminder could not be saved.', { retryable: true });
    return { text: `Reminder scheduled for ${formatLocal(row.remind_at, ctx.user.timezone)} (${ctx.user.timezone}): "${a.text}"`, data: { id: row.id, remindAt: row.remind_at }, verified: true };
  },
};

const reminderList = z.object({ status: z.enum(['scheduled', 'all']).optional() });

export const reminderListTool: ToolDef<z.infer<typeof reminderList>> = {
  id: 'reminder_list',
  title: { fa: 'فهرست یادآورها', en: 'List reminders' },
  description: "List the user's reminders.",
  argsHint: '{"status"?: "scheduled"|"all" (default scheduled)}',
  risk: 'read',
  schema: reminderList,
  async run(ctx, a) {
    const where = (a.status ?? 'scheduled') === 'all' ? '' : "AND status = 'scheduled'";
    const rows = await all<{ id: string; text: string; remind_at: number; status: string }>(
      ctx.env.DB.prepare(`SELECT id, text, remind_at, status FROM reminders WHERE user_id = ? ${where} ORDER BY remind_at LIMIT 50`).bind(ctx.user.id),
    );
    return {
      text: rows.length ? rows.map((r) => `- ${formatLocal(r.remind_at, ctx.user.timezone)}: ${r.text} [${r.status}] (id: ${r.id})`).join('\n') : 'No reminders found.',
      data: rows,
    };
  },
};

const reminderCancel = z.object({ id: z.string().trim().min(1).max(64) });

export const reminderCancelTool: ToolDef<z.infer<typeof reminderCancel>> = {
  id: 'reminder_cancel',
  title: { fa: 'لغو یادآور', en: 'Cancel reminder' },
  description: 'Cancel a scheduled reminder by id (use reminder_list first to find the id).',
  argsHint: '{"id": string}',
  risk: 'write',
  schema: reminderCancel,
  async run(ctx, a) {
    const res = await ctx.env.DB.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'scheduled'").bind(a.id, ctx.user.id).run();
    if (!res.meta.changes) throw new ToolError('NOT_FOUND', 'No scheduled reminder with this id was found.');
    const row = await first<{ status: string }>(ctx.env.DB.prepare('SELECT status FROM reminders WHERE id = ?').bind(a.id));
    return { text: 'Reminder cancelled.', data: { id: a.id }, verified: row?.status === 'cancelled' };
  },
};

/* ------------------------------------------------------------------------------------------------ projects */

const projectSave = z.object({
  name: z.string().trim().min(1).max(80),
  goal: z.string().trim().max(500).optional(),
  status: z.enum(['active', 'paused', 'done']).optional(),
  milestones: z.array(z.object({ title: z.string().trim().min(1).max(160), due: dateArg.optional() })).max(30).optional(),
});

export const projectSaveTool: ToolDef<z.infer<typeof projectSave>> = {
  id: 'project_save',
  title: { fa: 'ذخیره پروژه', en: 'Save project plan' },
  description: 'Create or update a project plan (name, goal, milestones). Updating an existing project name replaces its goal/milestones.',
  argsHint: '{"name": string, "goal"?: string, "status"?: "active"|"paused"|"done", "milestones"?: [{"title": string, "due"?: "YYYY-MM-DD"}]}',
  risk: 'write',
  schema: projectSave,
  async run(ctx, a) {
    const now = Date.now();
    const existing = await first<{ id: string; goal: string | null; plan: string | null; status: string }>(ctx.env.DB.prepare('SELECT id, goal, plan, status FROM projects WHERE user_id = ? AND name = ?').bind(ctx.user.id, a.name));
    const plan = a.milestones ? JSON.stringify(a.milestones.map((m) => ({ title: m.title, due: m.due ?? null, done: false }))) : existing?.plan ?? '[]';
    if (existing) {
      await ctx.env.DB.prepare('UPDATE projects SET goal = ?, status = ?, plan = ?, updated_at = ?, source_run_id = ? WHERE id = ?')
        .bind(a.goal ?? existing.goal, a.status ?? existing.status, plan, now, ctx.run.id, existing.id)
        .run();
    } else {
      await ctx.env.DB.prepare('INSERT INTO projects (id, user_id, name, goal, status, plan, source_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(stepScopedId(ID_PREFIX.project, ctx.step.id), ctx.user.id, a.name, a.goal ?? null, a.status ?? 'active', plan, ctx.run.id, now, now)
        .run();
    }
    const row = await first<{ id: string; plan: string | null }>(ctx.env.DB.prepare('SELECT id, plan FROM projects WHERE user_id = ? AND name = ?').bind(ctx.user.id, a.name));
    if (!row) throw new ToolError('NOT_SAVED', 'The project could not be saved.', { retryable: true });
    const n = safeJsonParse<unknown[]>(row.plan)?.length ?? 0;
    return { text: `Project "${a.name}" ${existing ? 'updated' : 'created'} with ${n} milestone(s).`, data: { id: row.id }, verified: true };
  },
};

const projectList = z.object({});

export const projectListTool: ToolDef<z.infer<typeof projectList>> = {
  id: 'project_list',
  title: { fa: 'فهرست پروژه‌ها', en: 'List projects' },
  description: "List the user's saved project plans.",
  argsHint: '{}',
  risk: 'read',
  schema: projectList,
  async run(ctx) {
    const rows = await all<{ name: string; goal: string | null; status: string; plan: string | null }>(
      ctx.env.DB.prepare('SELECT name, goal, status, plan FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30').bind(ctx.user.id),
    );
    const text = rows.length
      ? rows.map((r) => `- ${r.name} [${r.status}]${r.goal ? ` — ${r.goal}` : ''}\n${(safeJsonParse<{ title: string; due?: string | null }[]>(r.plan) ?? []).map((m) => `    • ${m.title}${m.due ? ` (${m.due})` : ''}`).join('\n')}`).join('\n')
      : 'No projects saved yet.';
    return { text: clip(text, 5000), data: rows.map((r) => ({ name: r.name, status: r.status })) };
  },
};

/* ------------------------------------------------------------------------------------------------ memory & history */

const memoryPropose = z.object({
  kind: z.enum(['preference', 'project', 'fact', 'other']),
  content: z.string().trim().min(3).max(600),
  project: z.string().trim().max(60).optional(),
});

export const memoryProposeTool: ToolDef<z.infer<typeof memoryPropose>> = {
  id: 'memory_propose',
  title: { fa: 'پیشنهاد حافظه', en: 'Propose memory' },
  description:
    'Propose a durable fact or preference to remember about the user. This only creates a SUGGESTION that the user must approve in Memory settings — nothing is stored until they approve.',
  argsHint: '{"kind": "preference"|"project"|"fact"|"other", "content": string, "project"?: string}',
  risk: 'write',
  schema: memoryPropose,
  async available(env, userId) {
    const settings = await getMemorySettings(env, userId);
    if (!settings.enabled) return { ok: false, reason: 'the user turned memory off in Memory settings' };
    if (!settings.autoSuggest) return { ok: false, reason: 'the user turned off memory suggestions in Memory settings' };
    return { ok: true };
  },
  async run(ctx, a) {
    const settings = await getMemorySettings(ctx.env, ctx.user.id);
    if (!settings.enabled) throw new ToolError('MEMORY_DISABLED', 'The user turned memory off, so nothing can be proposed.');
    const s = await createSuggestion(ctx.env, ctx.user.id, { kind: a.kind, content: a.content, project: a.project ?? null, reason: 'Requested in conversation', runId: ctx.run.id });
    if (!s) return { text: 'This is already remembered or already waiting for approval.', verified: true };
    return { text: 'Suggestion created. It is saved to memory only after the user approves it in Memory settings.', data: { suggestionId: s.id }, verified: true };
  },
};

const historySearch = z.object({ query: z.string().trim().min(2).max(120), limit: z.coerce.number().int().min(1).max(10).optional() });

export const historySearchTool: ToolDef<z.infer<typeof historySearch>> = {
  id: 'history_search',
  title: { fa: 'جستجو در گفتگوهای قبلی', en: 'Search past conversations' },
  description: "Search the user's earlier AMIN AI conversations. Works only if the user allowed history recall in Memory settings.",
  argsHint: '{"query": string, "limit"?: number}',
  risk: 'read',
  schema: historySearch,
  async available(env, userId) {
    const settings = await getMemorySettings(env, userId);
    if (!settings.enabled) return { ok: false, reason: 'the user turned memory off in Memory settings' };
    if (!settings.allowHistoryRecall) return { ok: false, reason: 'the user has not allowed recalling past conversations (Memory settings)' };
    return { ok: true };
  },
  async run(ctx, a) {
    const settings = await getMemorySettings(ctx.env, ctx.user.id);
    if (!settings.enabled || !settings.allowHistoryRecall) {
      throw new ToolError('HISTORY_RECALL_OFF', 'The user has not allowed AMIN AI to search past conversations. They can enable "recall past conversations" in Memory settings.');
    }
    const hits = await searchMessages(ctx.env, ctx.user.id, a.query, { scope: 'ai', limit: a.limit ?? 6 });
    if (hits.length === 0) return { text: 'No matching messages were found in past conversations.', data: [] };
    return {
      text: hits.map((h, i) => `${i + 1}. [${formatLocal(h.createdAt, ctx.user.timezone)}] ${h.threadTitle ?? 'Conversation'}: ${h.snippet}`).join('\n'),
      data: hits.map((h) => ({ messageId: h.messageId, threadId: h.threadId })),
    };
  },
};
