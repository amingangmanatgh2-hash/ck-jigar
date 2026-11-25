import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CF_API, GROQ_MODELS_URL, main, renderSummary, runChecks } from './preflight.mjs';

const ACCOUNT = 'c7c787887fc9fab25af0db15ebbf46f5';
const TOKEN = 'cfut_UnitTestTokenAbCdEf0123456789xyz';
const GROQ = 'gsk_UnitTestGroqKey0123456789abcdefghijk';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const cfOk = (result) => json({ success: true, errors: [], messages: [], result });
const cfErr = (status, code, message) => json({ success: false, errors: [{ code, message }], messages: [], result: null }, status);

/** A pretend Cloudflare + Groq. `over` replaces the answer for a path (a function of the Authorization header, or a Response). */
function world(over = {}) {
  const seen = [];
  const answers = {
    '/user/tokens/verify': () => cfOk({ id: 'tok', status: 'active' }),
    [`/accounts/${ACCOUNT}/workers/scripts`]: () => cfOk([]),
    [`/accounts/${ACCOUNT}/d1/database?per_page=100`]: () => cfOk([]),
    [`/accounts/${ACCOUNT}/r2/buckets`]: () => cfOk({ buckets: [] }),
    [`/accounts/${ACCOUNT}/workers/subdomain`]: () => cfOk({ subdomain: 'someone' }),
    groq: () => json({ object: 'list', data: [{ id: 'openai/gpt-oss-20b' }, { id: 'openai/gpt-oss-120b' }] }),
    ...over,
  };
  const fetch = async (url, init = {}) => {
    seen.push({ url: String(url), auth: init.headers?.Authorization, hasSignal: !!init.signal });
    const key = String(url).startsWith(CF_API) ? String(url).slice(CF_API.length) : String(url) === GROQ_MODELS_URL ? 'groq' : null;
    const answer = key && answers[key];
    if (!answer) return json({ success: false, errors: [{ code: 7003, message: 'no route' }] }, 404);
    return typeof answer === 'function' ? answer(init.headers?.Authorization) : answer;
  };
  return { fetch, seen };
}

const env = (extra = {}) => ({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN, ...extra });
const quick = { sleep: async () => {} };
const level = (results, id) => results.find((r) => r.id === id)?.level;
const detail = (results, id) => results.find((r) => r.id === id)?.detail ?? '';

test('everything in place: every check passes, Groq is skipped without a key, and the right credential goes to the right host', async () => {
  const w = world();
  const results = await runChecks({ env: env(), fetch: w.fetch, ...quick });
  assert.deepEqual(results.map((r) => [r.id, r.level]), [
    ['credentials', 'ok'], ['token', 'ok'], ['workers', 'ok'], ['d1', 'ok'], ['r2', 'ok'], ['subdomain', 'ok'], ['groq', 'skip'],
  ]);
  assert.match(detail(results, 'groq'), /runs on Workers AI alone/);
  assert.match(detail(results, 'd1'), /first deployment creates it/);
  for (const call of w.seen) {
    assert.ok(call.url.startsWith(CF_API), `only Cloudflare is asked without a Groq key: ${call.url}`);
    assert.equal(call.auth, `Bearer ${TOKEN}`);
    assert.ok(call.hasSignal, 'every request has a deadline');
  }
});

