import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RESERVED_USERNAMES, USERNAME_PATTERN, checkAdminUsernames, describeFailure, main, parseDatabaseNames, parseJsonc, planDeploy } from './deploy.mjs';

const unpinned = `{
  // comment with "quotes" and a url http://x
  "d1_databases": [ { "binding": "DB", "database_name": "amin-chat-db", "migrations_dir": "migrations", }, ], /* block */
}`;
const pinned = unpinned.replace('"migrations_dir"', '"database_id": "1234-abcd", "migrations_dir"');

const withAdmins = (value) => unpinned.replace('"d1_databases"', `"vars": { "ADMIN_USERNAMES": ${JSON.stringify(value)} }, "d1_databases"`);

const LIST_CMD = 'npx wrangler d1 list --json';
const BUILD = 'npm run build -w @aminchat/web';
const DEPLOY = 'npx wrangler deploy';
const MIGRATE = 'npx wrangler d1 migrations apply amin-chat-db --remote';

const listing = (...names) => JSON.stringify(names.map((name, i) => ({ uuid: `uuid-${i}`, name, created_at: '2026-11-01T00:00:00Z', version: 'production', num_tables: 3 })), null, 2);

/** Runs main() against fakes and returns what happened, in order. */
function drive({ argv = [], config = unpinned, answer = { status: 0, stdout: listing(), stderr: '' }, exitCodes = {}, env = {} } = {}) {
  const events = [];
  const logs = [];
  const code = main({
    argv,
    env,
    readText: () => config,
    log: (m) => logs.push(m),
    capture: (cmd, args) => {
      events.push(`ask: ${cmd} ${args.join(' ')}`);
      return answer;
    },
    run: (cmd, args) => {
      const line = `${cmd} ${args.join(' ')}`;
      events.push(line);
      return exitCodes[line] ?? 0;
    },
  });
  return { code, events, logs: logs.join('\n') };
}

test('parses JSONC with comments, trailing commas and comment markers inside strings', () => {
  assert.deepEqual(parseJsonc('{"a": "x // not a comment", /* c */ "b": [1,2,],}'), { a: 'x // not a comment', b: [1, 2] });
});

test('the real wrangler.jsonc parses; without a saved id the order is chosen at run time', () => {
  const text = readFileSync(new URL('../apps/api/wrangler.jsonc', import.meta.url), 'utf8');
  assert.ok(['undecided', 'migrate-first'].includes(planDeploy(text).order));
});

test('planDeploy: a saved id or an existing database means migrate first; a missing one means deploy first', () => {
  assert.equal(planDeploy(pinned).order, 'migrate-first');
  assert.equal(planDeploy(pinned, { databaseExists: false }).order, 'migrate-first', 'a saved id proves it exists');
  assert.equal(planDeploy(unpinned, { databaseExists: true }).order, 'migrate-first');
  assert.equal(planDeploy(unpinned, { databaseExists: false }).order, 'deploy-first');
  assert.equal(planDeploy(unpinned).order, 'undecided');
});

test('refuses a config without the DB binding', () => {
  assert.throws(() => planDeploy('{"d1_databases": []}'), /no D1 binding/);
});

test('parseDatabaseNames reads wrangler’s JSON, also with log lines around it, and rejects anything else', () => {
  assert.deepEqual(parseDatabaseNames(listing('a', 'amin-chat-db')), ['a', 'amin-chat-db']);
  assert.deepEqual(parseDatabaseNames('[]'), []);
  assert.deepEqual(parseDatabaseNames(`Cloudflare collects anonymous telemetry\n${listing('x')}\n(done)`), ['x']);
  assert.deepEqual(parseDatabaseNames('[{"uuid":"1"},{"name":42},{"name":"ok"}]'), ['ok'], 'entries without a text name are ignored');
  for (const bad of ['', 'not json', '{"name":"amin-chat-db"}', '[1, 2', 'Authentication error [code: 10000]']) {
    assert.throws(() => parseDatabaseNames(bad), undefined, JSON.stringify(bad));
  }
});

test('FIRST deployment (no such database): build, deploy, then migrate — after asking Cloudflare', () => {
  const r = drive();
  assert.equal(r.code, 0);
  assert.deepEqual(r.events, [`ask: ${LIST_CMD}`, BUILD, DEPLOY, MIGRATE]);
  assert.match(r.logs, /first deployment/);
  assert.match(r.logs, /First deployment finished/);
});

