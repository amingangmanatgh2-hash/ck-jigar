# Security

This document says what AMIN CHAT protects, how, and — just as important — what it does **not** protect. Everything below was read from the code or checked by an automated test; where something could not be verified it says so. Last reviewed in November 2026.

<div dir="rtl">

## خلاصه (فارسی)

- **هر درخواستی احراز هویت می‌شود** (توکن تصادفی ۲۵۶ بیتی؛ فقط هش آن در پایگاه داده است). تنها استثناها: `/api/health`، ثبت‌نام، ورود (هر سه با سقف نرخ) و WebSocket (با بلیت یک‌بارمصرف ۶۰ ثانیه‌ای).
- **دسترسی هوش مصنوعی به چت‌ها را خودِ کاربران/مدیران گروه تعیین می‌کنند** و پیش‌فرض «خاموش» است. در چت‌های رمزنگاری‌شده (E2EE) سرور اصلاً چیزی نمی‌خواند؛ فقط پیام‌هایی که کاربر آگاهانه انتخاب کند.
- **عملیات حساس (ارسال پیام، نظرسنجی، اطلاعیه، دسته‌بندی فایل) بدون تأیید کاربر اجرا نمی‌شود**؛ تأیید به محتوای دقیق گره خورده است و ۲۴ ساعت اعتبار دارد.
- **حافظهٔ هر کاربر جداست**، قابل مشاهده، ویرایش، خاموش‌کردن و حذف است؛ دستیار فقط پیشنهاد می‌دهد.
- **محدودیت‌های صادقانه:** ورود دومرحله‌ای، بازیابی گذرواژه و حذف حساب ندارد؛ توکن مرورگر در `localStorage` است؛ ابزار نظارت درون‌برنامه ندارد (مدیر برنامه نمی‌تواند حسابی را غیرفعال کند؛ فقط با ویرایش مستقیم پایگاه داده ممکن است)؛ رمزنگاری E2EE فاقد تأیید کلید و forward secrecy است و ممیزی مستقل نشده؛ برای صفحهٔ وب CSP تنظیم نشده؛ مالک حساب Cloudflare می‌تواند پیام‌های غیر E2EE را در D1 ببیند. فهرست کامل در بخش «آنچه محافظت نمی‌شود».
- **گزارش آسیب‌پذیری:** جزئیات حمله را در Issue عمومی ننویسید؛ مستقیم به مالک مخزن بگویید (قابلیت «Private vulnerability reporting» در GitHub هنوز روشن نیست؛ مالک می‌تواند از Settings ← Code security روشنش کند).

</div>

## Reporting a vulnerability

