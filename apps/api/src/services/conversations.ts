import {
  AMIN_AI_USER_ID,
  LIMITS,
  resolveAiAccess,
  type AccessDecision,
  type AccessInput,
  type AiAccessMode,
  type AiInvokeRoles,
  type ConversationDto,
  type GroupAiLevel,
  type MemberDto,
  type MemberRole,
} from '@aminchat/shared';
import { all, batch, first, isUniqueViolation, placeholders } from '../db/helpers';
import type { Env } from '../env';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { newId, ID_PREFIX } from '../lib/ids';
import { truncate } from '../lib/text';
import { publishToUsers } from '../lib/realtime';
import { messageToDto, userToDto, type MessageRow, type UserRow } from './dto';

export interface ConvRow {
  id: string;
  type: 'ai' | 'direct' | 'group';
  title: string | null;
  created_by: string | null;
  e2ee: number;
  direct_key: string | null;
  ai_level: GroupAiLevel;
  ai_invoke_roles: AiInvokeRoles;
  created_at: number;
  last_message_id: string | null;
  last_message_at: number | null;
}

export interface MemberRow {
  conversation_id: string;
  user_id: string;
  role: MemberRole;
  joined_at: number;
  pinned: number;
  muted: number;
  last_read_at: number;
  ai_access: AiAccessMode;
  ai_blocked: number;
}

export const getConversation = (env: Env, id: string) =>
  first<ConvRow>(env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(id));

export const getMember = (env: Env, conversationId: string, userId: string) =>
  first<MemberRow>(
    env.DB.prepare('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?').bind(conversationId, userId),
  );

/** Non-members get 404 (not 403) so the existence of private conversations is never revealed. */
export async function requireMember(env: Env, conversationId: string, userId: string): Promise<{ conv: ConvRow; member: MemberRow }> {
  const [conv, member] = await Promise.all([getConversation(env, conversationId), getMember(env, conversationId, userId)]);
  if (!conv || !member) throw notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
  return { conv, member };
}

export async function listMemberIds(env: Env, conversationId: string): Promise<string[]> {
  const rows = await all<{ user_id: string }>(
    env.DB.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').bind(conversationId),
  );
  return rows.map((r) => r.user_id).filter((id) => id !== AMIN_AI_USER_ID);
}

export const isAdminRole = (role: MemberRole) => role === 'owner' || role === 'admin';

/* ------------------------------------------------------------------------------------------------ AI access */

export async function loadAccessInput(env: Env, conv: ConvRow, member: MemberRow | null): Promise<AccessInput> {
  let anyBlocked = false;
  if (conv.type === 'direct') {
    const r = await first<{ n: number }>(
      env.DB.prepare('SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ? AND ai_blocked = 1').bind(conv.id),
    );
    anyBlocked = (r?.n ?? 0) > 0;
  }
  return {
    type: conv.type,
    e2ee: !!conv.e2ee,
    groupLevel: conv.ai_level,
    invokeRoles: conv.ai_invoke_roles,
    invoker: member ? { role: member.role, access: member.ai_access, blocked: !!member.ai_blocked } : null,
    anyBlocked,
  };
}

/** The single authority on "may the assistant look at this conversation on behalf of this user?". */
export async function computeAccess(env: Env, conv: ConvRow, member: MemberRow | null): Promise<AccessDecision> {
  return resolveAiAccess(await loadAccessInput(env, conv, member));
}

/* ------------------------------------------------------------------------------------------------ creation */

export async function ensureAiConversation(env: Env, userId: string): Promise<string> {
  const key = `ai:${userId}`;
  const existing = await first<{ id: string }>(env.DB.prepare('SELECT id FROM conversations WHERE direct_key = ?').bind(key));
  if (existing) return existing.id;
  const id = newId(ID_PREFIX.conversation);
  const now = Date.now();
  try {
    await batch(env.DB, [
      env.DB.prepare(
        `INSERT INTO conversations (id, type, title, created_by, e2ee, direct_key, created_at) VALUES (?, 'ai', NULL, ?, 0, ?, ?)`,
      ).bind(id, userId, key, now),
      env.DB.prepare(
        `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, pinned, ai_access) VALUES (?, ?, 'owner', ?, 1, 'context')`,
      ).bind(id, userId, now),
      env.DB.prepare(
        `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, ai_access) VALUES (?, ?, 'member', ?, 'off')`,
      ).bind(id, AMIN_AI_USER_ID, now),
    ]);
    return id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await first<{ id: string }>(env.DB.prepare('SELECT id FROM conversations WHERE direct_key = ?').bind(key));
    if (raced) return raced.id;
    throw err;
  }
}

