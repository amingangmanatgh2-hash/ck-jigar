/** Identity of the permanent AI contact. Seeded by migration 0001. */
export const AMIN_AI_USER_ID = 'usr_amin_ai';
export const AMIN_AI_USERNAME = 'aminai';
export const AMIN_AI_NAME = 'AMIN AI';
export const AMIN_AI_MENTION = '@AMINAI';

/** Usernames nobody may register (case-insensitive). */
export const RESERVED_USERNAMES = [
  'aminai',
  'amin_ai',
  'amin-ai',
  'aminchat',
  'amin_chat',
  'admin',
  'administrator',
  'root',
  'system',
  'support',
  'moderator',
  'ai',
  'bot',
];

export const USERNAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]{2,31}$/;

export const LIMITS = {
  passwordMin: 8,
  passwordMax: 128,
  displayNameMax: 60,
  messageMaxChars: 8000,
  cipherMaxChars: 24000,
  aiPromptMaxChars: 12000,
  titleMax: 80,
  groupMembersMax: 200,
  attachmentsPerMessage: 6,
  fileMaxBytes: 25 * 1024 * 1024,
  /** Largest file the AI pipeline will process (conversion / vision / transcription). */
  aiFileMaxBytes: 12 * 1024 * 1024,
  memoryItemMaxChars: 600,
  memoryItemsMax: 200,
  sharedExcerptsMax: 60,
  sharedExcerptChars: 4000,
  pollOptionsMax: 10,
  pollOptionChars: 100,
} as const;

export const AGENT_IDS = ['auto', 'general', 'personal', 'research', 'coder', 'messenger', 'file', 'creative'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const MODEL_ROLES = ['chat', 'fast', 'code', 'vision', 'asr', 'embedding', 'image'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export const MEMORY_KINDS = ['preference', 'project', 'fact', 'other'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const SUPPORTED_LOCALES = ['fa', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
