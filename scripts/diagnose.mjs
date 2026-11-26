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
import { spawn, spawnSync } from 'node:child_process';
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
  const { accountId, token } = credentials();
  const panel = await statusOf('https://zeus.amin-ck.workers.dev/?debug=1');
  say('panel', `${panel.status} title="${titleOf(panel.body)}"`);

  const old = await statusOf('https://amin-chat.amin-ck.workers.dev/api/health');
  say('oldWorker', `${old.status} ${old.body.slice(0, 60)}`);

  const plain = await statusOf('https://zeus.amin-ck.workers.dev/');
  say('panelNoDebug', `${plain.status} title="${titleOf(plain.body)}"`);

  try {
    const bust = await fetch(`https://zeus.amin-ck.workers.dev/?r=${Math.random().toString(36).slice(2)}`, {
      headers: { 'Cache-Control': 'no-cache' },
    });
    const text = (await bust.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    const header = ['cf-cache-status', 'server', 'cf-ray', 'content-type'].map((h) => `${h}=${bust.headers.get(h)}`).join(' ');
    say('freshUrl', `${bust.status} ${header} text="${text}"`);
  } catch (err) {
    say('freshUrl', String(err.message ?? err));
  }

  const settingsOf = async (name) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await response.json().catch(() => ({}));
    const r = json.result ?? {};
    return `date=${r.compatibility_date} flags=${JSON.stringify(r.compatibility_flags)} usage=${r.usage_model} bindings=${JSON.stringify((r.bindings ?? []).map((b) => `${b.type}:${b.name}`))}`;
  };
  say('settings', await settingsOf('zeus').catch((err) => String(err)));

  // is the database itself reachable?
  try {
    const dbs = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?per_page=100`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const db = (dbs.result ?? []).find((entry) => entry.name === 'zeus-db');
    const id = db?.uuid ?? db?.id;
    const query = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${id}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT COUNT(*) AS users FROM users' }),
    }).then((response) => response.json());
    say('d1', `${db?.num_tables ?? '?'} tables | ${JSON.stringify(query).slice(0, 200)}`);
  } catch (err) {
    say('d1', String(err.message ?? err));
  }

  // three probes with the same code: no database, the old database, the new one
  try {
    const source = readFileSync(`${workerDir}wrangler.jsonc`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(?=\s*[}\]])/g, '');
    const base = JSON.parse(source);
    const dbs = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?per_page=100`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const byName = new Map((dbs.result ?? []).map((db) => [db.name, db.uuid ?? db.id]));
    const cases = [
      ['fresh-nodb', null],
      ['fresh-new', byName.get('zeus-db')],
      ['fresh-old', byName.get('amin-chat-db')],
    ];
    for (const [suffix, id] of cases) {
      const name = `zeus-${suffix}-${Date.now().toString(36).slice(-4)}`;
      const config = { ...base, name };
      if (id) {
        config.d1_databases = [{ binding: 'DB', database_name: suffix === 'fresh-old' ? 'amin-chat-db' : 'zeus-db', database_id: id, migrations_dir: 'migrations' }];
      } else {
        delete config.d1_databases;
      }
      writeFileSync(`${workerDir}wrangler.probe.jsonc`, JSON.stringify(config, null, 2));
      const deployed = wrangler(['deploy', '--config', 'wrangler.probe.jsonc']);
      await new Promise((resolve) => setTimeout(resolve, 6000));
      const status = await statusOf(`https://${name}.amin-ck.workers.dev/?debug=1`);
      say(suffix, `${status.status} title="${titleOf(status.body)}" exit ${deployed.code}`);
    }
  } catch (err) {
    say('probes', String(err.message ?? err));
  }

  // the Worker's own words: wrangler tail while a request is made
  const { token: tailToken, accountId: tailAccount } = credentials();
  const tail = spawn('npx', ['--no-install', 'wrangler', 'tail', 'zeus', '--format', 'pretty'], {
    cwd: workerDir,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: tailToken, CLOUDFLARE_ACCOUNT_ID: tailAccount, WRANGLER_SEND_METRICS: 'false' },
  });
  let tailText = '';
  tail.stdout.on('data', (chunk) => (tailText += String(chunk)));
  tail.stderr.on('data', (chunk) => (tailText += String(chunk)));
  await new Promise((resolve) => setTimeout(resolve, 12000));
  await statusOf('https://zeus.amin-ck.workers.dev/?debug=1');
  await new Promise((resolve) => setTimeout(resolve, 6000));
  tail.kill('SIGKILL');
  say('tail', tailText.replace(/\s+/g, ' ').slice(-600) || '(nothing)');

  console.log(`::error title=Diagnose::${notes.join(' || ')}`);
  // wrangler tail leaves a child holding the pipes open; do not wait for it
  process.exit(0);
}

main().catch((err) => {
  console.log(`::error title=Diagnose::${String(err.stack ?? err).slice(0, 900)}`);
});