Do not post exploit details in a public issue. Tell the repository owner privately. (GitHub's *private vulnerability reporting* is currently **off** for this repository; the owner can switch it on under Settings → Code security, after which reports can be filed from the Security tab.) Include the `X-Request-Id` of a failing request if you have one.

## Assets and adversaries

| Asset | Who might attack it |
|---|---|
| Accounts and sessions | someone guessing passwords, someone who steals a device or token |
| Messages, files, the AI's memory of a user | other users, a group admin, anyone on the internet, a curious or compromised relay |
| What the AI may read | text inside chats, files and web pages that *talks to the model* (prompt injection) |
| The operator's budget (Workers AI neurons, R2, Google Drive) | abusive or runaway usage |
| The operator's Cloudflare and Google credentials | leaks through the repository, logs or the app |

Out of scope: the operator themself. Whoever owns the Cloudflare account can read everything that is not end-to-end encrypted (see "What is not protected").

## Authentication and sessions

- **Passwords:** PBKDF2-HMAC-SHA256, **100 000 iterations** (the most Cloudflare Workers allow; `apps/api/src/lib/crypto.ts`), a random 16-byte salt per password, stored as `pbkdf2-sha256$iterations$salt$hash`. Comparison is constant-time. Login does the same amount of work for an unknown user as for a wrong password and returns the same error, so usernames cannot be enumerated by response or timing. 8–128 characters; there is no complexity rule and no breached-password check.
- **Sessions:** an opaque token of 256 random bits, returned once at login. Only its **SHA-256** is stored, so a database leak does not yield usable tokens. A session lasts 30 days (fixed, not extended by use), appears in the user's session list, can be revoked individually, and **changing the password revokes every other session**. The `users.disabled_at` flag is honoured on every request: an account that carries it is rejected on its very next request, cannot log in, and disappears from search and profiles (a test pins all of this). **Nothing in the app sets the flag**, see limitation 3. An already-open live-update connection is not closed by it (the Durable Object does not look at the flag), and a WebSocket ticket issued just before it was set stays usable for up to 60 seconds; no new ticket or long-poll request is accepted (both need an authenticated session). The assistant's own account (`kind = 'ai'`) can never hold a session.
- **Brute force:** 30 register/login calls per 10 minutes per IP and 10 login (or change-password) attempts per 15 minutes per username, in a Durable Object.
- **No cookies.** The token travels in an `Authorization` header, so cross-site request forgery does not apply.
- **WebSocket:** the token is never put in a URL. A signed-in client asks for a **single-use ticket valid 60 seconds** and opens the socket with it; the upgrade also checks the browser `Origin`.

## Authorization — every request

- `requireAuth` is applied to every router, and the catch-all answers unknown `/api/*` paths with 404. The unauthenticated surface is exactly: `GET /api/health` (no data beyond service name, time, environment and the public alternative addresses), `POST /api/auth/register`, `POST /api/auth/login`, and `GET /api/realtime/ws` (ticket). Static files of the web app are public by nature.
- Services never trust an id from the client: conversation access goes through a membership check, AI threads and runs and approvals and memory are always queried **with the caller's user id**, and a stranger's id gives `404`, not `403`, so existence is not revealed. File download is allowed only to the owner and to members of the conversation the file is attached to.
- Tests with two or more users cover: reading or sending in a chat you are not in, selecting messages from a chat you are not in, `@AMINAI` from outside a group, attaching someone else's file, cancelling someone else's reminder, one user's memory appearing in another user's prompts, and AI conversations being invisible to other users (`apps/api/test/*.test.ts`).
- **Admins** (role `admin`, from `ADMIN_USERNAMES`) can manage quotas and look at usage and storage health. There is **no endpoint** for an admin to read other people's messages, files or memory. Because `ADMIN_USERNAMES` is claimed by *the first person who registers that name*, register it immediately after deploying (docs/deploy.md).
- Validation: every body and query is parsed with a zod schema with explicit bounds; unknown enum values are rejected; errors are a stable `{code, message}` and never contain stack traces (those go to the log, truncated).

## Abuse and cost control

| Control | Value | Where |
|---|---|---|
| Request rate per user | 600/min for the API, 120/min chat messages, 30/min AI-starting calls, 12/min heavy calls, 30/min uploads | `config/limits.ts`, `middleware/rate-limit.ts` |
| AI quota per user | default 300 000 tokens/day, 400 requests/day, 4 000 000 tokens/month (per-user override by an admin) | `ai/usage.ts` |
| Concurrent AI runs per user | 3 | `services/ai-chat.ts` |
| One run | ≤ 8 steps, ≤ 14 model calls, ≤ 10 minutes, 45 s per tool call | `config/limits.ts` |
| Inputs | message, file (25 MiB), audio (10 MB), memory (200 items × 600 chars), group size, poll options are all bounded | `packages/shared/src/constants.ts` |

The rate limiter **fails open**: if the Durable Object is unreachable the request is allowed (and the failure is logged), because an outage of the limiter must not take the messenger down. The AI quota fails closed.

## What the AI may read

`packages/shared/src/access.ts` is one pure function used by the server for **every** decision (the web app only uses it to explain). Default for every chat is *off*.

| Conversation | Rule |
|---|---|
| The user's own AMIN AI chat | full access (it is the user's own space) |
| Secret (E2EE) chat | **never** by the server. The user selects messages in the app; the app decrypts them locally and sends only those as `excerpts` |
| Direct chat | the *invoking* user grants `mention` (the invoking message and what it replies to) or `context` (recent history). **Anyone in the chat can block AI for everybody** |
| Group | owners/admins set the level `off` / `mention` / `context` / `assist` for the whole group and who may invoke it (`all` / `admins`). A member cannot opt out of what the admins enabled |

