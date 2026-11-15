import {
  LIMITS,
  type AttachmentDto,
  type E2eePayload,
  type MessageDto,
  type MessageMeta,
  type PollDto,
  type PollOption,
} from '@aminchat/shared';
import { all, batch, first, placeholders } from '../db/helpers';
import type { Env } from '../env';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { newId, ID_PREFIX } from '../lib/ids';
import { publishToUsers } from '../lib/realtime';
import { normalizeForSearch, safeJsonParse } from '../lib/text';
import { listMemberIds, requireMember } from './conversations';
import { fileToDto, messageToDto, type FileRow, type MessageRow } from './dto';
import { purgeBlobs, type StoredFile } from '../storage/file-store';

export interface NewMessage {
  id?: string;
  conversationId: string;
  senderId: string;
  threadId?: string | null;
  kind?: 'text' | 'system' | 'poll';
  body?: string | null;
  cipher?: E2eePayload | null;
  replyToId?: string | null;
  viaAi?: boolean;
  status?: MessageRow['status'];
  meta?: MessageMeta | null;
  /** Files (already uploaded) to attach to this message. */
  fileIds?: string[];
  /** Whose uploads may be attached (defaults to the sender; AI messages attach files owned by the human). */
  attachmentOwnerId?: string;
  createdAt?: number;
  /** The sender's idempotency token: sending the same one twice yields ONE message (see findByClientId / isClientIdConflict). */
  clientId?: string | null;
}

export interface InsertOptions {
  /** Recipients of the realtime event (defaults to all human members). */
  notify?: boolean;
}

/* ------------------------------------------------------------------------------------------------ hydration */

export async function attachmentsFor(env: Env, messageIds: string[]): Promise<Map<string, AttachmentDto[]>> {
  const map = new Map<string, AttachmentDto[]>();
  if (messageIds.length === 0) return map;
  const rows = await all<FileRow>(
    env.DB.prepare(`SELECT * FROM files WHERE message_id IN (${placeholders(messageIds.length)}) AND deleted_at IS NULL ORDER BY created_at, id`).bind(...messageIds),
  );
  for (const r of rows) {
    const arr = map.get(r.message_id!) ?? [];
    arr.push(fileToDto(r));
    map.set(r.message_id!, arr);
  }
  return map;
}

export async function pollsFor(env: Env, rows: MessageRow[], viewerId: string): Promise<Map<string, PollDto>> {
  const polls = new Map<string, PollDto>();
  const pollRows = rows.filter((r) => r.kind === 'poll' && !r.deleted_at);
  if (pollRows.length === 0) return polls;
  const ids = pollRows.map((r) => r.id);
  const votes = await all<{ message_id: string; user_id: string; option_id: string }>(
    env.DB.prepare(`SELECT message_id, user_id, option_id FROM poll_votes WHERE message_id IN (${placeholders(ids.length)})`).bind(...ids),
  );
  for (const r of pollRows) {
    const def = safeJsonParse<{ poll?: { question: string; options: PollOption[]; multiple: boolean } }>(r.meta)?.poll;
    if (!def) continue;
    const mine = votes.filter((v) => v.message_id === r.id && v.user_id === viewerId).map((v) => v.option_id);
    const counts: Record<string, number> = Object.fromEntries(def.options.map((o) => [o.id, 0]));
    const voters = new Set<string>();
    for (const v of votes) {
      if (v.message_id !== r.id) continue;
      counts[v.option_id] = (counts[v.option_id] ?? 0) + 1;
      voters.add(v.user_id);
    }
    polls.set(r.id, { question: def.question, options: def.options, multiple: !!def.multiple, counts, totalVoters: voters.size, myVotes: mine });
  }
  return polls;
}

export async function hydrateMessages(env: Env, rows: MessageRow[], viewerId: string): Promise<MessageDto[]> {
  const [atts, polls] = await Promise.all([attachmentsFor(env, rows.map((r) => r.id)), pollsFor(env, rows, viewerId)]);
  return rows.map((r) => {
    const dto = messageToDto(r, atts.get(r.id) ?? [], null, viewerId);
    const poll = polls.get(r.id);
    if (poll) dto.poll = poll;
    return dto;
  });
}

