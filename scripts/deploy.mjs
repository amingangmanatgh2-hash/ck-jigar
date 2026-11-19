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

/**
 * Mirror of RESERVED_USERNAMES and USERNAME_REGEX in packages/shared/src/constants.ts (the server's registration rules).
 * This script is plain JavaScript and must not import TypeScript, so deploy.test.mjs fails if the two ever drift apart.
 */
export const RESERVED_USERNAMES = ['aminai', 'amin_ai', 'amin-ai', 'aminchat', 'amin_chat', 'admin', 'administrator', 'root', 'system', 'support', 'moderator', 'ai', 'bot'];
export const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{2,31}$/;

/**
 * Who becomes administrator is decided by ADMIN_USERNAMES (apps/api/wrangler.jsonc): whoever REGISTERS one of those names. A name that
 * nobody can register (reserved, or not 3 to 32 letters/digits/underscores starting with a letter) can never work, and nothing would
 * tell you afterwards: the service runs, it just has no administrator. Returns null when the config has no such setting.
 */
export function checkAdminUsernames(configText) {
  const raw = parseJsonc(configText).vars?.ADMIN_USERNAMES;
  if (raw === undefined) return null;
  const names = (typeof raw === 'string' ? raw : '').split(',').map((n) => n.trim()).filter(Boolean);
  const usable = (n) => USERNAME_PATTERN.test(n) && !RESERVED_USERNAMES.includes(n.toLowerCase());
  return { names, usable: names.filter(usable), dead: names.filter((n) => !usable(n)) };
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

export function main({ argv = process.argv.slice(2), run = defaultRun, capture = defaultCapture, readText = (p) => readFileSync(p, 'utf8'), log = console.log, env = process.env } = {}) {
  const skipBuild = argv.includes('--skip-build');
  const dry = argv.includes('--dry-run');
  const configText = readText(`${apiDir}wrangler.jsonc`);
  let plan = planDeploy(configText);

  const admins = checkAdminUsernames(configText);
  const warn = (text) => {
    log(`[deploy] WARNING: ${text}`);
    if (env.GITHUB_ACTIONS === 'true') log(`::warning title=AMIN CHAT::${text}`); // shown on the run's summary page
  };
  if (admins && admins.names.length > 0 && admins.usable.length === 0) {
    log(`[deploy] ADMIN_USERNAMES in apps/api/wrangler.jsonc is ${admins.names.map((n) => `"${n}"`).join(', ')}, and nobody can register ${admins.names.length > 1 ? 'any of these' : 'that'}: a name must be 3 to 32 letters, digits or _, start with a letter, and not be a reserved one (${RESERVED_USERNAMES.join(', ')}). The service would run but have no administrator. Nothing was built or deployed.`);
    log('[deploy] نام مدیر باید با حرف انگلیسی شروع شود، ۳ تا ۳۲ حرف انگلیسی/عدد/_ باشد و admin یا root و مانند آن نباشد. مقدار ADMIN_USERNAMES را در apps/api/wrangler.jsonc درست کنید.');
    return 1;
  }
  if (admins && admins.names.length === 0) {
    warn('ADMIN_USERNAMES in apps/api/wrangler.jsonc is empty, so nobody will be administrator (no model check, no quotas, no storage page). Put your own username there before the first deployment (docs/deploy.md).');
  } else if (admins && admins.dead.length > 0) {
    warn(`these ADMIN_USERNAMES entries can never be registered and do nothing: ${admins.dead.join(', ')}`);
  }

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
