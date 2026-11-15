import {
  AMIN_AI_USER_ID,
  LIMITS,
  type MessageDto,
  type MessageMeta,
  type RunDto,
  type SharedExcerpt,
} from '@aminchat/shared';
import { AGENT_IDS } from '@aminchat/shared';
import { all, batch, first, placeholders } from '../db/helpers';
import type { Env } from '../env';
import { badRequest, conflict, forbidden, notFound, rateLimited, unavailable } from '../lib/errors';
import { publishToUsers } from '../lib/realtime';
import { safeJsonParse, truncate } from '../lib/text';
import { getModel, SELECTABLE_CHAT_MODELS } from '../ai/models';
import { loadHealth } from '../ai/health';
import { assertWithinQuota } from '../ai/usage';
import type { AuthUser } from '../middleware/auth';
import { computeAccess, listMemberIds, requireMember } from './conversations';
import type { MessageRow } from './dto';
import { findByClientId, ftsIndexStatements, getMessageRow, hydrateMessages, insertMessage, isClientIdConflict } from './messages';
import { cancelRun, startRun } from './run-control';
import { createRun, runToDto, type RunRow } from './runs';
import { displayNames, conversationLabel } from './transcript';
import { touchThread, type ThreadRow } from './threads';
import { purgeBlobs, type StoredFile } from '../storage/file-store';

export interface SharedInput {
  conversationId: string;
  messageIds?: string[];
  excerpts?: { sender: string; text: string; at?: number | null }[];
}

export interface TurnInput {
  body?: string | null;
  fileIds?: string[];
  agentId?: string;
  /** `undefined` keeps the thread's model, `null` resets to automatic. */
  modelId?: string | null;
  shared?: SharedInput;
  /** `task` = started from the tasks panel; behaves the same, but is labelled so in the run list. */
  kind?: 'chat' | 'task';
  /** Idempotency token: the same token twice returns the first turn instead of asking the model again. */
  clientId?: string | null;
}

export interface TurnResult {
  userMessage: MessageDto;
  assistantMessage: MessageDto;
  run: RunDto;
  /** True when this answer repeats an earlier identical request (nothing new was started). */
  duplicate?: boolean;
}

/* ------------------------------------------------------------------------------------------------ guards */

export function requireAiBackend(env: Env): void {
  if (!env.AI) throw unavailable('Workers AI is not connected in this deployment, so AMIN AI cannot answer.', 'AI_NOT_CONNECTED');
}

export const MAX_ACTIVE_RUNS_PER_USER = 3;

export async function guardConcurrency(env: Env, userId: string, threadId: string | null): Promise<void> {
  const active = await all<{ id: string; thread_id: string | null }>(
    env.DB.prepare("SELECT id, thread_id FROM runs WHERE user_id = ? AND status IN ('pending', 'planning', 'running')").bind(userId),
  );
  if (threadId && active.some((r) => r.thread_id === threadId)) {
    throw conflict('AMIN AI is still answering in this conversation. Wait for it to finish or stop it first.', 'RUN_IN_PROGRESS');
  }
  if (active.length >= MAX_ACTIVE_RUNS_PER_USER) throw rateLimited('Too many AI tasks are running at the same time. Wait for one to finish.', 10);
}

export async function validateAgentAndModel(env: Env, agentId: string | undefined, modelId: string | null | undefined): Promise<void> {
  if (agentId !== undefined && !(AGENT_IDS as readonly string[]).includes(agentId)) throw badRequest('Unknown agent', undefined, 'UNKNOWN_AGENT');
  if (modelId) {
    const spec = getModel(modelId);
    if (!spec || !SELECTABLE_CHAT_MODELS.includes(spec.id)) throw badRequest('This model cannot be selected', undefined, 'MODEL_NOT_SELECTABLE');
    const health = (await loadHealth(env)).get(spec.id);
    // Unavailable models are never accepted: they would be shown as usable only by mistake.
    if (health?.status === 'unavailable') throw badRequest(`This model is currently unavailable${health.reason ? `: ${health.reason}` : ''}`, undefined, 'MODEL_UNAVAILABLE');
  }
}

/* ------------------------------------------------------------------------------------------------ shared selections */

type SharedMeta = NonNullable<MessageMeta['shared']>;

/**
 * "Review these messages": the user consciously picks messages from another chat and hands them to AMIN AI.
 *  - End-to-end encrypted chat: the server cannot read it, so the client sends the decrypted excerpts it selected.
 *  - Normal chat: the client sends message ids; the server reads them itself (membership + AI veto are enforced).
 */