export async function getMessageRow(env: Env, id: string): Promise<MessageRow | null> {
  return first<MessageRow>(env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id));
}

/* ------------------------------------------------------------------------------------------------ writes */

/** Statement that (re)indexes a message for full-text search. Must run after the message row exists. */
export function ftsIndexStatements(env: Env, messageId: string, conversationId: string, threadId: string | null, body: string | null): D1PreparedStatement[] {
  const del = env.DB.prepare('DELETE FROM message_fts WHERE rowid = (SELECT seq FROM messages WHERE id = ?)').bind(messageId);
  if (!body || !body.trim()) return [del];
  return [
    del,
    env.DB.prepare(
      'INSERT INTO message_fts (rowid, conversation_id, thread_id, content) VALUES ((SELECT seq FROM messages WHERE id = ?), ?, ?, ?)',
    ).bind(messageId, conversationId, threadId, normalizeForSearch(body)),
  ];
}

/** The message this sender already stored under this idempotency token in this conversation, if any. */
export async function findByClientId(env: Env, conversationId: string, senderId: string, clientId: string): Promise<MessageDto | null> {
  const row = await first<MessageRow>(env.DB.prepare('SELECT * FROM messages WHERE conversation_id = ? AND sender_id = ? AND client_id = ?').bind(conversationId, senderId, clientId));
  if (!row) return null;
  const [dto] = await hydrateMessages(env, [row], senderId);
  return dto ?? null;
}

/** True when a write failed because the idempotency token was used concurrently (two identical requests raced). */
export const isClientIdConflict = (err: unknown): boolean => /UNIQUE constraint failed:.*client_id/i.test(String((err as Error)?.message ?? err));

export async function insertMessage(env: Env, m: NewMessage, opts: InsertOptions = {}): Promise<MessageDto> {
  const id = m.id ?? newId(ID_PREFIX.message);
  const now = m.createdAt ?? Date.now();
  const status = m.status ?? 'sent';
  const fileIds = [...new Set(m.fileIds ?? [])];
  if (fileIds.length > LIMITS.attachmentsPerMessage) throw badRequest(`At most ${LIMITS.attachmentsPerMessage} attachments per message`, undefined, 'TOO_MANY_ATTACHMENTS');
  const ownerId = m.attachmentOwnerId ?? m.senderId;

  if (fileIds.length > 0) {
    const owned = await all<{ id: string }>(
      env.DB.prepare(
        `SELECT id FROM files WHERE id IN (${placeholders(fileIds.length)}) AND owner_id = ? AND message_id IS NULL AND deleted_at IS NULL`,
      ).bind(...fileIds, ownerId),
    );
    if (owned.length !== fileIds.length) throw badRequest('One or more attachments are invalid or already used', undefined, 'INVALID_ATTACHMENT');
  }

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, thread_id, sender_id, kind, body, cipher, reply_to_id, via_ai, status, meta, created_at, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      m.conversationId,
      m.threadId ?? null,
      m.senderId,
      m.kind ?? 'text',
      m.body ?? null,
      m.cipher ? JSON.stringify(m.cipher) : null,
      m.replyToId ?? null,
      m.viaAi ? 1 : 0,
      status,
      m.meta ? JSON.stringify(m.meta) : null,
      now,
      m.clientId ?? null,
    ),
  ];
  for (const f of fileIds) {
    stmts.push(env.DB.prepare('UPDATE files SET message_id = ?, conversation_id = ? WHERE id = ?').bind(id, m.conversationId, f));
  }
  if (status === 'sent' && m.body && !m.cipher && (m.kind ?? 'text') === 'text') {
    stmts.push(...ftsIndexStatements(env, id, m.conversationId, m.threadId ?? null, m.body).slice(1));
  }
  stmts.push(env.DB.prepare('UPDATE conversations SET last_message_id = ?, last_message_at = ? WHERE id = ?').bind(id, now, m.conversationId));
  await batch(env.DB, stmts);

  const row = (await getMessageRow(env, id))!;
  const members = await listMemberIds(env, m.conversationId);
  const [dto] = await hydrateMessages(env, [row], m.senderId);
  if (opts.notify !== false) {
    // The idempotency token is the sender's own business: only the sender's other devices get it back.
    const { clientId: _own, ...forOthers } = dto!;
    await Promise.all([
      publishToUsers(env, [m.senderId], { type: 'message.created', message: dto! }),
      publishToUsers(env, members.filter((id) => id !== m.senderId), { type: 'message.created', message: forOthers as MessageDto }),
    ]);
  }
  return dto!;
}

