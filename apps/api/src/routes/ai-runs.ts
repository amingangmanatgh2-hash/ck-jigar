import { Hono } from 'hono';
import { z } from 'zod';
import { AMIN_AI_USER_ID } from '@aminchat/shared';
import { all, first } from '../db/helpers';
import { badRequest, conflict, notFound } from '../lib/errors';
import { parseJson, parseQuery } from '../lib/validate';
import type { AppEnv } from '../middleware/auth';
import { userLimit } from '../middleware/rate-limit';
import { regenerateTurn } from '../services/ai-chat';
import { decideApproval, pendingApprovals } from '../services/approvals';
import { cancelRun } from '../services/run-control';
import { getEvents, getRun, isTerminal, runToDto, runsToDtos, type RunRow } from '../services/runs';
import { requireThread } from '../services/threads';

export const aiRunRoutes = new Hono<AppEnv>();

async function ownRun(c: { env: AppEnv['Bindings']; get(k: 'user'): AppEnv['Variables']['user'] }, id: string): Promise<RunRow> {
  const run = await getRun(c.env, id);
  if (!run || run.user_id !== c.get('user').id) throw notFound('Run not found', 'RUN_NOT_FOUND');
  return run;
}

aiRunRoutes.get('/runs', async (c) => {
  const q = parseQuery(
    c,
    z.object({
      status: z.enum(['active', 'finished', 'all']).default('all'),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
  );
  const where = q.status === 'active' ? "AND status NOT IN ('completed', 'failed', 'cancelled')" : q.status === 'finished' ? "AND status IN ('completed', 'failed', 'cancelled')" : '';
  const rows = await all<RunRow>(c.env.DB.prepare(`SELECT * FROM runs WHERE user_id = ? ${where} ORDER BY created_at DESC LIMIT ?`).bind(c.get('user').id, q.limit));
  return c.json({ runs: await runsToDtos(c.env, rows) });
});

aiRunRoutes.get('/runs/:id', async (c) => {
  const run = await ownRun(c, c.req.param('id'));
  const dto = await runToDto(c.env, run);
  if (!isTerminal(run.status) && run.result_message_id) {
    const m = await first<{ body: string | null }>(c.env.DB.prepare('SELECT body FROM messages WHERE id = ?').bind(run.result_message_id));
    dto.text = m?.body ?? null;
  }
  return c.json({ run: dto });
});

/** The operation log of a run: every plan, step, retry, approval and model call, in order. */
aiRunRoutes.get('/runs/:id/events', async (c) => {
  const run = await ownRun(c, c.req.param('id'));
  const events = await getEvents(c.env, run.id, 500);
  return c.json({
    events: events.map((e) => ({ id: e.id, stepId: e.step_id, ts: e.ts, level: e.level, type: e.type, data: e.data ? safeParse(e.data) : null })),
  });
});

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

aiRunRoutes.post('/runs/:id/cancel', async (c) => {
  const run = await ownRun(c, c.req.param('id'));
  await cancelRun(c.env, c.get('user').id, run.id);
  return c.json({ ok: true });
});

/** Retry = produce the answer again (only for the newest answer of a conversation, like "regenerate"). */
aiRunRoutes.post('/runs/:id/retry', userLimit('ai'), async (c) => {
  const user = c.get('user');
  const run = await ownRun(c, c.req.param('id'));
  if (!isTerminal(run.status)) throw conflict('This task is still running.', 'RUN_ACTIVE');
  if (run.kind === 'assist' || !run.thread_id) throw badRequest('Only your own AMIN AI conversations can be retried.', undefined, 'RETRY_UNSUPPORTED');
  const thread = await requireThread(c.env, user.id, run.thread_id);
  const last = await first<{ id: string; sender_id: string }>(c.env.DB.prepare('SELECT id, sender_id FROM messages WHERE thread_id = ? AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1').bind(thread.id));
  if (!last || last.id !== run.result_message_id || last.sender_id !== AMIN_AI_USER_ID) throw conflict('Only the newest answer of a conversation can be retried.', 'NOT_LAST_ANSWER');
  return c.json(await regenerateTurn(c.env, user, thread, { agentId: run.agent_id, modelId: run.model_id }), 202);
});

/* ------------------------------------------------------------------------------------------------ approvals */

aiRunRoutes.get('/approvals', async (c) => c.json({ approvals: await pendingApprovals(c.env, c.get('user').id) }));

aiRunRoutes.post('/approvals/:id/decision', userLimit('ai'), async (c) => {
  const body = await parseJson(c, z.object({ decision: z.enum(['approve', 'reject']), edits: z.record(z.string(), z.unknown()).optional() }));
  const approval = await decideApproval(c.env, c.get('user').id, c.req.param('id'), body.decision, body.edits);
  return c.json({ approval });
});