export async function resolveShared(env: Env, user: AuthUser, shared: SharedInput): Promise<SharedMeta> {
  const { conv, member } = await requireMember(env, shared.conversationId, user.id);
  if (conv.type === 'ai') throw badRequest('Select messages from another chat', undefined, 'INVALID_SELECTION');
  const label = await conversationLabel(env, conv, user.id);

  if (conv.e2ee) {
    if (!shared.excerpts?.length || shared.messageIds?.length) throw badRequest('Secret chat: send the messages you selected as excerpts', undefined, 'E2EE_EXCERPTS_REQUIRED');
    const excerpts: SharedExcerpt[] = shared.excerpts.slice(0, LIMITS.sharedExcerptsMax).map((e) => ({
      sender: truncate(e.sender.trim(), 60, ''),
      text: truncate(e.text.trim(), LIMITS.sharedExcerptChars, '…'),
      at: typeof e.at === 'number' ? e.at : null,
    })).filter((e) => e.text);
    if (!excerpts.length) throw badRequest('Nothing was selected', undefined, 'EMPTY_SELECTION');
    return { conversationId: conv.id, conversationTitle: label, e2ee: true, count: excerpts.length, excerpts };
  }

  if (!shared.messageIds?.length || shared.excerpts?.length) throw badRequest('Select messages by id', undefined, 'MESSAGE_IDS_REQUIRED');
  const decision = await computeAccess(env, conv, member);
  if (decision.reason === 'blocked') throw forbidden('Someone in this chat has blocked AI processing, so its messages cannot be shared with AMIN AI.', 'AI_BLOCKED');
  if (conv.type === 'group' && !decision.allowed) throw forbidden('The admins of this group have not allowed AI to process its messages.', 'AI_NOT_ALLOWED_IN_GROUP');

  const ids = [...new Set(shared.messageIds)].slice(0, LIMITS.sharedExcerptsMax);
  const rows = await all<MessageRow>(
    env.DB.prepare(`SELECT * FROM messages WHERE id IN (${placeholders(ids.length)}) AND conversation_id = ? AND deleted_at IS NULL AND kind = 'text' AND body IS NOT NULL ORDER BY created_at, seq`).bind(...ids, conv.id),
  );
  if (!rows.length) throw badRequest('None of the selected messages could be found', undefined, 'EMPTY_SELECTION');
  const names = await displayNames(env, rows.map((r) => r.sender_id));
  const excerpts = rows.map((r) => ({ sender: names.get(r.sender_id) ?? 'Member', text: truncate(r.body!, LIMITS.sharedExcerptChars, '…'), at: r.created_at }));
  return { conversationId: conv.id, conversationTitle: label, e2ee: false, count: excerpts.length, excerpts };
}

/* ------------------------------------------------------------------------------------------------ messages */

export async function createAssistantPlaceholder(
  env: Env,
  o: { conversationId: string; threadId: string | null; agentId: string; runId?: string | null; invokedBy?: string | null; replyToId?: string | null },
): Promise<MessageDto> {
  return insertMessage(env, {
    conversationId: o.conversationId,
    threadId: o.threadId,
    senderId: AMIN_AI_USER_ID,
    body: null,
    status: 'streaming',
    replyToId: o.replyToId ?? null,
    meta: { ai: { agentId: o.agentId, modelId: null, runId: o.runId ?? null, ...(o.invokedBy ? { invokedBy: o.invokedBy } : {}) } },
  });
}

/** Marks an in-progress answer as "waiting for the user's approval" (or clears the mark) and tells everyone who sees the message. */
export async function setAssistantWaiting(env: Env, messageId: string, waiting: 'approval' | null): Promise<void> {
  const row = await getMessageRow(env, messageId);
  if (!row || row.status !== 'streaming') return;
  const meta = safeJsonParse<MessageMeta>(row.meta) ?? {};
  if ((meta.ai?.waiting ?? null) === waiting) return;
  meta.ai = { ...(meta.ai ?? { agentId: 'general', modelId: null, runId: null }), waiting } as MessageMeta['ai'];
  await env.DB.prepare('UPDATE messages SET meta = ? WHERE id = ?').bind(JSON.stringify(meta), messageId).run();
  const updated = (await getMessageRow(env, messageId))!;
  const members = await listMemberIds(env, row.conversation_id);
  const [dto] = await hydrateMessages(env, [updated], members[0] ?? AMIN_AI_USER_ID);
  await publishToUsers(env, members, { type: 'message.updated', message: dto! });
}

