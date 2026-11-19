import { Hono } from 'hono';
import { AMIN_AI_USER_ID, LIMITS } from '@aminchat/shared';
import { z } from 'zod';
import { badRequest, forbidden } from '../lib/errors';
import { clientIdField } from '../lib/fields';
import { newId, ID_PREFIX } from '../lib/ids';
import { publishToUsers } from '../lib/realtime';
import { parseJson, parseQuery } from '../lib/validate';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { userLimit } from '../middleware/rate-limit';
import {
  addMembers,
  computeAccess,
  createDirect,
  createGroup,
  getConversationDto,
  isAdminRole,
  listConversations,
  listMemberIds,
  removeMember,
  requireMember,
  setMemberRole,
} from '../services/conversations';
import { findByClientId, insertMessage, isClientIdConflict, listMessages, makePollMeta, markRead } from '../services/messages';
import { triggerAssistIfMentioned } from '../services/assist';

export const conversationRoutes = new Hono<AppEnv>();
conversationRoutes.use('*', requireAuth, userLimit('api'));

conversationRoutes.get('/', async (c) => c.json({ conversations: await listConversations(c.env, c.get('user').id) }));

conversationRoutes.post('/direct', async (c) => {
  const body = await parseJson(c, z.object({ userId: z.string().min(1).max(64), e2ee: z.boolean().default(false) }));
  const id = await createDirect(c.env, c.get('user').id, body.userId, body.e2ee);
  return c.json({ conversation: await getConversationDto(c.env, c.get('user').id, id) }, 201);
});

conversationRoutes.post('/group', async (c) => {
  const body = await parseJson(
    c,
    z.object({
      title: z.string().trim().min(1).max(LIMITS.titleMax),
      memberIds: z.array(z.string().min(1).max(64)).max(LIMITS.groupMembersMax).default([]),
    }),
  );
  const id = await createGroup(c.env, c.get('user').id, body.title, body.memberIds);
  return c.json({ conversation: await getConversationDto(c.env, c.get('user').id, id) }, 201);
});

conversationRoutes.get('/:id', async (c) => c.json({ conversation: await getConversationDto(c.env, c.get('user').id, c.req.param('id')) }));

conversationRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const { conv, member } = await requireMember(c.env, c.req.param('id'), user.id);
  const body = await parseJson(
    c,
    z.object({ title: z.string().trim().min(1).max(LIMITS.titleMax).optional(), pinned: z.boolean().optional(), muted: z.boolean().optional() }),
  );
  if (body.title !== undefined) {
    if (conv.type !== 'group') throw badRequest('Only groups have a title', undefined, 'NOT_A_GROUP');
    if (!isAdminRole(member.role)) throw forbidden('Only group admins can rename the group', 'ADMIN_ONLY');
    await c.env.DB.prepare('UPDATE conversations SET title = ? WHERE id = ?').bind(body.title, conv.id).run();
  }
  if (body.pinned !== undefined || body.muted !== undefined) {
    await c.env.DB.prepare(
      'UPDATE conversation_members SET pinned = COALESCE(?, pinned), muted = COALESCE(?, muted) WHERE conversation_id = ? AND user_id = ?',
    )
      .bind(body.pinned === undefined ? null : body.pinned ? 1 : 0, body.muted === undefined ? null : body.muted ? 1 : 0, conv.id, user.id)
      .run();
  }
  await publishToUsers(c.env, await listMemberIds(c.env, conv.id), { type: 'conversation.updated', conversationId: conv.id });
  return c.json({ conversation: await getConversationDto(c.env, user.id, conv.id) });
});

/* ------------------------------------------------------------------------------------------------ members */

conversationRoutes.post('/:id/members', async (c) => {
  const user = c.get('user');
  const { conv, member } = await requireMember(c.env, c.req.param('id'), user.id);
  const body = await parseJson(c, z.object({ userIds: z.array(z.string().min(1).max(64)).min(1).max(50) }));
  const added = await addMembers(c.env, conv, member, body.userIds);
  return c.json({ added, conversation: await getConversationDto(c.env, user.id, conv.id) });
});

conversationRoutes.delete('/:id/members/:userId', async (c) => {
  const user = c.get('user');
  const { conv, member } = await requireMember(c.env, c.req.param('id'), user.id);
  await removeMember(c.env, conv, member, c.req.param('userId'));
  return c.json({ ok: true });
});

