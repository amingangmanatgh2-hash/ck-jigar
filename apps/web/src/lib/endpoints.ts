import type {
  AgentDto,
  ApprovalDto,
  AttachmentDto,
  AuthResponse,
  ConversationDto,
  E2eePayload,
  MemoryItemDto,
  MemorySettingsDto,
  MemorySuggestionDto,
  MessageDto,
  ModelsResponse,
  ProjectDto,
  ReminderDto,
  RunDto,
  SearchHitDto,
  SelfDto,
  SessionDto,
  ThreadDto,
  TodoDto,
  UsageSummaryDto,
  UserDto,
  AiTriggerResult,
  PollDto,
} from '@aminchat/shared';
import { http, request } from './api';

export interface SharedInput {
  conversationId: string;
  messageIds?: string[];
  excerpts?: { sender: string; text: string; at?: number | null }[];
}
export interface TurnBody {
  body?: string | null;
  fileIds?: string[];
  agentId?: string;
  modelId?: string | null;
  shared?: SharedInput;
}
export interface TurnResult {
  userMessage: MessageDto;
  assistantMessage: MessageDto;
  run: RunDto;
}
export interface MessagePage {
  messages: MessageDto[];
  hasMore: boolean;
  activeRunId?: string | null;
}

export const Auth = {
  register: (b: { username: string; password: string; displayName?: string; locale?: string; timezone?: string }) => http.post<AuthResponse>('/api/auth/register', b),
  login: (b: { username: string; password: string }) => http.post<AuthResponse>('/api/auth/login', b),
  logout: () => http.post<{ ok: true }>('/api/auth/logout'),
  me: () => http.get<{ user: SelfDto }>('/api/auth/me'),
  updateMe: (b: Partial<{ displayName: string; bio: string | null; locale: string; timezone: string }>) => http.patch<{ user: SelfDto }>('/api/auth/me', b),
  sessions: () => http.get<{ sessions: SessionDto[] }>('/api/auth/sessions'),
  revokeSession: (id: string) => http.del<{ ok: true }>(`/api/auth/sessions/${id}`),
  changePassword: (b: { currentPassword: string; newPassword: string }) => http.post<{ ok: true }>('/api/auth/change-password', b),
};

export const Users = {
  search: (q: string) => http.get<{ users: UserDto[] }>('/api/users/search', { q }),
  e2eeKey: (id: string) => http.get<{ jwk: JsonWebKey }>(`/api/users/${id}/e2ee-key`),
  setE2eeKey: (jwk: JsonWebKey) => http.put<{ ok: true }>('/api/users/me/e2ee-key', { jwk }),
};

export const Convs = {
  list: () => http.get<{ conversations: ConversationDto[] }>('/api/conversations'),
  get: (id: string) => http.get<{ conversation: ConversationDto }>(`/api/conversations/${id}`),
  direct: (userId: string, e2ee: boolean) => http.post<{ conversation: ConversationDto }>('/api/conversations/direct', { userId, e2ee }),
  group: (title: string, memberIds: string[]) => http.post<{ conversation: ConversationDto }>('/api/conversations/group', { title, memberIds }),
  patch: (id: string, b: Partial<{ title: string; pinned: boolean; muted: boolean }>) => http.patch<{ conversation: ConversationDto }>(`/api/conversations/${id}`, b),
  addMembers: (id: string, userIds: string[]) => http.post<{ added: string[]; conversation: ConversationDto }>(`/api/conversations/${id}/members`, { userIds }),
  removeMember: (id: string, userId: string) => http.del<{ ok: true }>(`/api/conversations/${id}/members/${userId}`),
  setRole: (id: string, userId: string, role: 'admin' | 'member') => http.patch<{ conversation: ConversationDto }>(`/api/conversations/${id}/members/${userId}`, { role }),
  setAi: (id: string, b: { access?: 'off' | 'mention' | 'context'; blocked?: boolean }) => http.put<{ conversation: ConversationDto }>(`/api/conversations/${id}/ai`, b),
  setAiPolicy: (id: string, b: { level: 'off' | 'mention' | 'context' | 'assist'; invokeRoles: 'all' | 'admins' }) => http.put<{ conversation: ConversationDto }>(`/api/conversations/${id}/ai-policy`, b),
  messages: (id: string, q: { before?: string; limit?: number } = {}) => http.get<MessagePage>(`/api/conversations/${id}/messages`, q),
  send: (id: string, b: { body?: string; cipher?: E2eePayload; replyToId?: string; fileIds?: string[] }) => http.post<{ message: MessageDto; ai: AiTriggerResult }>(`/api/conversations/${id}/messages`, b),
  poll: (id: string, b: { question: string; options: string[]; multiple: boolean }) => http.post<{ message: MessageDto }>(`/api/conversations/${id}/polls`, b),
  read: (id: string) => http.post<{ ok: true }>(`/api/conversations/${id}/read`),
};

