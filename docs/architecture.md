# Architecture

This is the developer reference. The operator guides (deploy, Android, connectivity, storage) are in Persian next to this file; the index is in the [README](../README.md).

```
 Browser (PWA)  /  Android app (Capacitor shell around the same web app)        relays you run (optional)
        │   HTTPS  +  WebSocket (or long-poll when sockets are blocked)                  │
        └────────────────────────────────────┬──────────────────────────────────────────┘
                                             ▼
                    Cloudflare Worker  (apps/api — Hono; also serves apps/web/dist as static assets)
   /api/*  →  request id → CORS → auth (opaque bearer token) → rate limit → zod validation → service
                                             │
   ┌────────────────┬────────────────────────┼───────────────────┬────────────────────┬────────────────┐
   ▼                ▼                        ▼                   ▼                    ▼                ▼
  D1            UserHub (DO)           RunCoordinator (DO)   RateLimiter (DO)        R2           Workers AI  ·  Groq (optional)
 all durable    one per user:          one per AI run:       one per limit key:      hot files    env.AI binding   plain HTTPS, key in the
 state          WebSockets, event      executes the run      fixed-window counters   (≤ 7 days /  (main service)   secret GROQ_API_KEY
                fan-out, long-poll     from an alarm,                                 < 5 MiB)     the ONLY sources of model output
                ring                   cancel / resume                                  │
                                                                                         ▼
                                                                                  Google Drive (cold files, optional)
```

Everything runs in one Worker. There is no other server. Cloudflare services used: Workers, Workers AI, Durable Objects (SQLite-backed classes), D1, R2, static assets, a cron trigger. Outside Cloudflare, only when configured: Groq (a second AI provider), Google Drive (cold files), the optional relays.

## Repository layout

| Path | What it is |
|---|---|
| `packages/shared` | Types and rules used by both sides: constants and limits, the pure AI **access policy** (`access.ts`), `@AMINAI` mention parsing, the endpoint-list parser |
| `apps/api` | The Worker. `src/routes` (HTTP), `src/services` (logic), `src/agents` (registry, planner, executor, approvals, tools), `src/ai` (models, client, health, usage, `providers/` for Groq), `src/do` (the three Durable Objects), `src/storage` (R2 + Drive tiers), `src/middleware`, `src/lib`, `migrations/` |
| `apps/web` | The web app (React 19 + Vite): `src/screens`, `src/components`, `src/lib` (api, endpoint pool, outbox, realtime, e2ee…), `src/locales` (fa, en), service-worker plugin; `android/` is the Capacitor project |
| `relay/` | Zero-dependency reverse proxy for networks where the Worker's address is blocked |
| `scripts/` | `deploy.mjs`, `load-deploy-env.mjs` (reads the optional single secret `DEPLOY_ENV` into step outputs, masking the credentials first), `preflight.mjs` (asks Cloudflare and Groq whether everything is in place before a deployment), `verify-workers-ai.mjs`, `drive-token.mjs`, `dev-api.mjs` |
| `.github/workflows` | CI, Android build, Workers AI check, deploy |

## Request path

`app.ts` mounts the routers under `/api/{auth,users,conversations,messages,files,realtime,ai,admin}` plus `GET /api/health`. In order:

1. `requestContext` gives every request a full-length `X-Request-Id` (exposed to CORS; the client uses its presence to tell the Worker's answers from a censor's page).
2. `cors` allows the site's own origin, the Android origins, `ALLOWED_ORIGINS` and `PUBLIC_ENDPOINTS`. Never `*`.
3. `requireAuth`: an opaque random bearer token; only its SHA-256 is stored (`sessions.token_hash`). Sessions last 30 days, can be listed and revoked, and a user with `users.disabled_at` set is rejected on the next request (nothing in the app sets it today: [SECURITY.md](SECURITY.md), limitation 3).
4. A rate limit (per user, or per IP for register/login) through the `RateLimiter` Durable Object. Limits are in `config/limits.ts`.
5. `zod` validation of body and query (`lib/validate.ts`); unknown fields are rejected or ignored by schema, lengths are bounded by `LIMITS`.
6. The service function, which does the **authorization** (membership, ownership, access policy). Routes never trust an id from the client without checking it belongs to the caller.

Errors are `{ error: { code, message, details? } }` with a stable `code` the web app maps to a translated message (`err.<CODE>`).

