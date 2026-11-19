/**
 * THE central model registry.
 *
 * This is the only file in the code base that contains Workers AI model identifiers. Everything else
 * (agents, planner, memory, UI listing, tests) refers to *roles* ("chat", "fast", "code", "vision", "asr", "image").
 *
 * Changing the model behind a role = editing ROLE_PRIORITY below. Retiring a model = adding `deprecatedOn`.
 * A model is only ever *presented as ready* after its availability has been verified (see ai/health.ts).
 */
import type { ModelRole } from '@aminchat/shared';

/** Shape family of the Workers AI input/output (the client normalises both to one internal format). */
export type ModelApi = 'chat' | 'legacy-chat' | 'asr' | 'image';

export type Purpose = 'chat' | 'plan' | 'args' | 'route' | 'title' | 'memory' | 'tool' | 'assist' | 'health' | 'vision' | 'asr' | 'image' | 'summary';

export interface ModelSpec {
  id: string;
  label: string;
  vendor: string;
  api: ModelApi;
  roles: ModelRole[];
  capabilities: { vision: boolean; tools: boolean; json: boolean; reasoning: boolean; streaming: boolean };
  /** Context window in tokens as documented by Cloudflare. */
  contextWindow: number;
  /** USD per million tokens, when published on the model's Cloudflare page. */
  pricing: { inputPerM: number; outputPerM: number } | null;
  /** ISO date after which the model must not be used. */
  deprecatedOn?: string;
  /** Extra request parameters, applied only when the model supports them. */
  tune?: (purpose: Purpose) => Record<string, unknown>;
}

const isFast = (p: Purpose) => p === 'plan' || p === 'args' || p === 'route' || p === 'title' || p === 'memory' || p === 'health' || p === 'summary';

