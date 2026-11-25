import type { Locale, RunStepDto, ToolRisk } from '@aminchat/shared';
import type { z } from 'zod';
import type { AiClient, ChatRequest, ChatOutcome } from '../../ai/client';
import type { Env } from '../../env';
import type { RunRow, StepRow } from '../../services/runs';

export interface RunUser {
  id: string;
  username: string;
  displayName: string;
  locale: Locale;
  timezone: string;
  role: 'user' | 'admin';
}

export interface ToolContext {
  env: Env;
  user: RunUser;
  run: RunRow;
  step: StepRow;
  ai: AiClient;
  signal: AbortSignal;
  /** Injectable for tests; defaults to the global fetch. */
  fetch: typeof fetch;
  /** Model call that counts against the run's LLM-call budget. */
  chat(req: Omit<ChatRequest, 'userId' | 'runId' | 'signal'>): Promise<ChatOutcome>;
}

export interface ToolResult {
  /** Text shown to the user and fed to later steps / the final answer. */
  text: string;
  data?: unknown;
  /** True only when the tool re-read the state and confirmed the effect. */
  verified?: boolean;
  /** Files created by the tool that should be attached to the assistant's reply. */
  generatedFileIds?: string[];
  /** A pointer the client may follow (open a chat). Stored with the step; the server changes nothing because of it. */
  action?: RunStepDto['action'];
}

export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly opts: { retryable?: boolean; action?: RunStepDto['action'] } = {},
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export type Availability = { ok: true } | { ok: false; reason: string };

export interface PreparedApproval<A> {
  args: A;
  /** One line shown on the approval card. */
  summary: string;
  /** Extra read-only context shown next to the editable payload. */
  context?: Record<string, unknown>;
}

export interface ToolDef<A = any> {
  id: string;
  title: { fa: string; en: string };
  /** English description shown to the planner. */
  description: string;
  /** Compact argument description shown to the planner. */
  argsHint: string;
  risk: ToolRisk;
  schema: z.ZodType<A>;
  /** Arguments the user may edit on the approval card. */
  editable?: readonly string[];
  /** Wall-clock limit for one attempt (default RUN_LIMITS.stepTimeoutMs). */
  timeoutMs?: number;
  /** Run kinds in which the tool may be used (default: chat + task). */
  runKinds?: readonly RunRow['kind'][];
  /** Live check (per user): a tool the user switched off or that is not configured is never offered to the planner. */
  available?(env: Env, userId: string): Promise<Availability>;
  /** For sensitive tools: validate preconditions BEFORE asking the user, and describe what will happen. */
  prepare?(ctx: ToolContext, args: A): Promise<PreparedApproval<A>>;
  run(ctx: ToolContext, args: A): Promise<ToolResult>;
}

export const DEFAULT_RUN_KINDS: readonly RunRow['kind'][] = ['chat', 'task'];

export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}
