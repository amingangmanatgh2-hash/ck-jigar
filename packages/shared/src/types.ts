import type { AccessDecision, AiAccessMode, AiInvokeRoles, GroupAiLevel, MemberRole } from './access';
import type { AgentId, Locale, MemoryKind, ModelProviderId, ModelRole } from './constants';

/* ------------------------------------------------------------------ users & auth */

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  kind: 'human' | 'ai';
  /** Verified-AI badge (official assistant). */
  verified: boolean;
  bio: string | null;
  /** True when the user has published an end-to-end encryption public key. */
  hasE2eeKey?: boolean;
}

export interface SelfDto extends UserDto {
  role: 'user' | 'admin';
  locale: Locale;
  timezone: string;
}

export interface AuthResponse {
  token: string;
  expiresAt: number;
  user: SelfDto;
}

export interface SessionDto {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  userAgent: string | null;
  current: boolean;
}

/* ------------------------------------------------------------------ files */

export type FileKind = 'image' | 'audio' | 'video' | 'document' | 'text' | 'archive' | 'other';

export interface AttachmentDto {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: FileKind;
  category: string | null;
  createdAt: number;
}

/* ------------------------------------------------------------------ messages */

export interface E2eePayload {
  v: 1;
  /** base64 IV (12 bytes) */
  iv: string;
  /** base64 AES-GCM ciphertext */
  ct: string;
}

export interface PollOption {
  id: string;
  text: string;
}

export interface PollDto {
  question: string;
  options: PollOption[];
  multiple: boolean;
  counts: Record<string, number>;
  totalVoters: number;
  myVotes: string[];
}

export interface SharedExcerpt {
  sender: string;
  text: string;
  at: number | null;
}

export interface MessageMeta {
  /** Present on messages produced by the assistant. */
  ai?: {
    agentId: AgentId | string;
    modelId: string | null;
    runId: string | null;
    fallbackFrom?: string | null;
    usage?: { inputTokens: number; outputTokens: number; estimated: boolean } | null;
    invokedBy?: string | null;
    /** How many times the answer was regenerated. */
    regenerations?: number;
    /** The answer is paused until the invoking user approves an action (shown to everyone as "waiting for approval"). */
    waiting?: 'approval' | null;
    /** Set when the answer could not be produced; the UI maps `code` to a localised text. */
    error?: { code: string; message: string } | null;
  };
  /** Content the user chose to share with the assistant from another conversation. */
  shared?: {
    conversationId: string | null;
    conversationTitle: string | null;
    e2ee: boolean;
    count: number;
    excerpts: SharedExcerpt[];
    instruction?: string;
  };
  system?: { code: string; [k: string]: unknown };
  announcement?: boolean;
  reminderId?: string;
  [k: string]: unknown;
}

/** What happened to an @AMINAI mention (returned to the sender only; nothing about a denial is ever posted into the chat). */
export interface AiTriggerResult {
  triggered: boolean;
  runId?: string;
  messageId?: string;
  denied?: { code: string; message: string; canEnable?: boolean };
}

export interface MessageDto {
  id: string;
  conversationId: string;
  threadId: string | null;
  senderId: string;
  kind: 'text' | 'system' | 'poll';
  body: string | null;
  cipher: E2eePayload | null;
  replyToId: string | null;
  viaAi: boolean;
  status: 'streaming' | 'sent' | 'failed' | 'cancelled';
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
  attachments: AttachmentDto[];
  meta: MessageMeta | null;
  poll?: PollDto | null;
  /** Run that produced / is producing this message (assistant messages). */
  runId?: string | null;
  /** The sender's own idempotency token (only returned to the sender). Lets a client match its pending copy with the stored message. */
  clientId?: string | null;
}

/* ------------------------------------------------------------------ conversations */

export interface MemberDto {
  user: UserDto;
  role: MemberRole;
  joinedAt: number;
}

export interface ConversationAiState {
  /** My own consent level for this conversation (direct chats). */
  myAccess: AiAccessMode;
  /** I blocked AI processing for this conversation. */
  myBlocked: boolean;
  /** Somebody else (direct chats) blocked AI processing. */
  peerBlocked: boolean;
  groupLevel: GroupAiLevel;
  invokeRoles: AiInvokeRoles;
  /** What the assistant could do if *I* invoked it right now. */
  effective: AccessDecision;
}

export interface ConversationDto {
  id: string;
  type: 'ai' | 'direct' | 'group';
  title: string | null;
  e2ee: boolean;
  createdAt: number;
  peer: UserDto | null;
  memberCount: number;
  members?: MemberDto[];
  lastMessage: { id: string; senderId: string; preview: string; kind: string; encrypted: boolean; createdAt: number } | null;
  lastMessageAt: number | null;
  unread: number;
  pinned: boolean;
  muted: boolean;
  myRole: MemberRole;
  ai: ConversationAiState;
}

