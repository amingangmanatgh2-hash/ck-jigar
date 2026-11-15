import { LIMITS } from '@aminchat/shared';
import { z } from 'zod';
import { isUniqueViolation } from '../../db/helpers';
import { AppError } from '../../lib/errors';
import { ID_PREFIX } from '../../lib/ids';
import { RATE_LIMITS } from '../../config/limits';
import {
  computeAccess,
  getConversation,
  getMember,
  isAdminRole,
  listConversations,
  type ConvRow,
  type MemberRow,
} from '../../services/conversations';
import { getMessageRow, insertMessage, listMessages, makePollMeta } from '../../services/messages';
import { consume } from '../../services/rate';
import { conversationLabel, renderTranscript } from '../../services/transcript';
import { ToolError, clip, DEFAULT_RUN_KINDS, type ToolContext, type ToolDef } from './types';

const stepScopedId = (prefix: string, stepId: string) => `${prefix}_${stepId.slice(4)}`;

/** In assist runs the target conversation is fixed by the system — the model cannot redirect an action to another chat. */
function targetConversationId(ctx: ToolContext, requested: string | undefined): string {
  if (ctx.run.kind === 'assist') {
    if (!ctx.run.conversation_id) throw new ToolError('NO_CONVERSATION', 'This run has no conversation.');
    return ctx.run.conversation_id;
  }
  if (!requested) throw new ToolError('CONVERSATION_REQUIRED', 'conversationId is required. Use chat_list to find it.');
  return requested;
}

async function loadTarget(ctx: ToolContext, conversationId: string): Promise<{ conv: ConvRow; member: MemberRow; label: string }> {
  const [conv, member] = await Promise.all([getConversation(ctx.env, conversationId), getMember(ctx.env, conversationId, ctx.user.id)]);
  if (!conv || !member) throw new ToolError('CONVERSATION_NOT_FOUND', 'That conversation was not found among your chats.');
  if (conv.type === 'ai') throw new ToolError('INVALID_TARGET', 'Messages cannot be sent into the AMIN AI conversation this way.');
  return { conv, member, label: await conversationLabel(ctx.env, conv, ctx.user.id) };
}

function assertPlaintextChat(conv: ConvRow): void {
  if (conv.e2ee) {
    throw new ToolError('E2EE_UNSUPPORTED', 'This is a secret (end-to-end encrypted) chat. Messages must be encrypted on your device, so AMIN AI cannot post there. Copy the draft and send it yourself.');
  }
}

/* ------------------------------------------------------------------------------------------------ chat_list / chat_read */

const chatList = z.object({});

export const chatListTool: ToolDef<z.infer<typeof chatList>> = {
  id: 'chat_list',
  title: { fa: 'فهرست گفتگوها', en: 'List chats' },
  description: 'List the chats of the user (names and whether AMIN AI may read them). Never returns message content.',
  argsHint: '{}',
  risk: 'read',
  schema: chatList,
  async run(ctx) {
    const convs = (await listConversations(ctx.env, ctx.user.id)).filter((c) => c.type !== 'ai');
    const label = (c: (typeof convs)[number]) => c.title ?? c.peer?.displayName ?? 'Chat';
    const text = convs.length
      ? convs
          .slice(0, 50)
          .map((c) => `- ${label(c)} (${c.type}${c.e2ee ? ', secret chat' : ''}) — AI can read: ${c.ai.effective.allowed && c.ai.effective.level === 'context' ? 'yes' : 'no'} (id: ${c.id})`)
          .join('\n')
      : 'The user has no chats yet.';
    return { text, data: convs.slice(0, 50).map((c) => ({ id: c.id, label: label(c), type: c.type, e2ee: c.e2ee, aiReadable: c.ai.effective.allowed && c.ai.effective.level === 'context' })) };
  },
};

const chatRead = z.object({ conversationId: z.string().trim().min(1).max(64), limit: z.coerce.number().int().min(1).max(100).optional() });

