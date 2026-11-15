import type { ApprovalDto, RunDto, RunStatus, RunStepDto, StepStatus, ToolRisk } from '@aminchat/shared';
import { all, batch, first } from '../db/helpers';
import type { Env } from '../env';
import { newId, ID_PREFIX } from '../lib/ids';
import { publishToUsers } from '../lib/realtime';
import { safeJsonParse, truncate } from '../lib/text';

export interface RunRow {
  id: string;
  user_id: string;
  kind: 'chat' | 'task' | 'assist';
  agent_id: string;
  status: RunStatus;
  goal: string;
  conversation_id: string | null;
  thread_id: string | null;
  trigger_message_id: string | null;
  result_message_id: string | null;
  model_id: string | null;
  options: string | null;
  plan: string | null;
  result: string | null;
  error: string | null;
  error_code: string | null;
  cancel_requested: number;
  resumes: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  heartbeat_at: number | null;
}

export interface StepRow {
  id: string;
  run_id: string;
  idx: number;
  title: string;
  tool: string;
  args: string | null;
  resolved_args: string | null;
  status: StepStatus;
  risk: ToolRisk;
  attempts: number;
  output: string | null;
  error: string | null;
  error_code: string | null;
  verified: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface ApprovalRow {
  id: string;
  run_id: string;
  step_id: string;
  user_id: string;
  action: string;
  summary: string;
  payload: string;
  payload_hash: string;
  editable: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  created_at: number;
  expires_at: number;
  decided_at: number | null;
}

export interface RunOptions {
  modelId?: string | null;
  locale?: 'fa' | 'en';
  /** For assist runs: what the invoker may let the assistant see / do. */
  access?: { level: 'none' | 'mention' | 'context'; adminAssist: boolean };
  regenerate?: boolean;
  [k: string]: unknown;
}

export const TERMINAL: RunStatus[] = ['completed', 'failed', 'cancelled'];
export const isTerminal = (s: RunStatus) => TERMINAL.includes(s);

export const getRun = (env: Env, id: string) => first<RunRow>(env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(id));

export async function createRun(
  env: Env,
  r: { userId: string; kind: RunRow['kind']; agentId: string; goal: string; conversationId?: string | null; threadId?: string | null; triggerMessageId?: string | null; resultMessageId?: string | null; modelId?: string | null; options?: RunOptions },
): Promise<RunRow> {
  const id = newId(ID_PREFIX.run);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO runs (id, user_id, kind, agent_id, status, goal, conversation_id, thread_id, trigger_message_id, result_message_id, model_id, options, created_at, heartbeat_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, r.userId, r.kind, r.agentId, truncate(r.goal, 2000), r.conversationId ?? null, r.threadId ?? null, r.triggerMessageId ?? null, r.resultMessageId ?? null, r.modelId ?? null, r.options ? JSON.stringify(r.options) : null, now, now)
    .run();
  return (await getRun(env, id))!;
}

export const runOptions = (run: RunRow): RunOptions => safeJsonParse<RunOptions>(run.options) ?? {};

export async function patchRun(env: Env, id: string, patch: Partial<Record<keyof RunRow, unknown>>): Promise<void> {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  await env.DB.prepare(`UPDATE runs SET ${sets} WHERE id = ?`)
    .bind(...keys.map((k) => (patch as Record<string, unknown>)[k] ?? null), id)
    .run();
}

/* ------------------------------------------------------------------------------------------------ steps */

export const getSteps = (env: Env, runId: string) => all<StepRow>(env.DB.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx').bind(runId));

export async function insertSteps(env: Env, runId: string, steps: { title: string; tool: string; args?: unknown; risk: ToolRisk }[], startIdx = 0): Promise<StepRow[]> {
  if (steps.length === 0) return [];
  await batch(
    env.DB,
    steps.map((s, i) =>
      env.DB.prepare('INSERT INTO run_steps (id, run_id, idx, title, tool, args, risk) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
        newId(ID_PREFIX.step),
        runId,
        startIdx + i,
        truncate(s.title, 200),
        s.tool,
        s.args === undefined ? null : JSON.stringify(s.args),
        s.risk,
      ),
    ),
  );
  return getSteps(env, runId);
}

export async function patchStep(env: Env, id: string, patch: Partial<Record<keyof StepRow, unknown>>): Promise<void> {
  const keys = Object.keys(patch);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  await env.DB.prepare(`UPDATE run_steps SET ${sets} WHERE id = ?`)
    .bind(...keys.map((k) => (patch as Record<string, unknown>)[k] ?? null), id)
    .run();
}

/* ------------------------------------------------------------------------------------------------ events (operation log) */

export async function logEvent(env: Env, runId: string, type: string, data?: unknown, level: 'debug' | 'info' | 'warn' | 'error' = 'info', stepId?: string | null): Promise<void> {
  try {
    await env.DB.prepare('INSERT INTO run_events (run_id, step_id, ts, level, type, data) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(runId, stepId ?? null, Date.now(), level, type, data === undefined ? null : truncate(JSON.stringify(data), 4000, ''))
      .run();
  } catch (err) {
    console.error('run event log failed', String((err as Error)?.message ?? err));
  }
}

export interface EventRow {
  id: number;
  run_id: string;
  step_id: string | null;
  ts: number;
  level: string;
  type: string;
  data: string | null;
}

export const getEvents = (env: Env, runId: string, limit = 300) =>
  all<EventRow>(env.DB.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY id LIMIT ?').bind(runId, limit));

/* ------------------------------------------------------------------------------------------------ approvals */

export const getApproval = (env: Env, id: string) => first<ApprovalRow>(env.DB.prepare('SELECT * FROM approvals WHERE id = ?').bind(id));

export const getApprovalForStep = (env: Env, stepId: string) =>
  first<ApprovalRow>(env.DB.prepare('SELECT * FROM approvals WHERE step_id = ?').bind(stepId));

export const approvalsForRun = (env: Env, runId: string) =>
  all<ApprovalRow>(env.DB.prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at').bind(runId));

export function approvalToDto(a: ApprovalRow): ApprovalDto {
  return {
    id: a.id,
    runId: a.run_id,
    stepId: a.step_id,
    action: a.action,
    summary: a.summary,
    payload: safeJsonParse<Record<string, unknown>>(a.payload) ?? {},
    editable: safeJsonParse<string[]>(a.editable) ?? [],
    status: a.status,
    createdAt: a.created_at,
    expiresAt: a.expires_at,
  };
}

/* ------------------------------------------------------------------------------------------------ DTOs */

export function stepToDto(s: StepRow): RunStepDto {
  const output = safeJsonParse<{ text?: string; data?: unknown; action?: RunStepDto['action'] }>(s.output);
  return {
    id: s.id,
    idx: s.idx,
    title: s.title,
    tool: s.tool,
    status: s.status,
    risk: s.risk,
    attempts: s.attempts,
    args: safeJsonParse(s.args),
    resolvedArgs: safeJsonParse(s.resolved_args),
    output: output ? { text: output.text, data: output.data } : null,
    error: s.error,
    errorCode: s.error_code,
    verified: !!s.verified,
    startedAt: s.started_at,
    finishedAt: s.finished_at,
    action: output?.action ?? null,
  };
}

export async function runToDto(env: Env, run: RunRow): Promise<RunDto> {
  const [steps, approvals] = await Promise.all([getSteps(env, run.id), approvalsForRun(env, run.id)]);
  const plan = safeJsonParse<{ agent?: string; summary?: string }>(run.plan);
  return {
    id: run.id,
    kind: run.kind,
    agentId: run.agent_id,
    resolvedAgentId: plan?.agent ?? null,
    status: run.status,
    goal: run.goal,
    modelId: run.model_id,
    threadId: run.thread_id,
    conversationId: run.conversation_id,
    resultMessageId: run.result_message_id,
    error: run.error,
    errorCode: run.error_code,
    createdAt: run.created_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    steps: steps.map(stepToDto),
    approvals: approvals.map(approvalToDto),
    planSummary: plan?.summary ?? null,
  };
}

/** Batch variant for lists: two queries regardless of how many runs there are. */
export async function runsToDtos(env: Env, runs: RunRow[]): Promise<RunDto[]> {
  if (runs.length === 0) return [];
  const ph = runs.map(() => '?').join(',');
  const ids = runs.map((r) => r.id);
  const [steps, approvals] = await Promise.all([
    all<StepRow>(env.DB.prepare(`SELECT * FROM run_steps WHERE run_id IN (${ph}) ORDER BY run_id, idx`).bind(...ids)),
    all<ApprovalRow>(env.DB.prepare(`SELECT * FROM approvals WHERE run_id IN (${ph}) ORDER BY created_at`).bind(...ids)),
  ]);
  return runs.map((run) => {
    const plan = safeJsonParse<{ agent?: string; summary?: string }>(run.plan);
    return {
      id: run.id,
      kind: run.kind,
      agentId: run.agent_id,
      resolvedAgentId: plan?.agent ?? null,
      status: run.status,
      goal: run.goal,
      modelId: run.model_id,
      threadId: run.thread_id,
      conversationId: run.conversation_id,
      resultMessageId: run.result_message_id,
      error: run.error,
      errorCode: run.error_code,
      createdAt: run.created_at,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      steps: steps.filter((s) => s.run_id === run.id).map(stepToDto),
      approvals: approvals.filter((a) => a.run_id === run.id).map(approvalToDto),
      planSummary: plan?.summary ?? null,
    };
  });
}

/** Who receives run progress events (steps, approvals, status): always the invoking user. */
export async function publishRun(env: Env, run: RunRow): Promise<void> {
  const dto = await runToDto(env, run);
  await publishToUsers(env, [run.user_id], { type: 'run.updated', run: dto });
}