## Data (D1)

| Group | Tables |
|---|---|
| Accounts | `users` (the assistant is a row with `kind = 'ai'`, `verified = 1`; it can never log in), `sessions` |
| Messaging | `conversations` (`type` is `ai`, `direct` or `group`; `e2ee = 1` marks a secret direct chat; the `ai` conversation holds the user's `ai_threads`), `conversation_members`, `messages`, `poll_votes`, `message_fts` (full-text search over messages the server can read) |
| Files | `files` (with `tier` r2/moving/drive), `file_derivatives` (extracted text, thumbnails) |
| AI | `ai_threads`, `runs`, `run_steps`, `run_events`, `approvals`, `ai_usage`, `user_quotas`, `model_health` |
| Memory & personal | `memory_settings`, `memories`, `memory_suggestions`, `todos`, `reminders`, `projects` |
| Operations | `audit_log`, `storage_state` |

Migrations (`apps/api/migrations`): `0001_init`, `0002_file_tiers`, `0003_client_ids` (idempotent sends). They only move forward.

## Realtime

One **UserHub** Durable Object per user holds all of that user's WebSockets (hibernation API) and fans events out: `message.created/updated/deleted`, `conversation.updated`, `typing`, `run.updated`, `run.delta`, `run.step`, `run.approval`, `memory.suggestion`.

- A WebSocket is opened with a **single-use ticket** (`POST /api/realtime/ticket`, 60 s), so the long-lived token never appears in a URL.
- Where WebSockets are blocked, the client falls back to **long-poll** (`GET /api/realtime/poll?epoch=&seq=&wait≤25`). The hub keeps a 400-event ring in memory, only while someone polled in the last 90 s. If the hub was evicted or the client fell behind, the answer says `reset: true` and the client refetches what it shows (the same recovery as after a reconnect). Nothing is silently lost.
- AI answers stream as `run.delta {messageId, offset, text}`; the client keeps them in one global stream store keyed by message, so a screen change cannot lose or duplicate text.

## The AI layer (`apps/api/src/ai`)

Two providers, one interface. **Workers AI** (the `env.AI` binding) is the main infrastructure; **Groq** (plain HTTPS, optional) is a second provider that answers quick requests first and takes over when Workers AI cannot answer. Each provider is *connected* when its credential exists (`providers/index.ts`: the binding, the `GROQ_API_KEY` secret); a provider that is not connected is skipped everywhere and its models are listed as `unavailable` with reason `not_connected`.

- **`models.ts` is the only file with model ids** (Workers AI `@cf/…` and Groq alike; a unit test fails if any id of the registry appears in another file). Everything else asks for a *role* (`chat`, `fast`, `code`, `vision`, `asr`, `image`). `ROLE_PRIORITY` is the fallback order; `deprecatedOn` retires a model. Each model has a `provider`; Groq models are chat-only (no vision, audio or images).
  - `fast` (routing, planning, titles, summaries, the Quick agent): **Groq first** (gpt-oss 20B, then 120B), then the Workers AI models.
  - `chat` and `code`: **Workers AI first**, Groq last. `vision`, `asr`, `image`: Workers AI only.
- **`client.ts`** walks the candidate list on failure. A candidate must have a connected provider, a prompt small enough for it (`maxInputTokens`: Groq's free tier allows about 8 000 tokens per minute, so prompts above 5 000 estimated tokens, `GROQ_MAX_INPUT_TOKENS`, go to Workers AI), not be marked unavailable by `health.ts`, and not be cooling down. Error handling is per kind (`errors.ts`):
  - `account_limit` (a provider's whole allowance is spent, e.g. Workers AI's daily free allowance): the *rest of that provider* is skipped, **other providers are still tried**, so a spent Cloudflare allowance does not stop the assistant;
  - `capacity` (Groq: HTTP 429, 498, 503; per-minute and per-day limits look alike): that model is skipped for the time Groq's `Retry-After` names, between 1 s and 2 min (`cooldown.ts`; kept in the memory of the Worker instance, an optimisation only: another instance may try once and learn the same). `too_large` (HTTP 413) and the other kinds fall through to the next candidate. 401/403 are `access` (the model is marked unavailable and the next candidate answers);
  - once text reached the user the answer cannot silently switch models, so the error is shown instead.
- **`providers/groq.ts`** is the Groq adapter (`POST /openai/v1/chat/completions`, `GET /openai/v1/models`). It sends `max_completion_tokens`, `reasoning_effort` (`low` for the fast purposes, `medium` otherwise) and `include_reasoning: false`; because reasoning tokens count against the limit, small caps get headroom, and an answer that is empty (the limit was spent thinking) is skipped, never shown. A `400` for a tuning parameter is retried once without tuning. The `AbortSignal` is forwarded, so cancelling a run stops the request (and its billing). `stream_options` is not sent; usage is read from `usage` or `x_groq.usage` and estimated (and marked so) when absent. The key is only ever put in the `Authorization` header: it appears in no error, response or database row.
- **`health.ts`** decides what the UI may call *ready*. A model is ready only if a real, tiny call to it succeeded (admins can trigger the check; results are cached 20 min). It asks each provider's catalogue first (`env.AI.models`, Groq `GET /models`), then probes text models with a minimal real call. A model that fails at runtime is unavailable for 20 min. If *every* verdict is stale or failed, calls are still attempted rather than failing blind. `ModelDto.reasonCode` is one of `not_connected | deprecated | unverified | check_failed | stale`, or null when ready.
- **`usage.ts`** logs every call (`ai_usage`: model, purpose, tokens, estimated flag, latency, status ok/fallback/error) and enforces the per-user quota (defaults 300 000 tokens/day, 400 requests/day, 4 000 000 tokens/month; per-user override by an admin). The quota counts both providers together. Counts are estimates when the model reports no usage, and are marked so.
- **Groq's limits belong to the Groq *organisation***, so every user of one deployment shares them, whatever the per-user quota says. That is why Groq is the first choice only for short calls, and why a refusal moves on to Workers AI instead of failing.
- **Privacy:** a prompt sent to a Groq model leaves Cloudflare ([SECURITY.md](SECURITY.md)). The access policy decides what may be in a prompt, not which provider receives it; an operator who does not accept that does not set `GROQ_API_KEY`.
- **Without any provider** (`dev:api:offline`, or a broken deploy) every AI feature answers `AI_NOT_CONNECTED`. There is no canned or simulated output anywhere in production code; the fake models (Workers AI, Groq, Google) exist only in the API tests, behind service bindings.

## Who may be read: the access policy

`packages/shared/src/access.ts` is a pure function, used by the server for every decision and by the web app only to explain it.

| Conversation | Rule |
|---|---|
| AMIN AI's own chat | Full: it is the user's conversation with the assistant |
| Secret (E2EE) chat | **Never** server-side. The user selects messages in the client, which decrypts them and sends the chosen `excerpts` with the question (`shared` field of `POST /api/ai/threads/:id/messages`) |
| Direct | The *invoking* user's consent: `off`, `mention` (only the recent messages needed), or `context`. **Any participant's block vetoes AI for everybody** |
| Group | An owner/admin sets `ai_level` (`off` / `mention` / `context` / `assist`) and `ai_invoke_roles` (`all` / `admins`) |

`assist` additionally lets the assistant help admins with polls and announcements, always through an approval. `PUT /api/conversations/:id/ai` sets a user's own consent, `PUT …/ai-policy` the group policy. A denied `@AMINAI` mention is reported to the sender only; nothing is posted into the chat.

`services/assist.ts` handles a mention: resolve the policy for this chat and this invoker, build a bounded context (`services/context.ts`: last ≤ 60 messages / 8 000 tokens, files described only if readable), run the model, and post the answer as a message of AMIN AI replying to the mention (`{message, ai}`).

## Agents, runs and the task engine

Eight agents (`agents/registry.ts`) plus `auto`, which routes each request:

| Agent | Tools |
|---|---|
| general | none (direct answer) |
| quick | `chat_open`, `chat_list`, `todo_list`, `reminder_list` (read-only; model role `fast`, so Groq answers first; short answers) |
| personal | `todo_add/list/complete`, `reminder_set/list/cancel`, `project_save/list`, `memory_propose`, `history_search`, `compose` |
| research | `web_search`, `file_read`, `file_list`, `history_search`, `compose` |
| coder | none (direct answer) |
| messenger | `chat_list`, `chat_read`, `message_send`, `poll_create`, `announce_post`, `compose` |
| file | `file_list`, `file_read`, `file_categorize`, `compose` |
| creative | `image_generate`, `compose` |

An agent can only use the tools on its list; the planner's choice of any other tool is dropped. Agents without tools answer directly (mode `direct`); the rest **plan** (mode `plan`).

A **run** (`runs.kind`: `chat`, `task`, `assist`) goes through `pending → planning → awaiting_approval → running → completed | failed | cancelled`; each step has its own status (plus `skipped`). The flow:

1. `routes/ai*.ts` creates the run and hands it to the **RunCoordinator** DO, which executes it from an alarm, so the work outlives the HTTP request.
2. `planner.ts` produces at most 8 steps as JSON (`deferred` steps get their arguments derived later from earlier results); `executor.ts` runs them, with retries (3 attempts, back-off) for temporary errors, one repair attempt for invalid arguments, a 45 s per-tool timeout, 14 model calls and 10 minutes per run at most.
3. Every step and decision is appended to `run_events`; `GET /api/ai/runs/:id/events` is the operation log. Live updates go over realtime.
4. **No success is claimed without confirmation:** a non-read tool must return `verified: true` (e.g. the message row exists after sending), otherwise the step is `failed`, steps that depended on it are `skipped`, and the final answer is composed from tool results only.
5. **Recovery:** the cron job resumes runs that stopped heart-beating for 3 minutes (up to 3 resumes), expires old approvals and recovers decisions whose resume signal was lost.
6. A user can cancel at any time: in-flight model and tool calls are aborted and parked runs are settled.

### Approvals

Tools flagged sensitive — `message_send`, `poll_create`, `announce_post`, `file_categorize` — never run directly. The executor first validates preconditions (e.g. the target chat is reachable and policy-allowed), stores an `approvals` row with the exact arguments and their **SHA-256 fingerprint**, parks the run in `awaiting_approval` and sends the card to the user's devices. The user can approve (optionally editing the fields the tool declares editable, which are re-validated and re-fingerprinted) or reject. Execution refuses a payload whose fingerprint differs from what was approved. Approvals expire after 24 h (`expired`, the step does not run). `POST /api/ai/approvals/:id/decision`.

### Prompt-injection posture

The protection is structural (tool lists, approvals, access policy, bounded context). On top of that every prompt that sees other people's text (agent prompts, `@AMINAI`, the planner, the argument writer) carries `UNTRUSTED_CONTENT_RULE`: text from chats, files, web pages and tool results is data, not instructions, and instructions found in it are reported rather than obeyed. A test checks that the plan, args and chat calls of a real run all carry it.

## Memory

- **Temporary:** the conversation history of a thread, windowed to a token budget; it exists only inside that thread.
- **Permanent:** `memories` (kinds `preference | project | fact | other`, ≤ 200 items of ≤ 600 chars) belong to one user and are never shared between users. They are created by the user, or by the user approving a **suggestion**: the assistant can only *propose* (`memory_propose` → `memory_suggestions`, `pending`), never write. `memory_settings`: `enabled`, `auto_suggest`, `allow_history_recall` (default **off**; `history_search` can read the user's past AI threads only when on). The user can view, edit, disable and delete everything (`/api/ai/memory`).

## Files and storage

Uploads (≤ 25 MiB; the AI pipeline processes ≤ 12 MiB) go to **R2**. A cron job moves files older than 7 days or at least 5 MiB to **Google Drive** after verifying size and hash, so the Cloudflare bucket does not fill up; reads transparently fetch from Drive. `files.tier` is `r2 | moving | drive`. Details and failure modes: [storage-drive.md](storage-drive.md).

## Cron (every minute, `src/cron.ts`)

Deliver due reminders (with attempt limits) · recover stale runs · expire approvals · recover lost approval decisions · housekeeping · move files to the cold tier and refresh Drive health. Each part is isolated, so one failing part does not stop the rest.

## Connectivity

The web app talks to a **pool** of addresses (the primary, built-in/custom/learned alternatives), fails over only on evidence that it is the *server's* address that failed, sends chat messages through an offline-tolerant, idempotent outbox, and ships as an installable offline shell. Details, limits and the relay: [connectivity.md](connectivity.md), [../relay/README.md](../relay/README.md).

## Extension points

Another channel (Telegram, for example) is deliberately **not implemented**. The seams it would use are described in [telegram-extension.md](telegram-extension.md).