export async function finalizeAssistantMessage(
  env: Env,
  messageId: string,
  o: { body: string | null; status: 'sent' | 'failed' | 'cancelled'; ai?: Partial<NonNullable<MessageMeta['ai']>>; fileIds?: string[]; ownerId?: string },
): Promise<MessageDto | null> {
  const row = await getMessageRow(env, messageId);
  if (!row) return null;
  const meta = safeJsonParse<MessageMeta>(row.meta) ?? {};
  meta.ai = { ...(meta.ai ?? { agentId: 'general', modelId: null, runId: null }), ...(o.ai ?? {}), waiting: null } as MessageMeta['ai'];
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('UPDATE messages SET body = ?, status = ?, meta = ? WHERE id = ?').bind(o.body, o.status, JSON.stringify(meta), messageId),
    ...ftsIndexStatements(env, messageId, row.conversation_id, row.thread_id, o.status === 'sent' ? o.body : null),
  ];
  if (o.fileIds?.length && o.ownerId) {
    stmts.push(
      env.DB.prepare(`UPDATE files SET message_id = ?, conversation_id = ? WHERE id IN (${placeholders(o.fileIds.length)}) AND owner_id = ? AND message_id IS NULL`).bind(messageId, row.conversation_id, ...o.fileIds, o.ownerId),
    );
  }
  stmts.push(env.DB.prepare('UPDATE conversations SET last_message_id = ?, last_message_at = ? WHERE id = ?').bind(messageId, row.created_at, row.conversation_id));
  await batch(env.DB, stmts);
  const updated = (await getMessageRow(env, messageId))!;
  const members = await listMemberIds(env, row.conversation_id);
  const [dto] = await hydrateMessages(env, [updated], members[0] ?? AMIN_AI_USER_ID);
  await publishToUsers(env, members, { type: 'message.updated', message: dto! });
  return dto!;
}

async function newRunFor(
  env: Env,
  user: AuthUser,
  thread: ThreadRow,
  trigger: MessageDto | MessageRow,
  assistant: MessageDto,
  agentId: string,
  modelId: string | null,
  goal: string,
  regenerate = false,
  kind: 'chat' | 'task' = 'chat',
  regenerations = 0,
): Promise<RunRow> {
  const run = await createRun(env, {
    userId: user.id,
    kind,
    agentId,
    goal,
    conversationId: thread.conversation_id,
    threadId: thread.id,
    triggerMessageId: trigger.id,
    resultMessageId: assistant.id,
    modelId,
    options: { locale: user.locale, regenerate },
  });
  // Tie the placeholder to the run so clients can subscribe to its progress.
  const meta = { ai: { agentId, modelId: null, runId: run.id, ...(regenerations ? { regenerations } : {}) } };
  await env.DB.prepare('UPDATE messages SET meta = ? WHERE id = ?').bind(JSON.stringify(meta), assistant.id).run();
  assistant.meta = meta;
  try {
    await startRun(env, run.id);
  } catch (err) {
    await env.DB.prepare("UPDATE runs SET status = 'failed', error = ?, error_code = 'START_FAILED', finished_at = ? WHERE id = ?").bind('The task could not be started', Date.now(), run.id).run();
    await finalizeAssistantMessage(env, assistant.id, { body: null, status: 'failed', ai: { error: { code: 'START_FAILED', message: 'The task could not be started' } } });
    throw unavailable('The AI task could not be started. Please try again.', 'RUN_START_FAILED');
  }
  return run;
}

/** The turn already started for this idempotency token, rebuilt from what is stored. */
async function existingTurn(env: Env, user: AuthUser, thread: ThreadRow, clientId: string): Promise<TurnResult | null> {
  const userMessage = await findByClientId(env, thread.conversation_id, user.id, clientId);
  if (!userMessage) return null;
  const runRow = await first<RunRow>(env.DB.prepare('SELECT * FROM runs WHERE trigger_message_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1').bind(userMessage.id, user.id));
  if (!runRow?.result_message_id) return null;
  const assistantRow = await getMessageRow(env, runRow.result_message_id);
  if (!assistantRow) return null;
  const [assistantMessage] = await hydrateMessages(env, [assistantRow], user.id);
  return { userMessage, assistantMessage: assistantMessage!, run: await runToDto(env, runRow), duplicate: true };
}

