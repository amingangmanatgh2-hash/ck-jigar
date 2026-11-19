import { AMIN_AI_USER_ID, stripAiMention, type SharedExcerpt } from '@aminchat/shared';
import { AiClient, type ChatMessage, type ContentPart } from '../ai/client';
import { all, first, placeholders } from '../db/helpers';
import type { Env } from '../env';
import { formatLocal } from '../lib/datetime';
import { estimateTokens, safeJsonParse, truncate } from '../lib/text';
import type { ConvRow } from './conversations';
import type { FileRow, MessageRow } from './dto';
import { readFileForAi } from './file-text';
import { displayNames, renderTranscript, type SeqMessageRow } from './transcript';

export interface BuiltContext {
  messages: ChatMessage[];
  needsVision: boolean;
  /** Human-visible notes about things the model could not see (unreadable files …). */
  notes: string[];
}

const IMAGE_TOKENS = 900;
const PER_MESSAGE_ATTACHMENT_CHARS = 60_000;

async function filesOfMessages(env: Env, messageIds: string[]): Promise<Map<string, FileRow[]>> {
  const map = new Map<string, FileRow[]>();
  if (messageIds.length === 0) return map;
  const rows = await all<FileRow>(
    env.DB.prepare(`SELECT * FROM files WHERE message_id IN (${placeholders(messageIds.length)}) AND deleted_at IS NULL ORDER BY created_at, id`).bind(...messageIds),
  );
  for (const f of rows) {
    const list = map.get(f.message_id!) ?? [];
    list.push(f);
    map.set(f.message_id!, list);
  }
  return map;
}

interface Expanded {
  text: string;
  images: ContentPart[];
  notes: string[];
}

/** Reads the attachments of one message into prompt material. Images go to the vision model, documents/audio become text. */
export async function expandAttachments(
  env: Env,
  ai: AiClient,
  userId: string,
  files: FileRow[],
  opts: { runId?: string | null; signal?: AbortSignal; fullyExpand: boolean },
): Promise<Expanded> {
  const out: Expanded = { text: '', images: [], notes: [] };
  let budget = PER_MESSAGE_ATTACHMENT_CHARS;
  for (const f of files) {
    if (!opts.fullyExpand) {
      out.text += `\n[Earlier attachment: "${f.name}" (${f.kind})]`;
      continue;
    }
    const content = await readFileForAi(env, ai, userId, f, { maxChars: Math.min(30_000, budget), runId: opts.runId, signal: opts.signal });
    if (content.type === 'image') {
      out.images.push({ type: 'image_url', image_url: { url: content.dataUri } });
      out.text += `\n[Image attached: "${f.name}"]`;
    } else if (content.type === 'text') {
      budget -= content.text.length;
      const label = content.source === 'transcript' ? 'audio transcript' : f.kind;
      out.text += `\n[Attachment "${f.name}" (${label})${content.truncated ? ', truncated' : ''}]\n${content.text}\n[end of attachment]`;
    } else {
      out.text += `\n[Attachment "${f.name}" could not be read: ${content.reason}]`;
      out.notes.push(`${f.name}: ${content.reason}`);
    }
    if (budget <= 0) break;
  }
  return out;
}

export function renderShared(shared: NonNullable<import('@aminchat/shared').MessageMeta['shared']>, tz: string): string {
  const lines = shared.excerpts.map((e: SharedExcerpt) => `[${e.at ? formatLocal(e.at, tz) : '—'}] ${e.sender}: ${e.text}`);
  const title = shared.conversationTitle ? `the chat "${shared.conversationTitle}"` : 'a chat';
  return `The user selected and shared ${shared.count} message(s) from ${title}${shared.e2ee ? ' (a secret, end-to-end encrypted chat — only these messages were shared)' : ''}:\n${lines.join('\n')}\n[end of shared messages]`;
}

function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      const a: ContentPart[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
      const b: ContentPart[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      const allText = a.every((p) => p.type === 'text') && b.every((p) => p.type === 'text');
      if (allText) last.content = [...a, ...b].map((p) => (p.type === 'text' ? p.text : '')).join('\n\n');
      else last.content = [...a, ...b];
    } else out.push({ role: m.role, content: m.content });
  }
  return out;
}

