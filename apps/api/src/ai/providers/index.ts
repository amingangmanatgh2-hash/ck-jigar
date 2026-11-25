import { MODEL_PROVIDERS, type ModelProviderId, type ProviderDto } from '@aminchat/shared';
import type { Env } from '../../env';
import { groqConnected } from './groq';

export const PROVIDER_LABEL: Record<ModelProviderId, string> = { 'workers-ai': 'Cloudflare Workers AI', groq: 'Groq' };

/** Is there a credential / binding for this provider in this environment? (Whether its models really answer is ai/health.ts.) */
export function providerConnected(env: Env, id: ModelProviderId): boolean {
  return id === 'workers-ai' ? !!env.AI : groqConnected(env);
}

export const anyProviderConnected = (env: Env): boolean => MODEL_PROVIDERS.some((p) => providerConnected(env, p));

export const providerList = (env: Env): ProviderDto[] => MODEL_PROVIDERS.map((id) => ({ id, label: PROVIDER_LABEL[id], connected: providerConnected(env, id) }));