export interface ListOptions {
  conversationId: string;
  threadId?: string | null;
  before?: string | null;
  limit: number;
  viewerId: string;
}

export async function listMessages(env: Env, o: ListOptions): Promise<{ messages: MessageDto[]; hasMore: boolean }> {
  const binds: unknown[] = [o.conversationId];
  let where = 'conversation_id = ?';
  if (o.threadId !== undefined) {
    if (o.threadId === null) where += ' AND thread_id IS NULL';
    else {
      where += ' AND thread_id = ?';
      binds.push(o.threadId);
    }
  }
  if (o.before) {
    const cursor = await getMessageRow(env, o.before);
    if (cursor && cursor.conversation_id === o.conversationId) {
      where += ' AND (created_at < ? OR (created_at = ? AND seq < ?))';
      binds.push(cursor.created_at, cursor.created_at, (cursor as MessageRow & { seq: number }).seq);
    }
  }
  const rows = await all<MessageRow>(
    env.DB.prepare(`SELECT * FROM messages WHERE ${where} ORDER BY created_at DESC, seq DESC LIMIT ?`).bind(...binds, o.limit + 1),
  );
  const hasMore = rows.length > o.limit;
  const page = rows.slice(0, o.limit).reverse();
  return { messages: await hydrateMessages(env, page, o.viewerId), hasMore };
}

