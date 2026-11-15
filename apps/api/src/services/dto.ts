import type {
  AttachmentDto,
  E2eePayload,
  FileKind,
  MessageDto,
  MessageMeta,
  SelfDto,
  UserDto,
} from '@aminchat/shared';
import { safeJsonParse } from '../lib/text';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string | null;
  kind: 'human' | 'ai';
  role: 'user' | 'admin';
  verified: number;
  bio: string | null;
  locale: string;
  timezone: string;
  e2ee_public_key: string | null;
  created_at: number;
  disabled_at: number | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  thread_id: string | null;
  sender_id: string;
  kind: 'text' | 'system' | 'poll';
  body: string | null;
  cipher: string | null;
  reply_to_id: string | null;
  via_ai: number;
  status: 'streaming' | 'sent' | 'failed' | 'cancelled';
  meta: string | null;
  edited_at: number | null;
  deleted_at: number | null;
  created_at: number;
}

export interface FileRow {
  id: string;
  owner_id: string;
  r2_key: string;
  name: string;
  mime: string;
  size: number;
  sha256: string | null;
  kind: FileKind;
  category: string | null;
  conversation_id: string | null;
  message_id: string | null;
  source: 'upload' | 'ai';
  created_at: number;
  deleted_at: number | null;
  /** Where the bytes are: 'r2' (hot), 'drive' (cold), or 'moving' while the offload job copies them. */
  tier: 'r2' | 'moving' | 'drive';
  drive_id: string | null;
  tier_changed_at: number | null;
  purged_at: number | null;
}

export const userToDto = (r: UserRow): UserDto => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  kind: r.kind,
  verified: !!r.verified,
  bio: r.bio,
  hasE2eeKey: !!r.e2ee_public_key,
});

export const userToSelfDto = (r: UserRow): SelfDto => ({
  ...userToDto(r),
  role: r.role,
  locale: r.locale === 'en' ? 'en' : 'fa',
  timezone: r.timezone,
});

export const fileToDto = (r: FileRow): AttachmentDto => ({
  id: r.id,
  name: r.name,
  mime: r.mime,
  size: r.size,
  kind: r.kind,
  category: r.category,
  createdAt: r.created_at,
});

export function messageToDto(r: MessageRow, attachments: AttachmentDto[] = [], runId: string | null = null): MessageDto {
  const deleted = !!r.deleted_at;
  const meta = deleted ? null : safeJsonParse<MessageMeta>(r.meta);
  return {
    id: r.id,
    conversationId: r.conversation_id,
    threadId: r.thread_id,
    senderId: r.sender_id,
    kind: r.kind,
    body: deleted ? null : r.body,
    cipher: deleted ? null : safeJsonParse<E2eePayload>(r.cipher),
    replyToId: r.reply_to_id,
    viaAi: !!r.via_ai,
    status: r.status,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    deleted,
    attachments: deleted ? [] : attachments,
    meta,
    runId: runId ?? meta?.ai?.runId ?? null,
  };
}
