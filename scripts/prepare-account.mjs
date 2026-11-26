#!/usr/bin/env node
/**
 * Right before publishing (the "Prepare the account" step of the "Deploy to Cloudflare" workflow, after the tests): gives the Cloudflare
 * account a workers.dev address when it has none.
 *
 * Why: a Worker is published at <worker>.<address of the account>.workers.dev, and a new account has no address yet. Wrangler then asks the
 * person "register one now?" and, inside GitHub, nobody can answer, so it stops with "register a workers.dev subdomain here". (Read from
 * Wrangler's own source, 4.162.0: the question is skipped only when it runs for a coding agent.) The address is free, it can be renamed at any
 * time in the dashboard, and registering it is exactly what the person was told to do by hand, so this step does it and says which name it
 * took. A person who wants a particular name registers it first, in the dashboard; then there is nothing to do here.
 *
 * Safety:
 *   - An address that exists is NEVER touched. The registration (PUT) is sent only after the account itself answered "none" (code 10007, or
 *     an empty answer). Any other answer (an outage, a refusal) changes nothing; Wrangler then reports it in its own words.
 *   - Nothing here prints a credential: the messages are statuses and what Cloudflare said, passed through `redact`.
 *   - Only when the configuration publishes to workers.dev (Wrangler's own rule, `wantsWorkersDev`).
 *
 * Plain JavaScript on purpose (no TypeScript, no model id): it runs after `npm ci` but belongs to the same family as the preflight.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { parseJsonc, redact } from './deploy.mjs';
import { CF_API, wantsWorkersDev } from './preflight.mjs';

/** The shape of a workers.dev label: lower-case letters, digits and hyphens, not starting or ending with a hyphen, at most 63 characters. */
export const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** At most this many names are tried; each one that fails is a name somebody else already owns (or Cloudflare finds unusable). */
export const MAX_ATTEMPTS = 5;

const short = (text, n = 200) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Six random characters of the kind a subdomain may contain. */
const randomWord = () => randomBytes(3).toString('hex');

/** "amin_ck" → "amin-ck"; anything that cannot become a valid label → "". */
function labelOf(text) {
  const t = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return SUBDOMAIN_PATTERN.test(t) ? t : '';
}

/**
 * The names to try, in order: the administrator's username from the configuration ("amin_ck" → "amin-ck", which reads well in
 * https://amin-chat.amin-ck.workers.dev), then that name with "-chat", then "amin-chat-" with random characters. Always valid labels,
 * never repeated, at most MAX_ATTEMPTS.
 */
export function subdomainCandidates(configText, random = randomWord) {
  let admin = '';
  try {
    const vars = parseJsonc(configText)?.vars ?? {};
    admin = labelOf(String(vars.ADMIN_USERNAMES ?? '').split(',')[0]);
  } catch {
    admin = '';
  }
  const out = [];
  const add = (name) => {
    if (SUBDOMAIN_PATTERN.test(name) && !out.includes(name)) out.push(name);
  };
  if (admin) {
    add(admin);
    add(`${admin}-chat`.slice(0, 63));
  }
  for (let i = 0; out.length < MAX_ATTEMPTS && i < 20; i++) add(`amin-chat-${labelOf(random()) || randomWord()}`);
  return out.slice(0, MAX_ATTEMPTS);
}

/** One request with a deadline; a network failure, a 429 or a 5xx is retried once. Resolves to { status, body } or { error }. */
async function call(fetchFn, sleep, url, token, init = {}) {
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchFn(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        signal: AbortSignal.timeout(20_000),
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if ((res.status >= 500 || res.status === 429) && attempt === 0) {
        last = `HTTP ${res.status}`;
        await sleep(2000);
        continue;
      }
      return { status: res.status, body };
    } catch (err) {
      last = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'no answer within 20 seconds' : [err?.cause?.code, err?.message].filter(Boolean).join(': ') || String(err);
      if (attempt === 0) await sleep(2000);
    }
  }
  return { error: `Cloudflare could not be reached (${short(last, 120)})` };
}

/** What Cloudflare said, in one line: "HTTP 400, code 10031: the message". */
function problem(res) {
  if (res.error) return res.error;
  const e = Array.isArray(res.body?.errors) ? res.body.errors[0] : null;
  return `HTTP ${res.status}${e?.code ? `, code ${e.code}` : ''}${e?.message ? `: ${short(e.message)}` : ''}`;
}