export async function editMessage(
  env: Env,
  userId: string,
  messageId: string,
  patch: { body?: string; cipher?: E2eePayload },
): Promise<MessageDto> {
  const row = await getMessageRow(env, messageId);
  if (!row) throw notFound('Message not found', 'MESSAGE_NOT_FOUND');
  await requireMember(env, row.conversation_id, userId);
  if (row.sender_id !== userId) throw forbidden('You can only edit your own messages', 'NOT_YOUR_MESSAGE');
  if (row.deleted_at) throw badRequest('Message was deleted', undefined, 'MESSAGE_DELETED');
  if (row.kind !== 'text') throw badRequest('This message cannot be edited', undefined, 'NOT_EDITABLE');
  if (row.via_ai) throw badRequest('Messages sent via AI cannot be edited', undefined, 'NOT_EDITABLE');
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  if (row.cipher) {
    if (!patch.cipher) throw badRequest('Encrypted messages must be edited with a new ciphertext', undefined, 'CIPHER_REQUIRED');
    stmts.push(env.DB.prepare('UPDATE messages SET cipher = ?, edited_at = ? WHERE id = ?').bind(JSON.stringify(patch.cipher), now, messageId));
  } else {
    if (patch.body === undefined) throw badRequest('body is required', undefined, 'BODY_REQUIRED');
    stmts.push(env.DB.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').bind(patch.body, now, messageId));
    stmts.push(...ftsIndexStatements(env, messageId, row.conversation_id, row.thread_id, patch.body));
  }
  await batch(env.DB, stmts);
  const updated = (await getMessageRow(env, messageId))!;
  const [dto] = await hydrateMessages(env, [updated], userId);
  await publishToUsers(env, await listMemberIds(env, row.conversation_id), { type: 'message.updated', message: dto! });
  return dto!;
}

export async function deleteMessage(env: Env, userId: string, messageId: string, isAdminOfGroup = false): Promise<void> {
  const row = await getMessageRow(env, messageId);
  if (!row) throw notFound('Message not found', 'MESSAGE_NOT_FOUND');
  const { conv, member } = await requireMember(env, row.conversation_id, userId);
  const own = row.sender_id === userId;
  const adminOfGroup = conv.type === 'group' && (member.role === 'owner' || member.role === 'admin');
  if (!own && !(adminOfGroup || isAdminOfGroup)) throw forbidden('You cannot delete this message', 'NOT_YOUR_MESSAGE');
  if (conv.type === 'ai' && !own && row.sender_id !== 'usr_amin_ai') throw forbidden('You cannot delete this message', 'NOT_YOUR_MESSAGE');
  const now = Date.now();
  await batch(env.DB, [
    env.DB.prepare(`UPDATE messages SET deleted_at = ?, body = NULL, cipher = NULL, meta = NULL WHERE id = ?`).bind(now, messageId),
    env.DB.prepare('DELETE FROM message_fts WHERE rowid = (SELECT seq FROM messages WHERE id = ?)').bind(messageId),
    env.DB.prepare('DELETE FROM poll_votes WHERE message_id = ?').bind(messageId),
    env.DB.prepare('UPDATE files SET deleted_at = ? WHERE message_id = ? AND deleted_at IS NULL').bind(now, messageId),
  ]);
  // Remove the stored blobs (R2 or Drive); whatever fails is retried by the periodic sweep (files.deleted_at is already set).
  const gone = await all<StoredFile>(env.DB.prepare('SELECT id, r2_key, tier, drive_id FROM files WHERE message_id = ? AND purged_at IS NULL').bind(messageId));
  await purgeBlobs(env, gone);
  await publishToUsers(env, await listMemberIds(env, row.conversation_id), { type: 'message.deleted', conversationId: row.conversation_id, messageId });
}

/* ------------------------------------------------------------------------------------------------ polls */

export function makePollMeta(question: string, options: string[], multiple: boolean): MessageMeta & { poll: { question: string; options: PollOption[]; multiple: boolean } } {
  const clean = options.map((o) => o.trim()).filter(Boolean);
  return {
    poll: {
      question: question.trim(),
      options: clean.map((text, i) => ({ id: `o${i + 1}`, text })),
      multiple,
    },
  };
}

export async function votePoll(env: Env, userId: string, messageId: string, optionIds: string[]): Promise<PollDto> {
  const row = await getMessageRow(env, messageId);
  if (!row || row.kind !== 'poll' || row.deleted_at) throw notFound('Poll not found', 'POLL_NOT_FOUND');
  await requireMember(env, row.conversation_id, userId);
  const def = safeJsonParse<{ poll?: { options: PollOption[]; multiple: boolean } }>(row.meta)?.poll;
  if (!def) throw notFound('Poll not found', 'POLL_NOT_FOUND');
  const valid = new Set(def.options.map((o) => o.id));
  const chosen = [...new Set(optionIds)];
  if (chosen.some((o) => !valid.has(o))) throw badRequest('Unknown poll option', undefined, 'INVALID_OPTION');
  if (!def.multiple && chosen.length > 1) throw badRequest('This poll allows a single choice', undefined, 'SINGLE_CHOICE');
  const now = Date.now();
  await batch(env.DB, [
    env.DB.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?').bind(messageId, userId),
    ...chosen.map((o) => env.DB.prepare('INSERT INTO poll_votes (message_id, user_id, option_id, created_at) VALUES (?, ?, ?, ?)').bind(messageId, userId, o, now)),
  ]);
  const members = await listMemberIds(env, row.conversation_id);
  // Every member sees their own votes highlighted, so each gets a personalised update.
  await Promise.all(
    members.map(async (member) => {
      const polls = await pollsFor(env, [row], member);
      const poll = polls.get(row.id);
      if (poll) await publishToUsers(env, [member], { type: 'poll.updated', conversationId: row.conversation_id, messageId, poll });
    }),
  );
  const polls = await pollsFor(env, [row], userId);
  return polls.get(row.id)!;
}

export async function markRead(env: Env, userId: string, conversationId: string): Promise<void> {
  await env.DB.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?')
    .bind(Date.now(), conversationId, userId)
    .run();
}
