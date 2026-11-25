#!/usr/bin/env node
/**
 * Before anything is published (`npm run preflight`, also the first real step of the "Deploy to Cloudflare" workflow): asks Cloudflare
 * and Groq — with the very credentials the deployment will use — whether everything the deployment needs is in place.
 *
 * It reports EVERY problem in one run (not the first one only): each round trip through GitHub costs minutes, and "add this one right to
 * the token, then this one, then subscribe to R2" is a miserable way to find out three things that were all knowable at once.
 *
 *   blocking (the deployment would fail anyway, so it stops here with the fix in plain words):
 *     credentials  the account id and the token are present and look like what they should be
 *     token        Cloudflare accepts the token and it is active
 *     workers      the token can manage Workers on THIS account (so it is also the right account id)
 *     d1           the token has the D1 right (the "Edit Cloudflare Workers" template does not include it)
 *     r2           R2 is switched on for the account and the token has the R2 right
 *   not blocking (the service runs without it):
 *     subdomain    the account has a workers.dev address (else the first deploy asks for one)
 *     groq         the optional Groq key works
 *
 * It prints only what happened (names of checks, HTTP statuses, the messages Cloudflare or Groq sent) — never a credential. Everything it
 * prints goes through `redact`, and the values are never put into a message in the first place.
 *
 * Plain JavaScript on purpose: it runs before `npm ci` and must not import TypeScript. In particular it does not know any model id
 * (those live in one file, apps/api/src/ai/models.ts); whether a model really answers is what the signed-in availability check
 * ("Models & usage") finds out, with a real request per model.
 */
import { appendFileSync } from 'node:fs';
import { inspectGroqKey, redact } from './deploy.mjs';

export const CF_API = 'https://api.cloudflare.com/client/v4';
export const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
const D1_NAME = 'amin-chat-db';

const short = (text, n = 220) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The error Cloudflare reports: "[code] message", or the HTTP status when the body says nothing. */
function cfProblem(status, body) {
  const e = Array.isArray(body?.errors) ? body.errors[0] : null;
  if (e && (e.message || e.code)) return `HTTP ${status}${e.code ? `, code ${e.code}` : ''}: ${short(e.message)}`;
  return `HTTP ${status}`;
}

/** One request with a deadline; a network failure or a 5xx is retried once. Resolves to { status, body } or { error }. */
async function call(fetchFn, sleep, url, token, label) {
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (res.status >= 500 && attempt === 0) {
        last = `HTTP ${res.status}`;
        await sleep(1500);
        continue;
      }
      return { status: res.status, body };
    } catch (err) {
      last = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'no answer within 20 seconds' : [err?.cause?.code, err?.message].filter(Boolean).join(': ') || String(err);
      if (attempt === 0) await sleep(1500);
    }
  }
  return { error: `${label} could not be reached (${short(last, 120)})` };
}

const ok = (id, title, detail) => ({ id, title, level: 'ok', detail });
const fail = (id, title, detail) => ({ id, title, level: 'fail', detail });
const warn = (id, title, detail) => ({ id, title, level: 'warn', detail });
const skip = (id, title, detail) => ({ id, title, level: 'skip', detail });

