import { env } from 'cloudflare:workers';

export interface Rule {
  when?: { model?: string; notModel?: string; purpose?: string; system?: string; user?: string; any?: string; hasImage?: boolean };
  respond: {
    text?: string;
    json?: unknown;
    error?: string;
    delayMs?: number;
    chunkDelayMs?: number;
    failAfterChunks?: number;
    usage?: { prompt: number; completion: number };
    noUsage?: boolean;
    noStream?: boolean;
    legacy?: boolean;
    asr?: string;
    image?: boolean;
  };
  times?: number;
}

export interface RecordedCall {
  model: string;
  purpose: string | null;
  system: string;
  user: string;
  all: string;
  hasImage: boolean;
  inputs: Record<string, any>;
}

interface FakeAIStub {
  setRules(rules: Rule[]): Promise<boolean>;
  getCalls(): Promise<RecordedCall[]>;
  clearCalls(): Promise<boolean>;
  setCatalog(names: string[] | null): Promise<boolean>;
}

export const fakeAi = () => (env as unknown as { AI: FakeAIStub }).AI;

/** Replaces the scripted behaviour of the (test-only) Workers AI double and clears the call log. */
export async function script(rules: Rule[]): Promise<void> {
  await fakeAi().setRules(rules);
}

export const calls = () => fakeAi().getCalls();

export const MODEL = {
  gemma: '@cf/google/gemma-4-26b-a4b-it',
  qwen: '@cf/qwen/qwen3.8-27b',
  gptOss120: '@cf/openai/gpt-oss-120b',
  gptOss20: '@cf/openai/gpt-oss-20b',
  llama: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  coder: '@cf/qwen/qwen2.5-coder-32b-instruct',
  whisper: '@cf/openai/whisper-large-v3-turbo',
  flux: '@cf/black-forest-labs/flux-1-schnell',
} as const;