export async function startAiTurn(env: Env, user: AuthUser, thread: ThreadRow, input: TurnInput): Promise<TurnResult> {
  if (input.clientId) {
    const again = await existingTurn(env, user, thread, input.clientId);
    if (again) return again;
  }
  requireAiBackend(env);
  const body = input.body?.trim() ? input.body.trim() : null;
  if (body && body.length > LIMITS.aiPromptMaxChars) throw badRequest(`Messages to AMIN AI can be at most ${LIMITS.aiPromptMaxChars} characters`, undefined, 'MESSAGE_TOO_LONG');
  const fileIds = input.fileIds ?? [];
  if (!body && !input.shared && fileIds.length === 0) throw badRequest('Message is empty', undefined, 'EMPTY_MESSAGE');
  await validateAgentAndModel(env, input.agentId, input.modelId);
  await assertWithinQuota(env, user.id);
  await guardConcurrency(env, user.id, thread.id);

  const shared = input.shared ? await resolveShared(env, user, input.shared) : null;
  const agentId = input.agentId ?? thread.agent_id;
  const modelId = input.modelId === undefined ? thread.model_id : input.modelId;

  let userMessage: MessageDto;
  try {
    userMessage = await insertMessage(env, {
      conversationId: thread.conversation_id,
      threadId: thread.id,
      senderId: user.id,
      body,
      meta: shared ? { shared } : null,
      fileIds,
      clientId: input.clientId ?? null,
    });
  } catch (err) {
    // two identical requests raced: the loser gets the winner's turn (give it a moment to finish creating the run)
    if (input.clientId && isClientIdConflict(err)) {
      for (let i = 0; i < 20; i++) {
        const again = await existingTurn(env, user, thread, input.clientId);
        if (again) return again;
        await new Promise<void>((r) => setTimeout(r, 50));
      }
    }
    throw err;
  }
  const assistant = await createAssistantPlaceholder(env, { conversationId: thread.conversation_id, threadId: thread.id, agentId });
  const goal = body ?? (shared ? `Review ${shared.count} shared message(s)` : 'Review the attached file(s)');
  const run = await newRunFor(env, user, thread, userMessage, assistant, agentId, modelId, goal, false, input.kind ?? 'chat');
  await touchThread(env, thread.id, { agentId, modelId });
  return { userMessage, assistantMessage: assistant, run: await runToDto(env, run) };
}

async function lastMessages(env: Env, threadId: string, n: number) {
  return all<MessageRow & { seq: number }>(env.DB.prepare('SELECT * FROM messages WHERE thread_id = ? AND deleted_at IS NULL ORDER BY seq DESC LIMIT ?').bind(threadId, n));
}

/** Re-runs the latest answer (also the way to retry a failed one). The message keeps its id; its content is replaced. */
export async function regenerateTurn(env: Env, user: AuthUser, thread: ThreadRow, opts: { agentId?: string; modelId?: string | null }): Promise<TurnResult> {
  requireAiBackend(env);
  await validateAgentAndModel(env, opts.agentId, opts.modelId);
  await assertWithinQuota(env, user.id);
  await guardConcurrency(env, user.id, thread.id);

  const tail = await lastMessages(env, thread.id, 20);
  const answer = tail[0];
  if (!answer || answer.sender_id !== AMIN_AI_USER_ID) throw badRequest('Only the latest answer can be regenerated', undefined, 'NOT_LAST_ANSWER');
  const trigger = tail.find((m) => m.sender_id === user.id);
  if (!trigger) throw badRequest('There is nothing to regenerate', undefined, 'NO_PROMPT');

  const agentId = opts.agentId ?? thread.agent_id;
  const modelId = opts.modelId === undefined ? thread.model_id : opts.modelId;
  const prev = safeJsonParse<MessageMeta>(answer.meta);
  const meta = { ai: { agentId, modelId: null, runId: null, regenerations: (prev?.ai?.regenerations ?? 0) + 1 } };
  await batch(env.DB, [
    env.DB.prepare("UPDATE messages SET body = NULL, status = 'streaming', meta = ?, edited_at = NULL WHERE id = ?").bind(JSON.stringify(meta), answer.id),
    ...ftsIndexStatements(env, answer.id, answer.conversation_id, answer.thread_id, null),
  ]);
  const reset = (await getMessageRow(env, answer.id))!;
  const [assistant] = await hydrateMessages(env, [reset], user.id);
  await publishToUsers(env, [user.id], { type: 'message.updated', message: assistant! });
  const run = await newRunFor(env, user, thread, trigger, assistant!, agentId, modelId, trigger.body ?? 'Regenerate', true, 'chat', (prev?.ai?.regenerations ?? 0) + 1);
  await touchThread(env, thread.id, { agentId, modelId });
  const [triggerDto] = await hydrateMessages(env, [trigger], user.id);
  return { userMessage: triggerDto!, assistantMessage: assistant!, run: await runToDto(env, run) };
}

