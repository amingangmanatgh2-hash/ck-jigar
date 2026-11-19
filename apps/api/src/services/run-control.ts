import type { Env } from '../env';
import { notFound } from '../lib/errors';
import { getRun, isTerminal } from './runs';

export const coordinatorFor = (env: Env, runId: string) => env.RUN_COORDINATOR.get(env.RUN_COORDINATOR.idFromName(runId));

/** Hands a freshly created run to its Durable Object coordinator, which executes it from an alarm. */
export async function startRun(env: Env, runId: string): Promise<void> {
  await coordinatorFor(env, runId).start(runId);
}

/** Continues a parked run (after an approval decision) or a run that stopped heart-beating. */
export async function resumeRun(env: Env, runId: string): Promise<void> {
  await coordinatorFor(env, runId).resume(runId);
}

/** Cancels a run of the given user: marks it, aborts in-flight model/tool calls, and lets the executor wrap up. */
export async function cancelRun(env: Env, userId: string, runId: string): Promise<void> {
  const run = await getRun(env, runId);
  if (!run || run.user_id !== userId) throw notFound('Run not found', 'RUN_NOT_FOUND');
  if (isTerminal(run.status)) return;
  await env.DB.prepare('UPDATE runs SET cancel_requested = 1 WHERE id = ?').bind(runId).run();
  await coordinatorFor(env, runId).cancel(runId);
}