async function loadHumans(env: Env, ids: string[]): Promise<UserRow[]> {
  if (ids.length === 0) return [];
  return all<UserRow>(
    env.DB.prepare(`SELECT * FROM users WHERE id IN (${placeholders(ids.length)}) AND kind = 'human' AND disabled_at IS NULL`).bind(...ids),
  );
}

export async function createDirect(env: Env, userId: string, peerId: string, e2ee: boolean): Promise<string> {
  if (peerId === userId) throw badRequest('You cannot start a chat with yourself', undefined, 'SELF_CHAT');
  if (peerId === AMIN_AI_USER_ID) return ensureAiConversation(env, userId);
  const [me, peer] = await loadHumans(env, [userId, peerId]).then((rows) => [rows.find((r) => r.id === userId), rows.find((r) => r.id === peerId)] as const);
  if (!me || !peer) throw notFound('User not found', 'USER_NOT_FOUND');
  if (e2ee && (!me.e2ee_public_key || !peer.e2ee_public_key)) {
    throw badRequest('Both users must have an encryption key on at least one device to start a secret chat', undefined, 'E2EE_KEY_MISSING');
  }
  const key = `d:${[userId, peerId].sort().join(':')}${e2ee ? ':e' : ''}`;
  const existing = await first<{ id: string }>(env.DB.prepare('SELECT id FROM conversations WHERE direct_key = ?').bind(key));
  if (existing) return existing.id;
  const id = newId(ID_PREFIX.conversation);
  const now = Date.now();
  try {
    await batch(env.DB, [
      env.DB.prepare(`INSERT INTO conversations (id, type, created_by, e2ee, direct_key, created_at) VALUES (?, 'direct', ?, ?, ?, ?)`).bind(
        id,
        userId,
        e2ee ? 1 : 0,
        key,
        now,
      ),
      env.DB.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`).bind(id, userId, now),
      env.DB.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`).bind(id, peerId, now),
    ]);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await first<{ id: string }>(env.DB.prepare('SELECT id FROM conversations WHERE direct_key = ?').bind(key));
    if (raced) return raced.id;
    throw err;
  }
  await publishToUsers(env, [userId, peerId], { type: 'conversation.updated', conversationId: id });
  return id;
}

export async function createGroup(env: Env, userId: string, title: string, memberIds: string[]): Promise<string> {
  const ids = [...new Set(memberIds.filter((m) => m !== userId))];
  if (ids.length + 1 > LIMITS.groupMembersMax) throw badRequest(`A group can have at most ${LIMITS.groupMembersMax} members`, undefined, 'GROUP_TOO_LARGE');
  const humans = await loadHumans(env, ids);
  if (humans.length !== ids.length) throw notFound('One or more users were not found', 'USER_NOT_FOUND');
  const id = newId(ID_PREFIX.conversation);
  const now = Date.now();
  await batch(env.DB, [
    env.DB.prepare(`INSERT INTO conversations (id, type, title, created_by, e2ee, created_at) VALUES (?, 'group', ?, ?, 0, ?)`).bind(
      id,
      truncate(title.trim(), LIMITS.titleMax, ''),
      userId,
      now,
    ),
    env.DB.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`).bind(id, userId, now),
    ...ids.map((m) => env.DB.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`).bind(id, m, now)),
  ]);
  await publishToUsers(env, [userId, ...ids], { type: 'conversation.updated', conversationId: id });
  return id;
}

