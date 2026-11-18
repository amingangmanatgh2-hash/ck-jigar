# Adding Telegram (or another channel)

**Status: not implemented.** There is no Telegram code, no bot, no token and no webhook in this repository. This was a deliberate scope decision: the messenger and AMIN AI come first, and the architecture only has to *allow* a channel later. This file is the plan against the code as it is today. It names the real functions a channel would call, what already exists, and what would still have to be written, so the work can start without re-reading the whole project.

Nothing here has been built or run. The Telegram facts were read from Telegram's Bot API documentation (see the last section) and have not been tried against a real bot.

## What "a channel" means here

A channel is **another way for one already-registered AMIN CHAT user to talk to their own AMIN AI** (and to receive its answers, approvals and reminders). It is not a bridge between Telegram users and AMIN CHAT conversations, and it creates no accounts. Keeping it that narrow is what keeps the security model intact: every action is still performed *as* an AMIN user, through the same services, with the same access policy, quota, rate limits and approvals.

## The seams: what exists and what is missing

| Seam | What exists today | What a channel must add |
|---|---|---|
| **Identity** | `users` + opaque bearer `sessions`. Services take an `AuthUser` (`middleware/auth.ts`); `sessionId` inside it is used only by `/api/auth/*` (logout, session list, change-password), not by the AI services | A `channel_links` table and a linking flow (below). Do **not** hand out bearer sessions to a bot |
| **Inbound** (a message arrives) | `startAiTurn(env, user, thread, input)` in `services/ai-chat.ts` is the single entry for "the user says something to AMIN AI": it checks the AI backend, validates, enforces quota and the 3-active-runs limit, stores the message and starts the run. `input.clientId` already makes it **idempotent**. `createThread` makes a new conversation. `storeFile` (`services/files.ts`) ingests an upload and `AiClient.transcribe` turns audio into text | A webhook route that authenticates Telegram, finds the linked user and calls those functions. No change to them |
| **Outbound** (answers, approvals, reminders go out) | Everything user-visible leaves through **one function**, `publishToUsers` in `lib/realtime.ts` (27 call sites): `run.delta` (the streamed answer, with `offset`), `run.updated`, `run.step`, `run.approval`, `message.created/updated`, `memory.suggestion`. Reminders are delivered by inserting an AMIN AI message (`cron.ts`, `insertMessage`), which publishes `message.created` | A `ChannelSink` that `publishToUsers` also calls (it does not exist yet; it is a few lines in that one function) and one adapter per channel |
| **Approvals** | `decideApproval(env, userId, approvalId, 'approve'\|'reject', edits?)` in `services/approvals.ts`. It checks that the approval belongs to `userId`, is pending and unexpired, and re-validates the payload against its SHA-256 fingerprint | Render a `run.approval` as an inline-keyboard card and turn the button press into a `decideApproval` call for the **linked** user. The approval logic itself stays untouched |
| **Access policy** | `resolveAiAccess` (`packages/shared/src/access.ts`) is pure, takes the conversation type and consents, and is the only thing that decides what the AI may read | Nothing for the private-chat scope below. Groups need a new input type that defaults to *off* (see "Out of scope") |
| **Limits** | `consume(env, bucket, key, spec)` with `ipLimit()` / `userLimit()`, and `assertWithinQuota` inside `startAiTurn` | A bucket for the webhook (per IP, and per linked user once known). The AI quota is shared with the app automatically |
| **Config** | Optional secrets with a live `available()` check (web search, Drive), so a feature without credentials switches itself off honestly | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` as optional Worker secrets; the route answers 404 when they are unset |

## Plan, in order

### 1. Migration `0004_channels.sql`

```sql
CREATE TABLE channel_links (
  channel     TEXT NOT NULL,                 -- 'telegram'
  external_id TEXT NOT NULL,                 -- Telegram user id (the same as the private chat id)
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  linked_at   INTEGER NOT NULL,
  PRIMARY KEY (channel, external_id)
);
CREATE INDEX channel_links_user ON channel_links (user_id);

