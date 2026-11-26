import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GROQ_SECRET, NO_R2_CONFIG, RESERVED_USERNAMES, USERNAME_PATTERN, checkAdminUsernames, configWithoutR2, describeFailure, inspectGroqKey, main, parseDatabaseNames, parseJsonc, planDeploy, redact, storeGroqSecret } from './deploy.mjs';

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
function drive({ argv = [], config = unpinned, answer = { status: 0, stdout: listing(), stderr: '' }, exitCodes = {}, env = {}, secretAnswer = { status: 0, stdout: 'Success! Uploaded secret GROQ_API_KEY', stderr: '' }, writeFails = false } = {}) {
  const written = [];
  const events = [];
  const logs = [];
  const secrets = [];
  const code = main({
    argv,
    env,
    readText: () => config,
    writeText: (path, text) => {
      if (writeFails) throw new Error('read-only file system');
      events.push(`write: ${path.replace(/^.*apps\/api\//, 'apps/api/')}`);
      written.push({ path, text });
    },
    log: (m) => logs.push(m),
    capture: (cmd, args, cwd, input) => {
      const line = `${cmd} ${args.join(' ')}`;
      if (args[0] === 'wrangler' && args[1] === 'secret') {
        events.push(`secret: ${line}`);
        secrets.push({ line, cwd, input });
        return typeof secretAnswer === 'function' ? secretAnswer(input) : secretAnswer;
      }
      events.push(`ask: ${line}`);
      return answer;
    },
    run: (cmd, args) => {
      const line = `${cmd} ${args.join(' ')}`;
      events.push(line);
      return exitCodes[line] ?? 0;
    },
  });
  return { code, events, secrets, written, logs: logs.join('\n') };
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


/* ------------------------------------------------------------------------------------------------ Groq: the second AI service */

const KEY = 'gsk_UnitTestKey0123456789abcdefghijklmnop';
const SECRET_PUT = 'secret: npx wrangler secret put GROQ_API_KEY';

test('inspectGroqKey: nothing, a usable key (trimmed), an unusual one, and values no key can be', () => {
  assert.deepEqual(inspectGroqKey({}), { state: 'none' });
  assert.deepEqual(inspectGroqKey({ GROQ_API_KEY: '' }), { state: 'none' }, 'GitHub passes an empty string for a secret that does not exist');
  assert.deepEqual(inspectGroqKey({ GROQ_API_KEY: ' \n\t ' }), { state: 'none' });
  assert.deepEqual(inspectGroqKey({ GROQ_API_KEY: `  ${KEY}\r\n` }), { state: 'ready', key: KEY, unusual: false }, 'the usual copy-paste accident is trimmed, not reported');
  assert.deepEqual(inspectGroqKey({ GROQ_API_KEY: 'abc123' }), { state: 'ready', key: 'abc123', unusual: true });
  for (const value of ['gsk_abc def', 'gsk_abc\ndef', `"${KEY}"`, `'${KEY}'`, 'gsk_ключ']) {
    assert.equal(inspectGroqKey({ GROQ_API_KEY: value }).state, 'broken', JSON.stringify(value));
  }
  assert.equal(inspectGroqKey(undefined).state, 'none');
  assert.equal(inspectGroqKey({ GROQ_API_KEY: 42 }).state, 'none');
});

test('redact removes every occurrence of a secret from a text, and is harmless without one', () => {
  assert.equal(redact(`bad ${KEY} and again ${KEY}`, KEY), 'bad *** and again ***');
  assert.equal(redact('nothing here', KEY), 'nothing here');
  assert.equal(redact('text', ''), 'text');
  assert.equal(redact(undefined, KEY), '');
});

test('Groq: without a key nothing about Groq is touched, and the log says how to turn it on', () => {
  for (const env of [{}, { GROQ_API_KEY: '' }]) {
    const r = drive({ env, answer: { status: 0, stdout: listing('amin-chat-db'), stderr: '' } });
    assert.equal(r.code, 0);
    assert.ok(!r.events.some((e) => e.startsWith('secret:')), 'no secret command is run');
    assert.match(r.logs, /Groq: GROQ_API_KEY is not set, so nothing about Groq was changed/);
    assert.match(r.logs, /A key stored earlier stays in place/);
  }
});

test('Groq: the key is stored AFTER the Worker exists (first deployment: after deploy and migrate; later: after both)', () => {
  const first = drive({ env: { GROQ_API_KEY: KEY } }); // no database yet
  assert.equal(first.code, 0);
  assert.deepEqual(first.events, [`ask: ${LIST_CMD}`, BUILD, DEPLOY, MIGRATE, SECRET_PUT]);
  const later = drive({ env: { GROQ_API_KEY: KEY }, answer: { status: 0, stdout: listing('amin-chat-db'), stderr: '' } });
  assert.deepEqual(later.events, [`ask: ${LIST_CMD}`, BUILD, MIGRATE, DEPLOY, SECRET_PUT]);
  assert.match(later.logs, /the key was stored as the Worker secret GROQ_API_KEY/);
  assert.ok(first.secrets[0].cwd.endsWith('apps/api/'), 'it runs where wrangler.jsonc is, so the right Worker is meant');
});

test('Groq: the key reaches wrangler only on its standard input — never in an argument, an event or a log line', () => {
  const r = drive({ env: { GROQ_API_KEY: `  ${KEY}\n` }, answer: { status: 0, stdout: listing('amin-chat-db'), stderr: '' } });
  assert.equal(r.code, 0);
  assert.equal(r.secrets.length, 1);
  assert.equal(r.secrets[0].input, KEY, 'exactly the key: trimmed, no line break added');
  assert.ok(!r.events.join('\n').includes(KEY), 'not in any command line');
  assert.ok(!r.logs.includes(KEY), 'not in the log');
  assert.ok(!r.logs.includes('UnitTestKey'), 'not even a part of it');
});

test('Groq: a broken key is not stored and does not fail the deployment — it warns, and says what to do', () => {
  for (const [value, words] of [
    ['gsk_abc def', /contains spaces or line breaks/],
    [`"${KEY}"`, /wrapped in quotation marks/],
  ]) {
    const r = drive({ env: { GROQ_API_KEY: value, GITHUB_ACTIONS: 'true' }, answer: { status: 0, stdout: listing('amin-chat-db'), stderr: '' } });
    assert.equal(r.code, 0, 'the Worker is live and works without Groq');
    assert.ok(!r.events.some((e) => e.startsWith('secret:')));
    assert.match(r.logs, words);
    assert.match(r.logs, /::warning title=AMIN CHAT::Groq: GROQ_API_KEY was NOT stored/);
    assert.ok(!r.logs.includes(value.replace(/"/g, '')), 'the broken value is not repeated back either');
  }
});

test('Groq: an unusual-looking key is still stored, with a hint', () => {
  const r = drive({ env: { GROQ_API_KEY: 'abc123-not-a-groq-prefix' }, answer: { status: 0, stdout: listing('amin-chat-db'), stderr: '' } });
  assert.equal(r.secrets.length, 1);
  assert.match(r.logs, /does not start with gsk_/);
});

test('Groq: when storing fails the deployment still counts as done, the warning says the Worker is live, and nothing leaks even if wrangler echoes the key', () => {
  const r = drive({
    env: { GROQ_API_KEY: KEY, GITHUB_ACTIONS: 'true' },
    answer: { status: 0, stdout: listing('amin-chat-db'), stderr: '' },
    secretAnswer: (input) => ({ status: 1, stdout: '', stderr: `\u001b[31m✘ [ERROR] Authentication error [code: 10000] while sending ${input}\u001b[0m` }),
  });
  assert.equal(r.code, 0);
  assert.match(r.logs, /::warning title=AMIN CHAT::Groq: the Worker is live, but GROQ_API_KEY could not be stored \(✘ \[ERROR\] Authentication error \[code: 10000\] while sending \*\*\*\)/);
  assert.match(r.logs, /Workers AI alone/);
  assert.ok(!r.logs.includes(KEY));
  assert.ok(!r.logs.includes('UnitTestKey'));
});

test('Groq: a wrangler that cannot even be started is handled the same way', () => {
  const logs = [];
  const warnings = [];
  const result = storeGroqSecret({
    env: { GROQ_API_KEY: KEY },
    capture: () => {
      throw new Error(`spawn npx ENOENT (${KEY})`);
    },
    log: (m) => logs.push(m),
    warn: (m) => warnings.push(m),
    cwd: '/x',
  });
  assert.equal(result, 'failed');
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes(KEY));
});

test('Groq: nothing is stored when the deployment itself failed (the Worker may not exist)', () => {
  const failedDeploy = drive({ env: { GROQ_API_KEY: KEY }, exitCodes: { [DEPLOY]: 1 } });
  assert.equal(failedDeploy.code, 1);
  assert.ok(!failedDeploy.events.some((e) => e.startsWith('secret:')));
  const failedMigration = drive({ env: { GROQ_API_KEY: KEY }, exitCodes: { [MIGRATE]: 1 } });
  assert.equal(failedMigration.code, 1);
  assert.ok(!failedMigration.events.some((e) => e.startsWith('secret:')));
  const failedBuild = drive({ env: { GROQ_API_KEY: KEY }, exitCodes: { [BUILD]: 2 } });
  assert.equal(failedBuild.code, 2);
  assert.ok(!failedBuild.events.some((e) => e.startsWith('secret:')));
});

test('Groq: --dry-run only describes the step, runs nothing and prints no key', () => {
  const withKey = drive({ argv: ['--dry-run'], env: { GROQ_API_KEY: KEY } });
  assert.equal(withKey.code, 0);
  assert.deepEqual(withKey.events, []);
  assert.match(withKey.logs, /then: store GROQ_API_KEY as a Worker secret/);
  assert.ok(!withKey.logs.includes(KEY));
  const without = drive({ argv: ['--dry-run'] });
  assert.match(without.logs, /Groq: no usable GROQ_API_KEY in the environment, so Groq would be left alone/);
  assert.equal(GROQ_SECRET, 'GROQ_API_KEY');
});

const withR2 = unpinned.replace('"d1_databases"', '"r2_buckets": [{ "binding": "FILES", "bucket_name": "amin-chat-files" }], "durable_objects": { "bindings": [{ "name": "USER_HUB", "class_name": "UserHub" }] }, "d1_databases"');

test('R2 off: the configuration that is published is the real one minus the file bucket, and nothing else changes', () => {
  const text = configWithoutR2(withR2);
  assert.match(text, /^\/\/ GENERATED by scripts\/deploy\.mjs for a deployment WITHOUT R2 file storage/);
  const generated = parseJsonc(text);
  const original = parseJsonc(withR2);
  assert.equal(generated.r2_buckets, undefined);
  assert.ok(original.r2_buckets, 'the fixture does have a bucket');
  const { r2_buckets: _dropped, ...rest } = original;
  assert.deepEqual(generated, rest, 'every other key is kept as it was');
  // the real configuration: no bucket afterwards, everything the Worker needs otherwise is still there
  const real = readFileSync(new URL('../apps/api/wrangler.jsonc', import.meta.url), 'utf8');
  const realGenerated = parseJsonc(configWithoutR2(real));
  const realOriginal = parseJsonc(real);
  assert.ok(realOriginal.r2_buckets?.length > 0, 'the real configuration has the file bucket');
  assert.equal(realGenerated.r2_buckets, undefined);
  for (const key of ['name', 'main', 'compatibility_date', 'assets', 'ai', 'd1_databases', 'durable_objects', 'migrations', 'triggers', 'vars']) {
    assert.deepEqual(realGenerated[key], realOriginal[key], `${key} is unchanged`);
  }
  // a configuration without a bucket is left as it is
  assert.deepEqual(parseJsonc(configWithoutR2(unpinned)), parseJsonc(unpinned));
  // the file name is next to wrangler.jsonc (the paths in it are relative to the file), and git ignores it
  assert.equal(NO_R2_CONFIG, 'wrangler.no-r2.generated.jsonc');
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n');
  assert.ok(ignore.includes(`apps/api/${NO_R2_CONFIG}`), 'the generated file is never committed');
});

test('R2 off (--no-r2, or AMIN_R2=off as the workflow sets it): only "wrangler deploy" uses the generated file; the plan, the build and the migrations are as always', () => {
  for (const how of [{ argv: ['--no-r2'] }, { env: { AMIN_R2: 'off' } }]) {
    for (const answer of [{ status: 0, stdout: listing(), stderr: '' }, { status: 0, stdout: listing('amin-chat-db'), stderr: '' }]) {
      const r = drive({ ...how, config: withR2, answer });
      assert.equal(r.code, 0);
      const exists = answer.stdout.includes('amin-chat-db');
      const DEPLOY_OFF = `${DEPLOY} --config ${NO_R2_CONFIG}`;
      assert.deepEqual(
        r.events,
        exists
          ? [`ask: ${LIST_CMD}`, `write: apps/api/${NO_R2_CONFIG}`, BUILD, MIGRATE, DEPLOY_OFF]
          : [`ask: ${LIST_CMD}`, `write: apps/api/${NO_R2_CONFIG}`, BUILD, DEPLOY_OFF, MIGRATE],
        'first deployment: deploy then migrate; later: migrate then deploy',
      );
      assert.equal(r.written.length, 1);
      assert.ok(r.written[0].path.endsWith(`apps/api/${NO_R2_CONFIG}`));
      assert.equal(parseJsonc(r.written[0].text).r2_buckets, undefined);
      assert.ok(parseJsonc(r.written[0].text).d1_databases, 'the rest of the configuration is in the file');
      assert.match(r.logs, /WARNING: R2 file storage is OFF for this deployment/);
      assert.match(r.logs, /sending files and photos does not/);
      assert.match(r.logs, /then run the deployment again/);
    }
  }
});

test('R2 off: the warning is an annotation on GitHub (and only there); without it nothing changes — the real file, no generated one', () => {
  const inActions = drive({ argv: ['--no-r2'], config: withR2, env: { GITHUB_ACTIONS: 'true' } });
  assert.match(inActions.logs, /::warning title=AMIN CHAT::R2 file storage is OFF/);
  assert.ok(!drive({ argv: ['--no-r2'], config: withR2 }).logs.includes('::warning'));
  for (const env of [{}, { AMIN_R2: '' }, { AMIN_R2: 'on' }, { AMIN_R2: 'OFF ' }]) {
    const r = drive({ config: withR2, env });
    assert.equal(r.code, 0);
    assert.ok(r.events.includes(DEPLOY), `the plain deploy command: ${JSON.stringify(env)}`);
    assert.ok(!r.events.some((e) => e.includes('--config') || e.startsWith('write:')), `nothing generated: ${JSON.stringify(env)}`);
    assert.ok(!/R2 file storage is OFF/.test(r.logs));
    assert.deepEqual(r.written, []);
  }
});

test('R2 off: a dry run only describes it (nothing is written or contacted), and a file that cannot be written stops everything before the build', () => {
  const dry = drive({ argv: ['--dry-run', '--no-r2'], config: withR2 });
  assert.equal(dry.code, 0);
  assert.deepEqual(dry.events, []);
  assert.deepEqual(dry.written, []);
  assert.match(dry.logs, new RegExp(`deploy the Worker — npx wrangler deploy --config ${NO_R2_CONFIG.replace(/\./g, '\\.')}`));
  assert.match(dry.logs, /R2 file storage is OFF/);
  const failing = drive({ argv: ['--no-r2'], config: withR2, writeFails: true });
  assert.equal(failing.code, 1);
  assert.deepEqual(failing.events, [`ask: ${LIST_CMD}`], 'nothing was built or deployed');
  assert.match(failing.logs, /Could not prepare the configuration without R2 \(read-only file system\)\. Nothing was built or deployed\./);
});

test('R2 off: the Groq key is still stored after the deployment, and the key never reaches the generated file or the log', () => {
  const r = drive({ argv: ['--no-r2'], config: withR2, env: { GROQ_API_KEY: KEY }, answer: { status: 0, stdout: listing('amin-chat-db'), stderr: '' } });
  assert.equal(r.code, 0);
  assert.equal(r.secrets.length, 1);
  assert.equal(r.secrets[0].input.trim(), KEY);
  assert.ok(!r.written[0].text.includes(KEY));
  assert.ok(!r.logs.includes(KEY));
  assert.equal(r.events.at(-1), 'secret: npx wrangler secret put GROQ_API_KEY', 'after the deployment');
});

test('the deploy workflow hands the key to the deploy step and prints it nowhere', () => {
  const text = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(text, /GROQ_API_KEY: \$\{\{ secrets\.GROQ_API_KEY \|\| steps\.bundle\.outputs\.groq \}\}/);
  // the only places a secret may appear are `env:` entries — never inside a shell command, where it could be echoed. The forms: the value
  // itself; the value with other accepted spellings of the name (`a || b`: the first that exists wins) and, last of all, what the single
  // DEPLOY_ENV secret provided (`|| steps.bundle.outputs.x`); or a yes/no answer to "does it exist?" (`!= ''`), which carries no value.
  const ENV_ENTRY = [
    /^\s+[A-Z_]+: \$\{\{ secrets\.[A-Z_]+( != ''| \|\| secrets\.[A-Z_]+( \|\| steps\.bundle\.outputs\.[a-z]+)?| \|\| steps\.bundle\.outputs\.[a-z]+)? \}\}\s*$/,
    /^\s+GROQ_PROVIDED: \$\{\{ secrets\.GROQ_API_KEY != '' \|\| steps\.bundle\.outputs\.groq != '' \}\}\s*$/,
  ];
  for (const line of text.split('\n')) {
    if (/\$\{\{ *secrets\./.test(line)) assert.ok(ENV_ENTRY.some((re) => re.test(line)), `secret used outside an env entry: ${line}`);
  }
});

const workflowText = () => readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
/** The text of one step: from its `- name:` line up to the next step. */
function stepOf(text, startOfName) {
  const parts = text.split(/\n(?=      - (?:name|uses|run): )/);
  const hit = parts.filter((p) => p.startsWith(`      - name: ${startOfName}`));
  assert.equal(hit.length, 1, `exactly one step starts with "${startOfName}"`);
  return hit[0];
}

test('the shorter spellings CF_ACCOUNT_ID and CF_API_TOKEN work too, for the preflight and the deployment, and the official names win', () => {
  const text = workflowText();
  for (const name of ['Preflight', 'Deploy (build']) {
    const step = stepOf(text, name);
    assert.match(step, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \|\| secrets\.CF_ACCOUNT_ID \|\| steps\.bundle\.outputs\.account \}\}/);
    assert.match(step, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \|\| secrets\.CF_API_TOKEN \|\| steps\.bundle\.outputs\.token \}\}/);
    assert.match(step, /GROQ_API_KEY: \$\{\{ secrets\.GROQ_API_KEY \|\| steps\.bundle\.outputs\.groq \}\}/);
  }
  const account = stepOf(text, 'Prepare the account');
  assert.match(account, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \|\| secrets\.CF_ACCOUNT_ID \|\| steps\.bundle\.outputs\.account \}\}/);
  assert.match(account, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \|\| secrets\.CF_API_TOKEN \|\| steps\.bundle\.outputs\.token \}\}/);
  assert.ok(!/GROQ/.test(account), 'registering an address has nothing to do with Groq: the key is not handed to it');
});

