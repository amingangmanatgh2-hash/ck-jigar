import { AMIN_AI_NAME, AMIN_AI_USER_ID } from '@aminchat/shared';
import { all, placeholders } from '../db/helpers';
import type { Env } from '../env';
import { formatLocal } from '../lib/datetime';
import { safeJsonParse, truncate } from '../lib/text';
import type { ConvRow } from './conversations';
import type { MessageRow } from './dto';

export type SeqMessageRow = MessageRow & { seq: number };

export async function displayNames(env: Env, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const map = new Map<string, string>();
  if (unique.length === 0) return map;
  const rows = await all<{ id: string; display_name: string }>(env.DB.prepare(`SELECT id, display_name FROM users WHERE id IN (${placeholders(unique.length)})`).bind(...unique));
  for (const r of rows) map.set(r.id, r.display_name);
  map.set(AMIN_AI_USER_ID, AMIN_AI_NAME);
  return map;
}

/** Human-readable label of a conversation from one user's point of view (group title, or the other person's name). */
export async function conversationLabel(env: Env, conv: ConvRow, viewerId: string): Promise<string> {
  if (conv.type === 'group') return conv.title ?? 'Group';
  if (conv.type === 'ai') return AMIN_AI_NAME;
  const rows = await all<{ display_name: string }>(
    env.DB.prepare(
      `SELECT u.display_name FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ? AND cm.user_id != ?`,
    ).bind(conv.id, viewerId),
  );
  return rows[0]?.display_name ?? 'Chat';
}

function lineFor(r: MessageRow, name: string, tz: string): string | null {
  if (r.deleted_at) return null;
  const time = formatLocal(r.created_at, tz);
  if (r.kind === 'system') return null;
  if (r.kind === 'poll') {
    const poll = safeJsonParse<{ poll?: { question: string; options: { text: string }[] } }>(r.meta)?.poll;
    return poll ? `[${time}] ${name} created a poll: "${poll.question}" — options: ${poll.options.map((o) => o.text).join(' | ')}` : null;
  }
  const body = r.body?.trim();
  if (!body) return null;
  return `[${time}] ${name}: ${body}`;
}

/** Renders messages (oldest first) as a plain transcript, keeping the NEWEST content when it has to be cut to `maxChars`. */
export async function renderTranscript(env: Env, rows: MessageRow[], tz: string, maxChars = 14_000): Promise<{ text: string; count: number }> {
  const names = await displayNames(env, rows.map((r) => r.sender_id));
  const lines: string[] = [];
  for (const r of rows) {
    const line = lineFor(r, names.get(r.sender_id) ?? 'Member', tz);
    if (line) lines.push(truncate(line, 1500));
  }
  let total = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i]!.length + 1;
    if (total > maxChars) break;
    kept.unshift(lines[i]!);
  }
  return { text: kept.join('\n'), count: kept.length };
}
