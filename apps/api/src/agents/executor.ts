import { stripAiMention, type MessageMeta, type RunStatus } from '@aminchat/shared';
import { AiClient, type ChatMessage, type ChatOutcome, type ChatRequest } from '../ai/client';
import { AI_CONTEXT, APPROVAL_TTL_MS, RUN_LIMITS } from '../config/limits';
import { all, first } from '../db/helpers';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { ID_PREFIX, newId } from '../lib/ids';
import { publishToUsers } from '../lib/realtime';
import { clipForLog, firstLine, safeJsonParse, truncate } from '../lib/text';
import { computeAccess, getConversation, getMember, listMemberIds } from '../services/conversations';
import { buildAssistContext, buildThreadContext, type BuiltContext } from '../services/context';
import type { FileRow } from '../services/dto';
import { finalizeAssistantMessage, setAssistantWaiting } from '../services/ai-chat';
import { memoryContextBlock } from '../services/memory';
import { getMessageRow, hydrateMessages } from '../services/messages';
import {
  getApprovalForStep,
  getRun,
  getSteps,
  insertSteps,
  isTerminal,
  logEvent,
  patchRun,
  patchStep,
  publishRun,
  runOptions,
  approvalToDto,
  stepToDto,
  type ApprovalRow,
  type RunRow,
  type StepRow,
} from '../services/runs';
import { getThreadRow, touchThread, type ThreadRow } from '../services/threads';
import { payloadHash, splitPayload } from './approvals';
import { t } from './i18n';
import { deriveArgs, heuristicAgent, planSteps, resolveTemplates, routeAgent, type ChatFn, type PriorStep } from './planner';
import { assistSystemPrompt, systemPrompt, type PromptUser } from './prompts';
import { AGENTS, isConcreteAgent, type AgentDef } from './registry';
import { getTool, hasActionTools, toolsFor } from './tools';
import { ToolError, type RunUser, type ToolContext, type ToolDef, type ToolResult } from './tools/types';

export interface ExecDeps {
  fetch?: typeof fetch;
}

class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

class RunFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RunFailure';
  }
}

type StepOutcome = 'done' | 'parked' | 'failed' | 'declined';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const backoffMs = (attempt: number) => Math.min(4000, 400 * 3 ** (attempt - 1));
const OUTPUT_MAX = 8000;

export async function loadRunUser(env: Env, userId: string): Promise<RunUser | null> {
  const row = await first<{ id: string; username: string; display_name: string; role: 'user' | 'admin'; locale: string; timezone: string; disabled_at: number | null }>(
    env.DB.prepare('SELECT id, username, display_name, role, locale, timezone, disabled_at FROM users WHERE id = ?').bind(userId),
  );
  if (!row || row.disabled_at) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role, locale: row.locale === 'en' ? 'en' : 'fa', timezone: row.timezone || 'UTC' };
}

/** Runs (or continues) a run to its next resting point: a terminal status, or `awaiting_approval`. Never throws. */
export async function executeRun(env: Env, runId: string, signal: AbortSignal, deps: ExecDeps = {}): Promise<void> {
  const run = await getRun(env, runId);
  if (!run || isTerminal(run.status)) return;
  const user = await loadRunUser(env, run.user_id);
  if (!user) {
    await patchRun(env, run.id, { status: 'failed', error: 'The account is not available', error_code: 'USER_UNAVAILABLE', finished_at: Date.now() });
    return;
  }
  const thread = run.thread_id ? await getThreadRow(env, run.thread_id) : null;
  const exec = new RunExecutor(env, new AiClient(env), signal, user, run, thread, deps);
  await exec.execute();
}

/** Finishes a run that is not currently being executed (parked for approval, or never picked up) as cancelled. */
export async function settleCancelled(env: Env, runId: string): Promise<void> {
  const run = await getRun(env, runId);
  if (!run || isTerminal(run.status)) return;
  const user = await loadRunUser(env, run.user_id);
  const thread = run.thread_id ? await getThreadRow(env, run.thread_id) : null;
  if (!user) {
    await patchRun(env, run.id, { status: 'cancelled', finished_at: Date.now() });
    return;
  }
  const exec = new RunExecutor(env, new AiClient(env), new AbortController().signal, user, run, thread, {});
  await exec.finishCancelled();
}

/** Fails a run that is not being executed (for example one that stopped heart-beating too many times). */
export async function settleFailed(env: Env, runId: string, code: string, message: string): Promise<void> {
  const run = await getRun(env, runId);
  if (!run || isTerminal(run.status)) return;
  const user = await loadRunUser(env, run.user_id);
  const thread = run.thread_id ? await getThreadRow(env, run.thread_id) : null;
  if (!user) {
    await patchRun(env, run.id, { status: 'failed', error: message, error_code: code, finished_at: Date.now() });
    return;
  }
  const exec = new RunExecutor(env, new AiClient(env), new AbortController().signal, user, run, thread, {});
  await exec.fail(code, message);
}

class RunExecutor {
  private llmCalls = 0;
  private partial = '';
  private deadline = Date.now() + RUN_LIMITS.maxRunMs;
  private agent: AgentDef = AGENTS.general;
  private tools: ToolDef[] = [];
  private unavailable: { id: string; reason: string }[] = [];
  private built: BuiltContext | null = null;
  private userText = '';
  private attachmentsList = '';
  private audienceIds: string[] | null = null;
  private opts: ReturnType<typeof runOptions>;
  private generatedFileIds: string[] = [];

