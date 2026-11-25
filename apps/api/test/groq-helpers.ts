import { env } from 'cloudflare:workers';
import { resetCooldowns } from '../src/ai/cooldown';
import type { Env } from '../src/env';

/** The key the fake Groq accepts (test/fake-groq/worker.mjs). */
export const GROQ_KEY = 'test-groq-key';

export const GROQ = { oss20: 'openai/gpt-oss-20b', oss120: 'openai/gpt-oss-120b' } as const;

export interface GroqRule {
  when?: { model?: string; notModel?: string; system?: string; user?: string; any?: string; stream?: boolean };
  respond: {
    text?: string;
    json?: unknown;
    status?: number;
    message?: string;
    code?: string;
    retryAfter?: number;
    delayMs?: number;
    chunkDelayMs?: number;
    failAfterChunks?: number;
    error?: string;
    usage?: { prompt: number; completion: number };
    noUsage?: boolean;
    noStream?: boolean;
    reasoning?: string;
    reasoningTokens?: number;
    emptyIfCapBelow?: number;
  };
  times?: number;
}

export interface GroqCall {
  model: string;
  system: string;
  user: string;
  all: string;
  stream: boolean;
  body: Record<string, any>;
  key: string;
  cancelled?: boolean;
}

export interface GroqFailure {
  status: number;
  retryAfter?: number;
  message?: string;
  code?: string;
  type?: string;
  times?: number;
}

interface FakeGroqStub {
  reset(patch?: Record<string, unknown>): Promise<boolean>;
  configure(patch: Record<string, unknown>): Promise<boolean>;
  setRules(rules: GroqRule[]): Promise<boolean>;
  getCalls(): Promise<GroqCall[]>;
  clearCalls(): Promise<boolean>;
  listCallCount(): Promise<number>;
}

/** The test-only fake of Groq's API (see test/fake-groq/worker.mjs). */
export const fakeGroq = () => (env as unknown as { GROQ_API: FakeGroqStub }).GROQ_API;
export const groqCalls = () => fakeGroq().getCalls();
export const groqScript = (rules: GroqRule[]) => fakeGroq().setRules(rules);

/**
 * Connects Groq for the current suite: sets the secret on the Worker's env (a test's change of `env` reaches the Worker, as the
 * suite for the models endpoint proves) and starts from a clean fake. Call `groqOff()` in afterAll so other suites see no Groq.
 */
export async function groqOn(key: string = GROQ_KEY): Promise<void> {
  (env as unknown as Record<string, unknown>).GROQ_API_KEY = key;
  resetCooldowns();
  await fakeGroq().reset();
  await env.DB.prepare('DELETE FROM model_health').run();
}

export async function groqOff(): Promise<void> {
  delete (env as unknown as Record<string, unknown>).GROQ_API_KEY;
  delete (env as unknown as Record<string, unknown>).GROQ_MAX_INPUT_TOKENS;
  resetCooldowns();
  await fakeGroq().reset();
  await env.DB.prepare('DELETE FROM model_health').run();
}

/** The Worker's env with some values replaced (for calling services directly). */
export const withEnv = (over: Partial<Env>): Env => Object.assign(Object.create(Object.getPrototypeOf(env)), env, over) as Env;
