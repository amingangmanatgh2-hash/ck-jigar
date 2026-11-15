import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { main, parseJsonc, planDeploy } from './deploy.mjs';

const first = `{
  // comment with "quotes" and a url http://x
  "d1_databases": [ { "binding": "DB", "database_name": "amin-chat-db", "migrations_dir": "migrations", }, ], /* block */
}`;
const later = first.replace('"migrations_dir"', '"database_id": "1234-abcd", "migrations_dir"');

test('parses JSONC with comments, trailing commas and comment markers inside strings', () => {
  assert.deepEqual(parseJsonc('{"a": "x // not a comment", /* c */ "b": [1,2,],}'), { a: 'x // not a comment', b: [1, 2] });
});

test('the real wrangler.jsonc parses and is planned as a first deployment until an id is pinned', () => {
  const text = readFileSync(new URL('../apps/api/wrangler.jsonc', import.meta.url), 'utf8');
  assert.ok(['deploy-first', 'migrate-first'].includes(planDeploy(text).order));
});

test('first deploy: deploy before migrating (the database does not exist yet)', () => {
  assert.equal(planDeploy(first).order, 'deploy-first');
  const ran = [];
  const code = main({ argv: [], run: (cmd, args) => (ran.push(`${cmd} ${args.join(' ')}`), 0), readText: () => first, log: () => {} });
  assert.equal(code, 0);
  assert.deepEqual(ran, ['npm run build -w @aminchat/web', 'npx wrangler deploy', 'npx wrangler d1 migrations apply amin-chat-db --remote']);
});

test('later deploys: migrate before deploying', () => {
  assert.equal(planDeploy(later).order, 'migrate-first');
  const ran = [];
  main({ argv: ['--skip-build'], run: (cmd, args) => (ran.push(`${cmd} ${args.join(' ')}`), 0), readText: () => later, log: () => {} });
  assert.deepEqual(ran, ['npx wrangler d1 migrations apply amin-chat-db --remote', 'npx wrangler deploy']);
});

test('stops at the first failing step and reports its exit code', () => {
  const ran = [];
  const logs = [];
  const code = main({ argv: ['--skip-build'], run: (cmd, args) => (ran.push(args[1] ?? args[0]), ran.length === 1 ? 7 : 0), readText: () => later, log: (m) => logs.push(m) });
  assert.equal(code, 7);
  assert.equal(ran.length, 1); // the migration failed: the new code is NOT deployed on top of an old schema
  assert.match(logs.join('\n'), /failed \(exit 7\)/);
});

test('--dry-run runs nothing', () => {
  let called = 0;
  main({ argv: ['--dry-run'], run: () => (called++, 0), readText: () => later, log: () => {} });
  assert.equal(called, 0);
});

test('asks to pin the database id when wrangler did not write one back', () => {
  const logs = [];
  main({ argv: ['--skip-build'], run: () => 0, readText: () => first, log: (m) => logs.push(m) });
  assert.match(logs.join('\n'), /wrangler d1 list/);
});

test('refuses a config without the DB binding', () => {
  assert.throws(() => planDeploy('{"d1_databases": []}'), /no D1 binding/);
});