  constructor(
    private readonly env: Env,
    private readonly ai: AiClient,
    private readonly signal: AbortSignal,
    private readonly user: RunUser,
    private run: RunRow,
    private readonly thread: ThreadRow | null,
    private readonly deps: ExecDeps,
  ) {
    this.opts = runOptions(run);
  }

  private get promptUser(): PromptUser {
    return { displayName: this.user.displayName, locale: this.user.locale, timezone: this.user.timezone };
  }

  /* ------------------------------------------------------------------------------------------------ infrastructure */

  private async refresh(): Promise<RunRow> {
    this.run = (await getRun(this.env, this.run.id)) ?? this.run;
    return this.run;
  }

  private async setStatus(status: RunStatus, extra: Partial<Record<keyof RunRow, unknown>> = {}): Promise<void> {
    await patchRun(this.env, this.run.id, { status, ...extra });
    await this.refresh();
    await publishRun(this.env, this.run);
  }

  /** Heart-beat + cancellation/deadline check. Called between every phase. */
  private async checkpoint(): Promise<void> {
    if (this.signal.aborted) throw new CancelledError();
    const row = await first<{ cancel_requested: number }>(
      this.env.DB.prepare('UPDATE runs SET heartbeat_at = ? WHERE id = ? RETURNING cancel_requested').bind(Date.now(), this.run.id),
    );
    if (row?.cancel_requested) throw new CancelledError();
    if (Date.now() > this.deadline) throw new RunFailure('RUN_TIMEOUT', 'The task took too long and was stopped.');
  }

  private readonly chat: ChatFn = async (req: Omit<ChatRequest, 'userId' | 'runId' | 'signal'>): Promise<ChatOutcome> => {
    await this.checkpoint();
    if (++this.llmCalls > RUN_LIMITS.maxLlmCalls) throw new RunFailure('RUN_LLM_BUDGET', 'The task needed more model calls than allowed.');
    const out = await this.ai.chat({ ...req, userId: this.user.id, runId: this.run.id, signal: this.signal });
    await logEvent(this.env, this.run.id, 'llm', { purpose: req.purpose, model: out.modelId, fallbackFrom: out.fallbackFrom, tokens: out.usage.input + out.usage.output, ms: out.latencyMs });
    return out;
  };

  private async audience(): Promise<string[]> {
    if (this.audienceIds) return this.audienceIds;
    this.audienceIds = this.run.kind === 'assist' && this.run.conversation_id ? await listMemberIds(this.env, this.run.conversation_id) : [this.user.id];
    return this.audienceIds;
  }

  /* ------------------------------------------------------------------------------------------------ main flow */

  async execute(): Promise<void> {
    try {
      await this.main();
    } catch (err) {
      await this.handleFatal(err);
    }
  }

  private async main(): Promise<void> {
    await this.checkpoint();
    if (this.run.status === 'pending' || !this.run.started_at) {
      await this.setStatus('planning', { started_at: this.run.started_at ?? Date.now() });
      await logEvent(this.env, this.run.id, 'run.started', { kind: this.run.kind, agent: this.run.agent_id });
    }

    await this.assertStillAllowed();
    this.built = await this.buildContext();
    await this.loadRequestInfo();

    // 1. which agent?
    const planJson = safeJsonParse<{ agent?: string; summary?: string; deferred?: number[] }>(this.run.plan) ?? {};
    let agentId = planJson.agent ?? this.run.agent_id;
    if (agentId === 'auto') {
      const r = await this.routeAuto();
      agentId = r.agent;
      planJson.agent = agentId;
      await patchRun(this.env, this.run.id, { plan: JSON.stringify(planJson) });
      await logEvent(this.env, this.run.id, 'route', { agent: agentId, reason: r.reason, viaLlm: r.viaLlm });
    }
    this.agent = isConcreteAgent(agentId) ? AGENTS[agentId] : AGENTS.general;
    if (this.run.kind === 'assist') this.agent = AGENTS.general;

    // 2. tools of this agent that are usable right now
    const toolSet = await this.toolSet();
    this.tools = toolSet.tools;
    this.unavailable = toolSet.unavailable;

    // 3. plan (only agents with action tools, and only when a plan does not exist yet)
    let steps = await getSteps(this.env, this.run.id);
    if (steps.length === 0 && !planJson.summary && hasActionTools(this.tools) && this.shouldPlan()) {
      const plan = await planSteps(this.chat, {
        agent: this.agent,
        tools: this.tools,
        user: this.promptUser,
        text: this.userText,
        recent: this.recentText(),
        attachments: this.attachmentsList,
        assist: this.run.kind === 'assist',
      }).catch(async (err) => {
        if (err instanceof CancelledError || err instanceof RunFailure || err instanceof AppError) throw err;
        await logEvent(this.env, this.run.id, 'plan.invalid', { error: String((err as Error)?.message ?? err) }, 'warn');
        return null; // an unusable plan must not block an answer: fall back to a plain reply
      });
      planJson.summary = plan?.summary ?? '';
      planJson.deferred = plan?.steps.flatMap((s, i) => (s.deferred ? [i] : [])) ?? [];
      await patchRun(this.env, this.run.id, { plan: JSON.stringify(planJson) });
      if (plan && plan.steps.length > 0) {
        steps = await insertSteps(
          this.env,
          this.run.id,
          plan.steps.map((s) => ({ title: s.title, tool: s.tool, args: s.args, risk: getTool(s.tool)?.risk ?? 'read' })),
        );
        await logEvent(this.env, this.run.id, 'plan', { summary: plan.summary, steps: plan.steps.map((s) => ({ tool: s.tool, title: s.title })) });
        await this.refresh();
        await publishRun(this.env, this.run);
      } else {
        await logEvent(this.env, this.run.id, 'plan', { summary: plan?.summary ?? '', steps: [] });
      }
    }

    // 4. execute the steps
    let failed = false;
    if (steps.length > 0) {
      const outcome = await this.executeSteps(steps, planJson.deferred ?? []);
      if (outcome === 'parked') return;
      failed = outcome === 'failed';
    }

    // 5. final answer
    await this.checkpoint();
    await this.finish(failed);
  }