conversationRoutes.patch('/:id/members/:userId', async (c) => {
  const user = c.get('user');
  const { conv, member } = await requireMember(c.env, c.req.param('id'), user.id);
  const body = await parseJson(c, z.object({ role: z.enum(['admin', 'member']) }));
  await setMemberRole(c.env, conv, member, c.req.param('userId'), body.role);
  return c.json({ conversation: await getConversationDto(c.env, user.id, conv.id) });
});

/* ------------------------------------------------------------------------------------------------ AI access settings */

/** My own consent for AMIN AI in this conversation (direct chats) + the right to forbid AI processing for everyone. */
conversationRoutes.put('/:id/ai', async (c) => {
  const user = c.get('user');
  const { conv } = await requireMember(c.env, c.req.param('id'), user.id);
  const body = await parseJson(c, z.object({ access: z.enum(['off', 'mention', 'context']).optional(), blocked: z.boolean().optional() }));
  if (conv.type === 'ai') throw badRequest('This is your private AMIN AI conversation', undefined, 'AI_CONVERSATION');
  if (conv.e2ee && body.access && body.access !== 'off') {
    throw badRequest('AI cannot read secret chats. Select messages and share them with AMIN AI instead.', undefined, 'E2EE_NO_ACCESS');
  }
  await c.env.DB.prepare(
    'UPDATE conversation_members SET ai_access = COALESCE(?, ai_access), ai_blocked = COALESCE(?, ai_blocked) WHERE conversation_id = ? AND user_id = ?',
  )
    .bind(body.access ?? null, body.blocked === undefined ? null : body.blocked ? 1 : 0, conv.id, user.id)
    .run();
  await c.env.DB.prepare('INSERT INTO audit_log (user_id, action, target_type, target_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(user.id, 'conversation.ai_access', 'conversation', conv.id, JSON.stringify(body), Date.now())
    .run();
  await publishToUsers(c.env, await listMemberIds(c.env, conv.id), { type: 'conversation.updated', conversationId: conv.id });
  return c.json({ conversation: await getConversationDto(c.env, user.id, conv.id) });
});

/** Group-wide AI policy. Only the owner and admins may change it. */
conversationRoutes.put('/:id/ai-policy', async (c) => {
  const user = c.get('user');
  const { conv, member } = await requireMember(c.env, c.req.param('id'), user.id);
  if (conv.type !== 'group') throw badRequest('AI policy applies to groups only', undefined, 'NOT_A_GROUP');
  if (!isAdminRole(member.role)) throw forbidden('Only group admins can change the AI access level', 'ADMIN_ONLY');
  const body = await parseJson(
    c,
    z.object({ level: z.enum(['off', 'mention', 'context', 'assist']), invokeRoles: z.enum(['all', 'admins']).default('all') }),
  );
  await c.env.DB.prepare('UPDATE conversations SET ai_level = ?, ai_invoke_roles = ? WHERE id = ?').bind(body.level, body.invokeRoles, conv.id).run();
  await c.env.DB.prepare('INSERT INTO audit_log (user_id, action, target_type, target_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(user.id, 'group.ai_policy', 'conversation', conv.id, JSON.stringify(body), Date.now())
    .run();
  await insertMessage(c.env, {
    conversationId: conv.id,
    senderId: user.id,
    kind: 'system',
    body: null,
    meta: { system: { code: 'ai_policy_changed', level: body.level, invokeRoles: body.invokeRoles, by: user.displayName } },
  });
  return c.json({ conversation: await getConversationDto(c.env, user.id, conv.id) });
});

/* ------------------------------------------------------------------------------------------------ messages */

conversationRoutes.get('/:id/messages', async (c) => {
  const user = c.get('user');
  const { conv } = await requireMember(c.env, c.req.param('id'), user.id);
  if (conv.type === 'ai') throw badRequest('Use /api/ai/threads/:id/messages for AMIN AI conversations', undefined, 'USE_AI_ENDPOINT');
  const q = parseQuery(c, z.object({ before: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }));
  const res = await listMessages(c.env, { conversationId: conv.id, before: q.before ?? null, limit: q.limit, viewerId: user.id });
  return c.json(res);
});

const cipherSchema = z.object({
  v: z.literal(1),
  iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
  ct: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(LIMITS.cipherMaxChars),
});

const sendSchema = z.object({
  body: z.string().max(LIMITS.messageMaxChars).optional(),
  cipher: cipherSchema.optional(),
  replyToId: z.string().max(64).optional(),
  fileIds: z.array(z.string().max(64)).max(LIMITS.attachmentsPerMessage).default([]),
  /** Idempotency token chosen by the client (a retry with the same token never creates a second message). */
  clientId: clientIdField.optional(),
});

conversationRoutes.post('/:id/messages', userLimit('send'), async (c) => {
  const user = c.get('user');
  const { conv, member } = await requireMember(c.env, c.req.param('id'), user.id);
  if (conv.type === 'ai') throw badRequest('Use /api/ai/threads/:id/messages to talk to AMIN AI', undefined, 'USE_AI_ENDPOINT');
  const body = await parseJson(c, sendSchema);

  // A retry of something that already arrived: answer with the stored message and do NOT trigger the assistant again.
  if (body.clientId) {
    const existing = await findByClientId(c.env, conv.id, user.id, body.clientId);
    if (existing) return c.json({ message: existing, ai: { triggered: false }, duplicate: true }, 200);
  }

  if (conv.e2ee) {
    if (!body.cipher || body.body !== undefined) throw badRequest('Secret chat messages must be sent as ciphertext', undefined, 'CIPHER_REQUIRED');
    if (body.fileIds.length > 0) throw badRequest('Attachments are not supported in secret chats yet', undefined, 'E2EE_NO_ATTACHMENTS');
  } else {
    if (body.cipher) throw badRequest('This chat is not end-to-end encrypted', undefined, 'CIPHER_NOT_ALLOWED');
    if (!(body.body?.trim()) && body.fileIds.length === 0) throw badRequest('Message is empty', undefined, 'EMPTY_MESSAGE');
  }
  if (body.replyToId) {
    const ok = await c.env.DB.prepare('SELECT 1 AS x FROM messages WHERE id = ? AND conversation_id = ?').bind(body.replyToId, conv.id).first();
    if (!ok) throw badRequest('Reply target not found in this conversation', undefined, 'INVALID_REPLY');
  }

  let message;
  try {
    message = await insertMessage(c.env, {
      conversationId: conv.id,
      senderId: user.id,
      body: body.body?.trim() ? body.body : null,
      cipher: body.cipher ?? null,
      replyToId: body.replyToId ?? null,
      fileIds: body.fileIds,
      clientId: body.clientId ?? null,
    });
  } catch (err) {
    // two identical requests raced: the loser gets the winner's message
    const winner = body.clientId && isClientIdConflict(err) ? await findByClientId(c.env, conv.id, user.id, body.clientId) : null;
    if (!winner) throw err;
    return c.json({ message: winner, ai: { triggered: false }, duplicate: true }, 200);
  }

  // @AMINAI: only ever triggers when the policy allows it for this conversation and invoker.
  const decision = await computeAccess(c.env, conv, member);
  const ai = await triggerAssistIfMentioned(c.env, user, { conv, member, message, decision });
  return c.json({ message, ai }, 201);
});

const pollSchema = z.object({
  question: z.string().trim().min(1).max(200),
  options: z.array(z.string().trim().min(1).max(LIMITS.pollOptionChars)).min(2).max(LIMITS.pollOptionsMax),
  multiple: z.boolean().default(false),
});

conversationRoutes.post('/:id/polls', userLimit('send'), async (c) => {
  const user = c.get('user');
  const { conv } = await requireMember(c.env, c.req.param('id'), user.id);
  if (conv.type === 'ai') throw badRequest('Polls are not available in the AMIN AI conversation', undefined, 'NOT_ALLOWED');
  if (conv.e2ee) throw badRequest('Polls are not supported in secret chats', undefined, 'E2EE_NO_POLLS');
  const body = await parseJson(c, pollSchema);
  const message = await insertMessage(c.env, {
    id: newId(ID_PREFIX.message),
    conversationId: conv.id,
    senderId: user.id,
    kind: 'poll',
    body: body.question,
    meta: makePollMeta(body.question, body.options, body.multiple),
  });
  return c.json({ message }, 201);
});

conversationRoutes.post('/:id/read', async (c) => {
  const user = c.get('user');
  const { conv } = await requireMember(c.env, c.req.param('id'), user.id);
  await markRead(c.env, user.id, conv.id);
  return c.json({ ok: true });
});

export { AMIN_AI_USER_ID };