/** Conversation history of an AMIN AI thread as chat messages, trimmed to a token budget (newest messages win). */
export async function buildThreadContext(
  env: Env,
  ai: AiClient,
  o: { userId: string; tz: string; threadId: string; triggerMessageId: string; budgetTokens: number; runId?: string | null; signal?: AbortSignal; expandLast?: number },
): Promise<BuiltContext> {
  const trigger = await first<SeqMessageRow>(env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(o.triggerMessageId));
  const seqLimit = trigger?.seq ?? Number.MAX_SAFE_INTEGER;
  const rows = await all<SeqMessageRow>(
    env.DB.prepare(
      `SELECT * FROM messages WHERE thread_id = ? AND deleted_at IS NULL AND kind = 'text' AND seq <= ? AND (sender_id != ? OR status = 'sent')
       ORDER BY seq DESC LIMIT 80`,
    ).bind(o.threadId, seqLimit, AMIN_AI_USER_ID),
  );

  // newest → oldest while within budget (the trigger message is always kept)
  const kept: SeqMessageRow[] = [];
  let tokens = 0;
  for (const r of rows) {
    const meta = safeJsonParse<import('@aminchat/shared').MessageMeta>(r.meta);
    const cost = estimateTokens(r.body ?? '') + (meta?.shared ? estimateTokens(meta.shared.excerpts.map((e: SharedExcerpt) => e.text).join('\n')) : 0) + 20;
    if (kept.length > 0 && tokens + cost > o.budgetTokens) break;
    kept.push(r);
    tokens += cost;
  }
  kept.reverse();

  const files = await filesOfMessages(env, kept.filter((r) => r.sender_id !== AMIN_AI_USER_ID).map((r) => r.id));
  const expandFrom = Math.max(0, kept.length - (o.expandLast ?? 3));
  const notes: string[] = [];
  let needsVision = false;
  const messages: ChatMessage[] = [];

  for (const [i, r] of kept.entries()) {
    if (r.sender_id === AMIN_AI_USER_ID) {
      if (r.body?.trim()) messages.push({ role: 'assistant', content: r.body });
      continue;
    }
    const meta = safeJsonParse<import('@aminchat/shared').MessageMeta>(r.meta);
    let text = '';
    if (meta?.shared) text += renderShared(meta.shared, o.tz) + '\n\n';
    text += r.body ?? '';
    const attachments = files.get(r.id) ?? [];
    const exp = attachments.length ? await expandAttachments(env, ai, o.userId, attachments, { runId: o.runId, signal: o.signal, fullyExpand: i >= expandFrom }) : null;
    if (exp) {
      text += exp.text;
      notes.push(...exp.notes);
    }
    if (exp && exp.images.length > 0) {
      needsVision = true;
      messages.push({ role: 'user', content: [{ type: 'text', text: text.trim() || 'Please look at the attached image.' }, ...exp.images] });
    } else {
      messages.push({ role: 'user', content: text.trim() || '(empty message)' });
    }
  }
  // Images in older turns would make every later request vision-only; keep only images of the newest user message.
  if (needsVision) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user' && typeof m.content !== 'string');
    for (const m of messages) {
      if (m !== lastUser && typeof m.content !== 'string') {
        m.content = m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ');
      }
    }
  }
  return { messages: mergeConsecutive(messages), needsVision, notes };
}

/** Context for an @AMINAI mention inside a shared chat. Level `mention` sees only the mention (+ the message it replies to). */
export async function buildAssistContext(
  env: Env,
  ai: AiClient,
  o: {
    conv: ConvRow;
    trigger: MessageRow;
    level: 'mention' | 'context';
    invokerId: string;
    invokerName: string;
    tz: string;
    budgetTokens: number;
    maxMessages?: number;
    runId?: string | null;
    signal?: AbortSignal;
  },
): Promise<BuiltContext & { transcriptCount: number }> {
  const triggerRow = (await first<SeqMessageRow>(env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(o.trigger.id)))!;
  const request = stripAiMention(o.trigger.body ?? '').trim() || 'Please help with this chat.';
  const replyTo = o.trigger.reply_to_id
    ? await first<SeqMessageRow>(env.DB.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL').bind(o.trigger.reply_to_id, o.conv.id))
    : null;

  let transcript = '';
  let transcriptCount = 0;
  if (o.level === 'context') {
    const rows = await all<SeqMessageRow>(
      env.DB.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND deleted_at IS NULL AND seq < ? AND thread_id IS NULL AND cipher IS NULL ORDER BY seq DESC LIMIT ?`).bind(o.conv.id, triggerRow.seq, o.maxMessages ?? 60),
    );
    const t = await renderTranscript(env, rows.reverse(), o.tz, Math.max(2000, o.budgetTokens * 3));
    transcript = t.text;
    transcriptCount = t.count;
  }

  const names = await displayNames(env, [o.trigger.sender_id, ...(replyTo ? [replyTo.sender_id] : [])]);
  const targets = [o.trigger, ...(replyTo ? [replyTo] : [])];
  const filesMap = await filesOfMessages(env, targets.map((m) => m.id));
  const exp = await expandAttachments(env, ai, o.invokerId, targets.flatMap((m) => filesMap.get(m.id) ?? []), {
    runId: o.runId,
    signal: o.signal,
    fullyExpand: true,
  });

  let text = '';
  if (transcript) text += `Recent messages of this chat (oldest first):\n${transcript}\n[end of recent messages]\n\n`;
  if (replyTo?.body) text += `The message being replied to — ${names.get(replyTo.sender_id) ?? 'Member'}: ${truncate(replyTo.body, 3000)}\n\n`;
  text += `${o.invokerName} asks: ${request}`;
  text += exp.text;

  const content: string | ContentPart[] = exp.images.length > 0 ? [{ type: 'text', text }, ...exp.images] : text;
  return { messages: [{ role: 'user', content }], needsVision: exp.images.length > 0, notes: exp.notes, transcriptCount };
}

export { IMAGE_TOKENS };