  private shouldPlan(): boolean {
    if (this.run.kind === 'assist') {
      // Shared chats only plan for admin assistance (polls / announcements) and only when the request looks like it.
      return !!this.opts.access?.adminAssist && /poll|announce|نظرسنجی|اطلاعیه|اعلام|رأی|راي|vote/i.test(this.userText);
    }
    return this.userText.trim().length > 0 || (this.attachmentsList.length > 0);
  }

  private async assertStillAllowed(): Promise<void> {
    if (this.run.kind !== 'assist' || !this.run.conversation_id) return;
    const [conv, member] = await Promise.all([getConversation(this.env, this.run.conversation_id), getMember(this.env, this.run.conversation_id, this.user.id)]);
    if (!conv || !member) throw new RunFailure('AI_ACCESS_REVOKED', 'You are no longer a member of this chat.');
    const decision = await computeAccess(this.env, conv, member);
    if (!decision.allowed) throw new RunFailure('AI_ACCESS_REVOKED', 'AI access for this chat was turned off before the answer could be prepared.');
    this.opts = { ...this.opts, access: { level: decision.level, adminAssist: decision.adminAssist } };
  }

  private async buildContext(): Promise<BuiltContext> {
    if (this.run.kind === 'assist') {
      const conv = (await getConversation(this.env, this.run.conversation_id!))!;
      const trigger = await getMessageRow(this.env, this.run.trigger_message_id!);
      if (!trigger) throw new RunFailure('TRIGGER_MISSING', 'The message that mentioned AMIN AI no longer exists.');
      const level = this.opts.access?.level === 'context' ? 'context' : 'mention';
      const b = await buildAssistContext(this.env, this.ai, {
        conv, trigger, level, invokerId: this.user.id, invokerName: this.user.displayName, tz: this.user.timezone,
        budgetTokens: AI_CONTEXT.assistTokens, maxMessages: AI_CONTEXT.assistMessages, runId: this.run.id, signal: this.signal,
      });
      await logEvent(this.env, this.run.id, 'context', { level, messages: b.transcriptCount, vision: b.needsVision });
      return b;
    }
    if (!this.run.thread_id || !this.run.trigger_message_id) throw new RunFailure('THREAD_MISSING', 'This task has no conversation.');
    const b = await buildThreadContext(this.env, this.ai, {
      userId: this.user.id, tz: this.user.timezone, threadId: this.run.thread_id, triggerMessageId: this.run.trigger_message_id,
      budgetTokens: AI_CONTEXT.historyTokens, runId: this.run.id, signal: this.signal,
    });
    await logEvent(this.env, this.run.id, 'context', { messages: b.messages.length, vision: b.needsVision });
    return b;
  }

  /** The raw request text (without expanded attachments) and the list of attached files, for the router and planner. */
  private async loadRequestInfo(): Promise<void> {
    const trigger = this.run.trigger_message_id ? await getMessageRow(this.env, this.run.trigger_message_id) : null;
    const meta = safeJsonParse<MessageMeta>(trigger?.meta);
    let text = trigger?.body ?? '';
    if (this.run.kind === 'assist') text = stripAiMention(text);
    if (meta?.shared) text += `\n(The user shared ${meta.shared.count} message(s) from ${meta.shared.conversationTitle ? `"${meta.shared.conversationTitle}"` : 'another chat'}.)`;
    this.userText = text.trim() || this.run.goal;
    if (trigger) {
      const files = await all<FileRow>(this.env.DB.prepare('SELECT * FROM files WHERE message_id = ? AND deleted_at IS NULL ORDER BY created_at').bind(trigger.id));
      this.attachmentsList = files.map((f) => `- ${f.name} (${f.kind}) id: ${f.id}`).join('\n');
    }
  }

  private recentText(): string {
    if (!this.built) return '';
    const msgs = this.built.messages.slice(0, -1).slice(-4);
    const lines = msgs.map((m) => {
      const text = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ');
      return `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${truncate(text.replace(/\s+/g, ' '), 400)}`;
    });
    return truncate(lines.join('\n'), AI_CONTEXT.routerRecentChars);
  }

  private async routeAuto(): Promise<{ agent: string; reason: string; viaLlm: boolean }> {
    if (this.run.kind === 'assist') return { agent: 'general', reason: 'shared chat', viaLlm: false };
    if (this.userText.trim().length < 12 && !this.attachmentsList) {
      // "open Amin's chat" can be short: a quick request is recognised by its keywords, anything else short is just conversation.
      return heuristicAgent(this.userText) === 'quick' ? { agent: 'quick', reason: 'keyword routing', viaLlm: false } : { agent: 'general', reason: 'short message', viaLlm: false };
    }
    return routeAgent(this.chat, { text: this.userText, hasAttachments: !!this.attachmentsList, recent: this.recentText() });
  }