export async function runChecks({ env, fetch: fetchFn = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  const results = [];
  const token = typeof env.CLOUDFLARE_API_TOKEN === 'string' ? env.CLOUDFLARE_API_TOKEN.trim() : '';
  const account = typeof env.CLOUDFLARE_ACCOUNT_ID === 'string' ? env.CLOUDFLARE_ACCOUNT_ID.trim() : '';

  /* ---- credentials: presence and shape, before anything is sent anywhere */
  const missing = [!account && 'CLOUDFLARE_ACCOUNT_ID', !token && 'CLOUDFLARE_API_TOKEN'].filter(Boolean);
  let usable = false;
  if (missing.length > 0) {
    // Where to add them: a direct link when the repository is known (it is, inside GitHub Actions). In Actions the workflow also accepts
    // the two common shorter spellings, so the hint names them.
    const link = env.GITHUB_REPOSITORY ? `https://github.com/${env.GITHUB_REPOSITORY}/settings/secrets/actions` : 'GitHub → Settings → Secrets and variables → Actions';
    const inActions = env.GITHUB_ACTIONS === 'true';
    const spelling = inActions ? ' (CF_ACCOUNT_ID and CF_API_TOKEN are accepted as well)' : '';
    // The easiest way, offered only where it exists (the workflow reads the block; this script run by hand does not).
    const easiest = inActions ? ` Easiest: ONE secret named DEPLOY_ENV whose value is the lines CF_ACCOUNT_ID=…, CF_API_TOKEN=… and (optional) GROQ_API_KEY=…, one per line (${link}/new).` : '';
    const plural = missing.length > 1;
    results.push(
      fail(
        'credentials',
        'Cloudflare credentials',
        `${missing.join(' and ')} ${plural ? 'are' : 'is'} missing, so nothing could be checked. Add ${plural ? 'them' : 'it'} as a REPOSITORY secret: ${link} → button "New repository secret"; the name must match exactly${spelling}. A Variable, a Codespaces secret or a Dependabot secret does not work.${easiest} (فارسی: ${plural ? 'این Secretها به workflow نرسیده‌اند' : 'این Secret به workflow نرسیده است'}؛ باید در همین مخزن و در بخش Actions ← Repository secrets ساخته شود، نه Variable.${inActions ? ' ساده‌ترین راه: فقط یک Secret به نام DEPLOY_ENV با همان خط‌هایی که در چت می‌نویسید.' : ''})`,
      ),
    );
  } else if (!/^[0-9a-f]{32}$/i.test(account)) {
    results.push(fail('credentials', 'Cloudflare credentials', 'CLOUDFLARE_ACCOUNT_ID must be 32 letters and digits (Cloudflare dashboard → Workers & Pages → Account details → copy). It is not the account name or the e-mail address.'));
  } else if (/\s/.test(token) || /[^\x21-\x7e]/.test(token)) {
    results.push(fail('credentials', 'Cloudflare credentials', 'CLOUDFLARE_API_TOKEN contains spaces, line breaks or other characters no token has. Create the secret again and paste the token only.'));
  } else {
    usable = true;
    results.push(ok('credentials', 'Cloudflare credentials', 'both are present and look right'));
  }

  if (usable) {
    const api = (path) => call(fetchFn, sleep, `${CF_API}${path}`, token, 'Cloudflare');
    const A = `/accounts/${account}`;

    /* ---- token */
    let t = await api('/user/tokens/verify');
    if (!t.error && !(t.status === 200 && t.body?.success)) {
      // an account-owned token (cfat_…) is verified on the account instead of the user
      const t2 = await api(`${A}/tokens/verify`);
      if (!t2.error && t2.status === 200 && t2.body?.success) t = t2;
    }
    if (t.error) results.push(fail('token', 'Cloudflare token', t.error));
    else if (!(t.status === 200 && t.body?.success)) results.push(fail('token', 'Cloudflare token', `Cloudflare does not accept this token (${cfProblem(t.status, t.body)}). Create a new one: My Profile → API Tokens → Create Token → template "Edit Cloudflare Workers", plus Account → D1 → Edit.`));
    else if (t.body?.result?.status && t.body.result.status !== 'active') results.push(fail('token', 'Cloudflare token', `the token is ${t.body.result.status}. Create a new one and replace the secret.`));
    else {
      const exp = t.body?.result?.expires_on ? Date.parse(t.body.result.expires_on) : NaN;
      const days = Number.isFinite(exp) ? Math.floor((exp - now()) / 86_400_000) : null;
      results.push(days !== null && days < 7 ? warn('token', 'Cloudflare token', `active, but it expires in ${Math.max(days, 0)} day(s) (${String(t.body.result.expires_on).slice(0, 10)})`) : ok('token', 'Cloudflare token', 'accepted and active'));
    }

    if (results.find((r) => r.id === 'token')?.level !== 'fail') {
      /* ---- the four things the token must be able to do on this account — asked at the same time */
      const [w, d, r, s] = await Promise.all([api(`${A}/workers/scripts`), api(`${A}/d1/database?per_page=100`), api(`${A}/r2/buckets`), api(`${A}/workers/subdomain`)]);

      if (w.error) results.push(fail('workers', 'Workers', w.error));
      else if (w.status === 200 && w.body?.success !== false) results.push(ok('workers', 'Workers', 'the token can manage Workers on this account'));
      else results.push(fail('workers', 'Workers', `the token cannot manage Workers on this account (${cfProblem(w.status, w.body)}). Either CLOUDFLARE_ACCOUNT_ID belongs to a different account than the token, or the token lacks "Workers Scripts: Edit" (template "Edit Cloudflare Workers").`));

      if (d.error) results.push(fail('d1', 'D1 database', d.error));
      else if (d.status === 200 && d.body?.success !== false) {
        const names = Array.isArray(d.body?.result) ? d.body.result.map((x) => x?.name) : [];
        results.push(ok('d1', 'D1 database', names.includes(D1_NAME) ? `"${D1_NAME}" exists: this is an update, migrations run first` : `the token may use D1; "${D1_NAME}" does not exist yet: the first deployment creates it`));
      } else results.push(fail('d1', 'D1 database', `the token has no D1 right (${cfProblem(d.status, d.body)}). Edit the token and add one row: Account → D1 → Edit. (The template "Edit Cloudflare Workers" does not include D1.)`));

      if (r.error) results.push(fail('r2', 'R2 file storage', r.error));
      else if (r.status === 200 && r.body?.success !== false) {
        const buckets = Array.isArray(r.body?.result?.buckets) ? r.body.result.buckets.map((x) => x?.name) : [];
        results.push(ok('r2', 'R2 file storage', buckets.includes('amin-chat-files') ? 'on; the bucket "amin-chat-files" exists' : 'on; the first deployment creates the bucket "amin-chat-files"'));
      } else if (r.body?.errors?.some?.((e) => e?.code === 10042 || /enable R2|R2.*(not|never).*(enabled|activated|subscri)/i.test(String(e?.message)))) {
        results.push(fail('r2', 'R2 file storage', `R2 is not switched on for this account (${cfProblem(r.status, r.body)}). Cloudflare dashboard → Storage & databases → R2 → Overview → subscribe (the monthly free allowance is enough).`));
      } else results.push(fail('r2', 'R2 file storage', `R2 cannot be used with this token (${cfProblem(r.status, r.body)}). If R2 was never switched on: dashboard → Storage & databases → R2 → Overview → subscribe. Otherwise add Account → Workers R2 Storage → Edit to the token.`));

      if (s.error) results.push(warn('subdomain', 'workers.dev address', s.error));
      else if (s.status === 200 && s.body?.result?.subdomain) results.push(ok('subdomain', 'workers.dev address', 'the account has one'));
      else results.push(warn('subdomain', 'workers.dev address', `${s.status === 200 ? 'the account has none yet' : `could not be read (${cfProblem(s.status, s.body)})`}. Open "Workers & Pages" in the Cloudflare dashboard once: it asks you to choose one. Without it the first deployment stops.`));
    }
  } else {
    for (const [id, title] of [['token', 'Cloudflare token'], ['workers', 'Workers'], ['d1', 'D1 database'], ['r2', 'R2 file storage']]) results.push(skip(id, title, 'not checked (fix the credentials first)'));
  }

  /* ---- Groq (optional) */
  const groq = inspectGroqKey(env);
  if (groq.state === 'none') results.push(skip('groq', 'Groq', 'GROQ_API_KEY is not set: the service runs on Workers AI alone. To add Groq (fast answers, more fallback), create the repository secret GROQ_API_KEY.'));
  else if (groq.state === 'broken') results.push(warn('groq', 'Groq', `GROQ_API_KEY will not be used because ${groq.problem}. Create the secret again with the key only (it starts with gsk_).`));
  else {
    const g = await call(fetchFn, sleep, GROQ_MODELS_URL, groq.key, 'Groq');
    if (g.error) results.push(warn('groq', 'Groq', `${g.error}; the key was not verified`));
    else if (g.status === 200 && Array.isArray(g.body?.data)) results.push(ok('groq', 'Groq', `the key works (${g.body.data.length} models are open to it)`));
    else if (g.status === 401 || g.status === 403) results.push(warn('groq', 'Groq', `Groq rejected the key (HTTP ${g.status}${g.body?.error?.code ? `, ${g.body.error.code}` : ''}). It is stored anyway only if you keep the secret; create a new key at console.groq.com and replace the secret.`));
    else if (g.status === 429) results.push(warn('groq', 'Groq', 'the key is valid but Groq is rate-limiting it right now (HTTP 429)'));
    else results.push(warn('groq', 'Groq', `Groq answered unexpectedly (HTTP ${g.status}${g.body?.error?.message ? `: ${short(g.body.error.message, 120)}` : ''}); the key was not verified`));
  }
  return results;
}

const MARK = { ok: '✓', fail: '✗', warn: '!', skip: '–' };

export function renderSummary(results) {
  const lines = ['## Preflight', '', '| | Check | Result |', '|---|---|---|'];
  for (const r of results) lines.push(`| ${MARK[r.level]} | ${r.title} | ${r.detail.replace(/\|/g, '\\|')} |`);
  const failed = results.filter((r) => r.level === 'fail');
  lines.push('', failed.length > 0 ? `**${failed.length} problem(s) must be fixed first. Nothing was built or published.**` : '**Everything the deployment needs is in place.**');
  return lines.join('\n');
}

export async function main({ env = process.env, fetch: fetchFn = globalThis.fetch, log = console.log, sleep, now, summaryFile = env.GITHUB_STEP_SUMMARY } = {}) {
  const secrets = [env.CLOUDFLARE_API_TOKEN, env.GROQ_API_KEY].map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length >= 8);
  const clean = (text) => secrets.reduce((t, s) => redact(t, s), String(text));
  const results = await runChecks({ env, fetch: fetchFn, sleep, now });
  for (const r of results) {
    log(clean(`[preflight] ${MARK[r.level]} ${r.title} — ${r.detail}`));
    if (env.GITHUB_ACTIONS === 'true' && (r.level === 'fail' || r.level === 'warn')) {
      // one annotation per problem, one line, with the characters GitHub treats specially escaped
      const text = clean(r.detail).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
      log(`::${r.level === 'fail' ? 'error' : 'warning'} title=Preflight: ${r.title}::${text}`);
    }
  }
  if (summaryFile) {
    try {
      appendFileSync(summaryFile, `${clean(renderSummary(results))}\n`);
    } catch {
      // the summary is a convenience; the log above says the same
    }
  }
  const failed = results.filter((r) => r.level === 'fail');
  if (failed.length > 0) {
    log(`[preflight] ${failed.length} problem(s) above must be fixed first. Nothing was built or published.`);
    return 1;
  }
  log('[preflight] Everything the deployment needs is in place.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