export const chatReadTool: ToolDef<z.infer<typeof chatRead>> = {
  id: 'chat_read',
  title: { fa: 'خواندن گفتگو', en: 'Read chat' },
  description: 'Read the most recent messages of one chat. Only works if the AI-access setting of that chat allows reading context (never for secret chats).',
  argsHint: '{"conversationId": string, "limit"?: number (default 40)}',
  risk: 'read',
  schema: chatRead,
  async run(ctx, a) {
    const { conv, member, label } = await loadTarget(ctx, a.conversationId);
    const decision = await computeAccess(ctx.env, conv, member);
    if (!decision.allowed || decision.level !== 'context') {
      if (decision.reason === 'e2ee') {
        throw new ToolError('AI_ACCESS_DENIED', `"${label}" is a secret chat. AMIN AI cannot read it. The user can select specific messages and share them with AMIN AI instead.`);
      }
      const canEnable = (conv.type === 'direct' && decision.reason !== 'blocked') || (conv.type === 'group' && isAdminRole(member.role));
      const why =
        decision.reason === 'blocked' ? 'someone in this chat has blocked AI processing'
        : decision.reason === 'role' ? 'only group admins may use AI in this group'
        : decision.reason === 'off' ? 'AI access is turned off for this chat'
        : decision.level === 'mention' ? 'AI access is limited to explicit mentions in this chat'
        : 'AI access is not allowed';
      throw new ToolError('AI_ACCESS_DENIED', `AMIN AI cannot read "${label}": ${why}.${canEnable ? ' The user can allow it with one tap.' : ''}`, {
        action: canEnable ? { type: 'enable_ai_access', conversationId: conv.id, conversationTitle: label } : null,
      });
    }
    const { messages } = await listMessages(ctx.env, { conversationId: conv.id, limit: a.limit ?? 40, viewerId: ctx.user.id });
    const rows = messages.map((m) => ({
      id: m.id, conversation_id: m.conversationId, thread_id: m.threadId, sender_id: m.senderId, kind: m.kind, body: m.body, cipher: null,
      reply_to_id: m.replyToId, via_ai: m.viaAi ? 1 : 0, status: m.status, meta: m.meta ? JSON.stringify(m.meta) : null, edited_at: m.editedAt,
      deleted_at: m.deleted ? 1 : null, created_at: m.createdAt,
    }));
    const t = await renderTranscript(ctx.env, rows as never, ctx.user.timezone, 12_000);
    return { text: t.count ? `Messages of "${label}" (oldest first):\n${t.text}` : `"${label}" has no readable messages yet.`, data: { conversationId: conv.id, count: t.count } };
  },
};

/* ------------------------------------------------------------------------------------------------ sending (sensitive → approval) */

const messageSend = z.object({ conversationId: z.string().trim().min(1).max(64), text: z.string().trim().min(1).max(4000) });

async function postVerified(
  ctx: ToolContext,
  conv: ConvRow,
  input: { body: string; kind?: 'text' | 'poll'; meta?: Record<string, unknown> },
) {
  await consume(ctx.env, 'send', ctx.user.id, RATE_LIMITS.send).catch((e) => {
    throw new ToolError('RATE_LIMITED', e instanceof AppError ? e.message : 'Too many messages', { retryable: false });
  });
  const id = stepScopedId(ID_PREFIX.message, ctx.step.id);
  const meta = { ...(input.meta ?? {}), ai: { agentId: 'messenger', modelId: null, runId: ctx.run.id } };
  try {
    await insertMessage(ctx.env, { id, conversationId: conv.id, senderId: ctx.user.id, kind: input.kind ?? 'text', body: input.body, viaAi: true, meta });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err; // a retry after a lost response: the message already exists
  }
  const row = await getMessageRow(ctx.env, id);
  return { id, verified: !!row && row.conversation_id === conv.id && row.body === input.body && !row.deleted_at };
}

export const messageSendTool: ToolDef<z.infer<typeof messageSend>> = {
  id: 'message_send',
  title: { fa: 'ارسال پیام', en: 'Send message' },
  description: 'Send a text message to one of the user\'s chats on their behalf. ALWAYS needs the user\'s approval before it is sent. Only plan this when the user explicitly asked to send something.',
  argsHint: '{"conversationId": string (from chat_list), "text": string}',
  risk: 'sensitive',
  schema: messageSend,
  editable: ['text'],
  async prepare(ctx, a) {
    const { conv, label } = await loadTarget(ctx, a.conversationId);
    assertPlaintextChat(conv);
    return { args: a, summary: `Send to "${label}": ${clip(a.text.replace(/\s+/g, ' '), 90)}`, context: { conversationId: conv.id, conversation: label } };
  },
  async run(ctx, a) {
    const { conv, label } = await loadTarget(ctx, a.conversationId);
    assertPlaintextChat(conv);
    const res = await postVerified(ctx, conv, { body: a.text });
    if (!res.verified) throw new ToolError('NOT_VERIFIED', 'The message was written but could not be confirmed.', { retryable: true });
    return { text: `Message sent to "${label}".`, data: { messageId: res.id, conversationId: conv.id }, verified: true };
  },
};