test('a Groq key is verified against Groq only, and the Cloudflare token is never sent there (nor the Groq key to Cloudflare)', async () => {
  const w = world();
  const results = await runChecks({ env: env({ GROQ_API_KEY: ` ${GROQ}\n` }), fetch: w.fetch, ...quick });
  assert.equal(level(results, 'groq'), 'ok');
  assert.match(detail(results, 'groq'), /the key works \(2 models/);
  const groqCalls = w.seen.filter((c) => c.url === GROQ_MODELS_URL);
  assert.equal(groqCalls.length, 1);
  assert.equal(groqCalls[0].auth, `Bearer ${GROQ}`, 'trimmed');
  for (const c of w.seen.filter((x) => x.url !== GROQ_MODELS_URL)) assert.equal(c.auth, `Bearer ${TOKEN}`);
});

test('missing credentials: both names are listed (never values), and nothing is sent to Cloudflare', async () => {
  const w = world();
  for (const e of [{}, { CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '' }]) {
    const results = await runChecks({ env: e, fetch: w.fetch, ...quick });
    assert.equal(level(results, 'credentials'), 'fail');
    assert.match(detail(results, 'credentials'), /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are missing/);
    assert.match(detail(results, 'credentials'), /Settings → Secrets and variables → Actions/);
    for (const id of ['token', 'workers', 'd1', 'r2']) assert.equal(level(results, id), 'skip');
  }
  assert.equal(w.seen.length, 0);
  const one = await runChecks({ env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, fetch: w.fetch, ...quick });
  assert.match(detail(one, 'credentials'), /^CLOUDFLARE_API_TOKEN is missing/);
});

test('malformed credentials are named without being repeated: a short or non-hex account id, a token with spaces', async () => {
  const w = world();
  const badId = await runChecks({ env: env({ CLOUDFLARE_ACCOUNT_ID: 'my-account' }), fetch: w.fetch, ...quick });
  assert.equal(level(badId, 'credentials'), 'fail');
  assert.match(detail(badId, 'credentials'), /32 letters and digits/);
  assert.ok(!detail(badId, 'credentials').includes('my-account'));
  const badToken = await runChecks({ env: env({ CLOUDFLARE_API_TOKEN: 'cfut_abc def' }), fetch: w.fetch, ...quick });
  assert.equal(level(badToken, 'credentials'), 'fail');
  assert.ok(!detail(badToken, 'credentials').includes('abc def'));
  assert.equal(w.seen.length, 0);
  // a trailing line break is the usual paste accident: trimmed, not an error
  const trimmed = await runChecks({ env: env({ CLOUDFLARE_API_TOKEN: `${TOKEN}\n`, CLOUDFLARE_ACCOUNT_ID: ` ${ACCOUNT} ` }), fetch: world().fetch, ...quick });
  assert.equal(level(trimmed, 'credentials'), 'ok');
});

test('a token Cloudflare rejects: the reason is quoted, the steps to a new token are given, and the rest is not even tried', async () => {
  const w = world({ '/user/tokens/verify': () => cfErr(401, 1000, 'Invalid API Token'), [`/accounts/${ACCOUNT}/tokens/verify`]: () => cfErr(401, 1000, 'Invalid API Token') });
  const results = await runChecks({ env: env(), fetch: w.fetch, ...quick });
  assert.equal(level(results, 'token'), 'fail');
  assert.match(detail(results, 'token'), /HTTP 401, code 1000: Invalid API Token/);
  assert.match(detail(results, 'token'), /Edit Cloudflare Workers/);
  assert.match(detail(results, 'token'), /D1 → Edit/);
  for (const id of ['workers', 'd1', 'r2', 'subdomain']) assert.equal(results.find((r) => r.id === id), undefined, `${id} is not checked with a dead token`);
});

test('an account-owned token (verified on the account, not the user) is accepted', async () => {
  const w = world({ '/user/tokens/verify': () => cfErr(401, 1000, 'Invalid API Token'), [`/accounts/${ACCOUNT}/tokens/verify`]: () => cfOk({ id: 'x', status: 'active' }) });
  const results = await runChecks({ env: env(), fetch: w.fetch, ...quick });
  assert.equal(level(results, 'token'), 'ok');
});

test('an expired or disabled token fails; one that ends within a week warns', async () => {
  const expired = await runChecks({ env: env(), fetch: world({ '/user/tokens/verify': () => cfOk({ status: 'expired' }) }).fetch, ...quick });
  assert.equal(level(expired, 'token'), 'fail');
  assert.match(detail(expired, 'token'), /the token is expired/);
  const now = () => Date.parse('2026-11-25T00:00:00Z');
  const soon = await runChecks({ env: env(), fetch: world({ '/user/tokens/verify': () => cfOk({ status: 'active', expires_on: '2026-11-28T00:00:00Z' }) }).fetch, now, ...quick });
  assert.equal(level(soon, 'token'), 'warn');
  assert.match(detail(soon, 'token'), /expires in 3 day/);
  const later = await runChecks({ env: env(), fetch: world({ '/user/tokens/verify': () => cfOk({ status: 'active', expires_on: '2027-11-28T00:00:00Z' }) }).fetch, now, ...quick });
  assert.equal(level(later, 'token'), 'ok');
});

test('the commonest first-time problem: a token without D1 → says exactly which row to add, while the other checks still report', async () => {
  const w = world({ [`/accounts/${ACCOUNT}/d1/database?per_page=100`]: () => cfErr(403, 10000, 'Authentication error') });
  const results = await runChecks({ env: env(), fetch: w.fetch, ...quick });
  assert.equal(level(results, 'd1'), 'fail');
  assert.match(detail(results, 'd1'), /HTTP 403, code 10000: Authentication error/);
  assert.match(detail(results, 'd1'), /Account → D1 → Edit/);
  assert.equal(level(results, 'workers'), 'ok');
  assert.equal(level(results, 'r2'), 'ok');
});

test('R2 not switched on is told apart from a missing right', async () => {
  const off = await runChecks({ env: env(), fetch: world({ [`/accounts/${ACCOUNT}/r2/buckets`]: () => cfErr(403, 10042, 'Please enable R2 through the Cloudflare Dashboard.') }).fetch, ...quick });
  assert.equal(level(off, 'r2'), 'fail');
  assert.match(detail(off, 'r2'), /not switched on/);
  assert.match(detail(off, 'r2'), /R2 → Overview → subscribe/);
  // each signal alone is enough (Cloudflare could reword the message, or drop the code)
  const codeOnly = await runChecks({ env: env(), fetch: world({ [`/accounts/${ACCOUNT}/r2/buckets`]: () => cfErr(403, 10042, 'Forbidden') }).fetch, ...quick });
  assert.match(detail(codeOnly, 'r2'), /not switched on/);
  const messageOnly = await runChecks({ env: env(), fetch: world({ [`/accounts/${ACCOUNT}/r2/buckets`]: () => cfErr(403, 1, 'Please enable R2 through the Cloudflare Dashboard.') }).fetch, ...quick });
  assert.match(detail(messageOnly, 'r2'), /not switched on/);
  const noRight = await runChecks({ env: env(), fetch: world({ [`/accounts/${ACCOUNT}/r2/buckets`]: () => cfErr(403, 10000, 'Authentication error') }).fetch, ...quick });
  assert.equal(level(noRight, 'r2'), 'fail');
  assert.match(detail(noRight, 'r2'), /Workers R2 Storage → Edit/);
});

test('a wrong account id looks like a Workers refusal and says both possible causes', async () => {
  const results = await runChecks({ env: env(), fetch: world({ [`/accounts/${ACCOUNT}/workers/scripts`]: () => cfErr(403, 10000, 'Authentication error') }).fetch, ...quick });
  assert.equal(level(results, 'workers'), 'fail');
  assert.match(detail(results, 'workers'), /different account than the token/);
  assert.match(detail(results, 'workers'), /Workers Scripts: Edit/);
});

test('existing resources are recognised: an update, not a first deployment', async () => {
  const w = world({
    [`/accounts/${ACCOUNT}/d1/database?per_page=100`]: () => cfOk([{ name: 'other' }, { name: 'amin-chat-db' }]),
    [`/accounts/${ACCOUNT}/r2/buckets`]: () => cfOk({ buckets: [{ name: 'amin-chat-files' }] }),
  });
  const results = await runChecks({ env: env(), fetch: w.fetch, ...quick });
  assert.match(detail(results, 'd1'), /this is an update/);
  assert.match(detail(results, 'r2'), /"amin-chat-files" exists/);
});

test('no workers.dev address is only a warning (and says what to do)', async () => {
  const none = await runChecks({ env: env(), fetch: world({ [`/accounts/${ACCOUNT}/workers/subdomain`]: () => cfErr(404, 10007, 'workers.api.error.no_subdomain') }).fetch, ...quick });
  assert.equal(level(none, 'subdomain'), 'warn');
  assert.match(detail(none, 'subdomain'), /Open "Workers & Pages"/);
  const empty = await runChecks({ env: env(), fetch: world({ [`/accounts/${ACCOUNT}/workers/subdomain`]: () => cfOk({}) }).fetch, ...quick });
  assert.equal(level(empty, 'subdomain'), 'warn');
});

test('Groq problems never block: a rejected key, a rate limit, an outage and a malformed key all only warn', async () => {
  const cases = [
    [json({ error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401), GROQ, /Groq rejected the key \(HTTP 401, invalid_api_key\)/],
    [json({ error: { message: 'slow down' } }, 429), GROQ, /rate-limiting it right now/],
    [json({ error: { message: 'boom' } }, 503), GROQ, /Groq answered unexpectedly \(HTTP 503: boom\)/],
    [json({ nope: true }, 200), GROQ, /answered unexpectedly \(HTTP 200\)/],
    [null, 'gsk_has a space', /will not be used because it contains spaces/],
  ];
  for (const [answer, key, words] of cases) {
    const w = world(answer ? { groq: () => answer.clone() } : {}); // a fresh body on every request, as on the real network
    const results = await runChecks({ env: env({ GROQ_API_KEY: key }), fetch: w.fetch, ...quick });
    assert.equal(level(results, 'groq'), 'warn', String(words));
    assert.match(detail(results, 'groq'), words);
    assert.ok(!results.some((r) => r.level === 'fail'), 'a Groq problem is never a reason to stop the deployment');
    if (!answer) assert.equal(w.seen.filter((c) => c.url === GROQ_MODELS_URL).length, 0, 'a malformed key is not sent anywhere');
  }
});

test('a network failure is retried once, then reported by name — and a 5xx that clears up is not a failure', async () => {
  let attempts = 0;
  const flaky = world({
    '/user/tokens/verify': () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return cfOk({ status: 'active' });
    },
  });
  const recovered = await runChecks({ env: env(), fetch: flaky.fetch, ...quick });
  assert.equal(level(recovered, 'token'), 'ok');
  assert.equal(attempts, 2);

  const down = world({
    '/user/tokens/verify': () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    },
  });
  const results = await runChecks({ env: env(), fetch: down.fetch, ...quick });
  assert.equal(level(results, 'token'), 'fail');
  assert.match(detail(results, 'token'), /Cloudflare could not be reached \(ENOTFOUND: fetch failed\)/);

  let n = 0;
  const hiccup = world({ '/user/tokens/verify': () => (++n === 1 ? json({}, 502) : cfOk({ status: 'active' })) });
  assert.equal(level(await runChecks({ env: env(), fetch: hiccup.fetch, ...quick }), 'token'), 'ok');

  const timeout = world({
    '/user/tokens/verify': () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    },
  });
  assert.match(detail(await runChecks({ env: env(), fetch: timeout.fetch, ...quick }), 'token'), /no answer within 20 seconds/);
});

