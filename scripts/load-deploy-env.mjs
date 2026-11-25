#!/usr/bin/env node
/**
 * Reads the OPTIONAL repository secret DEPLOY_ENV: one text block with the same lines you would write in a chat message,
 *
 *   CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef      (or CF_ACCOUNT_ID=...)
 *   CLOUDFLARE_API_TOKEN=cfut_...                               (or CF_API_TOKEN=...)
 *   GROQ_API_KEY=gsk_...                                        (optional)
 *
 * so that three separate secrets (and their exact names) are not needed. The values are masked in the log first and are then handed to
 * the next steps as step outputs (`account`, `token`, `groq`). Secrets that exist on their own always win over this block (see deploy.yml).
 *
 * What it never does: print a value, print a line it could not understand (a bare token on a line of its own is a "line it could not
 * understand"), `eval` anything, or fail the run. A problem becomes a warning; the preflight that follows reports what is still missing.
 */
import { appendFileSync } from 'node:fs';

/** Which names fill which slot. The first name of each list is the official one and wins over the others. */
export const SLOTS = {
  account: ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID'],
  token: ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'],
  groq: ['GROQ_API_KEY'],
};
/** Slots whose value is a credential and must not appear in a log. (The account id is an identifier, not a secret.) */
const MASKED = ['token', 'groq'];

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const unquote = (v) => {
  const m = /^(["'`])(.*)\1$/.exec(v);
  return m ? m[2].trim() : v;
};

/**
 * Text → what it contains. Forgiving about the ways a person copies lines around: `export `, `KEY=value`, `KEY: value`, quotes,
 * a trailing comma or semicolon, Windows line breaks, blank lines and `#` comments, upper or lower case names.
 * Returns `{ values: { account, token, groq }, names: [recognised names, in order], ignored: [names of other KEY=VALUE lines], unreadable: count, problems: [...] }`.
 */
export function parseBundle(text) {
  const out = { values: { account: '', token: '', groq: '' }, names: [], ignored: [], unreadable: 0, problems: [] };
  const chosen = {}; // slot -> rank of the name used (lower = more official)
  for (const rawLine of String(text ?? '').split(/\r\n|\r|\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    line = line.replace(/^export\s+/i, '').replace(/[,;]\s*$/, '');
    const cut = line.search(/[=:]/);
    if (cut < 1) {
      out.unreadable++;
      continue;
    }
    const name = unquote(line.slice(0, cut).trim());
    const value = unquote(line.slice(cut + 1).trim().replace(/[,;]\s*$/, ''));
    if (!KEY.test(name)) {
      out.unreadable++;
      continue;
    }
    const upper = name.toUpperCase();
    const slot = Object.keys(SLOTS).find((s) => SLOTS[s].includes(upper));
    if (!slot) {
      out.ignored.push(upper);
      continue;
    }
    out.names.push(upper);
    if (!value) {
      out.problems.push(`${upper} has nothing after the = sign`);
      continue;
    }
    if (/[^\x21-\x7e]/.test(value)) {
      out.problems.push(`${upper} contains spaces or characters no key has (it was not used; paste the value only, without anything around it)`);
      continue;
    }
    const rank = SLOTS[slot].indexOf(upper);
    if (chosen[slot] === undefined || rank <= chosen[slot]) {
      out.values[slot] = value;
      chosen[slot] = rank;
    }
  }
  return out;
}

/**
 * Entry point. `env.DEPLOY_ENV` is the secret; `outputFile` is GITHUB_OUTPUT. Always returns 0.
 * Order matters: every credential is registered as a mask BEFORE anything is written to the log or to the output file.
 */
export function main({ env = process.env, log = console.log, outputFile = env.GITHUB_OUTPUT } = {}) {
  const raw = typeof env.DEPLOY_ENV === 'string' ? env.DEPLOY_ENV : '';
  if (!raw.trim()) {
    log('[bundle] There is no DEPLOY_ENV secret (or it is empty). That is fine when the secrets exist one by one.');
    return 0;
  }
  const found = parseBundle(raw);
  // workflow-command data escapes % (the values cannot contain line breaks: parseBundle refuses anything but printable ASCII)
  for (const slot of MASKED) if (found.values[slot]) log(`::add-mask::${found.values[slot].replace(/%/g, '%25')}`);
  const filled = Object.keys(SLOTS).filter((s) => found.values[s]);
  log(`[bundle] DEPLOY_ENV was read: ${found.names.length > 0 ? `recognised ${[...new Set(found.names)].join(', ')}` : 'it holds no line with a name this project knows'}.`);
  if (found.ignored.length > 0) log(`[bundle] Other names in it were not used: ${[...new Set(found.ignored)].slice(0, 10).join(', ')}.`);
  if (found.unreadable > 0) log(`[bundle] ${found.unreadable} line(s) were not of the form NAME=value and were skipped (their text is not shown).`);
  const lines = [];
  for (const slot of filled) lines.push(`${slot}=${found.values[slot]}`);
  if (outputFile && lines.length > 0) {
    try {
      appendFileSync(outputFile, `${lines.join('\n')}\n`);
    } catch (err) {
      log(`::warning title=DEPLOY_ENV::could not hand the values to the next steps (${String(err?.message ?? err).slice(0, 120)})`);
    }
  }
  const missing = [];
  if (!found.values.account) missing.push('no usable account id (a line CLOUDFLARE_ACCOUNT_ID=… or CF_ACCOUNT_ID=…)');
  if (!found.values.token) missing.push('no usable Cloudflare token (a line CLOUDFLARE_API_TOKEN=… or CF_API_TOKEN=…)');
  const trouble = [...found.problems, ...(missing.length > 0 ? [`DEPLOY_ENV has ${missing.join(' and ')}`] : [])];
  for (const t of trouble) log(`::warning title=DEPLOY_ENV::${t.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  if (trouble.length === 0) log(`[bundle] Handed on: ${filled.map((s) => ({ account: 'account id', token: 'Cloudflare token', groq: 'Groq key' })[s]).join(', ')}.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