  private async toolSet() {
    if (this.run.kind === 'assist') {
      const allow = this.opts.access?.adminAssist ? ['poll_create', 'announce_post'] : [];
      return toolsFor(this.env, this.user.id, 'general', 'assist', allow);
    }
    return toolsFor(this.env, this.user.id, this.agent.id, this.run.kind);
  }

  /* ------------------------------------------------------------------------------------------------ steps */

  private async executeSteps(steps: StepRow[], deferred: number[]): Promise<'ok' | 'failed' | 'parked'> {
    const outputs = new Map<number, string>();
    const prior: PriorStep[] = [];
    let failed = false;
    /** The user declined (or let expire) an action: the rest of the plan is not carried out, but this is not an error. */
    let halted = false;
    for (const step of steps) {
      if (step.status === 'completed') {
        const out = safeJsonParse<{ text?: string }>(step.output);
        outputs.set(step.idx + 1, out?.text ?? '');
        prior.push({ idx: step.idx, title: step.title, tool: step.tool, text: out?.text ?? '' });
        continue;
      }
      if (step.status === 'failed') {
        failed = true;
        continue;
      }
      if (step.status === 'skipped' || step.status === 'cancelled') continue;
      if (failed || halted) {
        await this.markStep(step, 'skipped', { error: t(this.user.locale).skipped, error_code: 'SKIPPED' });
        continue;
      }
      await this.checkpoint();
      if (this.run.status !== 'running') {
        await this.setStatus('running');
        if (this.run.result_message_id) await setAssistantWaiting(this.env, this.run.result_message_id, null);
      }
      const outcome = await this.runStep(step, outputs, prior, deferred.includes(step.idx));
      if (outcome === 'parked') return 'parked';
      if (outcome === 'declined') {
        halted = true;
        continue;
      }
      if (outcome === 'done') {
        const fresh = (await getSteps(this.env, this.run.id)).find((s) => s.id === step.id)!;
        const out = safeJsonParse<{ text?: string }>(fresh.output);
        outputs.set(step.idx + 1, out?.text ?? '');
        prior.push({ idx: step.idx, title: step.title, tool: step.tool, text: out?.text ?? '' });
      } else {
        failed = true; // fail-fast: later steps usually depend on this one
      }
    }
    return failed ? 'failed' : 'ok';
  }

  private async markStep(step: StepRow, status: StepRow['status'], patch: Partial<Record<keyof StepRow, unknown>> = {}): Promise<void> {
    await patchStep(this.env, step.id, { status, finished_at: Date.now(), ...patch });
    const fresh = (await getSteps(this.env, this.run.id)).find((s) => s.id === step.id);
    if (fresh) await publishToUsers(this.env, [this.user.id], { type: 'run.step', runId: this.run.id, step: stepToDto(fresh) });
  }

  private async emitStep(stepId: string): Promise<void> {
    const fresh = (await getSteps(this.env, this.run.id)).find((s) => s.id === stepId);
    if (fresh) await publishToUsers(this.env, [this.user.id], { type: 'run.step', runId: this.run.id, step: stepToDto(fresh) });
  }

  private toolContext(step: StepRow, signal: AbortSignal): ToolContext {
    return {
      env: this.env,
      user: this.user,
      run: this.run,
      step,
      ai: this.ai,
      signal,
      fetch: this.deps.fetch ?? fetch,
      chat: (req) => this.chat(req),
    };
  }

  private async failStep(step: StepRow, code: string, message: string, action?: ToolError['opts']['action']): Promise<StepOutcome> {
    await this.markStep(step, 'failed', {
      error: truncate(message, 600),
      error_code: code,
      output: action ? JSON.stringify({ text: '', action }) : null,
    });
    await logEvent(this.env, this.run.id, 'step.failed', { tool: step.tool, code, message: truncate(message, 400) }, 'error', step.id);
    return 'failed';
  }

  private async runStep(step: StepRow, outputs: Map<number, string>, prior: PriorStep[], deferred: boolean): Promise<StepOutcome> {
    const tool = getTool(step.tool);
    const avail = tool && this.tools.find((x) => x.id === tool.id);
    if (!tool || !avail) {
      const reason = this.unavailable.find((u) => u.id === step.tool)?.reason;
      return this.failStep(step, 'TOOL_UNAVAILABLE', reason ? `The tool "${step.tool}" is not available: ${reason}` : `The tool "${step.tool}" is not available to this agent.`);
    }

    const approval = tool.risk === 'sensitive' ? await getApprovalForStep(this.env, step.id) : null;
    let args: unknown;

    if (approval) {
      const decided = await this.checkApproval(step, tool, approval);
      if (decided.kind !== 'approved') return decided.outcome;
      args = decided.args;
    } else {
      // resolve {{step.N.text}} references, derive deferred arguments, validate (with one LLM repair attempt)
      try {
        args = await this.resolveArgs(step, tool, outputs, prior, deferred);
      } catch (err) {
        if (err instanceof CancelledError || err instanceof RunFailure) throw err;
        const msg = err instanceof ToolError ? err.message : `The arguments for "${tool.id}" are invalid.`;
        return this.failStep(step, 'INVALID_ARGS', msg);
      }
      await patchStep(this.env, step.id, { resolved_args: JSON.stringify(args) });

      if (tool.risk === 'sensitive') return this.requestApproval(step, tool, args);
    }

    return this.executeWithRetry(step, tool, args);
  }

