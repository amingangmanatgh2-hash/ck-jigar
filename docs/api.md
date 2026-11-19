# API reference

The HTTP API of the Worker (`apps/api`). Every path below is under the same origin as the web app (`https://<your-worker>/api/...`); the Android app and the relays talk to the same paths. This is the contract between the apps and the server; the source of truth is the zod schema next to each route in `apps/api/src/routes/*.ts`, and `apps/api/test/*.test.ts` exercises it against a real workerd.

## Conventions

| | |
|---|---|
| Format | JSON in, JSON out (`Content-Type: application/json`), except file upload/download and voice transcription |
| Authentication | `Authorization: Bearer <token>`. The token comes from `register` / `login`, is opaque (256 random bits), lasts 30 days and is stored on the server only as a SHA-256 hash. No cookies are used. |
| Unauthenticated | Exactly: `GET /api/health`, `POST /api/auth/register`, `POST /api/auth/login`, and the WebSocket upgrade `GET /api/realtime/ws` (authenticated by a single-use ticket instead). Everything else answers 401 without a valid session. |
| Request id | Every response carries `X-Request-Id` (also on errors, exposed to CORS). Quote it when reporting a problem; the client also uses its presence to tell this server from a filtering page. |
| Errors | `{ "error": { "code": "…", "message": "…", "details": …, "requestId": "…" } }` with a stable upper-case `code`. Never a stack trace. The web app translates `code` through `err.<CODE>` in `apps/web/src/locales`. |
| Validation | Unknown or malformed input is a `400` with a code such as `BAD_REQUEST`, `INVALID_JSON`, `MESSAGE_TOO_LONG`. Bounds come from `packages/shared/src/constants.ts` (`LIMITS`): message 8 000 characters (ciphertext 24 000), message to AMIN AI 12 000, 6 attachments per message, file 25 MiB (the AI pipeline reads files up to 12 MiB), group 200 members, title 80, poll 2–10 options of ≤ 100 characters, shared excerpts ≤ 60 of ≤ 4 000 characters, password 8–128, display name ≤ 60. |
| Idempotency | Sending endpoints accept `clientId` (8–64 chars `[A-Za-z0-9_-]`). Repeating a request with the same `clientId` returns the first result with `200` and `"duplicate": true` instead of creating a second message or starting a second AI run. |
| Pagination | `?before=<messageId>&limit=<n>` returns up to `n` messages older than `before` (the newest `n` when it is omitted), **in chronological order, oldest first within the page**; `hasMore` says whether older ones remain. To go further back, pass the id of the oldest message you have. |
| CORS | The site's own origin, `ALLOWED_ORIGINS`, `PUBLIC_ENDPOINTS`, the Android app's origins (`https://localhost`, `capacitor://localhost`), and localhost outside production. Never `*`. |
| Headers added to every response | `X-Request-Id`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` (unless the route sets another). |

### Rate limits

Fixed windows, counted per user (per IP for the unauthenticated routes) in the `RateLimiter` Durable Object. Exceeding one gives `429 RATE_LIMITED` with a `Retry-After` header and `details.retryAfterSec`. If the limiter itself cannot be reached the request is allowed (an outage of the limiter must not take the messenger down); this is logged.

| Bucket | Limit | Applies to |
|---|---|---|
| `auth-ip` | 30 / 10 min per IP | register, login |
| `login-user` | 10 / 15 min per username | login, change-password |
| `api` | 600 / min per user | every authenticated route |
| `send` | 120 / min per user | messages between people, edits, polls |
| `ai` | 30 / min per user | anything that starts AI work: messages to AMIN AI, regenerate, edit-and-resend, tasks, retry, approval decisions, `@AMINAI` mentions |
| `aiHeavy` | 12 / min per user | transcription, admin model/storage checks |
| `upload` | 30 / min per user | file upload |
| `poll` | 240 / min per user | realtime long-poll |
| `ws-ip` | 60 / min per IP | WebSocket upgrade |

Separately from request rates, **AI usage quota** is per user (defaults 300 000 tokens/day, 400 requests/day, 4 000 000 tokens/month; changeable per deployment with `DEFAULT_*` variables and per user by an admin). Exceeding it gives `429 QUOTA_EXCEEDED`. At most 3 AI runs per user are active at once.

## Health

| | |
|---|---|
| `GET /api/health` | `{ ok, service: "amin-chat", time, environment, endpoints: string[] }`. No authentication, no database access. `endpoints` are the alternative addresses (`PUBLIC_ENDPOINTS`) the apps may learn. |

## Authentication and account — `/api/auth`

| | |
|---|---|
| `POST /register` | `{ username, password, displayName?, locale?, timezone? }` → `201 { token, expiresAt, user }`. Username `^[a-zA-Z][a-zA-Z0-9_]{2,31}$`, not reserved; password 8+ chars. A username listed in `ADMIN_USERNAMES` becomes admin. |
| `POST /login` | `{ username, password }` → `{ token, expiresAt, user }`. Same error for unknown user and wrong password, with the same amount of work. |
| `POST /logout` | Revokes this session. |
| `GET /me`, `PATCH /me` | Own profile. `PATCH` takes any of `displayName`, `bio`, `locale` (`fa`/`en`), `timezone`. |
| `GET /sessions`, `DELETE /sessions/:id` | List and revoke own sessions (devices). |
| `POST /change-password` | `{ currentPassword, newPassword }`. Revokes every other session. |

## Users — `/api/users`

| | |
|---|---|
| `GET /search?q=` | Find people by username or display name (2+ chars, at most 20 results). Only active human accounts: not yourself, not disabled users, not the assistant. |
| `GET /:id` | Public profile. |
| `PUT /me/e2ee-key` | `{ jwk }` — publish this device's ECDH P-256 **public** key (`{kty:"EC", crv:"P-256", x, y}` only). |
| `GET /:id/e2ee-key` | Another user's public key, or `404 E2EE_KEY_MISSING`. |

## Conversations, messages, polls — `/api/conversations`, `/api/messages`

A conversation has `type` `ai`, `direct` or `group`; `e2ee` marks a secret direct chat. The user's AMIN AI conversation is created for them automatically and is the only `ai` one; it is **not** read or written through the endpoints below (those answer `USE_AI_ENDPOINT`; use `/api/ai`).

| | |
|---|---|
| `GET /api/conversations` | The user's conversations, with last message, unread count and the AI access that applies. |
| `POST /direct` | `{ userId, e2ee? }` → the (existing or new) direct conversation. |
| `POST /group` | `{ title, memberIds[] }` → group; the creator is owner. |
| `GET /:id`, `PATCH /:id` | Read; `PATCH` `{ title?, pinned?, muted? }` (title: group admins only). |
| `POST /:id/members`, `DELETE /:id/members/:userId`, `PATCH /:id/members/:userId` | Add (≤ 50 at a time), remove, set role `admin`/`member`. Owner-protected. |
| `PUT /:id/ai` | Your own AI consent for this chat: `{ access?: "off"|"mention"|"context", blocked?: boolean }`. It decides **direct** chats (`access` is the invoker's consent; `blocked` by *anyone* in the chat vetoes AI for everybody). In a **group** the members' own values are stored but not consulted: only the admins' policy below decides. Refused for the AI conversation, and for a secret chat anything but `off` (`E2EE_NO_ACCESS`). Audited. |
| `PUT /:id/ai-policy` | Group **admins only**: `{ level: "off"|"mention"|"context"|"assist", invokeRoles?: "all"|"admins" }`. |
| `GET /:id/messages` | `?before&limit≤100`. Members only. |
| `POST /:id/messages` | `{ body?, cipher?, replyToId?, fileIds[], clientId? }` → `201 { message, ai? }` (`ai` is present when the text mentioned `@AMINAI`, see below). Secret chats require `cipher` (`{v:1, iv, ct}`) and no `body`/files; other chats refuse `cipher`. |
| `POST /:id/polls` | `{ question, options[2..], multiple? }`. Not in secret chats. |
| `POST /:id/read` | Mark read. |
| `PUT /api/messages/:id` | Edit own message (`body` or `cipher`). |
| `DELETE /api/messages/:id` | Delete own message (owners and admins of a group can delete others'). The body or ciphertext, the search-index entry, poll votes and attached files (also their copies in R2 / Google Drive) are removed; clients get `message.deleted`. |
| `POST /api/messages/:id/vote` | `{ optionIds[] }`. |

**`@AMINAI` in a chat.** When a message to a direct chat or group contains the mention, the server resolves the access policy for *that chat and that invoker* (`packages/shared/src/access.ts`), builds a bounded context, runs the model and posts the answer as a message from AMIN AI. `ai` in the answer is `{ triggered: true, runId, messageId }` when the assistant started, `{ triggered: false }` when the message had no mention, and `{ triggered: false, denied: { code, message, canEnable? } }` when the policy (or the quota, or a missing AI backend) refused: that is reported to the sender only and nothing is posted into the chat. A message sent by AMIN AI itself never triggers it again. Secret chats are never read by the server: the client sends the user-chosen decrypted `excerpts` to `POST /api/ai/threads/:id/messages` instead.

## Files — `/api/files`

| | |
|---|---|
| `POST /` | Upload, at most 25 MiB. Either `multipart/form-data` with a `file` field, or the raw body with `Content-Type` and a URI-encoded `X-File-Name` header. → `{ file }`. The uploader owns the file; it becomes visible to a conversation's members only when it is attached to a message there. |
| `GET /` | Own files: `?kind=image|audio|video|document|text|archive|other&q=&limit≤100`. |
| `GET /:id` | Download. Allowed for the owner and for members of the conversation the file is attached to; anyone else gets `404`. Served with `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`; only known-safe types are shown inline (`?download=1` forces a download). Files that moved to Google Drive are fetched transparently through the Worker (after the access check); if Drive cannot be reached → `503 FILE_STORAGE_UNAVAILABLE`. |
| `DELETE /:id` | Owner only. |

## Realtime — `/api/realtime`

| | |
|---|---|
| `POST /ticket` | Authenticated. → `{ ticket, expiresInSec: 60 }`. Single-use. |
| `GET /ws?ticket=` | WebSocket upgrade (the ticket is the credential; the `Origin` must be allowed). |
| `GET /poll` | Fallback where WebSockets are blocked. No query → the starting cursor. Then `?epoch=&seq=&wait≤25` → `{ epoch, events[], reset? }`. `reset: true` means "you may have missed events: refetch what you show". |

Event types (`RealtimeEvent` in `packages/shared/src/types.ts`): `hello`, `message.created`, `message.updated`, `message.deleted`, `poll.updated`, `conversation.updated`, `typing`, `run.updated`, `run.step`, `run.approval`, `run.delta` `{ runId, messageId, offset, text }` (the streamed answer; `offset` = characters that came before `text`, so deltas can be ordered and de-duplicated), `memory.suggestion`.

## AMIN AI — `/api/ai`

| | |
|---|---|
| `GET /agents` | The six agents plus `auto`, each with its tools (`risk`, and `available` + `reason` for tools that are switched off or not configured, e.g. web search without a provider). |
| `GET /models` | `{ backend: "workers-ai"|"unavailable", models[], defaults, checkedAt }`. Each model: `id`, `label`, `vendor`, `roles`, `capabilities`, `contextWindow`, `pricing`, `deprecatedOn`, `status` (`available` | `unavailable` | `unknown`), `reason`, `reasonCode` (`not_connected`, `deprecated`, `unverified`, `check_failed`, `stale` or null), `checkedAt`, `latencyMs`, `selectable`. The UI shows a model as ready only when `status` is `available`, i.e. a real, tiny call to it succeeded recently. |
| `POST /models/refresh` | **Admin.** Probe every model now (spends a little of the Workers AI allocation). |
| `GET /usage` | `{ quota: { dailyTokens, dailyRequests, monthlyTokens, custom }, today: { tokens, requests, errors }, month: { tokens, requests }, byDay[], byModel[] }` for the caller. |
| `GET/POST /threads`, `GET/PATCH/DELETE /threads/:id` | The user's AMIN AI conversations ("new conversation"). `POST` `{ title?, agentId?, modelId? }`; at most 500 per user. `DELETE` cancels active runs, then removes the thread, its messages, runs and search index entries, and the files attached to them (including their copies in R2 or Google Drive). |
| `GET /threads/:id/messages` | `?before&limit≤100` → `{ messages, hasMore, activeRunId }`. |
| `POST /threads/:id/messages` | `{ body?, fileIds[], agentId?, modelId?, shared?, clientId? }` → `201 { userMessage, assistantMessage, run }` (`200` + `duplicate` on a repeat). The answer streams over realtime (`run.delta`); `assistantMessage` is the placeholder. `shared` = `{ conversationId, messageIds[] }` or, for a secret chat, `{ conversationId, excerpts[] }`. |
| `POST /threads/:id/regenerate` | `{ agentId?, modelId? }` → `202`. Only the latest answer. |
| `PUT /threads/:id/messages/:messageId` | `{ body, agentId?, modelId? }` — edit a message and answer it again → `202`. |
| `POST /tasks` | `{ goal, agentId?, modelId?, fileIds[] }` — a task from the tasks panel: a new thread whose first message is the goal. |
| `GET /search` | `?q=&scope=ai|all&limit≤50&conversationId=` — full-text search over past messages the server may read (never secret chats). |
| `POST /transcribe` | Voice input: the body is the audio recording (≤ 10 MB, `audio/*`), `?lang=fa|en` → `{ text, modelId }`. Not stored. |

### Runs, approvals — the task engine

| | |
|---|---|
| `GET /runs` | `?status=active|finished|all&limit≤50` → runs with steps. |
| `GET /runs/:id` | One run with its steps and approvals. |
| `GET /runs/:id/events` | The operation log (`run_events`): every plan, step, retry, error, decision. |
| `POST /runs/:id/cancel` | Cancel; in-flight model and tool calls are aborted. |
| `POST /runs/:id/retry` | Run the newest answer's request again (finished runs of your own conversations). |
| `GET /approvals` | Pending approvals of the caller. |
| `POST /approvals/:id/decision` | `{ decision: "approve"|"reject", edits? }`. `edits` may only change the fields the tool declared editable; the edited payload is re-validated and fingerprinted again. Answers `ALREADY_DECIDED`, `APPROVAL_EXPIRED` (24 h), `RUN_NOT_ACTIVE` as appropriate. |

Run status: `pending` (در انتظار) → `planning` (در حال برنامه‌ریزی) → `awaiting_approval` (نیازمند تأیید) → `running` (در حال اجرا) → `completed` (تکمیل‌شده) | `failed` (ناموفق) | `cancelled` (لغوشده). A step has the same statuses plus `skipped`.

### Memory and personal data

| | |
|---|---|
| `GET /memory` | `{ settings, items, suggestions }`. |
| `PATCH /memory/settings` | `{ enabled?, autoSuggest?, allowHistoryRecall? }` (strict). `allowHistoryRecall` defaults to **off**. |
| `POST /memory/items`, `PATCH /memory/items/:id`, `DELETE /memory/items/:id` | Create / edit / delete one item (`kind`: `preference|project|fact|other`, ≤ 600 chars, ≤ 200 items). |
| `DELETE /memory` | Delete everything; requires `{ "confirm": true }`. |
| `POST /memory/suggestions/:id/decision` | `{ decision: "approve"|"reject", content?, kind?, project? }` — the assistant can only *propose*; nothing is remembered until the user approves. |
| `GET /todos`, `PATCH /todos/:id` `{status}`, `DELETE /todos/:id` | The tasks the assistant keeps for the user. |
| `GET /reminders`, `DELETE /reminders/:id` | Reminders (created by the assistant's tools; delivered by the cron job). |
| `GET /projects`, `DELETE /projects/:id` | Saved project notes. |

## Admin — `/api/admin` (role `admin`)

| | |
|---|---|
| `GET /overview?days=` (1–60, default 7) | `{ days, byUser[] (top 25 by tokens), byModel[] (tokens, requests, errors, fallbacks), runs: { <status>: count } }`. |
| `GET /users/:id/usage`, `PUT /users/:id/quota` | Read usage; set `{ dailyTokens, dailyRequests, monthlyTokens }` (each `null` = deployment default). Audited. |
| `POST /models/refresh` | As `/api/ai/models/refresh`. |
| `GET /storage`, `POST /storage/check`, `POST /storage/offload` | File storage status (R2 / Google Drive health), re-check Drive, run the offload now. See [storage-drive.md](storage-drive.md). |

An admin has **no** endpoint that reads other people's messages or memory.

## Error codes

About 150 codes exist; the authoritative list with the English text is the `err.*` section of `apps/web/src/locales/en.ts` (the Persian text is next to it in `fa.ts`; a test keeps both in step). Families: `AI_*` (not connected, off, blocked, E2EE, busy, timeout, no model…), `E2EE_*`, `RUN_*`, `APPROVAL_*`, `MEMORY_*`, `*_NOT_FOUND`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `FILE_*`. Generic: `UNAUTHORIZED` / `SESSION_INVALID` (401), `FORBIDDEN` / `ADMIN_ONLY` / `OWNER_ONLY` (403), `NOT_FOUND` / `ROUTE_NOT_FOUND` (404), `CONFLICT` (409), `PAYLOAD_TOO_LARGE` (413), `RATE_LIMITED` / `QUOTA_EXCEEDED` (429), `INTERNAL` (500), `AI_NOT_CONNECTED` / `FILE_STORAGE_UNAVAILABLE` (503).
