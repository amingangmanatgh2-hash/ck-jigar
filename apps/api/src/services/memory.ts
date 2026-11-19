import { LIMITS, type MemoryItemDto, type MemoryKind, type MemorySettingsDto, type MemorySuggestionDto } from '@aminchat/shared';
import { all, batch, first } from '../db/helpers';
import type { Env } from '../env';
import { badRequest, conflict, notFound } from '../lib/errors';
import { ID_PREFIX, newId } from '../lib/ids';
import { publishToUsers } from '../lib/realtime';
import { normalizeForSearch, truncate } from '../lib/text';

interface MemoryRow {
  id: string;
  user_id: string;
  kind: MemoryKind;
  content: string;
  project: string | null;
  source: 'user' | 'ai_approved';
  source_run_id: string | null;
  created_at: number;
  updated_at: number;
}

interface SuggestionRow {
  id: string;
  user_id: string;
  kind: MemoryKind;
  content: string;
  project: string | null;
  reason: string | null;
  run_id: string | null;
  status: 'pending' | 'approved' | 'rejected';
  created_at: number;
  decided_at: number | null;
}

const memoryToDto = (r: MemoryRow): MemoryItemDto => ({
  id: r.id, kind: r.kind, content: r.content, project: r.project, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at,
});
const suggestionToDto = (r: SuggestionRow): MemorySuggestionDto => ({
  id: r.id, kind: r.kind, content: r.content, project: r.project, reason: r.reason, status: r.status, createdAt: r.created_at,
});

/* ------------------------------------------------------------------------------------------------ settings */

export async function getMemorySettings(env: Env, userId: string): Promise<MemorySettingsDto> {
  const r = await first<{ enabled: number; auto_suggest: number; allow_history_recall: number }>(
    env.DB.prepare('SELECT enabled, auto_suggest, allow_history_recall FROM memory_settings WHERE user_id = ?').bind(userId),
  );
  // Defaults: memory on (it only ever stores what the user approves), history recall OFF (explicit opt-in).
  return { enabled: r ? !!r.enabled : true, autoSuggest: r ? !!r.auto_suggest : true, allowHistoryRecall: r ? !!r.allow_history_recall : false };
}

export async function updateMemorySettings(env: Env, userId: string, patch: Partial<MemorySettingsDto>): Promise<MemorySettingsDto> {
  const cur = await getMemorySettings(env, userId);
  const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as MemorySettingsDto;
  await env.DB.prepare(
    `INSERT INTO memory_settings (user_id, enabled, auto_suggest, allow_history_recall, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled, auto_suggest = excluded.auto_suggest,
       allow_history_recall = excluded.allow_history_recall, updated_at = excluded.updated_at`,
  )
    .bind(userId, next.enabled ? 1 : 0, next.autoSuggest ? 1 : 0, next.allowHistoryRecall ? 1 : 0, Date.now())
    .run();
  return next;
}

/* ------------------------------------------------------------------------------------------------ items */

