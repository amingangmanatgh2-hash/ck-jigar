import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SLOTS, main, parseBundle } from './load-deploy-env.mjs';

const ACCOUNT = 'c7c787887fc9fab25af0db15ebbf46f5';
const TOKEN = 'cfut_UnitTestTokenAbCdEf0123456789xyz';
const GROQ = 'gsk_UnitTestGroqKey0123456789abcdefghijk';

/** Runs main() against a block of text; returns the log lines, the lines written to the output file and the exit code. */
function run(block, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  const outputFile = join(dir, 'output');
  writeFileSync(outputFile, '');
  const lines = [];
  const code = main({ env: { DEPLOY_ENV: block, ...extra }, log: (l) => lines.push(String(l)), outputFile });
  return { lines, log: lines.join('\n'), output: readFileSync(outputFile, 'utf8'), code };
}

test('the official lines: account id, token and Groq key are picked up', () => {
  const r = parseBundle(`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=${TOKEN}\nGROQ_API_KEY=${GROQ}\n`);
  assert.deepEqual(r.values, { account: ACCOUNT, token: TOKEN, groq: GROQ });
  assert.deepEqual(r.names, ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'GROQ_API_KEY']);
  assert.deepEqual(r.problems, []);
  assert.equal(r.unreadable, 0);
});

test('the ways a person copies lines around: export, quotes, colons, commas, lower case, Windows line breaks, comments, blank lines', () => {
  const block = [
    '# my keys',
    '',
    `export cf_account_id = "${ACCOUNT}"`,
    `"CF_API_TOKEN": "${TOKEN}",`,
    `   groq_api_key: '${GROQ}';   `,
    '// that was all',
  ].join('\r\n');
  const r = parseBundle(block);
  assert.deepEqual(r.values, { account: ACCOUNT, token: TOKEN, groq: GROQ });
  assert.deepEqual(r.problems, []);
});

test('the official name beats its shorter spelling, in either order; for the same name the last line wins', () => {
  const a = parseBundle(`CF_API_TOKEN=cfut_short\nCLOUDFLARE_API_TOKEN=${TOKEN}`);
  const b = parseBundle(`CLOUDFLARE_API_TOKEN=${TOKEN}\nCF_API_TOKEN=cfut_short`);
  assert.equal(a.values.token, TOKEN);
  assert.equal(b.values.token, TOKEN);
  assert.equal(parseBundle('GROQ_API_KEY=gsk_first\nGROQ_API_KEY=gsk_second').values.groq, 'gsk_second');
});

test('a value with a colon or an equals sign inside is cut only at the FIRST separator', () => {
  assert.equal(parseBundle('CF_API_TOKEN=abc:def=ghi').values.token, 'abc:def=ghi');
  assert.equal(parseBundle('CF_API_TOKEN: abc=def').values.token, 'abc=def');
});

test('a line that is not NAME=value is skipped and counted, and its text never comes back (a bare token on its own line)', () => {
  const r = parseBundle(`${TOKEN}\nthis is some prose without a separator\n{"CF_API_TOKEN": "${TOKEN}"}\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}`);
  assert.equal(r.unreadable, 3);
  assert.equal(r.values.account, ACCOUNT);
  assert.equal(r.values.token, '');
  const shown = run(`${TOKEN}\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}`);
  assert.match(shown.log, /1 line\(s\) were not of the form NAME=value and were skipped \(their text is not shown\)/);
  assert.ok(!shown.log.includes(TOKEN) && !shown.output.includes(TOKEN));
});

test('other names are listed (names only) and never used; their values never appear', () => {
  const shown = run(`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=${TOKEN}\nMY_PASSWORD=hunter2hunter2\nandroid_keystore=abcdef123456`);
  assert.match(shown.log, /Other names in it were not used: MY_PASSWORD, ANDROID_KEYSTORE\./);
  assert.ok(!shown.log.includes('hunter2') && !shown.log.includes('abcdef123456'));
  assert.ok(!/MY_PASSWORD|hunter2/.test(shown.output));
});

