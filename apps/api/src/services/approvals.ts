import type { ApprovalDto } from '@aminchat/shared';
import { AiClient } from '../ai/client';
import { payloadHash, splitPayload } from '../agents/approvals';
import { loadRunUser } from '../agents/executor';
import { getTool } from '../agents/tools';
import { ToolError, type ToolContext } from '../agents/tools/types';
import type { Env } from '../env';
import { badRequest, conflict, notFound } from '../lib/errors';
import { safeJsonParse } from '../lib/text';
import { approvalToDto, getApproval, getRun, getSteps, isTerminal, logEvent } from './runs';
import { resumeRun } from './run-control';
import { publishToUsers } from '../lib/realtime';

/**
 * The user's decision on a pending approval.
 *  - `reject`: the step will not run.
 *  - `approve`: optionally with edits to the fields the tool declared editable. The edited payload is re-validated and re-checked
 *    (preconditions such as "is the chat still reachable"), stored together with a new fingerprint, and only then is the run resumed.
 *    The executor refuses to run a payload whose fingerprint does not match what was approved.
 */
export async function decideApproval(
  env: Env,
  userId: string,
  approvalId: string,
  decision: 'approve' | 'reject',
  edits?: Record<string, unknown>,
): Promise<ApprovalDto> {
  const approval = await getApproval(env, approvalId);
  if (!approval || approval.user_id !== userId) throw notFound('Approval not found', 'APPROVAL_NOT_FOUND');
  if (approval.status !== 'pending') throw conflict('This request was already answered or has expired.', 'ALREADY_DECIDED');
  const now = Date.now();
  const run = await getRun(env, approval.run_id);
  if (!run || isTerminal(run.status)) throw conflict('The task is no longer active.', 'RUN_NOT_ACTIVE');
  if (approval.expires_at < now) {
    await env.DB.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'").bind(now, approval.id).run();
    await resumeRun(env, run.id);
    throw conflict('This request has expired.', 'APPROVAL_EXPIRED');
  }

  if (decision === 'reject') {
    const res = await env.DB.prepare("UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'").bind(now, approval.id).run();
    if (!res.meta.changes) throw conflict('This request was already answered.', 'ALREADY_DECIDED');
    await logEvent(env, run.id, 'approval.rejected', { approvalId: approval.id, action: approval.action }, 'info', approval.step_id);
    await resumeRun(env, run.id);
    return approvalToDto({ ...approval, status: 'rejected', decided_at: now });
  }

  const tool = getTool(approval.action);
  if (!tool) throw badRequest('This action is no longer available', undefined, 'TOOL_UNAVAILABLE');
  const { args, context } = splitPayload(safeJsonParse<Record<string, unknown>>(approval.payload) ?? {});
  let finalArgs: unknown = args;
  let edited = false;

  if (edits && Object.keys(edits).length > 0) {
    const editable = new Set(safeJsonParse<string[]>(approval.editable) ?? []);
    const illegal = Object.keys(edits).filter((k) => !editable.has(k));
    if (illegal.length) throw badRequest(`These fields cannot be edited: ${illegal.join(', ')}`, undefined, 'FIELD_NOT_EDITABLE');
    const parsed = tool.schema.safeParse({ ...args, ...edits });
    if (!parsed.success) throw badRequest('The edited values are not valid', parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })), 'INVALID_EDIT');
    finalArgs = parsed.data;
    edited = true;
    // re-check the preconditions with the edited values
    const runUser = await loadRunUser(env, userId);
    const step = (await getSteps(env, run.id)).find((s) => s.id === approval.step_id);
    if (runUser && step && tool.prepare) {
      const ctx: ToolContext = {
        env, user: runUser, run, step, ai: new AiClient(env), signal: new AbortController().signal, fetch,
        chat: async () => {
          throw new ToolError('NOT_ALLOWED', 'Model calls are not available while validating an approval.');
        },
      };
      try {
        const prepared = await tool.prepare(ctx, finalArgs);
        finalArgs = prepared.args;
      } catch (err) {
        if (err instanceof ToolError) throw badRequest(err.message, undefined, err.code);
        throw err;
      }
    }
  }

  const hash = await payloadHash(finalArgs);
  const payload = JSON.stringify({ ...(finalArgs as Record<string, unknown>), _context: context });
  const res = await env.DB.prepare(
    "UPDATE approvals SET status = 'approved', decided_at = ?, payload = ?, payload_hash = ? WHERE id = ? AND status = 'pending' AND expires_at >= ?",
  )
    .bind(now, payload, hash, approval.id, now)
    .run();
  if (!res.meta.changes) throw conflict('This request was already answered or has expired.', 'ALREADY_DECIDED');
  await logEvent(env, run.id, 'approval.approved', { approvalId: approval.id, action: approval.action, edited }, 'info', approval.step_id);
  const fresh = (await getApproval(env, approval.id))!;
  await publishToUsers(env, [userId], { type: 'run.approval', approval: approvalToDto(fresh) });
  await resumeRun(env, run.id);
  return approvalToDto(fresh);
}

/** Pending approvals of the user (the in-app inbox). */
export async function pendingApprovals(env: Env, userId: string): Promise<ApprovalDto[]> {
  const { results } = await env.DB.prepare("SELECT * FROM approvals WHERE user_id = ? AND status = 'pending' AND expires_at >= ? ORDER BY created_at DESC LIMIT 50")
    .bind(userId, Date.now())
    .all();
  return (results as never[]).map((r) => approvalToDto(r));
}