export async function addMembers(env: Env, conv: ConvRow, actor: MemberRow, userIds: string[]): Promise<string[]> {
  if (conv.type !== 'group') throw badRequest('Members can only be added to groups', undefined, 'NOT_A_GROUP');
  if (!isAdminRole(actor.role)) throw forbidden('Only group admins can add members', 'ADMIN_ONLY');
  const current = new Set(await listMemberIds(env, conv.id));
  const fresh = [...new Set(userIds)].filter((id) => !current.has(id));
  if (current.size + fresh.length > LIMITS.groupMembersMax) throw badRequest(`A group can have at most ${LIMITS.groupMembersMax} members`, undefined, 'GROUP_TOO_LARGE');
  const humans = await loadHumans(env, fresh);
  if (humans.length !== fresh.length) throw notFound('One or more users were not found', 'USER_NOT_FOUND');
  const now = Date.now();
  await batch(
    env.DB,
    fresh.map((u) => env.DB.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`).bind(conv.id, u, now)),
  );
  await publishToUsers(env, [...current, ...fresh], { type: 'conversation.updated', conversationId: conv.id });
  return fresh;
}

export async function removeMember(env: Env, conv: ConvRow, actor: MemberRow, targetId: string): Promise<void> {
  if (conv.type !== 'group') throw badRequest('Members can only be removed from groups', undefined, 'NOT_A_GROUP');
  const target = await getMember(env, conv.id, targetId);
  if (!target) throw notFound('Member not found', 'MEMBER_NOT_FOUND');
  const self = actor.user_id === targetId;
  if (!self) {
    if (!isAdminRole(actor.role)) throw forbidden('Only group admins can remove members', 'ADMIN_ONLY');
    if (target.role === 'owner') throw forbidden('The owner cannot be removed', 'OWNER_PROTECTED');
    if (target.role === 'admin' && actor.role !== 'owner') throw forbidden('Only the owner can remove an admin', 'OWNER_ONLY');
  }
  const before = await listMemberIds(env, conv.id);
  await env.DB.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').bind(conv.id, targetId).run();
  const remaining = before.filter((u) => u !== targetId);
  if (remaining.length === 0) {
    await env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind(conv.id).run();
  } else if (target.role === 'owner') {
    // Ownership passes to the longest-serving admin, otherwise the longest-serving member.
    const next = await first<{ user_id: string }>(
      env.DB.prepare(
        `SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?
         ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at LIMIT 1`,
      ).bind(conv.id, AMIN_AI_USER_ID),
    );
    if (next) {
      await env.DB.prepare(`UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?`).bind(conv.id, next.user_id).run();
    }
  }
  await publishToUsers(env, before, { type: 'conversation.updated', conversationId: conv.id });
}

export async function setMemberRole(env: Env, conv: ConvRow, actor: MemberRow, targetId: string, role: 'admin' | 'member'): Promise<void> {
  if (conv.type !== 'group') throw badRequest('Roles only exist in groups', undefined, 'NOT_A_GROUP');
  if (actor.role !== 'owner') throw forbidden('Only the owner can change roles', 'OWNER_ONLY');
  const target = await getMember(env, conv.id, targetId);
  if (!target) throw notFound('Member not found', 'MEMBER_NOT_FOUND');
  if (target.role === 'owner') throw conflict('The owner role cannot be changed', 'OWNER_PROTECTED');
  await env.DB.prepare('UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?').bind(role, conv.id, targetId).run();
  await publishToUsers(env, await listMemberIds(env, conv.id), { type: 'conversation.updated', conversationId: conv.id });
}

/* ------------------------------------------------------------------------------------------------ DTOs */

function previewOf(row: MessageRow): string {
  if (row.deleted_at) return '';
  if (row.kind === 'poll') {
    try {
      const meta = JSON.parse(row.meta ?? '{}') as { poll?: { question?: string } };
      return truncate(`📊 ${meta.poll?.question ?? ''}`, 120);
    } catch {
      return '📊';
    }
  }
  if (row.cipher) return '';
  return truncate((row.body ?? '').replace(/\s+/g, ' ').trim(), 120);
}

export async function conversationDtos(
  env: Env,
  userId: string,
  rows: { conv: ConvRow; member: MemberRow }[],
  opts: { withMembers?: boolean } = {},
): Promise<ConversationDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.conv.id);
  const ph = placeholders(ids.length);

  const [peers, counts, blocked, lastMessages, unread] = await Promise.all([
    all<UserRow & { conversation_id: string }>(
      env.DB.prepare(
        `SELECT cm.conversation_id, u.* FROM conversation_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.conversation_id IN (${ph}) AND cm.user_id != ?`,
      ).bind(...ids, userId),
    ),
    all<{ conversation_id: string; n: number }>(
      env.DB.prepare(
        `SELECT conversation_id, COUNT(*) AS n FROM conversation_members WHERE conversation_id IN (${ph}) AND user_id != ? GROUP BY conversation_id`,
      ).bind(...ids, AMIN_AI_USER_ID),
    ),
    all<{ conversation_id: string; user_id: string; ai_blocked: number }>(
      env.DB.prepare(`SELECT conversation_id, user_id, ai_blocked FROM conversation_members WHERE conversation_id IN (${ph}) AND ai_blocked = 1`).bind(...ids),
    ),
    (async () => {
      const lastIds = rows.map((r) => r.conv.last_message_id).filter((x): x is string => !!x);
      if (lastIds.length === 0) return [] as MessageRow[];
      return all<MessageRow>(env.DB.prepare(`SELECT * FROM messages WHERE id IN (${placeholders(lastIds.length)})`).bind(...lastIds));
    })(),
    all<{ conversation_id: string; n: number }>(
      env.DB.prepare(
        `SELECT m.conversation_id, COUNT(*) AS n FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
         WHERE m.conversation_id IN (${ph}) AND m.created_at > cm.last_read_at AND m.sender_id != ?
           AND m.deleted_at IS NULL AND m.status != 'streaming' AND m.kind != 'system'
         GROUP BY m.conversation_id`,
      ).bind(userId, ...ids, userId),
    ),
  ]);

  const peerByConv = new Map<string, UserRow>();
  for (const p of peers) if (!peerByConv.has(p.conversation_id)) peerByConv.set(p.conversation_id, p);
  const countByConv = new Map(counts.map((c) => [c.conversation_id, c.n]));
  const lastById = new Map(lastMessages.map((m) => [m.id, m]));
  const unreadByConv = new Map(unread.map((u) => [u.conversation_id, u.n]));

  let membersByConv = new Map<string, MemberDto[]>();
  if (opts.withMembers) {
    const ms = await all<UserRow & { conversation_id: string; mrole: MemberRole; mjoined: number }>(
      env.DB.prepare(
        `SELECT cm.conversation_id, cm.role AS mrole, cm.joined_at AS mjoined, u.* FROM conversation_members cm
         JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id IN (${ph}) AND u.kind = 'human' ORDER BY cm.joined_at`,
      ).bind(...ids),
    );
    membersByConv = new Map();
    for (const m of ms) {
      const arr = membersByConv.get(m.conversation_id) ?? [];
      arr.push({ user: userToDto(m), role: m.mrole, joinedAt: m.mjoined });
      membersByConv.set(m.conversation_id, arr);
    }
  }

  const dtos: ConversationDto[] = [];
  for (const { conv, member } of rows) {
    const convBlocked = blocked.filter((b) => b.conversation_id === conv.id);
    const anyBlocked = convBlocked.length > 0;
    const effective = resolveAiAccess({
      type: conv.type,
      e2ee: !!conv.e2ee,
      groupLevel: conv.ai_level,
      invokeRoles: conv.ai_invoke_roles,
      invoker: { role: member.role, access: member.ai_access, blocked: !!member.ai_blocked },
      anyBlocked: conv.type === 'direct' ? anyBlocked : false,
    });
    const last = conv.last_message_id ? lastById.get(conv.last_message_id) : undefined;
    const peer = peerByConv.get(conv.id);
    dtos.push({
      id: conv.id,
      type: conv.type,
      title: conv.title,
      e2ee: !!conv.e2ee,
      createdAt: conv.created_at,
      peer: conv.type === 'group' ? null : peer ? userToDto(peer) : null,
      memberCount: countByConv.get(conv.id) ?? 0,
      ...(opts.withMembers ? { members: membersByConv.get(conv.id) ?? [] } : {}),
      lastMessage: last
        ? { id: last.id, senderId: last.sender_id, preview: previewOf(last), kind: last.kind, encrypted: !!last.cipher, createdAt: last.created_at }
        : null,
      lastMessageAt: conv.last_message_at,
      unread: unreadByConv.get(conv.id) ?? 0,
      pinned: !!member.pinned,
      muted: !!member.muted,
      myRole: member.role,
      ai: {
        myAccess: member.ai_access,
        myBlocked: !!member.ai_blocked,
        peerBlocked: convBlocked.some((b) => b.user_id !== userId),
        groupLevel: conv.ai_level,
        invokeRoles: conv.ai_invoke_roles,
        effective,
      },
    });
  }
  return dtos;
}

export async function listConversations(env: Env, userId: string): Promise<ConversationDto[]> {
  await ensureAiConversation(env, userId);
  const rows = await all<ConvRow & { m_role: MemberRole; m_joined: number; m_pinned: number; m_muted: number; m_read: number; m_access: AiAccessMode; m_blocked: number }>(
    env.DB.prepare(
      `SELECT c.*, cm.role AS m_role, cm.joined_at AS m_joined, cm.pinned AS m_pinned, cm.muted AS m_muted,
              cm.last_read_at AS m_read, cm.ai_access AS m_access, cm.ai_blocked AS m_blocked
       FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
       WHERE cm.user_id = ?
       ORDER BY cm.pinned DESC, COALESCE(c.last_message_at, c.created_at) DESC`,
    ).bind(userId),
  );
  const pairs = rows.map((r) => ({
    conv: {
      id: r.id,
      type: r.type,
      title: r.title,
      created_by: r.created_by,
      e2ee: r.e2ee,
      direct_key: r.direct_key,
      ai_level: r.ai_level,
      ai_invoke_roles: r.ai_invoke_roles,
      created_at: r.created_at,
      last_message_id: r.last_message_id,
      last_message_at: r.last_message_at,
    } satisfies ConvRow,
    member: {
      conversation_id: r.id,
      user_id: userId,
      role: r.m_role,
      joined_at: r.m_joined,
      pinned: r.m_pinned,
      muted: r.m_muted,
      last_read_at: r.m_read,
      ai_access: r.m_access,
      ai_blocked: r.m_blocked,
    } satisfies MemberRow,
  }));
  return conversationDtos(env, userId, pairs);
}

export async function getConversationDto(env: Env, userId: string, conversationId: string, withMembers = true): Promise<ConversationDto> {
  const { conv, member } = await requireMember(env, conversationId, userId);
  const [dto] = await conversationDtos(env, userId, [{ conv, member }], { withMembers });
  return dto!;
}

export { messageToDto };
