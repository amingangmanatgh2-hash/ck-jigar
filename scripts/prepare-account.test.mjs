import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CF_API } from './preflight.mjs';
import { MAX_ATTEMPTS, SUBDOMAIN_PATTERN, main, subdomainCandidates } from './prepare-account.mjs';

const ACCOUNT = 'c7c787887fc9fab25af0db15ebbf46f5';
const TOKEN = 'cfut_UnitTestTokenAbCdEf0123456789xyz';
const URL_SUBDOMAIN = `${CF_API}/accounts/${ACCOUNT}/workers/subdomain`;
const CONFIG = '{ "name": "amin-chat", "vars": { "ADMIN_USERNAMES": "amin_ck" } }';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (result) => json({ success: true, errors: [], messages: [], result });
const err = (status, code, message) => json({ success: false, errors: [{ code, message }], messages: [], result: null }, status);
const noAddress = () => err(404, 10007, 'workers.api.error.no_subdomain');

/** A pretend Cloudflare. `get` answers the lookup; `put` answers each registration (a function of the name, or a list in order). */
function world({ get = noAddress, put = (name) => ok({ subdomain: name }) } = {}) {
  const seen = [];
  const puts = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    seen.push({ method, url: String(url), auth: init.headers?.Authorization, type: init.headers?.['Content-Type'], body: init.body, hasSignal: !!init.signal });
    if (String(url) !== URL_SUBDOMAIN) return json({ success: false, errors: [{ code: 7003, message: 'no route' }] }, 404);
    if (method === 'GET') return typeof get === 'function' ? get() : get;
    if (method === 'PUT') {
      const name = JSON.parse(init.body).subdomain;
      puts.push(name);
      return typeof put === 'function' ? put(name, puts.length) : put;
    }
    return json({}, 405);
  };
  return { fetch, seen, puts };
}

const env = (extra = {}) => ({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN, ...extra });
const quick = { sleep: async () => {}, readConfig: () => CONFIG, random: () => 'abc123' };
/** Runs main() and returns the exit code, the log and the requests. */
async function run(w, extra = {}) {
  const logs = [];
  const code = await main({ env: env(extra.env), fetch: w.fetch, log: (m) => logs.push(m), ...quick, summaryFile: undefined, ...extra.opts });
  return { code, out: logs.join('\n'), logs };
}

test('an account that already has an address is left alone: one lookup, no registration', async () => {
  const w = world({ get: () => ok({ subdomain: 'someone' }) });
  const r = await run(w);
  assert.equal(r.code, 0);
  assert.deepEqual(w.seen.map((s) => s.method), ['GET']);
  assert.match(r.out, /already has a workers\.dev address \(someone\.workers\.dev\): nothing to do/);
});