export const Msgs = {
  edit: (id: string, b: { body?: string; cipher?: E2eePayload }) => http.put<{ message: MessageDto }>(`/api/messages/${id}`, b),
  remove: (id: string) => http.del<{ ok: true }>(`/api/messages/${id}`),
  vote: (id: string, optionIds: string[]) => http.post<{ poll: PollDto }>(`/api/messages/${id}/vote`, { optionIds }),
};

export const Files = {
  upload: async (file: File | Blob, name?: string): Promise<AttachmentDto> => {
    const form = new FormData();
    form.set('file', file, name ?? (file instanceof File ? file.name : 'recording'));
    return (await request<{ file: AttachmentDto }>('POST', '/api/files', { body: form })).file;
  },
  remove: (id: string) => http.del<{ ok: true }>(`/api/files/${id}`),
};

export const Ai = {
  agents: () => http.get<{ agents: AgentDto[] }>('/api/ai/agents'),
  models: () => http.get<ModelsResponse>('/api/ai/models'),
  refreshModels: () => http.post<ModelsResponse>('/api/ai/models/refresh'),
  usage: () => http.get<UsageSummaryDto>('/api/ai/usage'),
  threads: () => http.get<{ threads: ThreadDto[] }>('/api/ai/threads'),
  createThread: (b: { title?: string | null; agentId?: string; modelId?: string | null } = {}) => http.post<{ thread: ThreadDto }>('/api/ai/threads', b),
  patchThread: (id: string, b: { title?: string; agentId?: string; modelId?: string | null }) => http.patch<{ thread: ThreadDto }>(`/api/ai/threads/${id}`, b),
  deleteThread: (id: string) => http.del<{ ok: true }>(`/api/ai/threads/${id}`),
  messages: (threadId: string, q: { before?: string; limit?: number } = {}) => http.get<MessagePage>(`/api/ai/threads/${threadId}/messages`, q),
  send: (threadId: string, b: TurnBody) => http.post<TurnResult>(`/api/ai/threads/${threadId}/messages`, b),
  regenerate: (threadId: string, b: { agentId?: string; modelId?: string | null } = {}) => http.post<TurnResult>(`/api/ai/threads/${threadId}/regenerate`, b),
  edit: (threadId: string, messageId: string, b: { body: string; agentId?: string; modelId?: string | null }) => http.put<TurnResult>(`/api/ai/threads/${threadId}/messages/${messageId}`, b),
  createTask: (b: { goal: string; agentId?: string; modelId?: string | null; fileIds?: string[] }) => http.post<TurnResult & { thread: ThreadDto }>('/api/ai/tasks', b),
  search: (q: string, scope: 'ai' | 'all' = 'ai') => http.get<{ hits: SearchHitDto[] }>('/api/ai/search', { q, scope }),
  transcribe: async (audio: Blob, lang: string): Promise<{ text: string; modelId: string }> =>
    request('POST', '/api/ai/transcribe', { body: audio, headers: { 'Content-Type': audio.type || 'audio/webm' }, query: { lang } }),
  runs: (status: 'active' | 'finished' | 'all' = 'all', limit = 20) => http.get<{ runs: RunDto[] }>('/api/ai/runs', { status, limit }),
  run: (id: string) => http.get<{ run: RunDto }>(`/api/ai/runs/${id}`),
  runLog: (id: string) => http.get<{ events: { id: number; stepId: string | null; ts: number; level: string; type: string; data: unknown }[] }>(`/api/ai/runs/${id}/events`),
  retryRun: (id: string) => http.post<TurnResult>(`/api/ai/runs/${id}/retry`),
  cancelRun: (id: string) => http.post<{ ok: true }>(`/api/ai/runs/${id}/cancel`),
  approvals: () => http.get<{ approvals: ApprovalDto[] }>('/api/ai/approvals'),
  decide: (id: string, decision: 'approve' | 'reject', edits?: Record<string, unknown>) => http.post<{ approval: ApprovalDto }>(`/api/ai/approvals/${id}/decision`, { decision, ...(edits ? { edits } : {}) }),

  memory: () => http.get<{ settings: MemorySettingsDto; items: MemoryItemDto[]; suggestions: MemorySuggestionDto[] }>('/api/ai/memory'),
  memorySettings: (b: Partial<MemorySettingsDto>) => http.patch<{ settings: MemorySettingsDto }>('/api/ai/memory/settings', b),
  addMemory: (b: { kind: string; content: string; project?: string | null }) => http.post<{ item: MemoryItemDto }>('/api/ai/memory/items', b),
  patchMemory: (id: string, b: { kind?: string; content?: string; project?: string | null }) => http.patch<{ item: MemoryItemDto }>(`/api/ai/memory/items/${id}`, b),
  deleteMemory: (id: string) => http.del<{ ok: true }>(`/api/ai/memory/items/${id}`),
  deleteAllMemory: () => http.del<{ ok: true; deleted: { memories: number; suggestions: number } }>('/api/ai/memory', { confirm: true }),
  decideSuggestion: (id: string, b: { decision: 'approve' | 'reject'; content?: string; kind?: string; project?: string | null }) =>
    http.post<{ suggestion: MemorySuggestionDto; memory: MemoryItemDto | null }>(`/api/ai/memory/suggestions/${id}/decision`, b),

  todos: (status: 'open' | 'done' | 'all' = 'open') => http.get<{ todos: TodoDto[] }>('/api/ai/todos', { status }),
  setTodo: (id: string, status: 'open' | 'done') => http.patch<{ ok: true }>(`/api/ai/todos/${id}`, { status }),
  deleteTodo: (id: string) => http.del<{ ok: true }>(`/api/ai/todos/${id}`),
  reminders: (status: 'scheduled' | 'all' = 'scheduled') => http.get<{ reminders: ReminderDto[] }>('/api/ai/reminders', { status }),
  deleteReminder: (id: string) => http.del<{ ok: true }>(`/api/ai/reminders/${id}`),
  projects: () => http.get<{ projects: ProjectDto[] }>('/api/ai/projects'),
  deleteProject: (id: string) => http.del<{ ok: true }>(`/api/ai/projects/${id}`),
};

export interface AdminOverview {
  days: number;
  byUser: { userId: string; username: string; tokens: number; requests: number }[];
  byModel: { modelId: string; tokens: number; requests: number; errors: number; fallbacks: number }[];
  runs: Record<string, number>;
}
export interface QuotaDto {
  dailyTokens: number;
  dailyRequests: number;
  monthlyTokens: number;
  custom: boolean;
}

export const Admin = {
  overview: (days = 7) => http.get<AdminOverview>('/api/admin/overview', { days }),
  userUsage: (id: string) => http.get<UsageSummaryDto>(`/api/admin/users/${id}/usage`),
  setQuota: (id: string, b: { dailyTokens: number | null; dailyRequests: number | null; monthlyTokens: number | null }) => http.put<{ quota: QuotaDto }>(`/api/admin/users/${id}/quota`, b),
};