const DASHBOARD = 'https://dash.cloudflare.com/?to=/:account/workers/onboarding';

/**
 * Entry point. Resolves to the exit code: 0 when the account has an address afterwards, none is needed, or nothing could be learned (nothing
 * was changed then), 1 when registering failed (the run stops here, before anything is built or published).
 */
export async function main({
  env = process.env,
  fetch: fetchFn = globalThis.fetch,
  log = console.log,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  readConfig = () => readFileSync(new URL('../apps/api/wrangler.jsonc', import.meta.url), 'utf8'),
  random = randomWord,
  summaryFile = env.GITHUB_STEP_SUMMARY,
} = {}) {
  const account = typeof env.CLOUDFLARE_ACCOUNT_ID === 'string' ? env.CLOUDFLARE_ACCOUNT_ID.trim() : '';
  const token = typeof env.CLOUDFLARE_API_TOKEN === 'string' ? env.CLOUDFLARE_API_TOKEN.trim() : '';
  const clean = (text) => (token.length >= 8 ? redact(text, token) : String(text));
  const inActions = env.GITHUB_ACTIONS === 'true';
  const say = (text) => log(clean(`[address] ${text}`));
  const annotate = (kind, title, text) => inActions && log(`::${kind} title=${title}::${clean(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);

  let configText = '';
  try {
    configText = readConfig();
  } catch {
    configText = '';
  }
  if (configText && !wantsWorkersDev(configText)) {
    say('the configuration publishes to routes only, not to workers.dev: no address is needed.');
    return 0;
  }
  if (!/^[0-9a-f]{32}$/i.test(account) || !token) {
    say('there is no usable account id or token in this run, so nothing was asked of Cloudflare (the preflight reports that).');
    return 0;
  }

  const A = `${CF_API}/accounts/${account}/workers/subdomain`;
  const asked = await call(fetchFn, sleep, A, token);
  const existing = asked.status === 200 ? asked.body?.result?.subdomain : undefined;
  if (existing) {
    say(`the account already has a workers.dev address (${existing}.workers.dev): nothing to do.`);
    return 0;
  }
  const none = (asked.status === 200 && asked.body?.success === true) || (asked.status === 404 && asked.body?.errors?.some?.((e) => e?.code === 10007));
  if (!none) {
    // never register on a guess: an existing address must not be replaced because of an outage
    const text = `could not find out whether the account has a workers.dev address (${problem(asked)}). Nothing was changed; Wrangler asks again when it publishes.`;
    say(text);
    annotate('warning', 'workers.dev address', text);
    return 0;
  }

  const names = subdomainCandidates(configText, random);
  const refused = [];
  for (const name of names) {
    const put = await call(fetchFn, sleep, A, token, { method: 'PUT', body: JSON.stringify({ subdomain: name }) });
    if (!put.error && put.status === 200 && put.body?.success !== false) {
      const got = put.body?.result?.subdomain || name;
      const text = `registered the workers.dev address "${got}" for this account (free). The service will live at https://amin-chat.${got}.workers.dev. To rename it later: Cloudflare dashboard → Workers & Pages → Account details → Change. Renaming moves every Worker of the account to the new name.`;
      say(text);
      annotate('notice', 'workers.dev address', text);
      if (summaryFile) {
        try {
          appendFileSync(summaryFile, `${clean(`### Address registered\n\nThe account had no workers.dev address, so this run registered **${got}.workers.dev** (free). Rename it any time: dashboard → Workers & Pages → Account details → Change.`)}\n\n`);
        } catch {
          // a convenience; the log says the same
        }
      }
      return 0;
    }
    if (put.error || put.status === 401 || put.status === 403 || put.status >= 500 || put.status === 429) {
      const text = `could not register a workers.dev address (${problem(put)}). Nothing was built or published. ${put.status === 401 || put.status === 403 ? 'The token needs the row Account → Workers Scripts → Edit. ' : ''}Or register one yourself, once: ${DASHBOARD}`;
      say(text);
      annotate('error', 'workers.dev address', text);
      return 1;
    }
    refused.push(`${name} (${problem(put)})`);
    say(`the name "${name}" was not accepted (${problem(put)}); trying the next one.`);
  }
  const text = `none of the names tried was accepted: ${refused.join('; ')}. Nothing was built or published. Choose a name yourself, once: ${DASHBOARD}`;
  say(text);
  annotate('error', 'workers.dev address', text);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