test('main: exit code, plain log, GitHub annotations, and a step summary file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
  const summaryFile = join(dir, 'summary.md');
  const logs = [];
  const bad = world({ [`/accounts/${ACCOUNT}/d1/database?per_page=100`]: () => cfErr(403, 10000, 'Authentication error') });
  const code = await main({ env: env({ GITHUB_ACTIONS: 'true' }), fetch: bad.fetch, log: (m) => logs.push(m), summaryFile, ...quick });
  assert.equal(code, 1);
  const out = logs.join('\n');
  assert.match(out, /\[preflight\] ✗ D1 database — the token has no D1 right/);
  assert.match(out, /::error title=Preflight: D1 database::the token has no D1 right/);
  assert.match(out, /1 problem\(s\) above must be fixed first\. Nothing was built or published\./);
  const summary = readFileSync(summaryFile, 'utf8');
  assert.match(summary, /\| ✗ \| D1 database \|/);
  assert.match(summary, /1 problem\(s\) must be fixed first/);

  const goodLogs = [];
  const goodCode = await main({ env: env(), fetch: world().fetch, log: (m) => goodLogs.push(m), summaryFile: undefined, ...quick });
  assert.equal(goodCode, 0);
  assert.match(goodLogs.join('\n'), /Everything the deployment needs is in place\./);
  assert.ok(!goodLogs.join('\n').includes('::'), 'no annotations outside GitHub');
});

