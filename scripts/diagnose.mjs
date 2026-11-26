#!/usr/bin/env node
/**
 * Run by the deploy workflow when the live check fails: put the reason into an annotation, because the run's log
 * is not always readable from where this is being looked at.
 *
 * It answers three questions in one line:
 *   1. what does the panel answer right now (status and the first characters of the body)?
 *   2. what does `wrangler deployments list` say about the worker?
 *   3. does the same panel work under a different worker name (so: the code, or this deployment)?
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { credentials } from './env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workerDir = `${root}worker/`;
const probeName = 'zeus-probe';

const notes = [];
const say = (label, value) => notes.push(`${label}=${String(value).replace(/\s+/g, ' ').slice(0, 240)}`);

function wrangler(args, cwd = workerDir) {
  const { accountId, token } = credentials();
  const result = spawnSync('npx', ['--no-install', 'wrangler', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: 'false' },
  });
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

async function statusOf(url) {
  try {
    const response = await fetch(url, { redirect: 'manual' });
    const body = await response.text();
    return { status: response.status, body: body.slice(0, 200) };
  } catch (err) {
    return { status: 'unreachable', body: String(err.message ?? err) };
  }
}

function titleOf(body) {
  const title = /<title[^>]*>([\s\S]{0,120}?)<\/title>/i.exec(body);
  return title ? title[1].trim() : body.slice(0, 60);
}

async function main() {
  const panel = await statusOf('https://zeus-lite.amin-ck.workers.dev/?debug=1');
  say('panel', `${panel.status} title="${titleOf(panel.body)}"`);

  const old = await statusOf('https://amin-chat.amin-ck.workers.dev/api/health');
  say('oldWorker', `${old.status} ${old.body.slice(0, 60)}`);

  const plain = await statusOf('https://zeus-lite.amin-ck.workers.dev/');
  say('panelNoDebug', `${plain.status} title="${titleOf(plain.body)}"`);

  // the same bundle under another name: a fresh deployment of a fresh worker
  const probe = wrangler(['deploy', '--config', 'wrangler.generated.jsonc', '--name', probeName]);
  say('probeDeploy', probe.out.slice(-200) || `exit ${probe.code}`);
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const probed = await statusOf(`https://${probeName}.amin-ck.workers.dev/?debug=1`);
  say('probe', `${probed.status} title="${titleOf(probed.body)}"`);
  say('probeDeployExit', probe.code);

  // the same panel without the database binding: is the binding what stops the isolate from starting?
  const generated = JSON.parse(readFileSync(`${workerDir}wrangler.generated.jsonc`, 'utf8'));
  say('d1', JSON.stringify(generated.d1_databases ?? []));
  const without = { ...generated, name: 'zeus-nodb' };
  delete without.d1_databases;
  writeFileSync(`${workerDir}wrangler.nodb.jsonc`, JSON.stringify(without, null, 2));
  const nodb = wrangler(['deploy', '--config', 'wrangler.nodb.jsonc']);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const nodbStatus = await statusOf('https://zeus-nodb.amin-ck.workers.dev/?debug=1');
  say('noDatabase', `${nodbStatus.status} title="${titleOf(nodbStatus.body)}" exit ${nodb.code}`);

  console.log(`::error title=Diagnose::${notes.join(' || ')}`);
}

main().catch((err) => {
  console.log(`::error title=Diagnose::${String(err.stack ?? err).slice(0, 900)}`);
});