const pollCreate = z.object({
  conversationId: z.string().trim().max(64).optional(),
  question: z.string().trim().min(1).max(200),
  options: z.array(z.string().trim().min(1).max(LIMITS.pollOptionChars)).min(2).max(LIMITS.pollOptionsMax),
  multiple: z.boolean().optional(),
});

export const pollCreateTool: ToolDef<z.infer<typeof pollCreate>> = {
  id: 'poll_create',
  title: { fa: 'ایجاد نظرسنجی', en: 'Create poll' },
  description: 'Publish a poll in a chat. ALWAYS needs the user\'s approval before it is published.',
  argsHint: '{"conversationId"?: string, "question": string, "options": string[2..10], "multiple"?: boolean}',
  risk: 'sensitive',
  schema: pollCreate,
  editable: ['question', 'options'],
  runKinds: ['chat', 'task', 'assist'],
  async prepare(ctx, a) {
    const { conv, label } = await loadTarget(ctx, targetConversationId(ctx, a.conversationId));
    assertPlaintextChat(conv);
    return { args: { ...a, conversationId: conv.id }, summary: `Publish a poll in "${label}": ${clip(a.question, 80)} (${a.options.length} options)`, context: { conversation: label } };
  },
  async run(ctx, a) {
    const { conv, label } = await loadTarget(ctx, targetConversationId(ctx, a.conversationId));
    assertPlaintextChat(conv);
    const res = await postVerified(ctx, conv, { body: a.question, kind: 'poll', meta: makePollMeta(a.question, a.options, a.multiple ?? false) });
    if (!res.verified) throw new ToolError('NOT_VERIFIED', 'The poll was created but could not be confirmed.', { retryable: true });
    return { text: `Poll published in "${label}".`, data: { messageId: res.id, conversationId: conv.id }, verified: true };
  },
};

const announce = z.object({ conversationId: z.string().trim().max(64).optional(), text: z.string().trim().min(1).max(4000) });

export const announcePostTool: ToolDef<z.infer<typeof announce>> = {
  id: 'announce_post',
  title: { fa: 'انتشار اطلاعیه', en: 'Post announcement' },
  description: 'Publish an announcement in a GROUP the user administers. ALWAYS needs the user\'s approval before it is published.',
  argsHint: '{"conversationId"?: string, "text": string}',
  risk: 'sensitive',
  schema: announce,
  editable: ['text'],
  runKinds: ['chat', 'task', 'assist'],
  async prepare(ctx, a) {
    const { conv, member, label } = await loadTarget(ctx, targetConversationId(ctx, a.conversationId));
    assertPlaintextChat(conv);
    if (conv.type !== 'group') throw new ToolError('NOT_A_GROUP', 'Announcements can only be published in groups.');
    if (!isAdminRole(member.role)) throw new ToolError('ADMIN_ONLY', 'Only group admins can publish announcements.');
    return { args: { ...a, conversationId: conv.id }, summary: `Publish an announcement in "${label}": ${clip(a.text.replace(/\s+/g, ' '), 90)}`, context: { conversation: label } };
  },
  async run(ctx, a) {
    const { conv, member, label } = await loadTarget(ctx, targetConversationId(ctx, a.conversationId));
    assertPlaintextChat(conv);
    if (conv.type !== 'group') throw new ToolError('NOT_A_GROUP', 'Announcements can only be published in groups.');
    if (!isAdminRole(member.role)) throw new ToolError('ADMIN_ONLY', 'Only group admins can publish announcements.');
    const res = await postVerified(ctx, conv, { body: a.text, meta: { announcement: true } });
    if (!res.verified) throw new ToolError('NOT_VERIFIED', 'The announcement was written but could not be confirmed.', { retryable: true });
    return { text: `Announcement published in "${label}".`, data: { messageId: res.id, conversationId: conv.id }, verified: true };
  },
};

export { DEFAULT_RUN_KINDS };
