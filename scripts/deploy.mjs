#!/usr/bin/env node
/**
 * One-command deployment (`npm run deploy`, also what the "Deploy to Cloudflare" GitHub workflow runs): build the web app,
 * publish the Worker, apply the D1 migrations — in the order that is safe for the situation:
 *
 *   • FIRST deployment (no D1 database named "amin-chat-db" in the account yet): the Worker is deployed first — Wrangler creates
 *     D1 and R2 during "deploy" — and the migrations run right after.
 *   • EVERY LATER deployment: migrations first, then the new code. Migrations are additive, so the old code keeps working
 *     while the schema changes and the new code never meets an old schema.
 *
 * Which of the two applies is asked from Cloudflare (`wrangler d1 list`), not guessed from the config file: in CI Wrangler
 * never writes the ids back, and it finds the database by its name anyway. A "database_id" in wrangler.jsonc is optional.
 *
 * `--skip-build` reuses apps/web/dist. `--dry-run` prints the plan without running anything or contacting Cloudflare.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const apiDir = `${root}apps/api/`;
const DB_NAME = 'amin-chat-db';

/** JSON with comments / trailing commas (wrangler.jsonc) → object. Comment markers inside strings are left alone. */
export function parseJsonc(text) {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * Which order is safe? `databaseExists` is Cloudflare's answer (true / false); undefined means "not asked" (--dry-run).
 * A "database_id" saved in wrangler.jsonc proves the database exists, so it needs no question.
 */
export function planDeploy(configText, { databaseExists } = {}) {
  const config = parseJsonc(configText);
  const db = (config.d1_databases ?? []).find((d) => d.binding === 'DB');
  if (!db) throw new Error('wrangler.jsonc has no D1 binding named "DB"');
  const pinned = typeof db.database_id === 'string' && db.database_id.length > 0;
  if (pinned) return { order: 'migrate-first', why: 'the database id is saved in wrangler.jsonc: migrate first so the new code never meets an old schema' };
  if (databaseExists === true) return { order: 'migrate-first', why: `the database "${DB_NAME}" already exists in your Cloudflare account: migrate first so the new code never meets an old schema` };
  if (databaseExists === false) return { order: 'deploy-first', why: `first deployment: the database "${DB_NAME}" does not exist yet, Wrangler creates D1 and R2 during "deploy", so the migrations can only run afterwards` };
  return { order: 'undecided', why: `the order is chosen when this runs: migrations first if the database "${DB_NAME}" already exists in your Cloudflare account, otherwise (first deployment) the Worker first, because Wrangler creates the database while deploying` };
}

/** Names of the databases in the answer of `wrangler d1 list --json` (tolerates log lines around the JSON). Throws when it is not such an answer. */
export function parseDatabaseNames(stdout) {
  const text = String(stdout ?? '');
  const start = text.search(/^\s*\[/m);
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('the answer is not a list of databases');
  const list = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(list)) throw new Error('the answer is not a list of databases');
  return list.map((d) => d?.name).filter((n) => typeof n === 'string');
}

const defaultRun = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1;
const defaultCapture = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
/** The line of wrangler's output that explains a failure: colours removed, the first line that says "error" (else the first line). */
export function describeFailure(...texts) {
  const lines = texts.join('\n').replace(/\u001b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /error/i.test(l)) ?? lines[0] ?? '';
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

export function main({ argv = process.argv.slice(2), run = defaultRun, capture = defaultCapture, readText = (p) => readFileSync(p, 'utf8'), log = console.log } = {}) {
  const skipBuild = argv.includes('--skip-build');
  const dry = argv.includes('--dry-run');
  const configText = readText(`${apiDir}wrangler.jsonc`);
  let plan = planDeploy(configText);

  if (plan.order === 'undecided' && !dry) {
    // Ask first, before anything is built or published: a wrong guess here is the one mistake that matters.
    const answer = capture('npx', ['wrangler', 'd1', 'list', '--json'], apiDir);
    let names;
    try {
      if (answer.status !== 0) throw new Error(describeFailure(answer.stderr, answer.stdout) || `exit ${answer.status}`);
      names = parseDatabaseNames(answer.stdout);
    } catch (err) {
      log(`[deploy] Could not ask Cloudflare which databases exist: ${err.message}`);
      log('[deploy] Check that you are signed in ("npx wrangler login") or that CLOUDFLARE_API_TOKEN (with D1 permission) and CLOUDFLARE_ACCOUNT_ID are set. Nothing was built or deployed.');
      return 1;
    }
    plan = planDeploy(configText, { databaseExists: names.includes(DB_NAME) });
  }

  const steps = [];
  if (!skipBuild) steps.push({ name: 'build the web app', cmd: 'npm', args: ['run', 'build', '-w', '@aminchat/web'], cwd: root });
  const migrate = { name: 'apply D1 migrations (remote)', cmd: 'npx', args: ['wrangler', 'd1', 'migrations', 'apply', DB_NAME, '--remote'], cwd: apiDir };
  const deploy = { name: 'deploy the Worker', cmd: 'npx', args: ['wrangler', 'deploy'], cwd: apiDir };
  steps.push(...(plan.order === 'migrate-first' ? [migrate, deploy] : [deploy, migrate]));

  log(`[deploy] ${plan.why}`);
  if (plan.order === 'undecided') log('[deploy] (dry run: the steps below are in first-deployment order)');
  for (const [i, s] of steps.entries()) {
    log(`[deploy] ${i + 1}/${steps.length} ${s.name}${dry ? ` — ${s.cmd} ${s.args.join(' ')}` : ''}`);
    if (dry) continue;
    const code = run(s.cmd, s.args, s.cwd);
    if (code !== 0) {
      log(`[deploy] "${s.name}" failed (exit ${code}). Nothing after it was run.`);
      return code;
    }
  }
  if (!dry && plan.order === 'deploy-first') {
    log(`[deploy] First deployment finished. From now on the database "${DB_NAME}" is found by its name and migrated before each deploy; saving its id in wrangler.jsonc is optional.`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