export const MODELS: readonly ModelSpec[] = [
  {
    id: '@cf/google/gemma-4-26b-a4b-it',
    label: 'Gemma 4 26B',
    vendor: 'Google',
    api: 'chat',
    roles: ['chat', 'fast', 'vision', 'code'],
    capabilities: { vision: true, tools: true, json: true, reasoning: true, streaming: true },
    contextWindow: 262_144,
    pricing: { inputPerM: 0.1, outputPerM: 0.3 },
    tune: (p) => (isFast(p) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  },
  {
    id: '@cf/qwen/qwen3.8-27b',
    label: 'Qwen 3.8 27B',
    vendor: 'Alibaba Qwen',
    api: 'chat',
    roles: ['chat', 'vision', 'code'],
    capabilities: { vision: true, tools: true, json: true, reasoning: true, streaming: true },
    contextWindow: 262_144,
    pricing: { inputPerM: 0.45, outputPerM: 3.2 },
    // The default effort (xhigh) is far too slow for a chat assistant.
    tune: (p) => ({ reasoning_effort: isFast(p) ? 'low' : 'medium' }),
  },
  {
    id: '@cf/openai/gpt-oss-120b',
    label: 'gpt-oss 120B',
    vendor: 'OpenAI',
    api: 'chat',
    roles: ['chat', 'code'],
    capabilities: { vision: false, tools: true, json: true, reasoning: true, streaming: true },
    contextWindow: 128_000,
    pricing: null,
    tune: (p) => ({ reasoning_effort: isFast(p) ? 'low' : 'medium' }),
  },
  {
    id: '@cf/openai/gpt-oss-20b',
    label: 'gpt-oss 20B',
    vendor: 'OpenAI',
    api: 'chat',
    roles: ['fast', 'chat'],
    capabilities: { vision: false, tools: true, json: true, reasoning: true, streaming: true },
    contextWindow: 128_000,
    pricing: null,
    tune: () => ({ reasoning_effort: 'low' }),
  },
  {
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    label: 'Llama 3.3 70B (fast)',
    vendor: 'Meta',
    api: 'legacy-chat',
    roles: ['chat', 'fast'],
    capabilities: { vision: false, tools: true, json: true, reasoning: false, streaming: true },
    contextWindow: 24_000,
    pricing: { inputPerM: 0.293, outputPerM: 2.253 },
    // Cloudflare's default max_tokens for this model is only 256.
    tune: () => ({}),
  },
  {
    id: '@cf/qwen/qwen2.5-coder-32b-instruct',
    label: 'Qwen 2.5 Coder 32B',
    vendor: 'Alibaba Qwen',
    api: 'legacy-chat',
    roles: ['code'],
    capabilities: { vision: false, tools: false, json: true, reasoning: false, streaming: true },
    contextWindow: 32_768,
    pricing: null,
  },
  {
    id: '@cf/openai/whisper-large-v3-turbo',
    label: 'Whisper large v3 turbo',
    vendor: 'OpenAI',
    api: 'asr',
    roles: ['asr'],
    capabilities: { vision: false, tools: false, json: false, reasoning: false, streaming: false },
    contextWindow: 0,
    pricing: null,
  },
  {
    id: '@cf/black-forest-labs/flux-1-schnell',
    label: 'FLUX.1 schnell',
    vendor: 'Black Forest Labs',
    api: 'image',
    roles: ['image'],
    capabilities: { vision: false, tools: false, json: false, reasoning: false, streaming: false },
    contextWindow: 0,
    pricing: null,
  },
];

/** Ordered preference per role: the first *usable* model wins; the rest are fallbacks. */
export const ROLE_PRIORITY: Record<ModelRole, readonly string[]> = {
  chat: [
    '@cf/google/gemma-4-26b-a4b-it',
    '@cf/qwen/qwen3.8-27b',
    '@cf/openai/gpt-oss-120b',
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/openai/gpt-oss-20b',
  ],
  fast: ['@cf/google/gemma-4-26b-a4b-it', '@cf/openai/gpt-oss-20b', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
  code: ['@cf/qwen/qwen3.8-27b', '@cf/google/gemma-4-26b-a4b-it', '@cf/qwen/qwen2.5-coder-32b-instruct', '@cf/openai/gpt-oss-120b'],
  vision: ['@cf/google/gemma-4-26b-a4b-it', '@cf/qwen/qwen3.8-27b'],
  asr: ['@cf/openai/whisper-large-v3-turbo'],
  image: ['@cf/black-forest-labs/flux-1-schnell'],
  embedding: [],
};

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

export const getModel = (id: string): ModelSpec | undefined => BY_ID.get(id);

export function isDeprecated(spec: ModelSpec, nowMs = Date.now()): boolean {
  return !!spec.deprecatedOn && Date.parse(spec.deprecatedOn + 'T00:00:00Z') <= nowMs;
}

/** Models a user may pick explicitly for conversation (text generation). */
export const SELECTABLE_CHAT_MODELS = MODELS.filter((m) => m.api === 'chat' || m.api === 'legacy-chat').map((m) => m.id);

export function rolePriority(role: ModelRole): ModelSpec[] {
  return ROLE_PRIORITY[role].map((id) => BY_ID.get(id)).filter((m): m is ModelSpec => !!m);
}

/**
 * Integrity check executed by the unit tests: every role references registered models that really have that role,
 * and the registry has no duplicate IDs.
 */
export function validateRegistry(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const m of MODELS) {
    if (seen.has(m.id)) problems.push(`duplicate model id ${m.id}`);
    seen.add(m.id);
  }
  for (const [role, ids] of Object.entries(ROLE_PRIORITY) as [ModelRole, readonly string[]][]) {
    for (const id of ids) {
      const spec = BY_ID.get(id);
      if (!spec) problems.push(`role ${role} references unknown model ${id}`);
      else if (!spec.roles.includes(role)) problems.push(`model ${id} is listed for role ${role} but does not declare it`);
    }
  }
  return problems;
}
