import { z } from 'zod';
import { all, escapeLike } from '../../db/helpers';
import { listConversations } from '../../services/conversations';
import { userToDto, type UserRow } from '../../services/dto';
import { ToolError, type ToolDef } from './types';

/**
 * Quick navigation: "open my chat with Amin". The tool only LOOKS (the user's own chat list and the same user directory the
 * "new chat" screen searches) and hands the client a pointer to follow. It never sends, creates or reads anything: the pointer to a
 * person without a chat yet is a button, and the chat is created only when the user presses it.
 */

/** Matching key for names: Persian/Arabic letter variants, vowel marks, half-spaces, case and a leading @ do not matter. */
export function fold(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\u064A\u0649]/g, '\u06CC') // ي ى → ی
    .replace(/\u0643/g, '\u06A9') // ك → ک
    .replace(/[\u064B-\u065F\u0670\u0640\u200C\u200D]/g, '') // harakat, superscript alef, tatweel, ZWNJ, ZWJ
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

/** 3 = a name is exactly the query, 2 = a word or the beginning of a name is, 1 = the query is somewhere inside, 0 = no match. */
export function matchScore(query: string, names: readonly string[]): number {
  const q = fold(query);
  if (!q) return 0;
  let best = 0;
  for (const raw of names) {
    const n = fold(raw);
    if (!n) continue;
    if (n === q) best = Math.max(best, 3);
    else if (n.startsWith(q) || n.split(' ').includes(q)) best = Math.max(best, 2);
    else if (n.includes(q)) best = Math.max(best, 1);
  }
  return best;
}

const chatOpen = z.object({
  person: z.string().trim().min(1).max(80),
  /** Only when the user asked for the secret (end-to-end encrypted) chat with that person. */
  secret: z.boolean().optional().default(false),
});

interface ChatMatch {
  conversationId: string;
  userId: string | null;
  label: string;
  username: string | null;
  type: 'direct' | 'group';
  e2ee: boolean;
}

export const chatOpenTool: ToolDef<z.infer<typeof chatOpen>> = {
  id: 'chat_open',
  title: { fa: 'باز کردن گفتگو', en: 'Open chat' },
  description:
    'Find the chat the user wants to open: a chat with a person (by name or @username) or a group (by title). It only gives the user a button to open it — it never sends or creates anything.',
  argsHint:
    '{"person": string  // the name or @username of the person, or the title of the group — not a sentence, "secret"?: boolean  // true only if the user asked for the secret (end-to-end encrypted) chat}',
  risk: 'read',
  schema: chatOpen,
  async run(ctx, a) {
    const query = a.person.trim();
    if (fold(query).length < 2) throw new ToolError('PERSON_REQUIRED', 'Say whose chat to open (at least two letters of a name or username).');

    // 1. the user's own chats
    const convs = (await listConversations(ctx.env, ctx.user.id)).filter((c) => c.type !== 'ai');
    const found: (ChatMatch & { score: number })[] = [];
    for (const c of convs) {
      if (c.type === 'direct' && c.peer) {
        const score = matchScore(query, [c.peer.username, c.peer.displayName]);
        if (score > 0) found.push({ conversationId: c.id, userId: c.peer.id, label: c.peer.displayName, username: c.peer.username, type: 'direct', e2ee: c.e2ee, score });
      } else if (c.type === 'group' && c.title) {
        const score = matchScore(query, [c.title]);
        if (score > 0) found.push({ conversationId: c.id, userId: null, label: c.title, username: null, type: 'group', e2ee: false, score });
      }
    }
    const top = Math.max(0, ...found.map((m) => m.score));
    const best = found.filter((m) => m.score === top);

    // A normal and a secret chat with the same person are one person: the normal one, unless the user spoke of a secret chat.
    const reps = new Map<string, ChatMatch>();
    const siblings = new Map<string, number>();
    for (const m of best) {
      const key = m.userId ?? m.conversationId;
      const have = reps.get(key);
      if (!have) reps.set(key, m);
      else {
        siblings.set(key, (siblings.get(key) ?? 0) + 1);
        if (m.e2ee === a.secret) reps.set(key, m);
      }
    }
    const unique = [...reps.values()];

    if (unique.length === 1) {
      const m = unique[0]!;
      const who = m.username ? `${m.label} (@${m.username})` : m.label;
      const other = siblings.has(m.userId ?? m.conversationId) ? ` (There is also a ${m.e2ee ? 'normal' : 'secret'} chat with them; this is the ${m.e2ee ? 'secret' : 'normal'} one.)` : '';
      return {
        text: `Found the ${m.type === 'group' ? 'group' : 'chat with'} "${who}". It is ready: the user gets a button that opens it. Nothing was sent.${other}`,
        data: { matches: [{ id: m.conversationId, label: m.label, type: m.type, e2ee: m.e2ee }] },
        action: { type: 'open_chat', conversationId: m.conversationId, userId: m.userId, title: m.label },
      };
    }
    if (unique.length > 1) {
      const list = unique.slice(0, 6).map((m, i) => `${i + 1}. ${m.label}${m.username ? ` (@${m.username})` : ''}${m.type === 'group' ? ' [group]' : ''}`).join('\n');
      return {
        text: `Several chats match "${query}":\n${list}\nAsk the user which one they mean (nothing was opened).`,
        data: { matches: unique.slice(0, 6).map((m) => ({ id: m.conversationId, label: m.label, type: m.type, e2ee: m.e2ee })) },
      };
    }

    // 2. nobody in the chat list: the user directory (the same search as the "new chat" screen)
    const q = query.replace(/^@/, '');
    if (q.length < 2) return { text: `No chat matches "${query}".` };
    const like = `%${escapeLike(q)}%`;
    const rows = await all<UserRow>(
      ctx.env.DB.prepare(
        `SELECT * FROM users WHERE kind = 'human' AND disabled_at IS NULL AND id != ?
           AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
         ORDER BY CASE WHEN username LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, username LIMIT 20`,
      ).bind(ctx.user.id, like, like, `${escapeLike(q)}%`),
    );
    const people = rows.map(userToDto).map((u) => ({ u, score: matchScore(query, [u.username, u.displayName]) })).filter((x) => x.score > 0);
    const topPerson = Math.max(0, ...people.map((x) => x.score));
    const bestPeople = people.filter((x) => x.score === topPerson);
    if (bestPeople.length === 1) {
      const u = bestPeople[0]!.u;
      return {
        text: `There is no chat with "${u.displayName}" (@${u.username}) yet. The user gets a button to start one; nothing was created or sent.`,
        data: { matches: [{ id: null, userId: u.id, label: u.displayName, type: 'direct' }] },
        action: { type: 'open_chat', conversationId: null, userId: u.id, title: u.displayName },
      };
    }
    if (bestPeople.length > 1) {
      const list = bestPeople.slice(0, 6).map((x, i) => `${i + 1}. ${x.u.displayName} (@${x.u.username})`).join('\n');
      return { text: `No chat with that name yet, but several people match "${query}":\n${list}\nAsk the user which one they mean (nothing was opened or created).` };
    }
    return { text: `No chat or person matches "${query}".` };
  },
};
