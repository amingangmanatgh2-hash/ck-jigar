# Testing

What is tested, how real each test is, how to run it, and — the part that matters most — **what is not tested**. Numbers are from a full run of `npm test` (about 1.5 minutes).

## Run it

```bash
npm ci                 # exactly what package-lock.json says (Node 22, see .nvmrc)
npm run typecheck      # shared + api + web (tsc), must be clean
npm test               # everything below, one command (exit code 0 = all green)

npm run test:scripts   # deploy / preflight / DEPLOY_ENV loader / drive-token / relay (node:test)
npm run test:api       # the Worker, on a real workerd
npm run test:web       # the web app, in jsdom
npx -w @aminchat/api vitest run test/agents.test.ts    # one API file
cd apps/web && npx vitest run test/Markdown.test.tsx   # one web file
```

GitHub runs the same on every push and pull request (`.github/workflows/ci.yml`: `npm ci`, a production-dependency audit, typecheck, `npm test`, build). The Android workflow builds the APK and checks it (docs/android.md).

## Totals

| Layer | Files | Tests | Runs on |
|---|---|---|---|
| Scripts and relay | 5 | 125 | Node's built-in test runner |
| API (`apps/api/test`) | 16 | 320 | **real workerd** (Cloudflare's own runtime), real SQLite-backed D1, Durable Objects, R2 |
| Web (`apps/web/test`) | 22 | 239 | jsdom (one file in plain Node for WebCrypto) |
| **Total** | **43** | **684** | |

## How real is "real"? The three doubles

The API tests do not mock the application. They run the Worker's actual code (`apps/api/src`) inside `@cloudflare/vitest-plugin`'s workerd, with every D1 migration applied, the three Durable Object classes, an R2 bucket and the real HTTP routing, and they talk to it over `SELF.fetch` like a client would. Three things outside our control are replaced by a **service binding to a small deterministic worker**:

| Double | Replaces | Where |
|---|---|---|
| `fake-ai` | the Workers AI binding (`env.AI`) | `apps/api/test/fake-ai/worker.mjs` |
| `fake-google` | Google's OAuth and Drive HTTP APIs | `apps/api/test/fake-google/worker.mjs` |
| `fake-groq` | Groq's HTTP API (`/openai/v1/chat/completions`, `/openai/v1/models`) | `apps/api/test/fake-groq/worker.mjs` |

Production code cannot tell: it calls `env.AI.run(...)` and `fetch` as usual. **A double proves our code handles the responses we *believe* the real service returns; it cannot prove those beliefs.** That is the single biggest caveat of this test suite; see "Not verified" below. None of the doubles exists in production code, which has no canned or simulated model output (`AI_NOT_CONNECTED` when no provider is connected). A unit test fails if any model id of the registry (Workers AI or Groq) or a `@cf/` prefix appears anywhere except `apps/api/src/ai/models.ts`. Groq is plain HTTP, so `fake-groq` is reached through a service binding the Worker's `GROQ_API` setting points at (the setting exists only in the test configuration; production always calls `api.groq.com`). The Groq key is **not** set globally in the tests, because Groq answers the `fast` role first and would then change every other suite; suites that want it call `groqOn()` / `groqOff()` (`test/groq-helpers.ts`).

## API suites (320 tests on workerd)

| File | Tests | What it checks |
|---|---|---|
| `unit.test.ts` | 41 | Pure logic: model registry, response normalisation, SSE parser, error classification, text utilities, `@AMINAI` mention detection, **the AI access policy**, the prompt-injection rule being present |
| `ai-client.test.ts` | 25 | `AiClient` against the scripted AI double: the three response shapes, streaming, per-model tuning and retry without a rejected parameter, fallback order, cancellation, model availability and reason codes |
| `ai-chat.test.ts` | 21 | AMIN AI conversations: isolation between users, send / stream / regenerate / edit-and-resend, idempotent `clientId`, quota and concurrency limits, files, images and voice, search over past conversations, the agents and models endpoints |
| `agents.test.ts` | 25 | Task engine: routing, planning, step execution, retries, operation log; **approvals** (sensitive tools park the run, edit, reject, expiry, fingerprint mismatch); cancel; file and boundary cases (including **which files the assistant may read for whom**: own files; a file shared in a chat only while that chat's AI level is `context`; never for an outsider); the prompt-injection rule in a real run |
| `assist.test.ts` | 14 | `@AMINAI` in direct chats (permission first, **only the mention's and its reply's files are read**), in secret chats (the user selects what to share), in groups (admins control the level and who may invoke) |
| `messenger.test.ts` | 14 | Direct chats, groups and roles, per-chat AI settings, secret chats, user search |
| `connectivity.test.ts` | 16 | Idempotent sends, realtime long-poll, advertised endpoints, client address behind a relay, and that `/api/health` reports which AI services have credentials (yes/no only) |
| `auth.test.ts` | 17 | Register, login, sessions, password change, rate limiting, admin role, **a disabled account is rejected at once, cannot log in and is hidden**, **the password-hash cost setting (`PASSWORD_HASH_ITERATIONS`): used by register and change-password, recorded in the hash, upgraded at sign-in, never downgraded, never overwriting a password changed in the meantime** |
| `memory.test.ts` | 11 | Memory is manageable (view, edit, delete, disable, suggestions) and **never leaks across users** |
| `files.test.ts` | 6 | Upload validation and file access |
| `storage.test.ts` | 34 | The cold file tier: offload from R2 to Google Drive, reading, access control, deleting, Drive connection problems, admin API, cron |
| `drive-client.test.ts` | 11 | The Google Drive client against the fake Google |
| `request-id.test.ts` | 9 | `X-Request-Id` on every response and its CORS exposure |
| `groq-provider.test.ts` | 33 | The Groq adapter against `fake-groq`: the request body (`max_completion_tokens` with room for the hidden reasoning, no `max_tokens`, no `stream_options`), the mapping of every HTTP error to a fallback kind, the registry (Groq first for quick tasks, Workers AI first for conversation, ids kept apart), a blank secret is not a key, the key travels only in the `Authorization` header, streaming with usage in the last chunk, `Retry-After`, a wrong key (401, never repeated back), one retry without the tuning parameters when Groq refuses one (and only then), a network failure versus a cancellation, and the key's model list |
| `groq-client.test.ts` | 21 | Two providers in `AiClient`: quick requests go to Groq first and conversation to Workers AI first; streaming; usage estimated (and marked) when Groq reports none; fallback both ways (Groq busy or failing → Workers AI, Cloudflare failing or its daily allowance spent → Groq, without hammering the other Cloudflare models); both providers out; no key means Groq is never called or offered; Groq alone without the Workers AI binding; prompts too big for Groq's free tier stay off it; images never go to it; reasoning headroom and an empty answer not accepted; the per-user quota is enforced before Groq is asked; cancelling a stream aborts the HTTP request; no model switch after text reached the user; health checks (catalogue plus a real call), a rejected key, and an unconnected provider shown honestly; the key appears in no response, stored error, run log or usage record |
| `quick-agent.test.ts` | 22 | The fast `quick` agent: name matching (Persian and Latin: case, `@`, letter variants, vowel marks, half-spaces); `chat_open` is read-only and never sends, creates or changes anything, finds an existing chat by name, `@username` or group title, asks which one when several match equally, prefers the better match, offers the normal chat by default and the secret one only when asked, offers to start a chat with a person who has none (creating nothing), never exposes other people's chats, never offers the AMIN AI conversation itself, treats SQL wildcards as plain characters; the agent is read-only by construction and recognised in both languages ("open a chat" is not mistaken for "send a message"); end to end with Groq answering every model call, the app gets a button and nothing navigates by itself; and the same run still completes on Workers AI when Groq refuses |

**Log noise you will see.** The suites that drive the fake model (`agents`, `ai-chat`, `assist`, `memory`, `connectivity`) print lines such as `FakeAI.run … 5000: internal server error` and `The Workers runtime canceled this request because it detected that your Worker's code had hung`. The first is the double simulating a Workers AI failure on purpose. The second looks like workerd cancelling a request to the fake model that was still open when a test ended or was cancelled (our reading, not investigated further). Suites that never start a model run (`auth`, `files`, `storage`, `messenger`) print none, and every run exits 0. It was observed locally only, and it is not something production code prints.

Many of these are written as attacks, not just happy paths: a second user trying to read, send, select from, cancel or attach someone else's things; a forged approval payload; a denied `@AMINAI` mention that must post nothing; over-quota and over-rate calls.

## Web suites (239 tests in jsdom)

| File | Tests | What it checks |
|---|---|---|
| `endpointPool.test.ts` | 28 | Server address pool: failover only on evidence that it is the *server* that failed, probing, learned addresses, back-off |
| `serviceWorker.test.ts`, `serviceWorker.build.test.ts` | 20 + 7 | The offline shell's logic, and the generated service worker of the real build (precache list, no `/api` interception) |
| `streams.test.tsx`, `deltas.test.ts` | 17 + 6 | Streaming answers: ordering, de-duplication by `offset`, no loss across screen changes |
| `outbox.test.ts`, `apiTransport.test.ts`, `realtime.test.ts` | 17 + 14 + 16 | Offline-tolerant exactly-once sending, request transport and retries, WebSocket and long-poll |
| `aiThread.test.ts`, `runs.test.ts` | 15 + 9 | AI conversation state and the run / step / approval state |
| `MessageBubble`, `Composer`, `ApprovalCard`, `Connection`, `StorageSection`, `Markdown` | 9, 8, 7, 10, 8, 6 | Components, including that Markdown never renders raw HTML or loads an image from an address in an answer |
| `Providers.test.tsx` | 10 | The Models page with two providers (which services are connected and where each model runs; the Groq privacy note only when Groq is connected; "Groq is not connected" while Workers AI still is; one warning and no model shown ready when no service is connected; the same messages in Persian) and the agent picker's own icon for the Quick agent; the run panel's **Open chat** button (opens an existing chat only when the user taps; starts a chat with a person who has none yet only on tap, then opens it; shows the reason and stays put when that fails; no button when the step found nothing) |
| `locales.test.ts` | 8 | Persian has exactly English's keys and placeholders, is really Persian, every error code the API can send has a text in both languages, `dir` and `lang` switch correctly |
| `e2ee.test.ts`, `session.test.tsx`, `text.test.tsx`, `useStickToBottom.test.tsx` | 7, 6, 6, 5 | WebCrypto round-trips, session handling, text helpers, scroll behaviour |

## Scripts and relay (125 tests)

`relay/relay.test.mjs` (44: HTTP, WebSocket and direct-HTTPS forwarding, header handling, limits, configuration errors), `scripts/deploy.test.mjs` (39: the migrate-before/after-deploy decision, dry-run, the check that `ADMIN_USERNAMES` names somebody who can really register — including a test that the list of reserved names and the username pattern still match `packages/shared/src/constants.ts` — pasted credentials with a stray line break are trimmed, the **Groq secret step**: the key goes to `wrangler secret put` on standard input only, never in an argument, is redacted from everything printed, a broken key is not stored, a failure to store only warns, and what the deploy workflow may do with secrets: only `env:` entries, the accepted spellings and their order, one flag per name that is a yes or no, never the whole secrets context — GitHub refused to run the workflow when it dumped it —, and the DEPLOY_ENV step that runs only in deploy runs), `scripts/preflight.test.mjs` (21: the pre-deployment check against a stand-in for the Cloudflare and Groq APIs: every problem reported at once with its fix, Groq problems never block, no credential printed or sent to the wrong host, timeouts and a retry, annotations escaped, the message for missing credentials, and that the workflow runs it before the tests and the deployment), `scripts/load-deploy-env.test.mjs` (14: the single `DEPLOY_ENV` secret: the ways people paste lines, the official name wins over its shorter spelling, a line that is not NAME=value is skipped and never shown, credentials are masked before anything is logged or written, nothing but printable ASCII is handed on, the run is never failed by it), `scripts/drive-token.test.mjs` (7).

## Checked by hand in a real browser (not automated in the repository)

With headless Chrome driving a production-shaped Worker (real workerd serving the built web app) and, for the relay checks, the relay in front of it: the offline shell (11 of 11 checks), the relay with a real WebSocket, a blocked WebSocket falling back to long-poll, and an offline outbox (17 of 17), and layout on phone and desktop sizes in Persian and English (27 of 27), plus several UI flows in earlier rounds. In these runs the AI was a scripted stand-in, not a model. These runs found real bugs (a banner covering the chat header, an "alternative address" banner that never cleared) that the unit tests had missed, and those are fixed and covered by unit tests now. **The scripts are not in the repository** (they depended on a rig assembled by hand); the findings above are the record. Turning them into a committed end-to-end suite (for example Playwright in CI) is the most valuable next piece of test work.

## Not verified — read this before relying on it

1. **The real Workers AI call path.** Everything about the model side was tested against `fake-ai`. Unverified against Cloudflare: the exact streaming chunk shapes, whether a stream reports `usage`, `reasoning_effort`, what `env.AI.models()` returns, the speech-to-text input and output, the image model's output. The model ids and the parameters came from Cloudflare's documentation. `npm run verify:ai` (or the manual GitHub workflow **Verify Workers AI**) calls every model the app depends on with the app's own parser and reports PASS, WARN or FAIL; it has **never run** against the real service.
2. **A real deployment.** `npm run deploy`, the **Deploy to Cloudflare** workflow, wrangler's automatic provisioning of the D1 and R2 bindings and by-name database lookup have never run against a Cloudflare account. Unmeasured: whether the free plan's 10 ms CPU limit breaks password hashing (docs/deploy.md recommends the paid plan).
3. **Real Google Drive** and the `drive:token` helper: tested only against the self-written fake.
4. **The real Groq call path.** The whole Groq integration was tested against `fake-groq`, which I wrote from Groq's published documentation (errors, rate limits, API reference, model pages), not from a real response. Unverified against Groq: where a stream reports its token usage (`usage` or `x_groq.usage`; both are read), the tool-call shape, how many reasoning tokens a `gpt-oss` answer really spends (the headroom is a guess; an empty answer is skipped and falls back, never shown), whether `include_reasoning: false` and `reasoning_effort` are accepted exactly as sent (one retry without tuning parameters covers a refusal), the real limits of the key (`console.groq.com/settings/limits`; the 5 000-token ceiling for Groq prompts assumes the free tier's 8 000 tokens per minute), and the 413 (`too_large`) path, which is only unit-mapped. The deploy step that stores the key and the preflight that checks it were tested against stand-ins as well.
5. **A real Android device or WebView.** The APK is built on GitHub and its contents are checked (10 checks), but nobody has installed it. Microphone, keyboard, system bars and speed in the real WebView are unverified. No push notifications exist.
6. **A real filtered network.** Connectivity logic is tested with simulated failures and a relay in front of the Worker, not on a real Iranian network. The relay's TLS, nginx, Caddy, Docker and systemd example files have never been run.
7. **Untested code paths:** the 45-second tool timeout, `image_generate`, the Brave and Tavily web-search providers, and (in the web app) the screens in `src/screens`, the run panel, the thread drawer, the share dialog and the pickers, which are covered only by the manual browser runs above.
8. **`@AMINAI` streaming in direct and group chats** was not looked at in a browser.
9. **No performance, load or concurrency testing, no accessibility audit** beyond what the manual layout runs looked at, and **no independent security review** (docs/SECURITY.md).
10. The Deploy workflow has run only in `check` mode (the plan and the tests, no secret, nothing published). Its `deploy` mode, the preflight step and the Verify-Workers-AI workflow have never run; they are linted (action-validator and a syntax check of every embedded script) and their shell logic was exercised against local stand-ins.

## Adding tests

- API: put a `*.test.ts` in `apps/api/test`, use the helpers in `test/helpers.ts` (`registerUser`, `api`, `json`) and `test/ai-helpers.ts`. D1 state persists within a file, so use fresh users, and `freshIp()` for the register and login limits. To change what the AI double answers, see the scripting API at the top of `test/fake-ai/worker.mjs`. Unconfigured Drive: `withEnv({ GOOGLE_REFRESH_TOKEN: undefined })` from `test/google-helpers.ts` (every API test file is given Drive credentials and the fake Google by default).
- Web: `apps/web/test/*.test.ts(x)`; jsdom has no layout, `matchMedia` or `ResizeObserver`, so layout belongs in a browser run, not here. Reset fetch mocks per test.
- A test for a bug comes first: write it, watch it fail for the right reason, then fix (the Markdown image test did exactly that).