test('the workflow registers the address after the tests and before the deploy, hands "r2=off" from the preflight to the deploy, and says what went wrong when the registration fails', () => {
  const text = workflowText();
  const at = (needle) => text.indexOf(needle);
  // order: preflight → tests → account → deploy → address → smoke test
  assert.ok(at('id: preflight') < at('id: tests') && at('id: tests') < at('id: account') && at('id: account') < at('id: deploy') && at('id: deploy') < at('id: address'));
  const account = stepOf(text, 'Prepare the account');
  assert.match(account, /\n {8}id: account\n/);
  assert.match(account, /\n {8}if: steps\.ask\.outputs\.mode == 'deploy'\n/, 'only in a deploy run: a "check" run changes nothing in the account');
  assert.match(account, /npm run prepare:account 2>&1 \| tee account\.log/);
  assert.match(account, /set -o pipefail/);
  // the tests really are a step with an id (the failure report relies on its outcome)
  assert.match(stepOf(text, 'Tests first'), /\n {8}id: tests\n/);
  // what the preflight found about R2 reaches the deploy (which leaves the bucket out) and the report of the live address
  const handed = [...text.matchAll(/\n {10}AMIN_R2: \$\{\{ steps\.preflight\.outputs\.r2 \}\}\n/g)];
  assert.equal(handed.length, 3, 'the deploy step, the address step and the smoke check');
  assert.match(stepOf(text, 'Deploy (build'), /AMIN_R2: \$\{\{ steps\.preflight\.outputs\.r2 \}\}/);
  assert.match(stepOf(text, 'Address of the live service'), /AMIN_R2: \$\{\{ steps\.preflight\.outputs\.r2 \}\}/);
  assert.match(stepOf(text, 'Address of the live service'), /if \[ "\$AMIN_R2" = "off" \]; then/);
  assert.match(stepOf(text, 'Address of the live service'), /::warning title=File storage is off::/);
  // the smoke check: waits long enough for a brand-new address, remembers why each attempt failed, and compares the bucket with the decision
  const smoke = stepOf(text, 'Check that it answers like AMIN CHAT');
  assert.match(smoke, /\n {8}id: smoke\n/);
  assert.match(smoke, /AMIN_R2: \$\{\{ steps\.preflight\.outputs\.r2 \}\}/);
  assert.match(smoke, /for i in \$\(seq 1 30\); do/);
  assert.match(smoke, /curl -sS -o health\.json -w '%\{http_code\}' --max-time 10 /);
  assert.match(smoke, /LAST="HTTP \$CODE \$\(head -c 160 curl\.err/);
  assert.match(smoke, /::error title=The service did not answer::.*\(last: \$LAST\)\. The Worker IS published/);
  assert.match(smoke, /FILES=\$\(jq -r '\.storage\.files' health\.json/);
  assert.match(smoke, /if \[ "\$AMIN_R2" = "off" \] && \[ "\$FILES" = "true" \]; then echo "::warning title=File storage::/);
  assert.match(smoke, /if \[ "\$AMIN_R2" != "off" \] && \[ "\$FILES" = "false" \]; then echo "::warning title=File storage::/);
  assert.match(smoke, /\| File storage \(R2\) \| \$FILES \|/);
  // sign-in under the plan's CPU limit: an UNKNOWN user costs the same hashing as a real one, so it must be answered 401 INVALID_CREDENTIALS;
  // nothing is created; a 5xx/error page fails the run with the way out; a rate limit proves nothing and only warns
  assert.match(smoke, /-X POST -H 'Content-Type: application\/json' --data '\{"username":"smoke_probe_nobody","password":"smoke-probe-not-a-password"\}' "\$\{TARGET%\/\}\/api\/auth\/login"/);
  assert.match(smoke, /if \[ "\$LOGIN" = "401" \] && grep -q 'INVALID_CREDENTIALS' login\.json; then/);
  assert.match(smoke, /elif \[ "\$LOGIN" = "429" \]; then\n\s+echo "::warning title=Sign-in check::/);
  assert.match(smoke, /::error title=Sign-in does not work::an unknown user got HTTP \$LOGIN instead of 401/);
  assert.match(smoke, /lower PASSWORD_HASH_ITERATIONS in apps\/api\/wrangler\.jsonc \(now 20000, never below 10000\)/);
  assert.match(smoke, /FAILED\*\* \(HTTP \$LOGIN\)\. See the error annotation\."; \} >> "\$GITHUB_STEP_SUMMARY"\n\s+exit 1\n\s+fi\n\s+exit 0/, 'a failed sign-in check fails the run (the exit 1 is inside that branch)');
  assert.match(smoke, /curl -sS -o login\.json -w '%\{http_code\}' --max-time 20 -X POST/, 'the probe has a deadline');
  assert.ok(smoke.indexOf('title=Sign-in check') > smoke.indexOf('/api/auth/login'));
  // the probe must stay harmless: the one username it uses is not one anybody could register as an administrator, and it creates nothing
  assert.ok(!/\/api\/auth\/register/.test(smoke), 'the smoke check never registers anybody');
  assert.ok(USERNAME_PATTERN.test('smoke_probe_nobody'));
  assert.ok(!RESERVED_USERNAMES.includes('smoke_probe_nobody'));
  // the number the message quotes is the real setting, and 10000 is the real floor
  const config = readFileSync(new URL('../apps/api/wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(config, /"PASSWORD_HASH_ITERATIONS": "20000"/);
  // the report of failures: "Tests failed" only when the tests failed; the account step has its own message
  const wrong = stepOf(text, 'What went wrong');
  assert.match(wrong, /DEPLOY_OUTCOME: \$\{\{ steps\.deploy\.outcome \}\}/);
  assert.match(wrong, /if \[ "\$DEPLOY_OUTCOME" = "failure" \] && \[ -s deploy\.log \]; then say "Deploy failed"/, 'a failed smoke check is not "Deploy failed"');
  assert.match(wrong, /TESTS_OUTCOME: \$\{\{ steps\.tests\.outcome \}\}/);
  assert.match(wrong, /\[ "\$TESTS_OUTCOME" = "failure" \] && \[ -s test\.log \] && ! \[ -s deploy\.log \]; then say "Tests failed"/);
  assert.match(wrong, /\[ -s account\.log \] && ! \[ -s deploy\.log \] && \[ "\$TESTS_OUTCOME" != "failure" \]; then say "Nothing was published"/);
  // the script the step runs, and the one place the preflight writes the output
  assert.ok(readFileSync(new URL('./prepare-account.mjs', import.meta.url), 'utf8').includes('export async function main'));
  assert.match(readFileSync(new URL('./preflight.mjs', import.meta.url), 'utf8'), /appendFileSync\(outputFile, 'r2=off\\n'\)/);
  // the header of the workflow no longer asks the person to do these two things by hand
  const header = text.slice(0, text.indexOf('\nname: Deploy to Cloudflare'));
  assert.match(header, /Prepare the account/);
  assert.match(header, /WITHOUT file\s+# storage/);
  assert.ok(!/subscribe to R2 \(Storage & databases > R2 > Overview > checkout/.test(header), 'R2 is no longer a required first step');
});

test('GitHub refuses to run a workflow that dumps the whole secrets context ("may be malicious … will not run until someone approves it"), so none does', () => {
  // This really happened: a step with `toJSON(secrets)` (to list the secret NAMES) made GitHub hold the run back for manual approval.
  const text = workflowText();
  assert.ok(!/toJSON\(\s*secrets\s*\)/i.test(text), 'the whole secrets context must not be read');
  assert.ok(!/secrets\[/.test(text), 'secrets are asked for by name, one by one');
  assert.ok(!/\benv\b[^\n]*\|\s*(base64|xxd|od)\b|printenv\s*\|/.test(text), 'the environment is not piped anywhere');
});

test('one secret named DEPLOY_ENV can hold all the lines: read by a script, in deploy runs only, handed on as step outputs, behind the separate secrets', () => {
  const text = workflowText();
  const step = stepOf(text, 'Read the optional single secret DEPLOY_ENV');
  assert.match(step, /\n {8}id: bundle\n/);
  assert.match(step, /\n {8}if: steps\.ask\.outputs\.mode == 'deploy'\n/);
  assert.match(step, /\n {8}env:\n {10}DEPLOY_ENV: \$\{\{ secrets\.DEPLOY_ENV \}\}\n {8}run: node scripts\/load-deploy-env\.mjs\n?$/);
  // it runs after the plan and before the preflight, which is the first user of what it provides
  assert.ok(text.indexOf('id: bundle') < text.indexOf('id: preflight'));
  assert.ok(text.indexOf('npm run deploy -- --dry-run') < text.indexOf('id: bundle'));
  // what the block provided is only ever used in an `env:` entry (never inside a script), and is always the LAST alternative
  for (const line of text.split('\n')) {
    if (!line.includes('steps.bundle.outputs')) continue;
    assert.match(line, /^\s+[A-Z_]+: \$\{\{ .*\}\}\s*$/, `the block's values must stay in env entries: ${line}`);
    if (line.includes('secrets.') && !line.includes('!=')) assert.match(line, /\|\| steps\.bundle\.outputs\.[a-z]+ \}\}\s*$/, `separate secrets win over the block: ${line}`);
  }
  // the script file the step runs exists
  assert.ok(readFileSync(new URL('./load-deploy-env.mjs', import.meta.url), 'utf8').includes('GITHUB_OUTPUT'));
});

test('after a failed preflight the run says, per name, whether a secret exists — a yes or no, never a value — and only then, never in a "check" run', () => {
  const text = workflowText();
  const step = stepOf(text, 'Which secrets does this run see?');
  // only after the preflight failed (in a "check" run the preflight is skipped, so these secrets are not even looked at there)
  assert.match(step, /\n {8}if: failure\(\) && steps\.preflight\.outcome == 'failure'\n/);
  assert.match(stepOf(text, 'Preflight'), /\n {8}if: steps\.ask\.outputs\.mode == 'deploy'\n/);
  // every flag is `S_<NAME>: ${{ secrets.<NAME> != '' }}` for the same NAME: a boolean, which carries no value
  const flags = [...step.matchAll(/\n {10}S_([A-Z_]+): \$\{\{ secrets\.([A-Z_]+) != '' \}\}/g)];
  assert.ok(flags.length >= 8, 'the plausible spellings are all asked about');
  for (const [, a, b] of flags) assert.equal(a, b);
  assert.equal(step.split('secrets.').length - 1, flags.length, 'secrets appear in nothing but those flags');
  // the script walks exactly the names that have a flag, and compares each flag with the word true
  const loop = step.match(/for n in ([A-Z_ ]+); do/);
  assert.ok(loop, 'the script has its list of names');
  assert.deepEqual(loop[1].trim().split(/\s+/).sort(), flags.map((f) => f[1]).sort());
  assert.match(step, /\[ "\$\(printenv "S_\$n"\)" = "true" \]/);
  // the names the project accepts are all in the list
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'GROQ_API_KEY']) assert.ok(loop[1].split(/\s+/).includes(name), name);
});

test('Cloudflare credentials pasted with a line break or spaces are trimmed for the commands that follow, and never printed', () => {
  const env = { CLOUDFLARE_API_TOKEN: 'cfut_SecretTokenValue123\n', CLOUDFLARE_ACCOUNT_ID: '  c7c787887fc9fab25af0db15ebbf46f5 ' };
  const r = drive({ env, answer: { status: 0, stdout: listing('amin-chat-db'), stderr: '' } });
  assert.equal(r.code, 0);
  assert.equal(env.CLOUDFLARE_API_TOKEN, 'cfut_SecretTokenValue123');
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, 'c7c787887fc9fab25af0db15ebbf46f5');
  assert.match(r.logs, /CLOUDFLARE_API_TOKEN had spaces or a line break around it/);
  assert.match(r.logs, /CLOUDFLARE_ACCOUNT_ID had spaces or a line break around it/);
  assert.ok(!r.logs.includes('SecretTokenValue') && !r.logs.includes('c7c787887'));
  // values that need no trimming are left alone and not mentioned
  const clean = drive({ env: { CLOUDFLARE_API_TOKEN: 'cfut_x', CLOUDFLARE_ACCOUNT_ID: 'abc' }, answer: { status: 0, stdout: listing('amin-chat-db'), stderr: '' } });
  assert.ok(!/had spaces/.test(clean.logs));
});
