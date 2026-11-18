# Testing

What is tested, how real each test is, how to run it, and — the part that matters most — **what is not tested**. Numbers are from a full run of `npm test` (about 1.5 minutes), plus the one test added after that run.

## Run it

```bash
npm ci                 # exactly what package-lock.json says (Node 22, see .nvmrc)
npm run typecheck      # shared + api + web (tsc), must be clean
npm test               # everything below, one command (exit code 0 = all green)

npm run test:scripts   # deploy / drive-token / relay (node:test)
npm run test:api       # the Worker, on a real workerd
npm run test:web       # the web app, in jsdom
npx -w @aminchat/api vitest run test/agents.test.ts    # one API file
cd apps/web && npx vitest run test/Markdown.test.tsx   # one web file
```

GitHub runs the same on every push and pull request (`.github/workflows/ci.yml`: `npm ci`, a production-dependency audit, typecheck, `npm test`, build). The Android workflow builds the APK and checks it (docs/android.md).

## Totals

| Layer | Files | Tests | Runs on |
|---|---|---|---|
| Scripts and relay | 3 | 67 | Node's built-in test runner |
| API (`apps/api/test`) | 13 | 234 | **real workerd** (Cloudflare's own runtime), real SQLite-backed D1, Durable Objects, R2 |
| Web (`apps/web/test`) | 21 | 229 | jsdom (one file in plain Node for WebCrypto) |
| **Total** | **37** | **530** | |

## How real is "real"? The two doubles

The API tests do not mock the application. They run the Worker's actual code (`apps/api/src`) inside `@cloudflare/vitest-plugin`'s workerd, with every D1 migration applied, the three Durable Object classes, an R2 bucket and the real HTTP routing, and they talk to it over `SELF.fetch` like a client would. Two things outside our control are replaced by a **service binding to a small deterministic worker**:

| Double | Replaces | Where |
|---|---|---|
| `fake-ai` | the Workers AI binding (`env.AI`) | `apps/api/test/fake-ai/worker.mjs` |
| `fake-google` | Google's OAuth and Drive HTTP APIs | `apps/api/test/fake-google/worker.mjs` |

Production code cannot tell: it calls `env.AI.run(...)` and `fetch` as usual. **A double proves our code handles the responses we *believe* the real service returns; it cannot prove those beliefs.** That is the single biggest caveat of this test suite; see "Not verified" below. Neither double exists in production code, which has no canned or simulated model output (`AI_NOT_CONNECTED` when the binding is missing). A unit test fails if a `@cf/` model id appears anywhere except `apps/api/src/ai/models.ts`.

## API suites (234 tests on workerd)

| File | Tests | What it checks |
|---|---|---|
| `unit.test.ts` | 39 | Pure logic: model registry, response normalisation, SSE parser, error classification, text utilities, `@AMINAI` mention detection, **the AI access policy**, the prompt-injection rule being present |
| `ai-client.test.ts` | 25 | `AiClient` against the scripted AI double: the three response shapes, streaming, per-model tuning and retry without a rejected parameter, fallback order, cancellation, model availability and reason codes |
| `ai-chat.test.ts` | 21 | AMIN AI conversations: isolation between users, send / stream / regenerate / edit-and-resend, idempotent `clientId`, quota and concurrency limits, files, images and voice, search over past conversations, the agents and models endpoints |
| `agents.test.ts` | 24 | Task engine: routing, planning, step execution, retries, operation log; **approvals** (sensitive tools park the run, edit, reject, expiry, fingerprint mismatch); cancel; file and boundary cases; the prompt-injection rule in a real run |
| `assist.test.ts` | 13 | `@AMINAI` in direct chats (permission first), in secret chats (the user selects what to share), in groups (admins control the level and who may invoke) |
| `messenger.test.ts` | 14 | Direct chats, groups and roles, per-chat AI settings, secret chats, user search |
| `connectivity.test.ts` | 15 | Idempotent sends, realtime long-poll, advertised endpoints, client address behind a relay |
| `auth.test.ts` | 12 | Register, login, sessions, password change, rate limiting, admin role |
| `memory.test.ts` | 11 | Memory is manageable (view, edit, delete, disable, suggestions) and **never leaks across users** |
| `files.test.ts` | 6 | Upload validation and file access |
| `storage.test.ts` | 34 | The cold file tier: offload from R2 to Google Drive, reading, access control, deleting, Drive connection problems, admin API, cron |
| `drive-client.test.ts` | 11 | The Google Drive client against the fake Google |
| `request-id.test.ts` | 9 | `X-Request-Id` on every response and its CORS exposure |

Many of these are written as attacks, not just happy paths: a second user trying to read, send, select from, cancel or attach someone else's things; a forged approval payload; a denied `@AMINAI` mention that must post nothing; over-quota and over-rate calls.

## Web suites (229 tests in jsdom)

| File | Tests | What it checks |
|---|---|---|
| `endpointPool.test.ts` | 28 | Server address pool: failover only on evidence that it is the *server* that failed, probing, learned addresses, back-off |
| `serviceWorker.test.ts`, `serviceWorker.build.test.ts` | 20 + 7 | The offline shell's logic, and the generated service worker of the real build (precache list, no `/api` interception) |
| `streams.test.tsx`, `deltas.test.ts` | 17 + 6 | Streaming answers: ordering, de-duplication by `offset`, no loss across screen changes |
| `outbox.test.ts`, `apiTransport.test.ts`, `realtime.test.ts` | 17 + 14 + 16 | Offline-tolerant exactly-once sending, request transport and retries, WebSocket and long-poll |
| `aiThread.test.ts`, `runs.test.ts` | 15 + 9 | AI conversation state and the run / step / approval state |
| `MessageBubble`, `Composer`, `ApprovalCard`, `Connection`, `StorageSection`, `Markdown` | 9, 8, 7, 10, 8, 6 | Components, including that Markdown never renders raw HTML or loads an image from an address in an answer |
| `locales.test.ts` | 8 | Persian has exactly English's keys and placeholders, is really Persian, every error code the API can send has a text in both languages, `dir` and `lang` switch correctly |
| `e2ee.test.ts`, `session.test.tsx`, `text.test.tsx`, `useStickToBottom.test.tsx` | 7, 6, 6, 5 | WebCrypto round-trips, session handling, text helpers, scroll behaviour |

## Scripts and relay (67 tests)

`relay/relay.test.mjs` (44: HTTP, WebSocket and direct-HTTPS forwarding, header handling, limits, configuration errors), `scripts/deploy.test.mjs` (16: the migrate-before/after-deploy decision and dry-run), `scripts/drive-token.test.mjs` (7).

## Checked by hand in a real browser (not automated in the repository)

With headless Chrome driving a production-shaped Worker (real workerd serving the built web app) and, for the relay checks, the relay in front of it: the offline shell (11 of 11 checks), the relay with a real WebSocket, a blocked WebSocket falling back to long-poll, and an offline outbox (17 of 17), and layout on phone and desktop sizes in Persian and English (27 of 27), plus several UI flows in earlier rounds. In these runs the AI was a scripted stand-in, not a model. These runs found real bugs (a banner covering the chat header, an "alternative address" banner that never cleared) that the unit tests had missed, and those are fixed and covered by unit tests now. **The scripts are not in the repository** (they depended on a rig assembled by hand); the findings above are the record. Turning them into a committed end-to-end suite (for example Playwright in CI) is the most valuable next piece of test work.

## Not verified — read this before relying on it

1. **The real Workers AI call path.** Everything about the model side was tested against `fake-ai`. Unverified against Cloudflare: the exact streaming chunk shapes, whether a stream reports `usage`, `reasoning_effort`, what `env.AI.models()` returns, the speech-to-text input and output, the image model's output. The model ids and the parameters came from Cloudflare's documentation. `npm run verify:ai` (or the manual GitHub workflow **Verify Workers AI**) calls every model the app depends on with the app's own parser and reports PASS, WARN or FAIL; it has **never run** against the real service.
2. **A real deployment.** `npm run deploy`, the **Deploy to Cloudflare** workflow, wrangler's automatic provisioning of the D1 and R2 bindings and by-name database lookup have never run against a Cloudflare account. Unmeasured: whether the free plan's 10 ms CPU limit breaks password hashing (docs/deploy.md recommends the paid plan).
3. **Real Google Drive** and the `drive:token` helper: tested only against the self-written fake.
4. **A real Android device or WebView.** The APK is built on GitHub and its contents are checked (10 checks), but nobody has installed it. Microphone, keyboard, system bars and speed in the real WebView are unverified. No push notifications exist.
5. **A real filtered network.** Connectivity logic is tested with simulated failures and a relay in front of the Worker, not on a real Iranian network. The relay's TLS, nginx, Caddy, Docker and systemd example files have never been run.
6. **Untested code paths:** the 45-second tool timeout, `image_generate`, the Brave and Tavily web-search providers, and (in the web app) the screens in `src/screens`, the run panel, the thread drawer, the share dialog and the pickers, which are covered only by the manual browser runs above.
7. **`@AMINAI` streaming in direct and group chats** was not looked at in a browser.
8. **No performance, load or concurrency testing, no accessibility audit** beyond what the manual layout runs looked at, and **no independent security review** (docs/SECURITY.md).
9. The Deploy and Verify-Workers-AI workflows are linted but have never run.

## Adding tests

- API: put a `*.test.ts` in `apps/api/test`, use the helpers in `test/helpers.ts` (`registerUser`, `api`, `json`) and `test/ai-helpers.ts`. D1 state persists within a file, so use fresh users, and `freshIp()` for the register and login limits. To change what the AI double answers, see the scripting API at the top of `test/fake-ai/worker.mjs`. Unconfigured Drive: `withEnv({ GOOGLE_REFRESH_TOKEN: undefined })` from `test/google-helpers.ts` (every API test file is given Drive credentials and the fake Google by default).
- Web: `apps/web/test/*.test.ts(x)`; jsdom has no layout, `matchMedia` or `ResizeObserver`, so layout belongs in a browser run, not here. Reset fetch mocks per test.
- A test for a bug comes first: write it, watch it fail for the right reason, then fix (the Markdown image test did exactly that).