/* ------------------------------------------------------------------ AI threads & runs */

export interface ThreadDto {
  id: string;
  title: string | null;
  kind: 'chat' | 'reminders';
  agentId: string;
  modelId: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
}

export type RunStatus = 'pending' | 'planning' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'skipped' | 'cancelled';
export type ToolRisk = 'read' | 'write' | 'sensitive';

/**
 * Something the client can offer or do after a step. It is only ever a *pointer*: the server has not changed anything because of it.
 * `open_chat` with a `conversationId` navigates to an existing chat; with only a `userId` the user may start that chat by tapping.
 */
export type StepAction =
  | { type: 'enable_ai_access'; conversationId: string; conversationTitle: string | null }
  | { type: 'open_chat'; conversationId: string | null; userId: string | null; title: string };

export interface RunStepDto {
  id: string;
  idx: number;
  title: string;
  tool: string;
  status: StepStatus;
  risk: ToolRisk;
  attempts: number;
  args: unknown;
  resolvedArgs: unknown;
  output: { text?: string; data?: unknown } | null;
  error: string | null;
  errorCode: string | null;
  /** True only if the tool confirmed the effect by re-reading the state. */
  verified: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  /** Hint for the UI: a one-click action (enabling AI access for a chat after a failure, or opening a chat the user asked for). */
  action?: StepAction | null;
}

export interface ApprovalDto {
  id: string;
  runId: string;
  stepId: string;
  action: string;
  summary: string;
  payload: Record<string, unknown>;
  editable: string[];
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: number;
  expiresAt: number;
}

export interface RunDto {
  id: string;
  kind: 'chat' | 'task' | 'assist';
  agentId: string;
  /** Agent chosen by the router when the user selected 'auto'. */
  resolvedAgentId?: string | null;
  status: RunStatus;
  goal: string;
  modelId: string | null;
  threadId: string | null;
  conversationId: string | null;
  resultMessageId: string | null;
  error: string | null;
  errorCode: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  steps: RunStepDto[];
  approvals: ApprovalDto[];
  /** One-sentence plan summary produced by the planner. */
  planSummary?: string | null;
  /** Text produced so far (for late subscribers). */
  text?: string | null;
}

/* ------------------------------------------------------------------ agents, models, usage, memory */

export interface ToolInfoDto {
  id: string;
  title: string;
  risk: ToolRisk;
  available: boolean;
  reason?: string | null;
}

export interface AgentDto {
  id: AgentId;
  name: { fa: string; en: string };
  description: { fa: string; en: string };
  icon: string;
  tools: ToolInfoDto[];
  /** 'direct' agents answer immediately; 'plan' agents plan tool steps first. */
  mode: 'direct' | 'plan' | 'router';
}

export type ModelStatus = 'available' | 'unavailable' | 'unknown';

export type ModelReasonCode = 'not_connected' | 'deprecated' | 'unverified' | 'stale' | 'check_failed';

export interface ModelDto {
  id: string;
  label: string;
  vendor: string;
  /** Where the model runs (its provider). Data sent to the model is processed there. */
  provider: ModelProviderId;
  roles: ModelRole[];
  capabilities: { vision: boolean; tools: boolean; json: boolean; reasoning: boolean; streaming: boolean };
  contextWindow: number;
  pricing: { inputPerM: number; outputPerM: number } | null;
  deprecatedOn: string | null;
  status: ModelStatus;
  reason: string | null;
  /** Machine-readable cause of a non-`available` status (so clients can localise it); `reason` keeps the English detail. */
  reasonCode: ModelReasonCode | null;
  checkedAt: number | null;
  latencyMs: number | null;
  /** True when the model can be picked by the user for chat. */
  selectable: boolean;
}

export interface ProviderDto {
  id: ModelProviderId;
  label: string;
  /** False when the server has no credentials/binding for this provider (its models are then never shown as ready). */
  connected: boolean;
}

export interface ModelsResponse {
  providers: ProviderDto[];
  models: ModelDto[];
  defaults: Record<ModelRole, string | null>;
  checkedAt: number | null;
}

export interface UsageSummaryDto {
  quota: { dailyTokens: number; dailyRequests: number; monthlyTokens: number; custom: boolean };
  today: { tokens: number; requests: number; errors: number };
  month: { tokens: number; requests: number };
  byDay: { day: string; tokens: number; requests: number }[];
  byModel: { modelId: string; tokens: number; requests: number; errors: number; fallbacks: number }[];
}

