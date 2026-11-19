import type { SearchHitDto, ThreadDto } from '@aminchat/shared';
import { all, batch, escapeLike, first } from '../db/helpers';
import type { Env } from '../env';
import { badRequest, notFound } from '../lib/errors';
import { ID_PREFIX, newId } from '../lib/ids';
import { publishToUsers } from '../lib/realtime';
import { buildFtsQuery, normalizeForSearch, truncate } from '../lib/text';
import { ensureAiConversation } from './conversations';
import { purgeBlobs, type StoredFile } from '../storage/file-store';

export interface ThreadRow {
  id: string;
  user_id: string;
  conversation_id: string;
  title: string | null;
  kind: 'chat' | 'reminders';
  agent_id: string;
  model_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export const threadToDto = (t: ThreadRow, messageCount?: number): ThreadDto => ({
  id: t.id,
  title: t.title,
  kind: t.kind,
  agentId: t.agent_id,
  modelId: t.model_id,
  createdAt: t.created_at,
  updatedAt: t.updated_at,
  ...(messageCount === undefined ? {} : { messageCount }),
});

export async function createThread(
  env: Env,
  userId: string,
  opts: { title?: string | null; agentId?: string; modelId?: string | null; kind?: 'chat' | 'reminders' } = {},
): Promise<ThreadRow> {
  const conversationId = await ensureAiConversation(env, userId);
  const id = newId(ID_PREFIX.thread);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO ai_threads (id, user_id, conversation_id, title, kind, agent_id, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, conversationId, opts.title ? truncate(opts.title, 80) : null, opts.kind ?? 'chat', opts.agentId ?? 'auto', opts.modelId ?? null, now, now)
    .run();
  return (await getThreadRow(env, id))!;
}

export const getThreadRow = (env: Env, id: string) => first<ThreadRow>(env.DB.prepare('SELECT * FROM ai_threads WHERE id = ?').bind(id));

/** Threads are strictly private: other users get 404. */
export async function requireThread(env: Env, userId: string, id: string): Promise<ThreadRow> {
  const row = await getThreadRow(env, id);
  if (!row || row.user_id !== userId || row.archived_at) throw notFound('Conversation not found', 'THREAD_NOT_FOUND');
  return row;
}

export async function listThreads(env: Env, userId: string, limit = 60): Promise<ThreadDto[]> {
  const rows = await all<ThreadRow & { n: number }>(
    env.DB.prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.deleted_at IS NULL) AS n
       FROM ai_threads t WHERE t.user_id = ? AND t.archived_at IS NULL ORDER BY t.updated_at DESC LIMIT ?`,
    ).bind(userId, limit),
  );
  return rows.map((r) => threadToDto(r, r.n));
}

export async function touchThread(env: Env, id: string, patch: { title?: string | null; agentId?: string; modelId?: string | null } = {}): Promise<void> {
  const sets = ['updated_at = ?'];
  const binds: unknown[] = [Date.now()];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    binds.push(patch.title ? truncate(patch.title, 80) : null);
  }
  if (patch.agentId !== undefined) {
    sets.push('agent_id = ?');
    binds.push(patch.agentId);
  }
  if (patch.modelId !== undefined) {
    sets.push('model_id = ?');
    binds.push(patch.modelId);
  }
  await env.DB.prepare(`UPDATE ai_threads SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
}

/** The per-user thread that receives reminder notifications. */
export async function ensureRemindersThread(env: Env, userId: string): Promise<ThreadRow> {
  const existing = await first<ThreadRow>(env.DB.prepare("SELECT * FROM ai_threads WHERE user_id = ? AND kind = 'reminders' AND archived_at IS NULL LIMIT 1").bind(userId));
  if (existing) return existing;
  return createThread(env, userId, { title: 'Reminders', kind: 'reminders', agentId: 'personal' });
}

/**
 * Deletes a thread with everything that belongs to it: messages, search-index rows, attached files (R2 + rows).
 * Runs that are still active must be cancelled by the caller first.
 */
export async function deleteThread(env: Env, userId: string, threadId: string): Promise<void> {
  const thread = await requireThread(env, userId, threadId);
  const files = await all<StoredFile>(
    env.DB.prepare('SELECT f.id, f.r2_key, f.tier, f.drive_id FROM files f JOIN messages m ON m.id = f.message_id WHERE m.thread_id = ? AND f.owner_id = ? AND f.deleted_at IS NULL').bind(thread.id, userId),
  );
  await batch(env.DB, [
    env.DB.prepare('DELETE FROM message_fts WHERE rowid IN (SELECT seq FROM messages WHERE thread_id = ?)').bind(thread.id),
    // soft-delete: the row keeps its R2 key / Drive id until the blob is really gone (purgeBlobs below, or the periodic sweep)
    env.DB.prepare('UPDATE files SET deleted_at = ? WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?) AND owner_id = ? AND deleted_at IS NULL').bind(Date.now(), thread.id, userId),
    env.DB.prepare('DELETE FROM runs WHERE thread_id = ?').bind(thread.id),
    env.DB.prepare('DELETE FROM messages WHERE thread_id = ?').bind(thread.id),
    env.DB.prepare('DELETE FROM ai_threads WHERE id = ?').bind(thread.id),
  ]);
  await purgeBlobs(env, files);
  await publishToUsers(env, [userId], { type: 'conversation.updated', conversationId: thread.conversation_id });
}

/* ------------------------------------------------------------------------------------------------ search */

function makeSnippet(body: string, query: string, max = 180): string {
  const text = body.replace(/\s+/g, ' ').trim();
  const normalized = normalizeForSearch(text);
  const token = normalizeForSearch(query).split(/[^\p{L}\p{N}]+/u).find((t) => t.length > 0);
  let at = token && normalized.length === text.length ? normalized.indexOf(token) : -1;
  if (at < 0) at = 0;
  const start = Math.max(0, at - Math.floor(max / 3));
  const slice = text.slice(start, start + max);
  return (start > 0 ? '…' : '') + slice + (start + max < text.length ? '…' : '');
}

/**
 * Full-text search. `ai` searches the user's AMIN AI conversations only; `all` searches every conversation the user is a member of.
 * End-to-end encrypted messages are never indexed (the server has no plaintext).
 */
export async function searchMessages(
  env: Env,
  userId: string,
  q: string,
  opts: { scope: 'ai' | 'all'; limit: number; conversationId?: string },
): Promise<SearchHitDto[]> {
  const fts = buildFtsQuery(q);
  if (!fts) throw badRequest('Search text is empty', undefined, 'EMPTY_QUERY');
  const binds: unknown[] = [fts, userId];
  let scope = '';
  if (opts.scope === 'ai') scope = "AND c.type = 'ai'";
  if (opts.conversationId) {
    scope += ' AND c.id = ?3';
    binds.push(opts.conversationId);
  }
  const rows = await all<{
    id: string; conversation_id: string; thread_id: string | null; sender_id: string; body: string; created_at: number;
    thread_title: string | null; conv_title: string | null; conv_type: string;
  }>(
    env.DB.prepare(
      `SELECT m.id, m.conversation_id, m.thread_id, m.sender_id, m.body, m.created_at,
              t.title AS thread_title, c.title AS conv_title, c.type AS conv_type
         FROM message_fts f
         JOIN messages m ON m.seq = f.rowid
         JOIN conversations c ON c.id = m.conversation_id
         JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?2
         LEFT JOIN ai_threads t ON t.id = m.thread_id
        WHERE message_fts MATCH ?1 AND m.deleted_at IS NULL AND m.body IS NOT NULL AND c.e2ee = 0
          AND (t.id IS NULL OR t.user_id = ?2) ${scope}
        ORDER BY rank LIMIT ?${binds.length + 1}`,
    ).bind(...binds, opts.limit),
  );
  return rows.map((r) => ({
    messageId: r.id,
    conversationId: r.conversation_id,
    threadId: r.thread_id,
    threadTitle: r.thread_title,
    conversationTitle: r.conv_title,
    snippet: makeSnippet(r.body, q),
    senderId: r.sender_id,
    createdAt: r.created_at,
  }));
}

export { escapeLike };