test('main: warnings annotate but do not fail', async () => {
  const logs = [];
  const w = world({ groq: () => json({ error: { code: 'invalid_api_key' } }, 401) });
  const code = await main({ env: env({ GITHUB_ACTIONS: 'true', GROQ_API_KEY: GROQ }), fetch: w.fetch, log: (m) => logs.push(m), summaryFile: undefined, ...quick });
  assert.equal(code, 0);
  assert.match(logs.join('\n'), /::warning title=Preflight: Groq::Groq rejected the key/);
});

test('no credential ever reaches the log, an annotation or the summary — even when a service echoes it back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
  const summaryFile = join(dir, 'summary.md');
  const logs = [];
  const echo = world({
    '/user/tokens/verify': (auth) => cfErr(401, 1000, `Invalid token ${String(auth).replace('Bearer ', '')} was refused`),
    groq: () => json({ error: { message: `bad key ${GROQ}` } }, 400),
  });
  const code = await main({ env: env({ GITHUB_ACTIONS: 'true', GROQ_API_KEY: GROQ }), fetch: echo.fetch, log: (m) => logs.push(m), summaryFile, ...quick });
  assert.equal(code, 1);
  const everything = `${logs.join('\n')}\n${readFileSync(summaryFile, 'utf8')}`;
  for (const secret of [TOKEN, GROQ, 'UnitTestTokenAbCdEf', 'UnitTestGroqKey']) assert.ok(!everything.includes(secret), `leaked: ${secret.slice(0, 12)}…`);
  assert.match(everything, /Invalid token \*\*\* was refused/);
  assert.match(everything, /::error title=Preflight: Cloudflare token::/);
});