A denied `@AMINAI` mention is reported to the sender only; nothing is posted into the chat and no model is called. Context is bounded (≤ 60 messages / 8 000 tokens). Tests: `apps/api/test/assist.test.ts` and the policy cases in `unit.test.ts`.

### Which files the assistant reads, and for whom

A stored file can reach a model by exactly three routes (every caller of the code that turns a file into model input was checked), each with its own rule:

1. **Your AMIN AI conversation:** the files you attached yourself. Attaching requires that you own the file and that it is not attached to anything else (otherwise `INVALID_ATTACHMENT`).
2. **An `@AMINAI` mention in a chat:** only the files of **the message that carries the mention and the message it replies to** (same chat; the policy above has already admitted this invoker for this chat). The recent-messages transcript of the `context` level is text only: files of earlier messages are not read, and encrypted messages never enter it. To point the assistant at somebody's file, reply to that message while mentioning it.
3. **The File agent's tools:** `file_list` shows only the caller's own uploads. `file_read` asks `canAiReadFile`: the caller's own files, or a file attached to a chat **only if the caller's AI access to that chat reads at the `context` level** (in a group, the admin levels `context` and `assist` both do; `off` and `mention` do not). Anyone else gets `FILE_NOT_FOUND`.

The function that converts a file (`readFileForAi`) does not check who is asking. It only checks that the file is technically readable (≤ 12 MiB, a supported type, content available); the access decision is made before it is called, by the three routes above.

Voice input (`POST /api/ai/transcribe`) is not a stored file: the recording travels in the request, is transcribed and is not kept.

Worth knowing: when you mention AMIN AI in a reply to somebody else's message that has a file, that file is sent to the model on your behalf. You can already open it, and you chose to invoke the assistant there.

