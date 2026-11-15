import type { ApprovalDto, RunDto, RunStatus, RunStepDto, StepStatus } from '@aminchat/shared';
import type { Key } from './i18n';

/** The seven live task states shown to the user (Persian: در انتظار / در حال برنامه‌ریزی / نیازمند تأیید / در حال اجرا / تکمیل‌شده / ناموفق / لغوشده). */
export const RUN_STATUS_KEY: Record<RunStatus, Key> = {
  pending: 'status.pending',
  planning: 'status.planning',
  awaiting_approval: 'status.awaiting_approval',
  running: 'status.running',
  completed: 'status.completed',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
};

export const STEP_STATUS_KEY: Record<StepStatus, Key> = {
  pending: 'status.pending',
  running: 'status.running',
  awaiting_approval: 'status.awaiting_approval',
  completed: 'status.completed',
  failed: 'status.failed',
  skipped: 'status.skipped',
  cancelled: 'status.cancelled',
};

export const isTerminal = (s: RunStatus): boolean => s === 'completed' || s === 'failed' || s === 'cancelled';
export const isActiveRun = (r: Pick<RunDto, 'status'> | null | undefined): boolean => !!r && !isTerminal(r.status);

export type Tone = 'neutral' | 'info' | 'warn' | 'ok' | 'bad';
export function statusTone(s: RunStatus | StepStatus): Tone {
  switch (s) {
    case 'completed':
      return 'ok';
    case 'failed':
      return 'bad';
    case 'awaiting_approval':
      return 'warn';
    case 'running':
    case 'planning':
      return 'info';
    default:
      return 'neutral';
  }
}

export function pendingApprovals(run: RunDto | null | undefined): ApprovalDto[] {
  return (run?.approvals ?? []).filter((a) => a.status === 'pending');
}

/** Replace/insert one step into a run (keeps steps ordered by their position). */
export function mergeStep(run: RunDto, step: RunStepDto): RunDto {
  const exists = run.steps.some((s) => s.id === step.id);
  const steps = exists ? run.steps.map((s) => (s.id === step.id ? step : s)) : [...run.steps, step];
  return { ...run, steps };
}

export function mergeApproval(run: RunDto, approval: ApprovalDto): RunDto {
  const exists = run.approvals.some((a) => a.id === approval.id);
  const approvals = exists ? run.approvals.map((a) => (a.id === approval.id ? approval : a)) : [...run.approvals, approval];
  return { ...run, approvals };
}

const RANK: Record<RunStatus, number> = { pending: 0, planning: 1, running: 2, awaiting_approval: 2, completed: 3, failed: 3, cancelled: 3 };

/**
 * Runs only move forward. A live event and an HTTP response can arrive in either order, so a late, stale snapshot
 * ("pending" from the POST response after the socket already said "running", or anything after "completed") is ignored.
 */
export function newerRun(prev: RunDto | undefined, next: RunDto): RunDto {
  if (!prev) return next;
  if (RANK[next.status] < RANK[prev.status]) return prev;
  return { ...next, steps: next.steps.length >= prev.steps.length ? next.steps : prev.steps, approvals: next.approvals.length >= prev.approvals.length ? next.approvals : prev.approvals };
}
