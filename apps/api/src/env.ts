import type { RateLimiter } from './do/rate-limiter';
import type { RunCoordinator } from './do/run-coordinator';
import type { UserHub } from './do/user-hub';

export interface Env {
  // ---- bindings
  DB: D1Database;
  FILES: R2Bucket;
  /**
   * Cloudflare Workers AI. Every AI feature goes through this binding — there are no canned responses anywhere.
   * Optional only so the app can start (and say so honestly) in a credential-less local dev environment.
   */
  AI?: Ai;
  ASSETS?: Fetcher;
  USER_HUB: DurableObjectNamespace<UserHub>;
  RUN_COORDINATOR: DurableObjectNamespace<RunCoordinator>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;

  // ---- plain variables (wrangler.jsonc "vars")
  ENVIRONMENT: string;
  /** Comma-separated list of extra browser origins allowed by CORS / WebSocket. */
  ALLOWED_ORIGINS?: string;
  /** Comma-separated usernames that get the admin role. */
  ADMIN_USERNAMES?: string;
  DEFAULT_DAILY_TOKENS?: string;
  DEFAULT_DAILY_REQUESTS?: string;
  DEFAULT_MONTHLY_TOKENS?: string;
  /** Optional: Cloudflare AI Gateway id used for all Workers AI calls (caching/observability). */
  AI_GATEWAY_ID?: string;

  // ---- secrets (wrangler secret put …)
  /** Web-search provider for the research agent: "brave" | "tavily". Unset → web search is not connected. */
  SEARCH_PROVIDER?: string;
  SEARCH_API_KEY?: string;
}
