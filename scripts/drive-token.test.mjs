import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';
import { authUrl, extractCode, parseArgs, pkcePair } from './drive-token.mjs';

test('the authorisation link asks for drive.file only, offline access and PKCE', () => {
  const { challenge } = pkcePair();
  const u = new URL(authUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:1234', challenge, state: 'st' }));
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:1234');
});

test('the PKCE challenge is the SHA-256 of the verifier', () => {
  const { verifier, challenge } = pkcePair();
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
});

test('extractCode accepts an address, a query string or the bare code, and rejects foreign answers', () => {
  assert.deepEqual(extractCode('http://127.0.0.1:5/?code=abc&state=s1', 's1'), { code: 'abc' });
  assert.deepEqual(extractCode('?code=abc&state=s1', 's1'), { code: 'abc' });
  assert.deepEqual(extractCode('4/0Aabc-def', 's1'), { code: '4/0Aabc-def' });
  assert.equal(extractCode('   ', 's1'), null);
  assert.throws(() => extractCode('http://127.0.0.1:5/?code=abc&state=other', 's1'), /state/);
  assert.throws(() => extractCode('http://127.0.0.1:5/?error=access_denied', 's1'), /access_denied/);
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--client-id', 'a', '--client-secret', 'b', '--port', '9', '--no-check']), { check: false, clientId: 'a', clientSecret: 'b', port: 9 });
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
});

/** A tiny Google: token endpoint (authorization_code + refresh_token grants, PKCE verified) and about. */
function fakeGoogle({ withRefreshToken = true } = {}) {
  const seen = { codeVerifier: null, grants: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const send = (status, obj) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    if (url.pathname === '/token') {
      seen.grants.push(form.get('grant_type'));
      if (form.get('client_id') !== 'cid' || form.get('client_secret') !== 'sec') return send(401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        seen.codeVerifier = form.get('code_verifier');
        if (form.get('code') !== 'the-code') return send(400, { error: 'invalid_grant', error_description: 'Bad code' });
        return send(200, { access_token: 'at-1', expires_in: 3600, ...(withRefreshToken ? { refresh_token: '1//refresh-xyz' } : {}) });
      }
      if (form.get('grant_type') === 'refresh_token') return form.get('refresh_token') === '1//refresh-xyz' ? send(200, { access_token: 'at-2', expires_in: 3600 }) : send(400, { error: 'invalid_grant' });
    }
    if (url.pathname === '/drive/v3/about') return req.headers.authorization === 'Bearer at-2' ? send(200, { user: { displayName: 'Amin', emailAddress: 'amin@example.com' }, storageQuota: { usage: String(2 * 1024 ** 3), limit: String(15 * 1024 ** 3) } }) : send(401, {});
    send(404, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

function runScript(env) {
  const child = spawn(process.execPath, ['scripts/drive-token.mjs', '--port', '0'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
  const until = async (re) => {
    for (let i = 0; i < 200; i++) {
      const m = re.exec(out);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${re}; output so far:\n${out}`);
  };
  return { child, done, until };
}

test('end to end: prints the link, receives the browser redirect, exchanges the code and shows the refresh token', async () => {
  const g = await fakeGoogle();
  const env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_OAUTH_AUTH_URL: `http://127.0.0.1:${g.port}/auth`, GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${g.port}/token`, GOOGLE_API_BASE: `http://127.0.0.1:${g.port}` };
  const run = runScript(env);
  try {
    const link = new URL((await run.until(/(http:\/\/127\.0\.0\.1:\d+\/auth\?[^\s]+)/))[1]);
    assert.equal(link.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
    const redirect = new URL(link.searchParams.get('redirect_uri'));
    redirect.searchParams.set('code', 'the-code');
    redirect.searchParams.set('state', link.searchParams.get('state'));
    const page = await fetch(redirect);
    assert.equal(page.status, 200);
    const { code, out } = await run.done;
    assert.equal(code, 0, out);
    assert.match(out, /Connected as Amin <amin@example.com> — 2\.0 GB of 15\.0 GB used/);
    assert.match(out, /^1\/\/refresh-xyz$/m);
    assert.match(out, /wrangler secret put GOOGLE_REFRESH_TOKEN/);
    assert.match(out, /In production/);
    // PKCE: the verifier sent to the token endpoint matches the challenge in the link
    assert.equal(createHash('sha256').update(g.seen.codeVerifier).digest('base64url'), link.searchParams.get('code_challenge'));
  } finally {
    run.child.kill();
    g.server.close();
  }
});

test('refuses an answer for another request (wrong state) and keeps waiting for the right one', async () => {
  const g = await fakeGoogle();
  const env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_OAUTH_AUTH_URL: `http://127.0.0.1:${g.port}/auth`, GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${g.port}/token`, GOOGLE_API_BASE: `http://127.0.0.1:${g.port}` };
  const run = runScript(env);
  try {
    const link = new URL((await run.until(/(http:\/\/127\.0\.0\.1:\d+\/auth\?[^\s]+)/))[1]);
    const redirect = new URL(link.searchParams.get('redirect_uri'));
    redirect.searchParams.set('code', 'the-code');
    redirect.searchParams.set('state', 'forged');
    const forged = await fetch(redirect);
    assert.equal(forged.status, 400);
    assert.deepEqual(g.seen.grants, []); // nothing was exchanged for the forged answer
    redirect.searchParams.set('state', link.searchParams.get('state')); // the genuine answer still works
    assert.equal((await fetch(redirect)).status, 200);
    const { code, out } = await run.done;
    assert.equal(code, 0, out);
    assert.match(out, /^1\/\/refresh-xyz$/m);
  } finally {
    run.child.kill();
    g.server.close();
  }
});

test('explains what to do when Google returns no refresh token', async () => {
  const g = await fakeGoogle({ withRefreshToken: false });
  const env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_OAUTH_AUTH_URL: `http://127.0.0.1:${g.port}/auth`, GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${g.port}/token`, GOOGLE_API_BASE: `http://127.0.0.1:${g.port}` };
  const run = runScript(env);
  try {
    const link = new URL((await run.until(/(http:\/\/127\.0\.0\.1:\d+\/auth\?[^\s]+)/))[1]);
    const redirect = new URL(link.searchParams.get('redirect_uri'));
    redirect.searchParams.set('code', 'the-code');
    redirect.searchParams.set('state', link.searchParams.get('state'));
    await fetch(redirect);
    const { code, err } = await run.done;
    assert.equal(code, 1);
    assert.match(err, /no refresh token/);
    assert.match(err, /myaccount\.google\.com\/permissions/);
  } finally {
    run.child.kill();
    g.server.close();
  }
});
