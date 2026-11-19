#!/usr/bin/env node
/**
 * Creates the Google Drive refresh token the cold file tier needs (`npm run drive:token`).
 *
 * Why a human account: service accounts have no Drive storage quota. This script performs the standard "installed app"
 * OAuth flow (loopback redirect + PKCE) for ONE Google account with the single scope `drive.file`, which only lets
 * AMIN CHAT see the files it created itself — never the rest of that Drive.
 *
 *   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… npm run drive:token
 *   npm run drive:token -- --client-id … --client-secret … [--port 53682] [--no-check]
 *
 * Works on a remote machine too: open the printed link on any device, and when the browser ends up on a page that does
 * not load (http://127.0.0.1:…/?code=…), paste that address (or just the code) into this terminal.
 *
 * GOOGLE_OAUTH_AUTH_URL / GOOGLE_OAUTH_TOKEN_URL / GOOGLE_API_BASE override Google's endpoints (used by the tests).
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = process.env.GOOGLE_OAUTH_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
const API_BASE = process.env.GOOGLE_API_BASE ?? 'https://www.googleapis.com';

export function parseArgs(argv) {
  const out = { check: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-check') out.check = false;
    else if (a === '--client-id') out.clientId = argv[++i];
    else if (a === '--client-secret') out.clientSecret = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function authUrl({ clientId, redirectUri, challenge, state }) {
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline', // ask for a refresh token …
    prompt: 'consent', // … every time (Google only returns one on the first consent otherwise)
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();
  return u.toString();
}

export class StateMismatch extends Error {}

/** Accepts the full redirected address, a query string, or the bare code. */
export function extractCode(input, expectedState) {
  const text = input.trim();
  if (!text) return null;
  let params = null;
  try {
    params = new URL(text).searchParams;
  } catch {
    if (text.includes('code=')) params = new URLSearchParams(text.replace(/^\?/, ''));
  }
  if (!params) return { code: text };
  if (params.get('error')) throw new Error(`Google answered: ${params.get('error')}${params.get('error_description') ? ` (${params.get('error_description')})` : ''}`);
  if (expectedState && params.get('state') && params.get('state') !== expectedState) throw new StateMismatch('The "state" value does not match: this answer belongs to a different request.');
  const code = params.get('code');
  return code ? { code } : null;
}

async function postForm(url, form) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${body.error ?? res.status}${body.error_description ? `: ${body.error_description}` : ''}`);
  return body;
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri, verifier }) {
  return postForm(TOKEN_URL, { client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier });
}

/** Proves the token works: refreshes an access token and reads the account's name and free space. */
export async function checkToken({ clientId, clientSecret, refreshToken }) {
  const t = await postForm(TOKEN_URL, { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
  const res = await fetch(`${API_BASE}/drive/v3/about?fields=${encodeURIComponent('user(emailAddress,displayName),storageQuota')}`, { headers: { Authorization: `Bearer ${t.access_token}` } });
  if (!res.ok) throw new Error(`Drive answered ${res.status}`);
  return res.json();
}

const gb = (n) => (Number(n) / 1024 ** 3).toFixed(1);

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a))));
}

function waitForCallback(server, state) {
  return new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      try {
        const got = extractCode(url.toString(), state);
        if (!got) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No code in this request.');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>AMIN CHAT</title><body style="font:18px system-ui;padding:3rem;text-align:center"><h2>✅ Done</h2><p>You can close this tab and go back to the terminal.</p></body>');
        resolve(got.code);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(err.message));
        // a stray or forged request must not abort the flow: keep waiting for the real answer
        if (!(err instanceof StateMismatch)) reject(err);
      }
    });
  });
}

export async function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  const args = parseArgs(argv);
  if (args.help) {
    log('Usage: GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… npm run drive:token [-- --port N] [--no-check]');
    return 0;
  }
  const clientId = args.clientId ?? env.GOOGLE_CLIENT_ID ?? (await ask('OAuth client ID: ')).trim();
  const clientSecret = args.clientSecret ?? env.GOOGLE_CLIENT_SECRET ?? (await ask('OAuth client secret: ')).trim();
  if (!clientId || !clientSecret) throw new Error('A client ID and a client secret are required (see docs/storage-drive.md, step 3).');

  const state = b64url(randomBytes(16));
  const { verifier, challenge } = pkcePair();
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(args.port ?? 0, '127.0.0.1', resolve));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const url = authUrl({ clientId, redirectUri, challenge, state });

  log('\n1. Open this link in a browser and sign in with the Google account whose Drive should hold the files:\n');
  log(url + '\n');
  log(`2. Allow access. The browser returns to ${redirectUri} and this window continues by itself.`);
  log('   (On another machine the page will not load — paste the address from the browser bar here and press Enter.)\n');

  let code;
  try {
    const fromServer = waitForCallback(server, state);
    const fromPaste = process.stdin.isTTY ? ask('> ').then((s) => extractCode(s, state)?.code ?? new Promise(() => {})) : new Promise(() => {});
    code = await Promise.race([fromServer, fromPaste]);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }

  const tokens = await exchangeCode({ clientId, clientSecret, code, redirectUri, verifier });
  if (!tokens.refresh_token) {
    throw new Error('Google returned no refresh token. Remove the earlier grant at https://myaccount.google.com/permissions (AMIN CHAT) and run this again.');
  }
  if (args.check) {
    const about = await checkToken({ clientId, clientSecret, refreshToken: tokens.refresh_token });
    log(`\n✅ Connected as ${about.user?.displayName ?? '?'} <${about.user?.emailAddress ?? '?'}>` + (about.storageQuota?.limit ? ` — ${gb(about.storageQuota.usage)} GB of ${gb(about.storageQuota.limit)} GB used` : ''));
  }
  log('\nStore the secrets in Cloudflare (run these in apps/api, paste the value when asked):\n');
  log('  npx wrangler secret put GOOGLE_CLIENT_ID');
  log('  npx wrangler secret put GOOGLE_CLIENT_SECRET');
  log('  npx wrangler secret put GOOGLE_REFRESH_TOKEN\n');
  log('GOOGLE_REFRESH_TOKEN value (keep it private — anyone holding it can use the app\'s part of your Drive):\n');
  log(tokens.refresh_token + '\n');
  log('Reminder: the OAuth consent screen must be "In production" (Audience → Publish app). In "Testing" this token dies after 7 days.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`\n✖ ${err.message}`);
      process.exit(1);
    },
  );
}