/** Edits one of the user's own prompts: everything after it is discarded and the answer is generated again. */
export async function editAndResend(env: Env, user: AuthUser, thread: ThreadRow, messageId: string, newBody: string, opts: { agentId?: string; modelId?: string | null }): Promise<TurnResult> {
  requireAiBackend(env);
  const body = newBody.trim();
  if (!body) throw badRequest('Message is empty', undefined, 'EMPTY_MESSAGE');
  if (body.length > LIMITS.aiPromptMaxChars) throw badRequest('Message is too long', undefined, 'MESSAGE_TOO_LONG');
  await validateAgentAndModel(env, opts.agentId, opts.modelId);
  const row = await first<MessageRow & { seq: number }>(env.DB.prepare('SELECT * FROM messages WHERE id = ? AND thread_id = ? AND deleted_at IS NULL').bind(messageId, thread.id));
  if (!row) throw notFound('Message not found', 'MESSAGE_NOT_FOUND');
  if (row.sender_id !== user.id) throw forbidden('You can only edit your own messages', 'NOT_YOUR_MESSAGE');
  await assertWithinQuota(env, user.id);

  // Stop whatever is still running in this thread before rewriting its history.
  const running = await all<{ id: string }>(env.DB.prepare("SELECT id FROM runs WHERE thread_id = ? AND status IN ('pending', 'planning', 'running', 'awaiting_approval')").bind(thread.id));
  for (const r of running) await cancelRun(env, user.id, r.id);
  await guardConcurrency(env, user.id, thread.id).catch(async (err) => {
    // cancellation is asynchronous: give the executor a moment to settle
    await new Promise((res) => setTimeout(res, 150));
    const still = await first<{ n: number }>(env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE thread_id = ? AND status IN ('pending', 'planning', 'running')").bind(thread.id));
    if ((still?.n ?? 0) > 0) throw err;
  });

  const later = await all<{ id: string }>(env.DB.prepare('SELECT id FROM messages WHERE thread_id = ? AND seq > ?').bind(thread.id, row.seq));
  const files = await all<StoredFile>(
    env.DB.prepare('SELECT f.id, f.r2_key, f.tier, f.drive_id FROM files f JOIN messages m ON m.id = f.message_id WHERE m.thread_id = ? AND m.seq > ? AND f.owner_id = ? AND f.deleted_at IS NULL').bind(thread.id, row.seq, user.id),
  );
  await batch(env.DB, [
    env.DB.prepare('DELETE FROM message_fts WHERE rowid IN (SELECT seq FROM messages WHERE thread_id = ? AND seq > ?)').bind(thread.id, row.seq),
    // soft-delete: the row keeps its R2 key / Drive id until the blob is really gone (purgeBlobs below, or the periodic sweep)
    env.DB.prepare('UPDATE files SET deleted_at = ? WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ? AND seq > ?) AND owner_id = ? AND deleted_at IS NULL').bind(Date.now(), thread.id, row.seq, user.id),
    env.DB.prepare('DELETE FROM runs WHERE thread_id = ? AND (trigger_message_id IN (SELECT id FROM messages WHERE thread_id = ? AND seq >= ?) OR result_message_id IN (SELECT id FROM messages WHERE thread_id = ? AND seq > ?))').bind(thread.id, thread.id, row.seq, thread.id, row.seq),
    env.DB.prepare('DELETE FROM messages WHERE thread_id = ? AND seq > ?').bind(thread.id, row.seq),
    env.DB.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').bind(body, Date.now(), row.id),
    ...ftsIndexStatements(env, row.id, row.conversation_id, row.thread_id, body),
  ]);
  await purgeBlobs(env, files);
  for (const m of later) await publishToUsers(env, [user.id], { type: 'message.deleted', conversationId: thread.conversation_id, messageId: m.id });

  const edited = (await getMessageRow(env, row.id))!;
  const [userDto] = await hydrateMessages(env, [edited], user.id);
  await publishToUsers(env, [user.id], { type: 'message.updated', message: userDto! });

  const agentId = opts.agentId ?? thread.agent_id;
  const modelId = opts.modelId === undefined ? thread.model_id : opts.modelId;
  const assistant = await createAssistantPlaceholder(env, { conversationId: thread.conversation_id, threadId: thread.id, agentId });
  const run = await newRunFor(env, user, thread, edited, assistant, agentId, modelId, body);
  await touchThread(env, thread.id, { agentId, modelId });
  return { userMessage: userDto!, assistantMessage: assistant, run: await runToDto(env, run) };
}