test('an empty value, or one with spaces or non-ASCII characters, is not used and says so without repeating it', () => {
  const r = parseBundle(`CLOUDFLARE_ACCOUNT_ID=\nCLOUDFLARE_API_TOKEN=cfut_abc def\nGROQ_API_KEY=gsk_کلید`);
  assert.deepEqual(r.values, { account: '', token: '', groq: '' });
  assert.equal(r.problems.length, 3);
  assert.match(r.problems[0], /CLOUDFLARE_ACCOUNT_ID has nothing after the = sign/);
  assert.match(r.problems[1], /CLOUDFLARE_API_TOKEN contains spaces/);
  assert.ok(!r.problems.join('\n').includes('abc def'));
});

test('main: the credentials are masked BEFORE anything else is logged or written; the account id (an identifier) is not masked', () => {
  const r = run(`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=${TOKEN}\nGROQ_API_KEY=${GROQ}`);
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines.slice(0, 2), [`::add-mask::${TOKEN}`, `::add-mask::${GROQ}`]);
  assert.ok(!r.lines.includes(`::add-mask::${ACCOUNT}`));
  assert.equal(r.output, `account=${ACCOUNT}\ntoken=${TOKEN}\ngroq=${GROQ}\n`);
  assert.match(r.log, /recognised CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, GROQ_API_KEY/);
  assert.match(r.log, /Handed on: account id, Cloudflare token, Groq key\./);
  // apart from the two mask commands, no log line carries a credential
  const visible = r.lines.slice(2).join('\n');
  assert.ok(!visible.includes(TOKEN) && !visible.includes(GROQ));
});

test('main: a percent sign in a value is escaped in the mask command, so the mask equals the real value', () => {
  const r = run(`CLOUDFLARE_API_TOKEN=cfut_ab%cd1234567890`);
  assert.ok(r.lines.includes('::add-mask::cfut_ab%25cd1234567890'));
  assert.equal(r.output, 'token=cfut_ab%cd1234567890\n');
});

test('main: no DEPLOY_ENV (or an empty one) is fine: nothing written, exit 0, and the log says why', () => {
  for (const block of [undefined, '', '  \n  ']) {
    const r = run(block);
    assert.equal(r.code, 0);
    assert.equal(r.output, '');
    assert.match(r.log, /There is no DEPLOY_ENV secret/);
  }
});

test('main: a block without the token says exactly what is missing; what is there is still handed on; it never fails the run', () => {
  const r = run(`CF_ACCOUNT_ID=${ACCOUNT}\nCOMMENT=nothing useful`);
  assert.equal(r.code, 0);
  assert.equal(r.output, `account=${ACCOUNT}\n`);
  assert.match(r.log, /::warning title=DEPLOY_ENV::DEPLOY_ENV has no usable Cloudflare token \(a line CLOUDFLARE_API_TOKEN=… or CF_API_TOKEN=…\)/);
  assert.ok(!/no usable account id/.test(r.log), 'what is present is not reported as missing');
  const none = run('just words\nmore words');
  assert.equal(none.code, 0);
  assert.equal(none.output, '');
  assert.match(none.log, /it holds no line with a name this project knows/);
  assert.match(none.log, /DEPLOY_ENV has no usable account id \(a line CLOUDFLARE_ACCOUNT_ID=… or CF_ACCOUNT_ID=…\) and no usable Cloudflare token/);
});

test('main: warnings are escaped for GitHub (percent signs, line breaks) and a value in a problem is never repeated', () => {
  const r = run(`CLOUDFLARE_API_TOKEN=has space ${TOKEN}`);
  assert.ok(!r.log.includes(TOKEN));
  for (const line of r.lines.filter((l) => l.startsWith('::warning'))) assert.ok(!/[\r\n]/.test(line));
});

test('main: an unwritable output file only warns', () => {
  const lines = [];
  const code = main({ env: { DEPLOY_ENV: `CLOUDFLARE_API_TOKEN=${TOKEN}` }, log: (l) => lines.push(l), outputFile: '/nonexistent-dir/definitely/not/here' });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => /::warning title=DEPLOY_ENV::could not hand the values to the next steps/.test(l)));
});

test('the names the block accepts are the ones the workflow and the guide document', () => {
  assert.deepEqual(SLOTS, { account: ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID'], token: ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'], groq: ['GROQ_API_KEY'] });
});
