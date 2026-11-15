import type { ConversationDto } from '@aminchat/shared';
import type { TFn } from './i18n';

/** Display name of a conversation: AMIN AI, the peer of a direct chat, or the group title. */
export function conversationTitle(c: ConversationDto, t: TFn): string {
  if (c.type === 'ai') return t('ai.name');
  if (c.type === 'direct') return c.peer?.displayName ?? t('chat.unknown');
  return c.title ?? t('chat.group');
}
