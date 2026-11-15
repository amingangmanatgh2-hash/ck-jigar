import { AMIN_AI_USER_ID, type ConversationDto, type MessageDto, type RealtimeEvent } from '@aminchat/shared';
import { Convs } from '../lib/endpoints';
import { createStore, useStore } from '../lib/store';
import { stripMarkdown } from '../lib/text';

export interface ConversationsState {
  items: ConversationDto[];
  loaded: boolean;
  error: unknown;
}

export const convStore = createStore<ConversationsState>({ items: [], loaded: false, error: null });

/** Conversation currently open on screen: its unread counter stays at zero. */
export const activeConversation = createStore<string | null>(null);

export function sortConversations(items: ConversationDto[]): ConversationDto[] {
  const rank = (c: ConversationDto) => (c.type === 'ai' ? 2 : c.pinned ? 1 : 0);
  return [...items].sort((a, b) => rank(b) - rank(a) || (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
}

export function resetConversations(): void {
  convStore.set({ items: [], loaded: false, error: null });
  activeConversation.set(null);
}

export async function loadConversations(): Promise<void> {
  try {
    const { conversations } = await Convs.list();
    // the server counts as unread whatever it has not been told about yet; what is open on screen is being read
    const open = activeConversation.get();
    const items = open ? conversations.map((c) => (c.id === open && c.unread ? { ...c, unread: 0 } : c)) : conversations;
    convStore.set({ items: sortConversations(items), loaded: true, error: null });
  } catch (error) {
    convStore.set((s) => ({ ...s, loaded: true, error }));
  }
}

export function upsertConversation(conv: ConversationDto): void {
  convStore.set((s) => {
    const exists = s.items.some((c) => c.id === conv.id);
    const items = exists ? s.items.map((c) => (c.id === conv.id ? conv : c)) : [...s.items, conv];
    return { ...s, items: sortConversations(items) };
  });
}

export function removeConversation(id: string): void {
  convStore.set((s) => ({ ...s, items: s.items.filter((c) => c.id !== id) }));
}

export function markRead(id: string): void {
  convStore.set((s) => ({ ...s, items: s.items.map((c) => (c.id === id && c.unread ? { ...c, unread: 0 } : c)) }));
}

/** One line for the list. The AI writes Markdown, which would show up as stray asterisks; people's text stays as typed. */
export const previewOf = (m: MessageDto): string => {
  if (m.cipher) return '';
  const body = m.body ?? '';
  const line = m.senderId === AMIN_AI_USER_ID ? stripMarkdown(body) : body.replace(/\s+/g, ' ').trim();
  return line.slice(0, 120) || (m.attachments.length ? '📎' : '');
};

function withMessage(c: ConversationDto, m: MessageDto, meId: string | null): ConversationDto {
  const fromOther = m.senderId !== meId;
  return {
    ...c,
    lastMessage: { id: m.id, senderId: m.senderId, preview: previewOf(m), kind: m.kind, encrypted: !!m.cipher, createdAt: m.createdAt },
    lastMessageAt: m.createdAt,
    unread: fromOther && activeConversation.get() !== c.id && m.status !== 'streaming' ? c.unread + 1 : c.unread,
  };
}

/** Folds one realtime event into the list. Returns true when the list should be refetched instead. */
export function applyRealtimeEvent(ev: RealtimeEvent, meId: string | null): 'ok' | 'refetch' {
  const items = convStore.get().items;
  switch (ev.type) {
    case 'message.created': {
      const m = ev.message;
      const c = items.find((x) => x.id === m.conversationId);
      if (!c) return 'refetch';
      convStore.set((s) => ({ ...s, items: sortConversations(s.items.map((x) => (x.id === c.id ? withMessage(x, m, meId) : x))) }));
      return 'ok';
    }
    case 'message.updated': {
      const m = ev.message;
      const c = items.find((x) => x.id === m.conversationId);
      if (!c || c.lastMessage?.id !== m.id) return 'ok';
      convStore.set((s) => ({
        ...s,
        items: s.items.map((x) => (x.id === c.id && x.lastMessage ? { ...x, lastMessage: { ...x.lastMessage, preview: previewOf(m), encrypted: !!m.cipher } } : x)),
      }));
      return 'ok';
    }
    case 'message.deleted': {
      const c = items.find((x) => x.id === ev.conversationId);
      return c?.lastMessage?.id === ev.messageId ? 'refetch' : 'ok';
    }
    case 'conversation.updated':
      return 'refetch';
    default:
      return 'ok';
  }
}

export const useConversations = (): ConversationsState => useStore(convStore, (s) => s);
export const useConversation = (id: string | undefined): ConversationDto | undefined => useStore(convStore, (s) => s.items.find((c) => c.id === id));
export const useAiConversation = (): ConversationDto | undefined => useStore(convStore, (s) => s.items.find((c) => c.type === 'ai'));