export interface MemoryItemDto {
  id: string;
  kind: MemoryKind;
  content: string;
  project: string | null;
  source: 'user' | 'ai_approved';
  createdAt: number;
  updatedAt: number;
}

export interface MemorySuggestionDto {
  id: string;
  kind: MemoryKind;
  content: string;
  project: string | null;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
}

export interface MemorySettingsDto {
  enabled: boolean;
  autoSuggest: boolean;
  allowHistoryRecall: boolean;
}

export interface TodoDto {
  id: string;
  title: string;
  notes: string | null;
  dueAt: number | null;
  priority: 'low' | 'normal' | 'high';
  status: 'open' | 'done';
  project: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface ReminderDto {
  id: string;
  text: string;
  remindAt: number;
  status: 'scheduled' | 'delivering' | 'delivered' | 'cancelled' | 'failed';
  deliveredAt: number | null;
}

export interface ProjectDto {
  id: string;
  name: string;
  goal: string | null;
  status: 'active' | 'paused' | 'done';
  milestones: { title: string; due?: string | null; done?: boolean }[];
  updatedAt: number;
}

export interface SearchHitDto {
  messageId: string;
  conversationId: string;
  threadId: string | null;
  threadTitle: string | null;
  conversationTitle: string | null;
  snippet: string;
  senderId: string;
  createdAt: number;
}

/* ------------------------------------------------------------------ realtime */

/** `GET /api/realtime/poll`: the long-poll fallback for networks where WebSockets do not work. */
export interface PollResponse {
  /** Identifies this server-side buffer; changes whenever it was lost (the client must resync when it changes). */
  epoch: string;
  /** Pass back as `seq` in the next call. */
  seq: number;
  events: RealtimeEvent[];
  /** The buffer cannot prove that nothing was missed: refetch what is on screen, then continue from `seq`. */
  reset: boolean;
}

/** `GET /api/health` — public. */
export interface HealthDto {
  ok: true;
  service: string;
  time: number;
  environment: string;
  /** Alternative addresses of this service (relays), advertised so that clients can keep working when the main address is blocked. */
  endpoints: string[];
  /**
   * Which AI services this deployment has credentials for (yes/no only — never a value). It lets a deployment be checked without
   * logging in; whether a model really answers is what the signed-in availability check ("Models & usage") finds out.
   */
  ai: Record<ModelProviderId, boolean>;
}

export type RealtimeEvent =
  | { type: 'hello'; userId: string; ts: number }
  | { type: 'message.created'; message: MessageDto }
  | { type: 'message.updated'; message: MessageDto }
  | { type: 'message.deleted'; conversationId: string; messageId: string }
  | { type: 'conversation.updated'; conversationId: string }
  | { type: 'typing'; conversationId: string; userId: string; ai?: boolean }
  | { type: 'run.updated'; run: RunDto }
  /** `offset` = number of characters of the answer that came before `text`, so clients can order, de-duplicate and buffer deltas. */
  | { type: 'run.delta'; runId: string; messageId: string | null; text: string; offset: number }
  | { type: 'run.step'; runId: string; step: RunStepDto }
  | { type: 'run.approval'; approval: ApprovalDto }
  | { type: 'memory.suggestion'; suggestion: MemorySuggestionDto }
  | { type: 'poll.updated'; conversationId: string; messageId: string; poll: PollDto };

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

/* ------------------------------------------------------------------------------------------------ file storage (admin) */

/** Health of the connection to Google Drive, the cold file tier. */
export type DriveHealth = 'not_configured' | 'ok' | 'degraded' | 'auth_failed' | 'quota_full';
/** The one thing an administrator should look at first. */
export type StorageAttention = 'drive_auth_failed' | 'drive_full' | 'drive_degraded' | 'r2_filling_without_drive' | null;

export interface StorageStatusDto {
  hot: { files: number; bytes: number; softLimitBytes: number; overLimit: boolean };
  cold: {
    configured: boolean;
    health: DriveHealth;
    /** Technical detail from Google (English). Show as a detail only, never as the explanation. */
    error: string | null;
    errorAt: number | null;
    okAt: number | null;
    folderId: string | null;
    files: number;
    bytes: number;
    account: { used: number; limit: number | null } | null;
  };
  policy: { afterDays: number; largeBytes: number; minAgeMinutes: number };
  lastRunAt: number | null;
  attention: StorageAttention;
}

export interface OffloadReportDto {
  skipped: 'not_configured' | 'auth_failed' | 'quota_full' | 'throttled' | 'nothing_to_do' | null;
  moved: number;
  bytes: number;
  failed: number;
  purged: number;
}
