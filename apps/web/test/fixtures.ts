import type { ApprovalDto, MessageDto, ModelDto, ModelsResponse, ProviderDto, RunDto, RunStepDto, StorageStatusDto, UsageSummaryDto } from '@aminchat/shared';

export const message = (o: Partial<MessageDto> = {}): MessageDto => ({
  id: 'm1',
  conversationId: 'c1',
  threadId: 't1',
  senderId: 'usr_amin_ai',
  kind: 'text',
  body: '',
  cipher: null,
  replyToId: null,
  viaAi: false,
  status: 'sent',
  createdAt: 1_000,
  editedAt: null,
  deleted: false,
  attachments: [],
  meta: null,
  ...o,
});

export const step = (o: Partial<RunStepDto> = {}): RunStepDto => ({
  id: 's1',
  idx: 0,
  title: 'Step',
  tool: 'web_search',
  status: 'pending',
  risk: 'read',
  attempts: 0,
  args: {},
  resolvedArgs: null,
  output: null,
  error: null,
  errorCode: null,
  verified: false,
  startedAt: null,
  finishedAt: null,
  ...o,
});

export const run = (o: Partial<RunDto> = {}): RunDto => ({
  id: 'r1',
  kind: 'chat',
  agentId: 'personal',
  status: 'running',
  goal: 'goal',
  modelId: null,
  threadId: 't1',
  conversationId: 'c1',
  resultMessageId: null,
  error: null,
  errorCode: null,
  createdAt: 1,
  startedAt: 2,
  finishedAt: null,
  steps: [],
  approvals: [],
  ...o,
});

export const approval = (o: Partial<ApprovalDto> = {}): ApprovalDto => ({
  id: 'ap1',
  runId: 'r1',
  stepId: 's1',
  action: 'message_send',
  summary: 'Send a message to Reza',
  payload: { conversationId: 'c9', text: 'I will be late', _context: { conversation: 'Reza' } },
  editable: ['text'],
  status: 'pending',
  createdAt: 1,
  expiresAt: Date.now() + 3_600_000,
  ...o,
});

export const storageStatus = (o: Omit<Partial<StorageStatusDto>, 'cold'> & { cold?: Partial<StorageStatusDto['cold']> } = {}): StorageStatusDto => ({
  hot: { files: 12, bytes: 3 * 1024 ** 2, softLimitBytes: 8 * 1024 ** 3, overLimit: false },
  policy: { afterDays: 7, largeBytes: 5 * 1024 ** 2, minAgeMinutes: 60 },
  lastRunAt: null,
  attention: null,
  ...o,
  cold: { configured: true, health: 'ok', error: null, errorAt: null, okAt: null, folderId: 'fld1', files: 4, bytes: 20 * 1024 ** 2, account: null, ...o.cold },
});

export const model = (o: Partial<ModelDto> = {}): ModelDto => ({
  id: '@cf/google/gemma-4-26b-a4b-it',
  label: 'Gemma 4 26B',
  vendor: 'Google',
  provider: 'workers-ai',
  roles: ['chat'],
  capabilities: { vision: true, tools: true, json: true, reasoning: false, streaming: true },
  contextWindow: 256_000,
  pricing: null,
  deprecatedOn: null,
  status: 'available',
  reason: null,
  reasonCode: null,
  checkedAt: 1_000,
  latencyMs: 420,
  selectable: true,
  ...o,
});

export const provider = (o: Partial<ProviderDto> = {}): ProviderDto => ({ id: 'workers-ai', label: 'Cloudflare Workers AI', connected: true, ...o });

export const modelsResponse = (o: Partial<ModelsResponse> = {}): ModelsResponse => ({
  providers: [provider(), provider({ id: 'groq', label: 'Groq' })],
  models: [model(), model({ id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', vendor: 'OpenAI', provider: 'groq', roles: ['fast', 'chat'] })],
  defaults: { chat: '@cf/google/gemma-4-26b-a4b-it', fast: 'openai/gpt-oss-20b', code: null, vision: null, asr: null, embedding: null, image: null },
  checkedAt: 1_000,
  ...o,
});

export const usageSummary = (o: Partial<UsageSummaryDto> = {}): UsageSummaryDto => ({
  quota: { dailyTokens: 100_000, dailyRequests: 200, monthlyTokens: 2_000_000, custom: false },
  today: { tokens: 0, requests: 0, errors: 0 },
  month: { tokens: 0, requests: 0 },
  byDay: [],
  byModel: [],
  ...o,
});