  private async resolveArgs(step: StepRow, tool: ToolDef, outputs: Map<number, string>, prior: PriorStep[], deferred: boolean): Promise<unknown> {
    const planned = safeJsonParse<Record<string, unknown>>(step.args) ?? {};
    let candidate: unknown = resolveTemplates(planned, outputs);
    const validate = (v: unknown) => tool.schema.safeParse(v);

    if (deferred) {
      candidate = await deriveArgs(this.chat, { tool, user: this.promptUser, request: this.userText, title: step.title, planned, previous: prior });
      await logEvent(this.env, this.run.id, 'args.derived', { tool: tool.id }, 'info', step.id);
    }
    let parsed = validate(candidate);
    if (!parsed.success && !deferred) {
      const issues = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ');
      await logEvent(this.env, this.run.id, 'args.invalid', { tool: tool.id, issues }, 'warn', step.id);
      candidate = await deriveArgs(this.chat, { tool, user: this.promptUser, request: this.userText, title: step.title, planned: candidate, previous: prior, issues });
      parsed = validate(candidate);
    }
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ');
      throw new ToolError('INVALID_ARGS', `Invalid arguments for "${tool.id}": ${issues}`);
    }
    return parsed.data;
  }

  /* ------------------------------------------------------------------------------------------------ approvals */

  private async requestApproval(step: StepRow, tool: ToolDef, args: unknown): Promise<StepOutcome> {
    let prepared;
    try {
      prepared = await tool.prepare!(this.toolContext(step, this.signal), args);
    } catch (err) {
      const te = toToolError(err);
      return this.failStep(step, te.code, te.message, te.opts.action);
    }
    const now = Date.now();
    const id = newId(ID_PREFIX.approval);
    const payload = { ...(prepared.args as Record<string, unknown>), _context: prepared.context ?? {} };
    const hash = await payloadHash(prepared.args);
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO approvals (id, run_id, step_id, user_id, action, summary, payload, payload_hash, editable, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
      .bind(id, this.run.id, step.id, this.user.id, tool.id, truncate(prepared.summary, 400), JSON.stringify(payload), hash, JSON.stringify(tool.editable ?? []), now, now + APPROVAL_TTL_MS)
      .run();
    const row = (await getApprovalForStep(this.env, step.id))!;
    await patchStep(this.env, step.id, { status: 'awaiting_approval', resolved_args: JSON.stringify(prepared.args) });
    await logEvent(this.env, this.run.id, 'approval.requested', { tool: tool.id, summary: prepared.summary, approvalId: row.id }, 'info', step.id);
    await this.setStatus('awaiting_approval');
    if (this.run.result_message_id) await setAssistantWaiting(this.env, this.run.result_message_id, 'approval');
    await publishToUsers(this.env, [this.user.id], { type: 'run.approval', approval: approvalToDto(row) });
    await this.emitStep(step.id);
    return 'parked';
  }

  private async checkApproval(
    step: StepRow,
    tool: ToolDef,
    approval: ApprovalRow,
  ): Promise<{ kind: 'approved'; args: unknown } | { kind: 'stop'; outcome: StepOutcome }> {
    const stop = (outcome: StepOutcome) => ({ kind: 'stop' as const, outcome });
    if (approval.status === 'pending') {
      if (approval.expires_at < Date.now()) {
        await this.env.DB.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), approval.id).run();
        await this.markStep(step, 'skipped', { error: t(this.user.locale).expired(approval.summary), error_code: 'EXPIRED' });
        await logEvent(this.env, this.run.id, 'approval.expired', { approvalId: approval.id }, 'warn', step.id);
        return stop('declined');
      }
      // Still waiting for the user (for example after a spurious resume): the run must visibly stay in "needs approval".
      if (this.run.status !== 'awaiting_approval') await this.setStatus('awaiting_approval');
      if (this.run.result_message_id) await setAssistantWaiting(this.env, this.run.result_message_id, 'approval');
      return stop('parked');
    }
    if (approval.status === 'rejected' || approval.status === 'expired') {
      await this.markStep(step, 'skipped', {
        error: approval.status === 'rejected' ? t(this.user.locale).declined(approval.summary) : t(this.user.locale).expired(approval.summary),
        error_code: approval.status === 'rejected' ? 'DECLINED' : 'EXPIRED',
      });
      return stop('declined');
    }
    // approved: the exact payload that was stored must still match its fingerprint, and must still be valid
    const { args } = splitPayload(safeJsonParse<Record<string, unknown>>(approval.payload) ?? {});
    if ((await payloadHash(args)) !== approval.payload_hash) {
      await logEvent(this.env, this.run.id, 'approval.tampered', { approvalId: approval.id }, 'error', step.id);
      await this.failStep(step, 'APPROVAL_MISMATCH', 'The approved action no longer matches what was approved, so it was not executed.');
      return stop('failed');
    }
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      await this.failStep(step, 'INVALID_ARGS', 'The approved arguments are not valid.');
      return stop('failed');
    }
    return { kind: 'approved', args: parsed.data };
  }

  /* ------------------------------------------------------------------------------------------------ tool execution */

  private async executeWithRetry(step: StepRow, tool: ToolDef, args: unknown): Promise<StepOutcome> {
    const timeoutMs = tool.timeoutMs ?? RUN_LIMITS.stepTimeoutMs;
    let lastError: ToolError | null = null;
    const already = step.attempts;
    for (let attempt = already + 1; attempt <= Math.max(RUN_LIMITS.stepMaxAttempts, already + 1); attempt++) {
      await this.checkpoint();
      await patchStep(this.env, step.id, { status: 'running', attempts: attempt, started_at: step.started_at ?? Date.now(), error: null, error_code: null });
      await this.emitStep(step.id);
      await logEvent(this.env, this.run.id, 'step.started', { tool: tool.id, attempt }, 'info', step.id);

      const ctl = new AbortController();
      const onAbort = () => ctl.abort(this.signal.reason ?? new Error('cancelled'));
      this.signal.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctl.abort(new Error('step timeout'));
      }, timeoutMs);
      try {
        const fresh = (await getSteps(this.env, this.run.id)).find((s) => s.id === step.id) ?? step;
        const result = await raceAbort(tool.run(this.toolContext(fresh, ctl.signal), args), ctl.signal);
        // Hard rule: a tool that changes something must confirm the effect, otherwise it counts as NOT done.
        if (tool.risk !== 'read' && !result.verified) throw new ToolError('NOT_VERIFIED', 'The action could not be confirmed, so it is not reported as done.');
        await this.completeStep(step, result);
        await logEvent(this.env, this.run.id, 'step.completed', { tool: tool.id, verified: !!result.verified, attempt }, 'info', step.id);
        return 'done';
      } catch (err) {
        if (this.signal.aborted || this.run.cancel_requested) throw new CancelledError();
        const te = timedOut ? new ToolError('TIMEOUT', `The step did not finish within ${Math.round(timeoutMs / 1000)} seconds.`, { retryable: true }) : toToolError(err);
        lastError = te;
        await logEvent(this.env, this.run.id, 'step.error', { tool: tool.id, attempt, code: te.code, message: truncate(te.message, 300), retryable: !!te.opts.retryable }, 'warn', step.id);
        if (te.opts.retryable && attempt < RUN_LIMITS.stepMaxAttempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        break;
      } finally {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', onAbort);
      }
    }
    const te = lastError ?? new ToolError('FAILED', 'The step failed.');
    return this.failStep(step, te.code, te.message, te.opts.action);
  }

  private async completeStep(step: StepRow, result: ToolResult): Promise<void> {
    if (result.generatedFileIds?.length) this.generatedFileIds.push(...result.generatedFileIds);
    const data = result.data === undefined ? undefined : safeJsonParse(truncate(JSON.stringify(result.data), 3000, ''));
    await this.markStep(step, 'completed', {
      output: JSON.stringify({ text: truncate(result.text, OUTPUT_MAX), ...(data === null || data === undefined ? {} : { data }), ...(result.action ? { action: result.action } : {}) }),
      verified: result.verified ? 1 : 0,
      error: null,
      error_code: null,
    });
  }

  /* ------------------------------------------------------------------------------------------------ final answer */

  private opsBlock(steps: StepRow[]): string {
    const lines = steps.map((s) => {
      const out = safeJsonParse<{ text?: string }>(s.output);
      if (s.status === 'completed') return `${s.idx + 1}. [COMPLETED${s.verified ? ', confirmed' : ''}] ${s.title} (${s.tool})\n   Result: ${truncate((out?.text ?? '').replace(/\n{3,}/g, '\n\n'), 2500)}`;
      if (s.status === 'failed') return `${s.idx + 1}. [FAILED] ${s.title} (${s.tool}) — ${s.error ?? 'error'}`;
      if (s.error_code === 'DECLINED') return `${s.idx + 1}. [NOT DONE — the user declined to approve it] ${s.title} (${s.tool})`;
      if (s.error_code === 'EXPIRED') return `${s.idx + 1}. [NOT DONE — approval expired] ${s.title} (${s.tool})`;
      return `${s.idx + 1}. [NOT DONE — ${s.status}] ${s.title} (${s.tool})`;
    });
    return [
      "Tool results for the user's latest request. They are authoritative and are the ONLY things that really happened:",
      ...lines,
      'Now write the final reply to the user, based strictly on these results. State clearly what was done, what failed and what was not done (and what the user can do next). ' +
        'Never claim an action succeeded unless its step is COMPLETED. Present lists and results clearly instead of pasting raw output. Do not mention step numbers or tool names unless useful.',
    ].join('\n');
  }

  private notDoneFooter(steps: StepRow[]): string {
    const loc = t(this.user.locale);
    const lines: string[] = [];
    for (const s of steps) {
      if (s.status === 'completed') continue;
      const tool = getTool(s.tool);
      if (!tool || tool.risk === 'read') continue; // reads that fail are explained in the answer itself
      if (s.error_code === 'DECLINED') lines.push(loc.declined(s.title));
      else if (s.error_code === 'EXPIRED') lines.push(loc.expired(s.title));
      else if (s.status === 'failed') lines.push(loc.stepFailed(s.title, s.error ?? ''));
      else lines.push(`⚠️ ${s.title}: ${loc.skipped}`);
    }
    return lines.join('\n');
  }

  private async resetBodyIfNeeded(): Promise<void> {
    const msgId = this.run.result_message_id;
    if (!msgId) return;
    const row = await first<{ body: string | null }>(this.env.DB.prepare('SELECT body FROM messages WHERE id = ?').bind(msgId));
    if (row?.body) {
      await this.env.DB.prepare("UPDATE messages SET body = NULL, status = 'streaming' WHERE id = ?").bind(msgId).run();
      const full = await getMessageRow(this.env, msgId);
      if (full) {
        const [dto] = await hydrateMessages(this.env, [full], this.user.id);
        await publishToUsers(this.env, await this.audience(), { type: 'message.updated', message: dto! });
      }
    }
  }

  private async finish(stepsFailed: boolean): Promise<void> {
    const steps = await getSteps(this.env, this.run.id);
    const built = this.built!;
    const loc = t(this.user.locale);
    const planJson = safeJsonParse<{ summary?: string }>(this.run.plan);

    let system: string;
    if (this.run.kind === 'assist') {
      const conv = (await getConversation(this.env, this.run.conversation_id!))!;
      system = assistSystemPrompt({
        user: this.promptUser,
        invokerName: this.user.displayName,
        conversationTitle: conv.title,
        kind: conv.type === 'group' ? 'group' : 'direct',
        level: this.opts.access?.level === 'context' ? 'context' : 'mention',
        extra: steps.length ? this.opsBlock(steps) : undefined,
      });
    } else {
      const memory = await memoryContextBlock(this.env, this.user.id, this.userText);
      const extraParts: string[] = [];
      if (steps.length) extraParts.push(this.opsBlock(steps));
      else if (planJson?.summary) extraParts.push('No tool was needed for this request: answer directly.');
      if (this.unavailable.length) extraParts.push(`These tools are not available right now (do not pretend to use them): ${this.unavailable.map((u) => `${u.id} (${u.reason})`).join('; ')}.`);
      system = systemPrompt({ agent: this.agent, user: this.promptUser, memory, extra: extraParts.join('\n\n') || undefined, toolsDisabledNote: false });
    }

    const messages: ChatMessage[] = [{ role: 'system', content: system }, ...built.messages];
    await this.resetBodyIfNeeded();
    this.partial = '';

    let outcome: ChatOutcome | null = null;
    let answerError: unknown = null;
    try {
      outcome = await this.streamAnswer(messages, built.needsVision);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      answerError = err;
    }

    const footer = this.notDoneFooter(steps);
    let body: string | null = outcome?.text ?? null;

    if (!body && steps.length > 0) {
      // The model could not write the final answer, but the operation log is still the truth: report it.
      body = [loc.answerFailed, ...steps.map((s) => `• ${s.title}: ${s.status === 'completed' ? '✓' : s.status === 'failed' ? `✗ ${s.error ?? ''}` : loc.skipped}`)].join('\n');
      await logEvent(this.env, this.run.id, 'answer.fallback', { error: String((answerError as Error)?.message ?? answerError) }, 'warn');
    } else if (!body && answerError) {
      throw answerError;
    }
    if (body && footer && outcome) body = `${body}\n\n${footer}`;

    const failedStep = steps.find((s) => s.status === 'failed');
    const declined = steps.some((s) => s.error_code === 'DECLINED' || s.error_code === 'EXPIRED');
    const runFailed = stepsFailed || !!failedStep;

    await finalizeAssistantMessage(this.env, this.run.result_message_id ?? '', {
      body,
      status: 'sent',
      ai: {
        agentId: this.agent.id,
        modelId: outcome?.modelId ?? null,
        runId: this.run.id,
        fallbackFrom: outcome?.fallbackFrom ?? null,
        usage: outcome ? { inputTokens: outcome.usage.input, outputTokens: outcome.usage.output, estimated: outcome.usage.estimated } : null,
        ...(this.run.kind === 'assist' ? { invokedBy: this.user.id } : {}),
        error: null,
      },
      fileIds: this.generatedFileIds,
      ownerId: this.user.id,
    });

    await patchRun(this.env, this.run.id, {
      result: truncate(body ?? '', 4000, ''),
      error: runFailed ? failedStep?.error ?? 'A step failed' : null,
      error_code: runFailed ? failedStep?.error_code ?? 'STEP_FAILED' : null,
    });
    await this.setStatus(runFailed ? 'failed' : 'completed', { finished_at: Date.now() });
    await logEvent(this.env, this.run.id, 'run.finished', { status: this.run.status, declined, llmCalls: this.llmCalls }, runFailed ? 'warn' : 'info');

    // best-effort extras that must never change the outcome of the run
    if (outcome) await this.afterAnswer(outcome.text).catch((err) => console.warn('post-answer task failed', String((err as Error)?.message ?? err)));
  }

  private async streamAnswer(messages: ChatMessage[], needsVision: boolean): Promise<ChatOutcome> {
    await this.checkpoint();
    if (++this.llmCalls > RUN_LIMITS.maxLlmCalls) throw new RunFailure('RUN_LLM_BUDGET', 'The task needed more model calls than allowed.');
    const recipients = await this.audience();
    const messageId = this.run.result_message_id;
    let buffer = '';
    let lastFlush = 0;
    let lastPersist = Date.now();
    let flushedLen = this.partial.length; // characters of the answer already published
    const flush = async () => {
      if (!buffer) return;
      const text = buffer;
      buffer = '';
      lastFlush = Date.now();
      const offset = flushedLen;
      flushedLen += text.length;
      await publishToUsers(this.env, recipients, { type: 'run.delta', runId: this.run.id, messageId, text, offset });
    };
    const role = this.run.kind === 'assist' ? 'chat' : this.agent.modelRole;
    const outcome = await this.ai.chatStream(
      {
        userId: this.user.id,
        runId: this.run.id,
        role,
        purpose: this.run.kind === 'assist' ? 'assist' : 'chat',
        messages,
        maxTokens: this.run.kind === 'assist' ? undefined : this.agent.maxAnswerTokens,
        modelId: this.run.model_id,
        needsVision,
        signal: this.signal,
      },
      async (text) => {
        this.partial += text;
        buffer += text;
        const now = Date.now();
        if (buffer.length >= 48 || now - lastFlush >= 150) await flush();
        if (now - lastPersist >= 2500) {
          lastPersist = now;
          if (messageId) await this.env.DB.prepare("UPDATE messages SET body = ? WHERE id = ? AND status = 'streaming'").bind(this.partial, messageId).run();
          await this.env.DB.prepare('UPDATE runs SET heartbeat_at = ? WHERE id = ?').bind(now, this.run.id).run();
        }
      },
    );
    await flush();
    await logEvent(this.env, this.run.id, 'answer', { model: outcome.modelId, fallbackFrom: outcome.fallbackFrom, tokens: outcome.usage.input + outcome.usage.output, ms: outcome.latencyMs });
    return outcome;
  }

  /** Auto title for new threads. Never throws. */
  private async afterAnswer(answer: string): Promise<void> {
    if (this.thread && !this.thread.title && this.run.kind !== 'assist') await this.generateTitle(answer);
  }

  private async generateTitle(answer: string): Promise<void> {
    const thread = this.thread!;
    const fallback = firstLine(this.userText, 40);
    let title = '';
    try {
      const out = await this.ai.chat({
        userId: this.user.id,
        runId: this.run.id,
        role: 'fast',
        purpose: 'title',
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content:
              'Write a very short title (2 to 6 words) for this conversation. Use the same language as the user message. Output ONLY the title: no quotes, no punctuation at the end, no markdown.',
          },
          { role: 'user', content: `User message:\n${truncate(this.userText, 400)}\n\nAssistant reply (start):\n${truncate(answer, 300)}` },
        ],
      });
      title = out.text.split(/\r?\n/)[0]?.replace(/^["'«»“”‘’`#*\s-]+|["'«»“”‘’`.*\s]+$/g, '').trim() ?? '';
    } catch {
      // a title is cosmetic: fall back to the beginning of the user's message
    }
    if (!title || title.length > 70) title = fallback;
    if (!title) return;
    await touchThread(this.env, thread.id, { title });
    await publishToUsers(this.env, [this.user.id], { type: 'conversation.updated', conversationId: thread.conversation_id });
  }

  /* ------------------------------------------------------------------------------------------------ endings */

  async finishCancelled(): Promise<void> {
    const steps = await getSteps(this.env, this.run.id);
    for (const s of steps) {
      if (s.status === 'pending' || s.status === 'running' || s.status === 'awaiting_approval') await this.markStep(s, 'cancelled', { error: t(this.user.locale).cancelled, error_code: 'CANCELLED' });
    }
    await this.env.DB.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE run_id = ? AND status = 'pending'").bind(Date.now(), this.run.id).run();
    const partial = this.partial.trim();
    if (this.run.result_message_id) {
      const row = await getMessageRow(this.env, this.run.result_message_id);
      const stored = row?.status === 'streaming' ? row.body : null;
      await finalizeAssistantMessage(this.env, this.run.result_message_id, {
        body: partial || stored || null,
        status: 'cancelled',
        ai: { agentId: this.agent.id, modelId: null, runId: this.run.id, error: null },
        ownerId: this.user.id,
      });
    }
    await patchRun(this.env, this.run.id, { finished_at: Date.now(), error: null, error_code: null });
    await this.setStatus('cancelled', { finished_at: Date.now() });
    await logEvent(this.env, this.run.id, 'run.cancelled', {}, 'warn');
  }

  async fail(code: string, message: string): Promise<void> {
    await this.handleFatal(new RunFailure(code, message));
  }

  private async handleFatal(err: unknown): Promise<void> {
    if (err instanceof CancelledError) {
      await this.finishCancelled().catch((e) => console.error('cancel wrap-up failed', String((e as Error)?.message ?? e)));
      return;
    }
    let code = 'RUN_FAILED';
    let message = t(this.user.locale).genericError;
    if (err instanceof AppError) {
      code = err.code;
      message = err.message;
      if (err.code === 'AI_ABORTED') {
        await this.finishCancelled().catch(() => undefined);
        return;
      }
    } else if (err instanceof RunFailure) {
      code = err.code;
      message = err.message;
    } else {
      console.error('run crashed', this.run.id, clipForLog(err));
    }
    try {
      const steps = await getSteps(this.env, this.run.id);
      for (const s of steps) if (s.status === 'pending' || s.status === 'running' || s.status === 'awaiting_approval') await this.markStep(s, 'cancelled', { error: message, error_code: code });
      await this.env.DB.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE run_id = ? AND status = 'pending'").bind(Date.now(), this.run.id).run();
      if (this.run.result_message_id) {
        await finalizeAssistantMessage(this.env, this.run.result_message_id, {
          body: this.partial.trim() || null,
          status: 'failed',
          ai: { agentId: this.agent.id, modelId: null, runId: this.run.id, error: { code, message } },
          ownerId: this.user.id,
        });
      }
      await patchRun(this.env, this.run.id, { error: truncate(message, 500), error_code: code });
      await this.setStatus('failed', { finished_at: Date.now() });
      await logEvent(this.env, this.run.id, 'run.failed', { code, message: truncate(message, 400) }, 'error');
    } catch (e) {
      console.error('failure wrap-up failed', this.run.id, clipForLog(e));
    }
  }
}

/* ------------------------------------------------------------------------------------------------ helpers */

function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof AppError) {
    const retryable = err.status >= 500 || err.status === 429;
    return new ToolError(err.code, err.message, { retryable });
  }
  console.error('tool crashed', clipForLog(err));
  return new ToolError('TOOL_CRASHED', 'The tool failed unexpectedly.', { retryable: false });
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(new Error('aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      p.catch(() => undefined);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