test('LATER deployment in CI (the database exists, no id saved): migrate first, then deploy', () => {
  const r = drive({ argv: ['--skip-build'], answer: { status: 0, stdout: listing('something-else', 'amin-chat-db'), stderr: '' } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.events, [`ask: ${LIST_CMD}`, MIGRATE, DEPLOY]);
  assert.match(r.logs, /already exists/);
});

test('a database whose name only looks like ours does not count', () => {
  const r = drive({ argv: ['--skip-build'], answer: { status: 0, stdout: listing('amin-chat-db-old', 'my-amin-chat-db', 'AMIN-CHAT-DB'), stderr: '' } });
  assert.deepEqual(r.events, [`ask: ${LIST_CMD}`, DEPLOY, MIGRATE]);
});

test('a saved id needs no question: migrate first', () => {
  const r = drive({ argv: ['--skip-build'], config: pinned });
  assert.deepEqual(r.events, [MIGRATE, DEPLOY]);
});

test('when Cloudflare cannot be asked, NOTHING is built or deployed, and the message says what to check', () => {
  const r = drive({ answer: { status: 1, stdout: '', stderr: '\n✘ [ERROR] A request to the Cloudflare API (/accounts/x/d1/database) failed.\n  Authentication error [code: 10000]\n' } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.events, [`ask: ${LIST_CMD}`]);
  assert.match(r.logs, /Could not ask Cloudflare which databases exist: ✘ \[ERROR\] A request to the Cloudflare API/);
  assert.match(r.logs, /CLOUDFLARE_API_TOKEN/);
  assert.match(r.logs, /Nothing was built or deployed/);
});

test('an answer that is not a database list is not mistaken for “no database”', () => {
  const r = drive({ answer: { status: 0, stdout: 'Proxy environment variables detected.\n', stderr: '' } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.events, [`ask: ${LIST_CMD}`], 'a garbled answer must not start a FIRST deployment');
});

test('stops at the first failing step and reports its exit code (a failed migration leaves the old code running)', () => {
  const r = drive({ argv: ['--skip-build'], answer: { status: 0, stdout: listing('amin-chat-db'), stderr: '' }, exitCodes: { [MIGRATE]: 7 } });
  assert.equal(r.code, 7);
  assert.deepEqual(r.events, [`ask: ${LIST_CMD}`, MIGRATE], 'the new code is NOT deployed on top of an old schema');
  assert.match(r.logs, /failed \(exit 7\)/);
});

test('a failing build stops everything before anything reaches Cloudflare', () => {
  const r = drive({ exitCodes: { [BUILD]: 2 } });
  assert.equal(r.code, 2);
  assert.deepEqual(r.events, [`ask: ${LIST_CMD}`, BUILD]);
});

test('--dry-run asks nothing and runs nothing, and says that the order is chosen when it runs', () => {
  const r = drive({ argv: ['--dry-run'] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.events, []);
  assert.match(r.logs, /chosen when this runs/);
  assert.match(r.logs, /npx wrangler deploy/);
});

test('--dry-run with a saved id shows the real order', () => {
  const r = drive({ argv: ['--dry-run', '--skip-build'], config: pinned });
  assert.deepEqual(r.events, []);
  assert.ok(r.logs.indexOf('migrations apply') < r.logs.indexOf('wrangler deploy'), r.logs);
});

test('describeFailure shows the line that explains the problem, without terminal colour codes', () => {
  const stderr = '\u001b[33m▲ \u001b[43;33m[\u001b[43;30mWARNING\u001b[43;33m]\u001b[0m telemetry notice\n\n\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mAuthentication error [code: 10000]\u001b[0m\n';
  assert.equal(describeFailure(stderr, ''), '✘ [ERROR] Authentication error [code: 10000]');
  assert.equal(describeFailure('', 'only a plain line'), 'only a plain line');
  assert.equal(describeFailure('', ''), '');
  assert.ok(describeFailure('x'.repeat(1000)).length <= 300);
});

test('checkAdminUsernames: who can ever become administrator', () => {
  const check = (value) => checkAdminUsernames(withAdmins(value));
  assert.deepEqual(check('my_boss'), { names: ['my_boss'], usable: ['my_boss'], dead: [] });
  assert.deepEqual(check(' My_Boss , other_one ,'), { names: ['My_Boss', 'other_one'], usable: ['My_Boss', 'other_one'], dead: [] });
  assert.deepEqual(check('a'.repeat(32)).usable, ['a'.repeat(32)], '32 characters is the longest username');
  assert.deepEqual(check(''), { names: [], usable: [], dead: [] });
  // reserved names (any case) and malformed ones can never be registered
  for (const bad of ['admin', 'Root', 'AMINAI', 'aminchat', 'ab', '1abc', 'has-dash', 'with space', '\u0646\u0627\u0645', 'a'.repeat(33)]) {
    const r = check(bad);
    assert.deepEqual(r.usable, [], `${bad} must not count as a usable administrator name`);
    assert.deepEqual(r.dead, [bad]);
  }
  assert.deepEqual(check('admin, my_boss'), { names: ['admin', 'my_boss'], usable: ['my_boss'], dead: ['admin'] });
});

test('checkAdminUsernames: a config without the setting is left alone', () => {
  assert.equal(checkAdminUsernames(unpinned), null);
  assert.equal(checkAdminUsernames('{"vars": {}}'), null);
});

test('the reserved names and the username pattern here are the server’s (packages/shared/src/constants.ts)', () => {
  const text = readFileSync(new URL('../packages/shared/src/constants.ts', import.meta.url), 'utf8');
  const list = /RESERVED_USERNAMES = \[([\s\S]*?)\];/.exec(text);
  assert.ok(list, 'RESERVED_USERNAMES not found in constants.ts');
  assert.deepEqual([...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]), RESERVED_USERNAMES);
  const pattern = /USERNAME_REGEX = \/(.+)\/;/.exec(text);
  assert.ok(pattern, 'USERNAME_REGEX not found in constants.ts');
  assert.equal(USERNAME_PATTERN.source, pattern[1]);
});

test('the committed wrangler.jsonc does not name an administrator that nobody can register', () => {
  const r = checkAdminUsernames(readFileSync(new URL('../apps/api/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.ok(r, 'ADMIN_USERNAMES must stay in apps/api/wrangler.jsonc (an empty value is allowed)');
  assert.deepEqual(r.dead, [], `ADMIN_USERNAMES has names nobody can register: ${r.dead.join(', ')}`);
});

test('an ADMIN_USERNAMES that nobody can register stops everything before Cloudflare is even asked', () => {
  const r = drive({ config: withAdmins('admin') });
  assert.equal(r.code, 1);
  assert.deepEqual(r.events, [], 'nothing asked, nothing built, nothing deployed');
  assert.match(r.logs, /ADMIN_USERNAMES in apps\/api\/wrangler\.jsonc is "admin", and nobody can register that/);
  assert.match(r.logs, /Nothing was built or deployed/);
  assert.match(r.logs, /\u0646\u0627\u0645 \u0645\u062f\u06cc\u0631/, 'a Persian explanation too');
  assert.equal(drive({ config: withAdmins('root, Support'), argv: ['--dry-run'] }).code, 1, 'also on the dry run that the workflow shows first');
});

test('an empty ADMIN_USERNAMES only warns (and becomes an annotation on GitHub); a usable name is silent', () => {
  const empty = drive({ config: withAdmins('') });
  assert.equal(empty.code, 0);
  assert.match(empty.logs, /WARNING: ADMIN_USERNAMES in apps\/api\/wrangler\.jsonc is empty/);
  assert.doesNotMatch(empty.logs, /::warning/);
  assert.match(drive({ config: withAdmins(''), env: { GITHUB_ACTIONS: 'true' } }).logs, /::warning title=AMIN CHAT::ADMIN_USERNAMES in apps\/api\/wrangler\.jsonc is empty/);
  const good = drive({ config: withAdmins('my_boss'), env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(good.code, 0);
  assert.doesNotMatch(good.logs, /WARNING|::warning/);
  const mixed = drive({ config: withAdmins('admin, my_boss') });
  assert.equal(mixed.code, 0, 'one usable name is enough to deploy');
  assert.match(mixed.logs, /WARNING: these ADMIN_USERNAMES entries can never be registered and do nothing: admin/);
});