CREATE TABLE channel_link_codes (            -- one-time codes, stored as a hash, short expiry
  code_hash  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE channel_threads (               -- which AI thread a chat on the channel talks to
  channel     TEXT NOT NULL,
  external_id TEXT NOT NULL,
  thread_id   TEXT NOT NULL REFERENCES ai_threads (id) ON DELETE CASCADE,
  last_update INTEGER NOT NULL DEFAULT 0,    -- last Telegram update_id handled (retries and duplicates are ignored)
  PRIMARY KEY (channel, external_id)
);
```

Migrations only move forward (`apps/api/migrations`), and `scripts/deploy.mjs` already applies them in the right order.

### 2. Linking (this is what stops impersonation)

A Telegram account must never become an AMIN user just because it knows a username.

1. The signed-in user taps "Connect Telegram" in the app → `POST /api/channels/telegram/link-code` (normal auth, `userLimit`) creates a random code, stores only its hash with a ~10 minute expiry, and shows it.
2. The user sends `/start <code>` to the bot. The webhook looks the code up by hash, checks expiry, inserts the `channel_links` row, deletes the code. One code works once.
3. The app lists links and can remove one (`DELETE`), which must also stop delivery immediately. Disabling the AMIN user (`users.disabled_at`) must stop the channel too; check it on every update, as `authenticate` does for sessions.

### 3. The webhook route

`POST /api/channels/telegram/webhook`, mounted before the catch-all in `app.ts`, **not** behind `requireAuth` (Telegram has no bearer token) but behind:

- the **secret header**: `setWebhook` is called with a `secret_token`, and Telegram then sends it as `X-Telegram-Bot-Api-Secret-Token` on every request. Compare it with `timingSafeEqualBytes` (already in `lib/crypto.ts`). It is a shared secret, not a signature: if it leaks, anyone can forge updates until it is rotated by calling `setWebhook` again;
- `ipLimit('tg-ip', …)`, and a zod schema for the small part of an `Update` that is used (unknown fields ignored, lengths bounded like everything else);
- an answer of `200` quickly. Telegram retries any non-2xx, so a slow model call must not run inside the request: the run already executes in the `RunCoordinator` Durable Object from an alarm and outlives the request, exactly as for the app.

Handling an update, as the **linked user** (unlinked senders get one short "link your account" reply and nothing else):

- ignore an `update_id` that is not newer than `channel_threads.last_update` (duplicates after a retry);
- text → `startAiTurn(env, authUser, thread, { body, clientId: 'tg_<chat>_<update_id>' })`. The `clientId` is URL-safe and within the 8-64 characters `clientIdField` demands, so even a duplicate that slips past the check cannot start a second run;
- a voice message → download through the Bot API, `AiClient.transcribe`, then as text; a document or photo → `validateUpload` + `storeFile`, then `fileIds`. Check Telegram's current download size limits before promising a number;
- `/new` → `createThread` and update `channel_threads`; `/cancel` → `cancelRun(env, userId, runId)`.

To build the `AuthUser` for the linked user, read the `users` row as `authenticate` does (id, username, display name, role, locale, timezone). `sessionId` is not used by the AI services; pass a placeholder or make the field optional.

### 4. Outbound: the sink

```ts
interface ChannelSink {
  /** Called for every event published to `userId`; must never throw and must not block the caller. */
  deliver(env: Env, userId: string, event: RealtimeEvent): Promise<void>;
}
```

`publishToUsers` would call the registered sinks after the Durable Object publish, wrapped in the same `Promise.allSettled` so a Telegram outage cannot break the app. A Telegram sink:

- forwards events **only for threads that belong to the channel** (a row in `channel_threads`). It must not mirror every thread of the user: a thread in which the user shared messages from an end-to-end encrypted chat must never be copied to a service that is not end-to-end encrypted, and a bot's cloud chat on Telegram is not;
- streams `run.delta` text. Telegram's Bot API offers `sendMessageDraft` (partial text while it is generated; Bot API 9.3, open to all bots since 9.5) and the older `sendMessage` + `editMessageText`, which is throttled to roughly one edit per second in practice. A message is limited to 4096 characters, so long answers are split. Use `offset` to order and de-duplicate deltas exactly as `apps/web/src/lib/streams.ts` does;
- turns `run.approval` into a message with inline buttons whose `callback_data` carries the approval id and the decision. The `callback_query` handler must map the *Telegram sender* to a link and call `decideApproval` for **that** user only; `decideApproval` already refuses an approval that belongs to someone else. Show the exact payload (the target, the text) on the card, since the user is approving on a small screen;
- sends reminders for free: they are AMIN AI messages in the user's reminders thread. That thread is not a channel thread, so forwarding reminders would be an explicit, separate user setting (default off).

Delivery through a sink is **best effort** and never the system of record. D1 is. (Today a reminder is marked *delivered* when its message row exists, not when a device saw it; that is true for the app and would stay true for a channel.)

### 5. Tests

Follow the pattern of `fake-ai` and `fake-google` (`apps/api/test/*/worker.mjs`, wired as service bindings in `vitest.config.ts`): a `fake-telegram` worker records every Bot API call the sink makes and can inject failures, so tests run against the real Worker on workerd without a bot. Minimum cases: a forged or missing secret is rejected; an unlinked sender cannot start a run; a link code works once and expires; a duplicate `update_id` starts nothing; a callback from user B cannot decide user A's approval; a thread that is not a channel thread is never forwarded; a failing Telegram API does not fail the run; the sink never receives data of an E2EE-sourced thread.

### 6. What must not change

The access policy function, the approval fingerprint, `verified: true` before a tool claims success, the per-user quota and the rate limits. A channel is a new door into those services, not a way around them.

## Out of scope for a first version (and why)

- **Telegram groups.** `conversations.type` has a `CHECK (type IN ('ai','direct','group'))` (migration `0001_init.sql`); SQLite cannot alter a CHECK, so a new type means rebuilding the `conversations` table. More importantly, who counts as an "admin" there, and what the AI may read, would need its own policy input (default *off*) and a verified `getChatMember` check. A private chat with the bot needs none of that.
- **Telegram secret chats** cannot include a bot, and end-to-end encrypted AMIN chats must never be forwarded. Nothing to build; the sink rule above is the guard.
- **Mirroring AMIN CHAT conversations into Telegram.** A different product with a different consent model.

## The same seam serves mobile push

The Android app currently has **no notifications** when it is closed (docs/android.md). The missing piece is the same `ChannelSink` with an FCM adapter (plus a Firebase project and a device-token table). Building the sink once serves both.

## Telegram facts used (Bot API documentation)

- `setWebhook` takes an HTTPS `url` (ports 443, 80, 88 or 8443) and an optional `secret_token` of 1-256 characters from `A-Z a-z 0-9 _ -`, which Telegram sends in the `X-Telegram-Bot-Api-Secret-Token` header of every request. While a webhook is set, `getUpdates` does not work. A response other than 2xx makes Telegram retry and eventually give up. `allowed_updates` can be limited to `message` and `callback_query`.
- `sendMessageDraft`: added in Bot API 9.3 (31 Dec 2025), allowed for all bots from Bot API 9.5 (1 Mar 2026). Message text is limited to 4096 characters.
- Sources read in November 2026: <https://core.telegram.org/bots/api> (as quoted by search results) and developer write-ups of the same documents. The Bot API changes often: re-read the current version, and the changelog, before building.
