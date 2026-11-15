#!/usr/bin/env node
/**
 * One-command deployment (`npm run deploy`): build the web app, publish the Worker, apply the D1 migrations — in the
 * order that is safe for the situation:
 *
 *   • FIRST deploy  (wrangler.jsonc has no D1 "database_id" yet): the database does not exist, so the Worker is deployed
 *     first (Wrangler provisions D1 + R2 and writes the ids back into wrangler.jsonc — commit them), then migrated.
 *   • EVERY LATER deploy: migrations first, then the new code. Migrations are additive, so the old code keeps working
 *     while the schema changes and the new code never meets an old schema.
 *
 * `--skip-build` reuses apps/web/dist. `--dry-run` prints the plan without running anything.
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

export function planDeploy(configText) {
  const config = parseJsonc(configText);
  const db = (config.d1_databases ?? []).find((d) => d.binding === 'DB');
  if (!db) throw new Error('wrangler.jsonc has no D1 binding named "DB"');
  const provisioned = typeof db.database_id === 'string' && db.database_id.length > 0;
  return provisioned
    ? { order: 'migrate-first', why: 'the database already exists: migrate first so the new code never meets an old schema' }
    : { order: 'deploy-first', why: 'first deployment: Wrangler creates D1 and R2 during "deploy", so migrations can only run afterwards' };
}

const defaultRun = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1;

export function main({ argv = process.argv.slice(2), run = defaultRun, readText = (p) => readFileSync(p, 'utf8'), log = console.log } = {}) {
  const skipBuild = argv.includes('--skip-build');
  const dry = argv.includes('--dry-run');
  const configPath = `${apiDir}wrangler.jsonc`;
  const plan = planDeploy(readText(configPath));
  const steps = [];
  if (!skipBuild) steps.push({ name: 'build the web app', cmd: 'npm', args: ['run', 'build', '-w', '@aminchat/web'], cwd: root });
  const migrate = { name: 'apply D1 migrations (remote)', cmd: 'npx', args: ['wrangler', 'd1', 'migrations', 'apply', DB_NAME, '--remote'], cwd: apiDir };
  const deploy = { name: 'deploy the Worker', cmd: 'npx', args: ['wrangler', 'deploy'], cwd: apiDir };
  steps.push(...(plan.order === 'migrate-first' ? [migrate, deploy] : [deploy, migrate]));

  log(`[deploy] ${plan.why}`);
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
    const after = planDeploy(readText(configPath));
    if (after.order === 'deploy-first') {
      log('[deploy] Note: wrangler.jsonc still has no "database_id". Run "npx wrangler d1 list" and add the id of amin-chat-db to the D1 binding so later deploys can migrate first.');
    } else {
      log('[deploy] Wrangler wrote the D1 id into apps/api/wrangler.jsonc — commit that file.');
    }
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