test('annotation text escapes what GitHub treats specially (percent signs and line breaks)', async () => {
  const logs = [];
  const w = world({ '/user/tokens/verify': () => cfErr(400, 1, '100% wrong\nsecond line') });
  await main({ env: env({ GITHUB_ACTIONS: 'true' }), fetch: w.fetch, log: (m) => logs.push(m), summaryFile: undefined, ...quick });
  const annotation = logs.find((l) => l.startsWith('::error title=Preflight: Cloudflare token::'));
  assert.ok(annotation);
  assert.ok(!annotation.includes('\n'));
  assert.match(annotation, /100%25 wrong second line/);
});

test('renderSummary: a table, with pipes in details escaped, and a verdict', () => {
  const md = renderSummary([
    { id: 'a', title: 'A', level: 'ok', detail: 'fine' },
    { id: 'b', title: 'B', level: 'fail', detail: 'x | y' },
  ]);
  assert.match(md, /\| ✓ \| A \| fine \|/);
  assert.match(md, /\| ✗ \| B \| x \\\| y \|/);
  assert.match(md, /1 problem\(s\) must be fixed first/);
  assert.match(renderSummary([{ id: 'a', title: 'A', level: 'ok', detail: 'fine' }]), /Everything the deployment needs is in place/);
});

test('the preflight knows no model id (they live in one file) and the workflow runs it before the tests and the deployment', () => {
  const source = readFileSync(new URL('./preflight.mjs', import.meta.url), 'utf8');
  assert.ok(!/gpt-oss|@cf\/|llama|gemma|qwen/i.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), 'no model id outside apps/api/src/ai/models.ts');
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const at = (needle) => workflow.indexOf(needle);
  assert.ok(at('npm run preflight') > 0, 'the workflow runs the preflight');
  assert.ok(at('npm run preflight') < at('npm test'), 'before the tests');
  assert.ok(at('npm run preflight') < at('npm run deploy 2>&1'), 'and before anything is published');
});