test('no address yet: the name from ADMIN_USERNAMES is registered, with exactly the request the API documents, and the run says which name it took', async () => {
  const w = world();
  const r = await run(w, { env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(r.code, 0);
  assert.deepEqual(w.seen.map((s) => s.method), ['GET', 'PUT']);
  const put = w.seen[1];
  assert.equal(put.url, URL_SUBDOMAIN);
  assert.equal(put.auth, `Bearer ${TOKEN}`);
  assert.equal(put.type, 'application/json');
  assert.deepEqual(JSON.parse(put.body), { subdomain: 'amin-ck' });
  for (const call of w.seen) assert.ok(call.hasSignal, 'every request has a deadline');
  assert.match(r.out, /registered the workers\.dev address "amin-ck" for this account \(free\)/);
  assert.match(r.out, /https:\/\/amin-chat\.amin-ck\.workers\.dev/);
  assert.match(r.out, /::notice title=workers\.dev address::registered the workers\.dev address "amin-ck"/);
  assert.match(r.out, /Renaming moves every Worker of the account to the new name/);
});

test('an empty answer (200 without an address) also counts as "none", but only when it says success', async () => {
  const w = world({ get: () => ok({}) });
  assert.equal((await run(w)).code, 0);
  assert.deepEqual(w.puts, ['amin-ck']);
  // 200 with a body that does not say success is not an answer: nothing is registered on it
  for (const odd of [() => json({ success: false, errors: [], result: {} }), () => json({ result: {} }), () => new Response('<html>ok</html>', { status: 200 })]) {
    const x = world({ get: odd });
    const r = await run(x);
    assert.equal(r.code, 0);
    assert.deepEqual(x.puts, [], 'never register on a guess');
    assert.match(r.out, /could not find out whether the account has a workers\.dev address/);
  }
});

test('a name somebody else owns is skipped: the next candidate is tried, in order', async () => {
  const w = world({ put: (name) => (name === 'amin-ck' ? err(400, 10031, 'subdomain is not available') : ok({ subdomain: name })) });
  const r = await run(w, { env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(r.code, 0);
  assert.deepEqual(w.puts, ['amin-ck', 'amin-ck-chat']);
  assert.match(r.out, /the name "amin-ck" was not accepted \(HTTP 400, code 10031: subdomain is not available\); trying the next one/);
  assert.match(r.out, /registered the workers\.dev address "amin-ck-chat"/);
});

test('when no name is accepted the run stops before anything is built, and says where to choose one', async () => {
  const w = world({ put: () => err(409, 10031, 'taken') });
  let n = 0;
  const r = await run(w, { env: { GITHUB_ACTIONS: 'true' }, opts: { random: () => `r${n++}x` } });
  assert.equal(r.code, 1);
  assert.equal(w.puts.length, MAX_ATTEMPTS);
  assert.equal(new Set(w.puts).size, w.puts.length, 'no name is tried twice');
  assert.match(r.out, /none of the names tried was accepted/);
  assert.match(r.out, /Nothing was built or published/);
  assert.match(r.out, /https:\/\/dash\.cloudflare\.com\/\?to=\/:account\/workers\/onboarding/);
  assert.match(r.out, /::error title=workers\.dev address::none of the names tried was accepted/);
  assert.ok(!r.out.includes(ACCOUNT), 'the account id is not printed');
});

test('a refused token stops at once (no other name would help) and names the missing row', async () => {
  for (const status of [401, 403]) {
    const w = world({ put: () => err(status, 10000, 'Authentication error') });
    const r = await run(w);
    assert.equal(r.code, 1);
    assert.deepEqual(w.puts, ['amin-ck'], 'one attempt');
    assert.match(r.out, /could not register a workers\.dev address \(HTTP \d+, code 10000: Authentication error\)/);
    assert.match(r.out, /Account → Workers Scripts → Edit/);
    assert.match(r.out, /Nothing was built or published/);
  }
});

test('an outage while registering stops the run (a retry already happened), and a hiccup that clears up is not a failure', async () => {
  const down = world({ put: () => err(503, 1, 'unavailable') });
  const r = await run(down);
  assert.equal(r.code, 1);
  assert.equal(down.puts.length, 2, 'one try and one retry, for the same name');
  assert.deepEqual([...new Set(down.puts)], ['amin-ck']);
  assert.match(r.out, /could not register a workers\.dev address \(HTTP 503, code 1: unavailable\)/);
  assert.ok(!/Account → Workers Scripts → Edit/.test(r.out), 'not a rights problem');
  const hiccup = world({ put: (name, n) => (n === 1 ? err(429, 1, 'slow down') : ok({ subdomain: name })) });
  const r2 = await run(hiccup);
  assert.equal(r2.code, 0);
  assert.deepEqual(hiccup.puts, ['amin-ck', 'amin-ck']);
  // a network failure is reported by name
  const dead = { fetch: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }, seen: [], puts: [] };
  const r3 = await run(dead);
  assert.equal(r3.code, 0, 'if even the lookup fails nothing is registered and nothing is failed here');
  assert.match(r3.out, /Cloudflare could not be reached \(ENOTFOUND: fetch failed\)/);
});

test('an answer that is neither "one" nor "none" changes nothing: an outage, a refusal, another 404', async () => {
  for (const [label, answer] of [
    ['an outage', () => err(500, 1, 'boom')],
    ['a refusal', () => err(403, 10000, 'Authentication error')],
    ['another 404', () => err(404, 7003, 'no route')],
    ['a rate limit', () => err(429, 1, 'slow down')],
  ]) {
    const w = world({ get: answer });
    const r = await run(w, { env: { GITHUB_ACTIONS: 'true' } });
    assert.equal(r.code, 0, label);
    assert.deepEqual(w.seen.filter((s) => s.method === 'PUT'), [], `${label}: nothing is registered`);
    assert.match(r.out, /could not find out whether the account has a workers\.dev address/, label);
    assert.match(r.out, /Nothing was changed; Wrangler asks again when it publishes/, label);
    assert.match(r.out, /::warning title=workers\.dev address::could not find out/, label);
  }
});

test('with routes only in the configuration no address is needed and Cloudflare is not even asked; without credentials it is not asked either', async () => {
  const w = world();
  const r = await run(w, { opts: { readConfig: () => '{ "routes": [ { "pattern": "chat.example.com", "custom_domain": true } ] }' } });
  assert.equal(r.code, 0);
  assert.deepEqual(w.seen, []);
  assert.match(r.out, /routes only, not to workers\.dev: no address is needed/);
  const none = world();
  const nothing = await run(none, { env: { CLOUDFLARE_API_TOKEN: '' } });
  assert.equal(nothing.code, 0);
  assert.deepEqual(none.seen, []);
  assert.match(nothing.out, /no usable account id or token/);
  const bad = world();
  assert.equal((await run(bad, { env: { CLOUDFLARE_ACCOUNT_ID: 'my-account' } })).code, 0);
  assert.deepEqual(bad.seen, [], 'a malformed account id is not sent anywhere (the preflight reports it)');
  // an unreadable configuration takes the stricter rule: the address is looked at
  const unreadable = world({ get: () => ok({ subdomain: 'x' }) });
  await run(unreadable, { opts: { readConfig: () => { throw new Error('no file'); } } });
  assert.equal(unreadable.seen.length, 1);
});

test('credentials pasted with spaces or a line break are trimmed; and no credential reaches the log or the summary, even when Cloudflare echoes it back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'account-'));
  const summaryFile = join(dir, 'summary.md');
  const w = world({ put: () => err(400, 1, `bad request from ${TOKEN}`) });
  const r = await run(w, { env: { CLOUDFLARE_API_TOKEN: `  ${TOKEN}\n`, CLOUDFLARE_ACCOUNT_ID: `${ACCOUNT}\n`, GITHUB_ACTIONS: 'true' }, opts: { summaryFile } });
  assert.equal(w.seen[0].auth, `Bearer ${TOKEN}`, 'trimmed');
  assert.ok(w.puts.length > 0);
  assert.ok(!r.out.includes(TOKEN) && !r.out.includes('UnitTestTokenAbCdEf'), 'no token in the log');
  assert.match(r.out, /bad request from \*\*\*/);
  // the success path writes a summary, also without a credential in it
  const okDir = mkdtempSync(join(tmpdir(), 'account-'));
  const okSummary = join(okDir, 'summary.md');
  const good = world();
  await run(good, { opts: { summaryFile: okSummary } });
  const text = readFileSync(okSummary, 'utf8');
  assert.match(text, /### Address registered/);
  assert.match(text, /\*\*amin-ck\.workers\.dev\*\*/);
  assert.ok(!text.includes(TOKEN));
  // even a service that put the token into its answer cannot get it into the summary
  const echoDir = mkdtempSync(join(tmpdir(), 'account-'));
  const echoSummary = join(echoDir, 'summary.md');
  const echo = world({ put: () => ok({ subdomain: `x-${TOKEN}` }) });
  const echoed = await run(echo, { opts: { summaryFile: echoSummary } });
  assert.ok(!readFileSync(echoSummary, 'utf8').includes(TOKEN), 'no token in the summary');
  assert.ok(!echoed.out.includes(TOKEN), 'no token in the log');
  assert.ok(!existsSync(join(dir, 'unused')));
});

test('annotation text escapes what GitHub treats specially', async () => {
  const w = world({ put: () => err(400, 1, '100% taken\nsecond line') });
  const r = await run(w, { env: { GITHUB_ACTIONS: 'true' } });
  const error = r.logs.find((l) => l.startsWith('::error title=workers.dev address::'));
  assert.ok(error);
  assert.ok(!error.includes('\n'));
  assert.match(error, /100%25 taken second line/);
  // outside GitHub there are no annotation commands at all
  const plain = await run(world({ put: () => err(400, 1, 'taken') }));
  assert.ok(!plain.out.includes('::'));
});

test('the names to try: the administrator name first, then "-chat", then random ones; always valid labels, never repeated, never more than MAX_ATTEMPTS', () => {
  let n = 0;
  const random = () => `r${n++}x`;
  const names = subdomainCandidates(CONFIG, random);
  assert.deepEqual(names, ['amin-ck', 'amin-ck-chat', 'amin-chat-r0x', 'amin-chat-r1x', 'amin-chat-r2x']);
  assert.equal(names.length, MAX_ATTEMPTS);
  for (const name of names) assert.match(name, SUBDOMAIN_PATTERN);
  // only the first administrator counts; odd spellings become valid labels
  assert.equal(subdomainCandidates('{ "vars": { "ADMIN_USERNAMES": "Amin__CK, other" } }', random)[0], 'amin-ck');
  // no usable administrator name (empty, missing, unreadable file): random names only
  for (const text of ['{ "vars": { "ADMIN_USERNAMES": "" } }', '{ "vars": {} }', '{}', 'not json', '']) {
    const list = subdomainCandidates(text, () => 'abc123');
    assert.ok(list.length >= 1 && list.every((x) => SUBDOMAIN_PATTERN.test(x) && x.startsWith('amin-chat-')), text);
  }
  // a generator that repeats itself must not make the same name be tried twice
  const same = subdomainCandidates(CONFIG, () => 'abc123');
  assert.deepEqual(same, ['amin-ck', 'amin-ck-chat', 'amin-chat-abc123']);
  assert.equal(new Set(same).size, same.length);
  // a very long name is cut to a valid label
  const long = subdomainCandidates(`{ "vars": { "ADMIN_USERNAMES": "${'a'.repeat(80)}" } }`, random);
  for (const name of long) assert.ok(name.length <= 63 && SUBDOMAIN_PATTERN.test(name), name);
  // the real configuration of this repository gives the name its administrator would expect
  const real = readFileSync(new URL('../apps/api/wrangler.jsonc', import.meta.url), 'utf8');
  assert.equal(subdomainCandidates(real, random)[0], 'amin-ck');
  // random characters from the default generator are valid, and different each time
  const a = subdomainCandidates('{}');
  const b = subdomainCandidates('{}');
  assert.ok(a.every((x) => SUBDOMAIN_PATTERN.test(x)));
  assert.notDeepEqual(a, b);
});

test('the step exists in package.json, uses no model id, and never reads secrets directly', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['prepare:account'], 'node scripts/prepare-account.mjs');
  const source = readFileSync(new URL('./prepare-account.mjs', import.meta.url), 'utf8');
  assert.ok(!/gpt-oss|@cf\/|llama|gemma|qwen/i.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), 'no model id outside apps/api/src/ai/models.ts');
  assert.ok(!/secrets\./.test(source), 'secrets reach it through the environment only');
});
