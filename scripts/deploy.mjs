#!/usr/bin/env node
/**
 * Publish the panel to your Cloudflare account.
 *
 *   node scripts/deploy.mjs            create the database if needed, migrate, deploy, print the address
 *   node scripts/deploy.mjs --dry-run  explain what would happen; contact nobody
 *
 * Credentials come from the environment, either as single variables or as one `DEPLOY_ENV` value holding
 * KEY=VALUE lines (the form the GitHub workflow uses):
 *
 *   CLOUDFLARE_ACCOUNT_ID=...   CLOUDFLARE_API_TOKEN=...
 *
 * The token needs Workers Scripts:Edit and D1:Edit. Nothing secret is printed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { credentials } from './env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workerDir = `${root}worker/`;
const DB_NAME = 'zeus-db';
const WORKER_NAME = 'zeus-lite';
const GENERATED_CONFIG = 'wrangler.generated.jsonc';
const dryRun = process.argv.includes('--dry-run');

const api = async (path, init = {}) => {
  const { accountId, token } = credentials();
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const detail = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
    throw new Error(`${init.method ?? 'GET'} ${path} → ${detail}`);
  }
  return body.result;
};

/** The D1 database, created if the account does not have it yet. */
async function ensureDatabase(accountId) {
  const list = await api(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(DB_NAME)}`);
  const found = (Array.isArray(list) ? list : list?.databases ?? []).find((db) => db.name === DB_NAME);
  if (found) return found.uuid ?? found.id;
  const created = await api(`/accounts/${accountId}/d1/database`, { method: 'POST', body: JSON.stringify({ name: DB_NAME }) });
  return created.uuid ?? created.id;
}

/** workers.dev is account-wide: it is either already registered or created now. */
async function ensureSubdomain(accountId) {
  const current = await api(`/accounts/${accountId}/workers/subdomain`);
  if (current?.subdomain) return current.subdomain;
  const wanted = process.env.WORKERS_SUBDOMAIN || `zeus-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const created = await api(`/accounts/${accountId}/workers/subdomain`, { method: 'PUT', body: JSON.stringify({ subdomain: wanted }) });
    return created.subdomain ?? wanted;
  } catch (err) {
    console.warn(`could not register a workers.dev name (${err.message}); deploy anyway and read the address below`);
    return '';
  }
}

function wrangler(args, { capture = false } = {}) {
  const { accountId, token } = credentials();
  const result = spawnSync('npx', ['--no-install', 'wrangler', ...args], {
    cwd: workerDir,
    encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: 'false' },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`wrangler ${args.join(' ')} failed${output ? `:\n${output}` : ''}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/** The configuration with the real database id, written next to the real one (never committed). */
function writeConfig(databaseId) {
  const source = readFileSync(`${workerDir}wrangler.jsonc`, 'utf8');
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(?=\s*[}\]])/g, '');
  const config = JSON.parse(withoutComments);
  const db = config.d1_databases?.find((entry) => entry.binding === 'DB');
  if (!db) throw new Error('wrangler.jsonc has no D1 binding named "DB"');
  db.database_id = databaseId;
  writeFileSync(`${workerDir}${GENERATED_CONFIG}`, `${JSON.stringify(config, null, 2)}\n`);
  return `${workerDir}${GENERATED_CONFIG}`;
}

async function main() {
  const { accountId, token } = credentials();
  if (!dryRun && (!accountId || !token)) {
    console.error(
      'Missing credentials. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or one DEPLOY_ENV value with those two lines.',
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log(`would create the D1 database "${DB_NAME}" if it is missing, apply worker/migrations, then deploy "${WORKER_NAME}"`);
    console.log('would print the workers.dev address at the end');
    return;
  }

  console.log(`1/4  asking Cloudflare for the database "${DB_NAME}"`);
  const databaseId = await ensureDatabase(accountId);
  console.log(`     ${DB_NAME} = ${databaseId}`);

  const configPath = writeConfig(databaseId);
  console.log(`2/4  wrote ${configPath.replace(root, '')}`);

  console.log('3/4  applying migrations');
  wrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote', '--config', GENERATED_CONFIG]);

  if (process.env.ADMIN_PASSWORD) {
    console.log('     storing ADMIN_PASSWORD as a Worker secret');
    spawnSync('npx', ['--no-install', 'wrangler', 'secret', 'put', 'ADMIN_PASSWORD', '--config', GENERATED_CONFIG], {
      cwd: workerDir,
      input: process.env.ADMIN_PASSWORD,
      encoding: 'utf8',
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['pipe', 'inherit', 'inherit'],
    });
  }

  console.log('4/4  deploying');
  const output = wrangler(['deploy', '--config', GENERATED_CONFIG], { capture: true });
  process.stdout.write(output);

  const subdomain = await ensureSubdomain(accountId).catch(() => '');
  const url = subdomain ? `https://${WORKER_NAME}.${subdomain}.workers.dev` : '';
  console.log('');
  console.log('--------------------------------------------------------------------------');
  console.log('panel       ', url || '(see the address wrangler printed above)');
  console.log('admin       ', `${url || ''}/  — password: ${process.env.ADMIN_PASSWORD ? 'the ADMIN_PASSWORD secret' : 'amin_ck (change it in the panel)'}`);
  console.log('subscription', `${url || ''}/sub/<user token>`);
  console.log('--------------------------------------------------------------------------');
  console.log('');
  writeFileSync(`${workerDir}.deployed-url`, `${url}\n`);
  if (process.env.GITHUB_OUTPUT) {
    spawnSync('bash', ['-c', `echo "url=${url}" >> "$GITHUB_OUTPUT"`], { env: { ...process.env }, stdio: 'inherit' });
  }
  console.log(`::notice title=Panel::${url || 'deployed'}`);
}

if (!existsSync(`${workerDir}wrangler.jsonc`)) {
  console.error('worker/wrangler.jsonc is missing');
  process.exit(1);
}

main().catch((err) => {
  console.error(`deployment failed: ${err.message}`);
  process.exit(1);
});