export async function listMemories(env: Env, userId: string): Promise<MemoryItemDto[]> {
  const rows = await all<MemoryRow>(env.DB.prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC').bind(userId));
  return rows.map(memoryToDto);
}

async function countMemories(env: Env, userId: string): Promise<number> {
  return (await first<{ n: number }>(env.DB.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?').bind(userId)))?.n ?? 0;
}

async function findDuplicate(env: Env, userId: string, content: string): Promise<MemoryRow | null> {
  const norm = normalizeForSearch(content).replace(/\s+/g, ' ').trim();
  const rows = await all<MemoryRow>(env.DB.prepare('SELECT * FROM memories WHERE user_id = ?').bind(userId));
  return rows.find((r) => normalizeForSearch(r.content).replace(/\s+/g, ' ').trim() === norm) ?? null;
}

export async function createMemory(
  env: Env,
  userId: string,
  m: { kind: MemoryKind; content: string; project?: string | null; source: 'user' | 'ai_approved'; runId?: string | null },
): Promise<MemoryItemDto> {
  const content = m.content.trim();
  if (!content) throw badRequest('Memory text is empty', undefined, 'EMPTY_MEMORY');
  if (content.length > LIMITS.memoryItemMaxChars) throw badRequest(`Memory items can be at most ${LIMITS.memoryItemMaxChars} characters`, undefined, 'MEMORY_TOO_LONG');
  if ((await countMemories(env, userId)) >= LIMITS.memoryItemsMax) throw conflict(`You can keep at most ${LIMITS.memoryItemsMax} memory items`, 'MEMORY_FULL');
  const dup = await findDuplicate(env, userId, content);
  if (dup) return memoryToDto(dup);
  const id = newId(ID_PREFIX.memory);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO memories (id, user_id, kind, content, project, source, source_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, userId, m.kind, content, m.project?.trim() || null, m.source, m.runId ?? null, now, now)
    .run();
  return memoryToDto((await first<MemoryRow>(env.DB.prepare('SELECT * FROM memories WHERE id = ?').bind(id)))!);
}

export async function updateMemory(env: Env, userId: string, id: string, patch: { content?: string; kind?: MemoryKind; project?: string | null }): Promise<MemoryItemDto> {
  const row = await first<MemoryRow>(env.DB.prepare('SELECT * FROM memories WHERE id = ? AND user_id = ?').bind(id, userId));
  if (!row) throw notFound('Memory item not found', 'MEMORY_NOT_FOUND');
  const content = patch.content === undefined ? row.content : patch.content.trim();
  if (!content || content.length > LIMITS.memoryItemMaxChars) throw badRequest('Invalid memory text', undefined, 'INVALID_MEMORY');
  await env.DB.prepare('UPDATE memories SET content = ?, kind = ?, project = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(content, patch.kind ?? row.kind, patch.project === undefined ? row.project : patch.project?.trim() || null, Date.now(), id, userId)
    .run();
  return memoryToDto((await first<MemoryRow>(env.DB.prepare('SELECT * FROM memories WHERE id = ?').bind(id)))!);
}

export async function deleteMemory(env: Env, userId: string, id: string): Promise<void> {
  const res = await env.DB.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').bind(id, userId).run();
  if (!res.meta.changes) throw notFound('Memory item not found', 'MEMORY_NOT_FOUND');
}

/** Permanent erasure of everything AMIN AI remembers about the user (items and pending suggestions). */
export async function deleteAllMemory(env: Env, userId: string): Promise<{ memories: number; suggestions: number }> {
  const [a, b] = await batch(env.DB, [
    env.DB.prepare('DELETE FROM memories WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM memory_suggestions WHERE user_id = ?').bind(userId),
  ]);
  return { memories: a?.meta.changes ?? 0, suggestions: b?.meta.changes ?? 0 };
}

/* ------------------------------------------------------------------------------------------------ suggestions */

export async function listSuggestions(env: Env, userId: string): Promise<MemorySuggestionDto[]> {
  const rows = await all<SuggestionRow>(env.DB.prepare("SELECT * FROM memory_suggestions WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 50").bind(userId));
  return rows.map(suggestionToDto);
}

/** Records a proposal. Nothing becomes a memory until the user approves it. Returns null if it duplicates an existing item/proposal. */
export async function createSuggestion(
  env: Env,
  userId: string,
  s: { kind: MemoryKind; content: string; project?: string | null; reason?: string | null; runId?: string | null },
): Promise<MemorySuggestionDto | null> {
  const content = truncate(s.content.trim(), LIMITS.memoryItemMaxChars, '');
  if (content.length < 3) return null;
  if (await findDuplicate(env, userId, content)) return null;
  const norm = normalizeForSearch(content).replace(/\s+/g, ' ').trim();
  const pending = await all<SuggestionRow>(env.DB.prepare("SELECT * FROM memory_suggestions WHERE user_id = ? AND status = 'pending'").bind(userId));
  if (pending.length >= 20 || pending.some((p) => normalizeForSearch(p.content).replace(/\s+/g, ' ').trim() === norm)) return null;
  const id = newId(ID_PREFIX.suggestion);
  await env.DB.prepare('INSERT INTO memory_suggestions (id, user_id, kind, content, project, reason, run_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, userId, s.kind, content, s.project?.trim() || null, s.reason ? truncate(s.reason, 200) : null, s.runId ?? null, 'pending', Date.now())
    .run();
  const dto = suggestionToDto((await first<SuggestionRow>(env.DB.prepare('SELECT * FROM memory_suggestions WHERE id = ?').bind(id)))!);
  await publishToUsers(env, [userId], { type: 'memory.suggestion', suggestion: dto });
  return dto;
}

export async function decideSuggestion(
  env: Env,
  userId: string,
  id: string,
  decision: 'approve' | 'reject',
  edits?: { content?: string; kind?: MemoryKind; project?: string | null },
): Promise<{ suggestion: MemorySuggestionDto; memory: MemoryItemDto | null }> {
  const row = await first<SuggestionRow>(env.DB.prepare('SELECT * FROM memory_suggestions WHERE id = ? AND user_id = ?').bind(id, userId));
  if (!row) throw notFound('Suggestion not found', 'SUGGESTION_NOT_FOUND');
  if (row.status !== 'pending') throw conflict('This suggestion was already decided', 'ALREADY_DECIDED');
  // Compare-and-set so a double click can never create two memories.
  const claimed = await env.DB.prepare("UPDATE memory_suggestions SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
    .bind(decision === 'approve' ? 'approved' : 'rejected', Date.now(), id)
    .run();
  if (!claimed.meta.changes) throw conflict('This suggestion was already decided', 'ALREADY_DECIDED');
  let memory: MemoryItemDto | null = null;
  if (decision === 'approve') {
    memory = await createMemory(env, userId, {
      kind: edits?.kind ?? row.kind,
      content: edits?.content ?? row.content,
      project: edits?.project === undefined ? row.project : edits.project,
      source: 'ai_approved',
      runId: row.run_id,
    });
  }
  return { suggestion: suggestionToDto({ ...row, status: decision === 'approve' ? 'approved' : 'rejected' }), memory };
}

/* ------------------------------------------------------------------------------------------------ recall */

const tokens = (s: string) => normalizeForSearch(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);

/**
 * The approved memory that is injected into the system prompt of the user's own AMIN AI conversations
 * (never into shared chats). Relevance = keyword overlap + project match + a small recency bonus.
 */
export async function memoryContextBlock(env: Env, userId: string, query: string, maxItems = 12, maxChars = 1800): Promise<string | null> {
  const settings = await getMemorySettings(env, userId);
  if (!settings.enabled) return null;
  const rows = await all<MemoryRow>(env.DB.prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200').bind(userId));
  if (rows.length === 0) return null;
  const q = new Set(tokens(query));
  const qNorm = normalizeForSearch(query);
  const scored = rows.map((r, i) => {
    const t = tokens(r.content + ' ' + (r.project ?? ''));
    const overlap = t.filter((x) => q.has(x)).length;
    const project = r.project && qNorm.includes(normalizeForSearch(r.project)) ? 3 : 0;
    const kindBonus = r.kind === 'preference' ? 0.5 : 0;
    return { r, score: overlap + project + kindBonus + Math.max(0, 1 - i / 40) };
  });
  scored.sort((a, b) => b.score - a.score);
  const lines: string[] = [];
  let used = 0;
  for (const { r } of scored.slice(0, maxItems)) {
    const line = `- ${r.kind}${r.project ? ` [${r.project}]` : ''}: ${r.content}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length ? lines.join('\n') : null;
}
