import { Hono } from 'hono';
import type { ProjectDto, ReminderDto, TodoDto } from '@aminchat/shared';
import { z } from 'zod';
import { all } from '../db/helpers';
import { notFound } from '../lib/errors';
import { safeJsonParse } from '../lib/text';
import { parseJson, parseQuery } from '../lib/validate';
import type { AppEnv } from '../middleware/auth';

/** Read/manage views of what the Personal agent created, so the user can always check and correct it. */
export const aiPersonalRoutes = new Hono<AppEnv>();

interface TodoRow { id: string; title: string; notes: string | null; due_at: number | null; priority: TodoDto['priority']; status: TodoDto['status']; project: string | null; created_at: number; completed_at: number | null }

aiPersonalRoutes.get('/todos', async (c) => {
  const q = parseQuery(c, z.object({ status: z.enum(['open', 'done', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(200).default(100) }));
  const where = q.status === 'all' ? '' : 'AND status = ?';
  const binds: unknown[] = [c.get('user').id];
  if (q.status !== 'all') binds.push(q.status);
  const rows = await all<TodoRow>(c.env.DB.prepare(`SELECT * FROM todos WHERE user_id = ? ${where} ORDER BY (due_at IS NULL), due_at, created_at DESC LIMIT ?`).bind(...binds, q.limit));
  const todos: TodoDto[] = rows.map((r) => ({ id: r.id, title: r.title, notes: r.notes, dueAt: r.due_at, priority: r.priority, status: r.status, project: r.project, createdAt: r.created_at, completedAt: r.completed_at }));
  return c.json({ todos });
});

aiPersonalRoutes.patch('/todos/:id', async (c) => {
  const body = await parseJson(c, z.object({ status: z.enum(['open', 'done']) }));
  const res = await c.env.DB.prepare('UPDATE todos SET status = ?, completed_at = ? WHERE id = ? AND user_id = ?')
    .bind(body.status, body.status === 'done' ? Date.now() : null, c.req.param('id'), c.get('user').id)
    .run();
  if (!res.meta.changes) throw notFound('Task not found', 'TODO_NOT_FOUND');
  return c.json({ ok: true });
});

aiPersonalRoutes.delete('/todos/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM todos WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('user').id).run();
  if (!res.meta.changes) throw notFound('Task not found', 'TODO_NOT_FOUND');
  return c.json({ ok: true });
});

aiPersonalRoutes.get('/reminders', async (c) => {
  const q = parseQuery(c, z.object({ status: z.enum(['scheduled', 'all']).default('scheduled') }));
  const where = q.status === 'all' ? '' : "AND status IN ('scheduled', 'delivering')";
  const rows = await all<{ id: string; text: string; remind_at: number; status: ReminderDto['status']; delivered_at: number | null }>(
    c.env.DB.prepare(`SELECT id, text, remind_at, status, delivered_at FROM reminders WHERE user_id = ? ${where} ORDER BY remind_at DESC LIMIT 100`).bind(c.get('user').id),
  );
  const reminders: ReminderDto[] = rows.map((r) => ({ id: r.id, text: r.text, remindAt: r.remind_at, status: r.status, deliveredAt: r.delivered_at }));
  return c.json({ reminders });
});

aiPersonalRoutes.delete('/reminders/:id', async (c) => {
  const res = await c.env.DB.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'scheduled'").bind(c.req.param('id'), c.get('user').id).run();
  if (!res.meta.changes) throw notFound('Reminder not found or already delivered', 'REMINDER_NOT_FOUND');
  return c.json({ ok: true });
});

aiPersonalRoutes.get('/projects', async (c) => {
  const rows = await all<{ id: string; name: string; goal: string | null; status: ProjectDto['status']; plan: string | null; updated_at: number }>(
    c.env.DB.prepare('SELECT id, name, goal, status, plan, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100').bind(c.get('user').id),
  );
  const projects: ProjectDto[] = rows.map((r) => ({ id: r.id, name: r.name, goal: r.goal, status: r.status, milestones: safeJsonParse<ProjectDto['milestones']>(r.plan) ?? [], updatedAt: r.updated_at }));
  return c.json({ projects });
});

aiPersonalRoutes.delete('/projects/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('user').id).run();
  if (!res.meta.changes) throw notFound('Project not found', 'PROJECT_NOT_FOUND');
  return c.json({ ok: true });
});