Tests: `agents.test.ts` (each branch of `canAiReadFile`: own file, a chat's file at `off` / `mention` / `context`, an outsider) and `assist.test.ts` (only the mention's and the reply's files are sent). Both were checked by breaking the code on purpose and watching them fail.

## Agents, tools and approvals

- An agent can use **only the tools on its list** (`agents/registry.ts`); the planner choosing another tool is dropped. Agents never get a general "run anything" tool, outbound HTTP to user-supplied addresses, or database access. The only outbound calls the Worker makes are to the configured search provider (Brave or Tavily) and to Google (Drive), at fixed hosts, so there is no server-side request forgery surface.
- **Sensitive tools never run directly:** `message_send`, `poll_create`, `announce_post`, `file_categorize`. The executor validates preconditions, stores an approval with the exact arguments and their **SHA-256 fingerprint**, parks the run in `awaiting_approval`, and shows the card to the user. Editing fields is allowed only for the fields the tool declared editable, and the edited payload is re-validated and re-fingerprinted. Execution refuses a payload whose fingerprint differs from what was approved. An approval expires after 24 hours. Approving or rejecting is done by the owner of the run only.
- **No success without confirmation:** a tool that changes something must return `verified: true` after re-reading the state; otherwise the step is failed and the final answer is composed from tool results only. A cancelled run aborts in-flight model and tool calls.
- A model's argument choices are validated by the tool's own schema before anything runs (one repair attempt, then `ARGS_INVALID`), and every lookup a tool makes is scoped to the run's user id (a verification re-read happens only after a scoped update succeeded).

## Prompt injection

Text from chats, files, images, web pages and tool results is attacker-controlled input to the model. The real protections are structural (the points above: tool lists, approvals, the access policy, bounded context, run limits), so that a model that *is* fooled still cannot send a message, read a private chat or act without the user's approval. On top of that every prompt that sees other people's text (agent prompts, `@AMINAI`, planner, argument writer) carries a rule that such text is data, not instructions, and that instructions found in it must be reported rather than obeyed; a test checks the rule is present in all of them. The display side is closed too: an answer cannot cause a request by itself (no auto-loaded images, no raw HTML, see "Web and transport hardening"). This reduces, but cannot eliminate, the risk of a model following hostile text: treat the approval card as the real safeguard and read what it says.

## Memory and privacy

- Memory is per user, never shared and never put into another user's prompt (tested). Permanent items are created by the user or by the user **approving a suggestion**; the assistant can only propose. `memory_settings` lets the user switch memory off, switch suggestions off, and allow or forbid recalling past AI conversations (**off by default**).
- The user can view, edit, delete one item or delete everything (`DELETE /api/ai/memory` with `{"confirm": true}`), and delete a whole AI conversation, which removes its messages, runs, search-index entries and attached files including their copies in R2 or Google Drive.
- Temporary conversation memory (the history of one thread, windowed to a token budget) is separate from the permanent memory.
- **When the AI is used, the text it needs is sent to Cloudflare Workers AI** to be processed by the chosen model. Read Cloudflare's current data-use terms for Workers AI before relying on this for confidential material; the app cannot promise more than they do.

## End-to-end encrypted ("secret") chats

Design (`apps/web/src/lib/e2ee.ts`, WebCrypto only): every device creates an **ECDH P-256** key pair; the private key never leaves the device (it is kept in the browser's `localStorage`, and the Android app does not back it up); the public key is published to the server. For a conversation both sides derive a shared secret, run it through **HKDF-SHA256** (info `aminchat-e2ee-v1`) and encrypt each message with **AES-256-GCM** and a fresh random 12-byte IV. The server stores `{v, iv, ct}` only, never indexes it for search, and never gives it to the AI.

Be aware of what this does **not** give you:

- **No key verification.** There are no safety numbers or fingerprints to compare. The peer's public key comes from the server, so a malicious or compromised *server* could substitute a key (a man-in-the-middle). The design protects against someone who only reads the database or the network, not against an active, malicious operator.
- **No forward secrecy.** Keys are long-lived per device; whoever obtains a private key can decrypt everything that device could.
- **Keys are per device.** A secret chat is readable only on the device holding the key; signing in elsewhere, clearing browser data or reinstalling the app loses access to earlier messages (on Android `allowBackup=false` means the key is not restored on a new phone).
- The server still sees **metadata**: who talks to whom, when, and the size of messages. No attachments or polls in secret chats.
- If the user chooses to **share messages with AMIN AI**, those messages are decrypted in the app and sent to the server and the model as plain text. That is the conscious choice the design is built around; nothing is shared automatically.
- This is custom composition of standard primitives that has **not been independently reviewed**. For high-risk use, prefer an audited messenger for that conversation.

## Files

Uploads are limited to 25 MiB and stored in R2 (cold files later move to Google Drive with the `drive.file` scope, which only lets the app see files it created). Downloads go through the Worker after the access check above (never a public bucket or Drive link) with `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, and `Content-Disposition: attachment` except for a short list of safe types. Deleting a message or file also deletes the stored copy, retrying in the periodic sweep if the storage service is unreachable.

## Web and transport hardening

- API responses carry `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. CORS allows the site's own origin, the operator's configured origins and the Android app's origins, never `*`.
- The web app renders text through React (escaped) and Markdown **without raw HTML**; there is no `dangerouslySetInnerHTML`, `eval` or `innerHTML` in the app code, `javascript:` links are dropped, and links open in a new tab with `noopener noreferrer`.
- **An answer can never make the browser fetch an address.** Markdown images (`![](https://…)`) are not rendered as `<img>`; they become a link that loads nothing until the user opens it. Without this, text that fools the model could carry private chat content out in an image address (the usual prompt-injection exfiltration trick). The only `<img>` in the app shows an attachment fetched with the user's own session from this server. Test: `apps/web/test/Markdown.test.tsx`.
- The service worker never touches `/api/*`, other origins or non-GET requests, so it cannot cache or replay private data.
- **Gap:** the web app itself is served **without a Content-Security-Policy** (only file downloads have one). A CSP would add a second layer against script injection. It needs the inline theme script in `index.html` moved to a file and a `_headers` file in `apps/web/public`; it was not done, and the session token is in `localStorage`, so an XSS bug, were one to exist, would expose it.

## Secrets and configuration

Cloudflare and Google credentials are Worker **secrets** (`wrangler secret put …`) or GitHub Actions secrets, never in the repository. `.gitignore` excludes `.dev.vars*`, `.env*` (except the `.example` files) and signing keystores. No API returns a secret: the storage status shows health only. `vars` in `wrangler.jsonc` (such as `ADMIN_USERNAMES`) are public configuration. The Android release key is held in GitHub secrets; lose it and updates can no longer be installed over existing installs (docs/android.md).

## Android app

Minimum permissions (`INTERNET`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`), no cleartext traffic, `allowBackup=false` (the session token and E2EE key must not reach a cloud backup), and the web app is inside the APK rather than loaded from a remote address. The CI build checks all of this on every APK (docs/android.md). Not verified on a real device.

## Relays

A relay (`relay/`) is a transparent proxy: whoever runs it can read everything that is not end-to-end encrypted, including tokens. It strips client-forgeable identity headers and cookies, signs the real client address with a shared secret so rate limits still apply per person, is not an open proxy, and logs no addresses or query strings. Only use relays you run or fully trust (relay/README.md).

## Logging and audit

Errors are logged with the request id, the error message and a truncated stack. The code never logs request bodies, tokens or passwords, and only error text (not user content) reaches the log; a library that echoed its input inside an error message would be the one way for something to slip in, and none is known to. Security-relevant changes are written to `audit_log`: quota changes by an admin, storage checks and offloads, a user's per-chat AI consent, and a group's AI policy. (Membership and title changes are **not** audited.) Every approval, step and tool result of an AI run is in `run_events` (the operation log the user can open).

## Dependencies and supply chain

- `npm ci` from a committed lockfile in CI; `npm audit --omit=dev` (production dependencies) reports **0 vulnerabilities** (November 2026), and the CI step *Known vulnerabilities in production dependencies* fails the build on any high or critical advisory there.
- `npm audit` over the whole tree reports 7 high findings with **one root cause**: a ReDoS in `picomatch` (GHSA-fc5q-39xc-vjpf), reachable only through development tooling (vite, vitest and their glob helpers), not shipped to users, and exploitable only with attacker-chosen glob patterns, which this project never feeds it. No fixed release exists (every version up to the latest, 4.0.7, is listed as affected), and the suggested `npm audit fix --force` would downgrade Vite. Re-check periodically.
- GitHub Actions are referenced by version tag (for example `actions/checkout@v7`), not pinned to commit SHAs. Pin them if you need stricter supply-chain control.

## What is not protected (known limitations)
1. **The Cloudflare account owner can read non-E2EE content.** Messages and files are stored in plain text in D1 and R2 (encrypted at rest only by Cloudflare's platform). Admin role inside the app does not grant this, but the operator's dashboard does.
2. **No two-factor authentication, no email, no password reset, no self-service account deletion.** A forgotten password means a lost account.
3. **No in-app moderation.** No admin route or screen disables, suspends or deletes an account, and the application administrator cannot read or remove content in other people's chats. `users.disabled_at` is honoured everywhere (see Sessions) but can only be set by editing the database directly. From `apps/api`: `npx wrangler d1 execute amin-chat-db --remote --command "UPDATE users SET disabled_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE username = 'someone' AND kind = 'human'"` (set it back to `NULL` to re-enable). The SQL was run on a SQLite database built from this repository's migrations; the `wrangler d1 execute --remote` call itself was never run against Cloudflare. What does exist: owners and admins of a group can delete other members' messages in that group.
4. **The token lives in `localStorage`** in the browser, and there is **no CSP** on the web app (see above).
5. **E2EE limits** listed above: no key verification, no forward secrecy, per-device keys, not independently audited.
6. **Prompt injection cannot be ruled out**; the approval step is the safeguard for anything with side effects.
7. **A group member cannot opt out of AI** when that group's admins enabled it (they can leave the group).
8. The rate limiter fails open if its Durable Object is down.
9. Token counts are estimates when a model does not report usage (they are marked as such), so quotas are approximate.
10. **No independent security review or penetration test** has been done. The automated tests (docs/testing.md) are good at regressions, not at finding what nobody thought of.
11. Not verified on real infrastructure: the Workers AI call path, the Cloudflare deployment, Google Drive, a real Android device, and a real filtered network (docs/testing.md has the full list).
