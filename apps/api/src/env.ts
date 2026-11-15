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
  /**
   * Alternative addresses of this service (reverse-proxy relays, see docs/connectivity.md), comma separated. Advertised by
   * GET /api/health so clients can keep working when the main address is blocked, and trusted as browser origins.
   */
  PUBLIC_ENDPOINTS?: string;
  /** Comma-separated usernames that get the admin role. */
  ADMIN_USERNAMES?: string;
  DEFAULT_DAILY_TOKENS?: string;
  DEFAULT_DAILY_REQUESTS?: string;
  DEFAULT_MONTHLY_TOKENS?: string;
  /** Optional: Cloudflare AI Gateway id used for all Workers AI calls (caching/observability). */
  AI_GATEWAY_ID?: string;

  /** Move files older than this many days from R2 to Google Drive (default 7). */
  FILES_OFFLOAD_AFTER_DAYS?: string;
  /** Files at least this big (bytes) move to Drive as soon as they have settled (default 5 MiB). */
  FILES_OFFLOAD_LARGE_BYTES?: string;
  /** When R2 holds more than this many bytes the oldest files move to Drive regardless of age (default 8 GiB; R2 free tier is 10 GB). */
  R2_SOFT_LIMIT_BYTES?: string;
  /** Name of the Drive folder the app creates (default "AMIN CHAT"). */
  DRIVE_FOLDER_NAME?: string;

  // ---- secrets (wrangler secret put …)
  /**
   * Shared secret of the operator's relays. A request that carries it in `X-Relay-Secret` may tell us the real client address in
   * `X-Forwarded-For`; without it every user behind a relay would share the relay's address (and its rate limits).
   */
  RELAY_SECRET?: string;
  /** Web-search provider for the research agent: "brave" | "tavily". Unset → web search is not connected. */
  SEARCH_PROVIDER?: string;
  SEARCH_API_KEY?: string;
  /**
   * Google Drive as the cold file tier (all three must be set, otherwise files simply stay in R2).
   * The refresh token must belong to a HUMAN Google account (service accounts have no Drive quota) and use the
   * `drive.file` scope. See docs/storage-drive.md and `npm run drive:token`.
   */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  /** Optional: a folder this same OAuth client created earlier. Normally unset — the app creates and remembers its own folder. */
  DRIVE_FOLDER_ID?: string;
  /** Tests only: when bound, every Google request (OAuth + Drive) goes through this fetcher instead of the network. */
  GOOGLE_API?: Fetcher;
}
