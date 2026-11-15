#!/usr/bin/env node
/**
 * Verifies the REAL Cloudflare Workers AI connection with the exact model ids and request parameters AMIN CHAT uses.
 *
 *   CLOUDFLARE_ACCOUNT_ID=…  CLOUDFLARE_API_TOKEN=…  npm run verify:ai
 *   npm run verify:ai -- --dry-run          # only prints what would be called (no network, no token needed)
 *   npm run verify:ai -- --only gemma       # restrict to model ids containing "gemma"
 *   npm run verify:ai -- --skip-media       # skip the speech-to-text and image models
 *
 * The token needs the "Workers AI" permission (Account → Workers AI → Read/Edit). Calls spend a few neurons of the free
 * allocation. Nothing is stored. Model ids, tuning parameters and response parsers come from apps/api/src/ai (the same code the
 * Worker runs), so a green result here means the Worker's assumptions hold on your account.
 *
 * Exit code 0 = every chat model that the app lists first for its role works; 1 = something the app depends on failed.
 */
import { MODELS, ROLE_PRIORITY } from '../apps/api/src/ai/models.ts';
import { normalizeChatResult, parseStreamData } from '../apps/api/src/ai/normalize.ts';
import { SseParser } from '../apps/api/src/lib/sse.ts';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BASE = (process.env.CLOUDFLARE_API_BASE ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
const DRY = flag('dry-run');
const only = value('only');

const C = process.stdout.isTTY ? { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m' } : { ok: '', bad: '', warn: '', dim: '', off: '' };
const results = [];
function report(status, name, detail = '') {
  results.push({ status, name });
  const tag = status === 'pass' ? `${C.ok}PASS${C.off}` : status === 'fail' ? `${C.bad}FAIL${C.off}` : `${C.warn}${status.toUpperCase()}${C.off}`;
  console.log(`${tag}  ${name}${detail ? `${C.dim}  — ${detail}${C.off}` : ''}`);
}

if (!DRY && (!ACCOUNT || !TOKEN)) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or use --dry-run).');
  process.exit(2);
}

async function call(modelId, body, { stream = false, timeoutMs = 90_000 } = {}) {
  const res = await fetch(`${BASE}/accounts/${ACCOUNT}/ai/run/${modelId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(stream ? { Accept: 'text/event-stream' } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

async function errorText(res) {
  const t = await res.text().catch(() => '');
  try {
    const j = JSON.parse(t);
    return `${res.status} ${(j.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ') || t.slice(0, 200)}`;
  } catch {
    return `${res.status} ${t.slice(0, 200)}`;
  }
}

const probeMessages = [{ role: 'user', content: 'Reply with the single word: ok' }];
const isChat = (m) => m.api === 'chat' || m.api === 'legacy-chat';
const selected = MODELS.filter((m) => !only || m.id.includes(only));
const firstForRole = new Set(Object.values(ROLE_PRIORITY).map((ids) => ids[0]));

/* ------------------------------------------------------------------------------------------------ catalog */
async function checkCatalog() {
  const names = new Set();
  for (let page = 1; page <= 6; page++) {
    const res = await fetch(`${BASE}/accounts/${ACCOUNT}/ai/models/search?per_page=100&page=${page}`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      if (page === 1) return report('skip', 'model catalog', `the catalog endpoint answered ${await errorText(res)}`);
      break;
    }
    const json = await res.json();
    const list = Array.isArray(json.result) ? json.result : [];
    for (const m of list) if (typeof m?.name === 'string') names.add(m.name);
    if (list.length < 100) break;
  }
  if (names.size === 0) return report('skip', 'model catalog', 'the catalog returned no entries');
  report('pass', 'model catalog', `${names.size} models listed`);
  for (const m of selected) {
    names.has(m.id) ? report('pass', `catalog lists ${m.id}`) : report('warn', `catalog lists ${m.id}`, 'not in the catalog of this account — the app marks it unavailable and falls back');
  }
}

/* ------------------------------------------------------------------------------------------------ chat */
async function checkChat(m) {
  const tune = m.tune?.('health') ?? {};
  const body = { messages: probeMessages, max_tokens: 24, ...tune };
  let res = await call(m.id, body);
  let tuned = Object.keys(tune).length > 0;
  if (res.status === 400 && tuned) {
    const why = await errorText(res);
    if (/no such model|5007|not found|does not exist/i.test(why)) {
      return report(firstForRole.has(m.id) ? 'fail' : 'warn', `${m.id}: chat`, `the model does not exist on this account (${why.slice(0, 120)}) — the app marks it unavailable and falls back`);
    }
    report('warn', `${m.id}: tuning parameters`, `rejected (${why.slice(0, 120)}) — the Worker retries without them`);
    res = await call(m.id, { messages: probeMessages, max_tokens: 24 });
    tuned = false;
  } else if (tuned) {
    report('pass', `${m.id}: tuning parameters accepted`, Object.keys(tune).join(', '));
  }
  if (!res.ok) return report(firstForRole.has(m.id) ? 'fail' : 'warn', `${m.id}: chat`, await errorText(res));
  const json = await res.json();
  const out = normalizeChatResult(json.result ?? json);
  out.text.trim()
    ? report('pass', `${m.id}: chat`, `"${out.text.trim().slice(0, 40)}"${out.usage ? `, usage ${out.usage.input}/${out.usage.output} tokens` : ', no usage field (the app estimates)'}`)
    : report(firstForRole.has(m.id) ? 'fail' : 'warn', `${m.id}: chat`, `empty text; raw: ${JSON.stringify(json).slice(0, 200)}`);
}

async function checkStream(m) {
  const tune = m.tune?.('chat') ?? {};
  const body = { messages: [{ role: 'user', content: 'Count from 1 to 5, separated by commas.' }], max_tokens: 60, ...tune, stream: true, ...(m.api === 'chat' ? { stream_options: { include_usage: true } } : {}) };
  let res = await call(m.id, body, { stream: true });
  if (res.status === 400) res = await call(m.id, { ...body, ...Object.fromEntries(Object.keys(tune).map((k) => [k, undefined])), stream_options: undefined }, { stream: true });
  if (!res.ok) return report('fail', `${m.id}: streaming`, await errorText(res));
  const type = res.headers.get('content-type') ?? '';
  if (!/event-stream/i.test(type)) return report('fail', `${m.id}: streaming`, `content-type is "${type}", expected text/event-stream`);
  const parser = new SseParser();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let chunks = 0;
  let usage = false;
  let done = false;
  let firstMs = null;
  const t0 = Date.now();
  for (;;) {
    const { value: v, done: d } = await reader.read();
    if (d) break;
    for (const ev of parser.feed(v instanceof Uint8Array ? v : dec.encode(v))) {
      const piece = parseStreamData(ev.data);
      if (!piece) continue;
      if (piece.error) return report('fail', `${m.id}: streaming`, piece.error);
      if (piece.text) {
        chunks++;
        text += piece.text;
        firstMs ??= Date.now() - t0;
      }
      if (piece.usage) usage = true;
      if (piece.done) done = true;
    }
  }
  chunks > 1 && text.trim()
    ? report('pass', `${m.id}: streaming`, `${chunks} chunks, first token after ${firstMs} ms, usage in stream: ${usage ? 'yes' : 'no (estimated)'}, [DONE]: ${done ? 'yes' : 'no'}`)
    : report(chunks === 1 ? 'warn' : 'fail', `${m.id}: streaming`, chunks === 1 ? 'the answer arrived as a single chunk' : 'no text could be parsed from the stream');
}

/* ------------------------------------------------------------------------------------------------ media */
function silentWav(seconds = 1, rate = 16000) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  return buf;
}

async function checkAsr(m) {
  const res = await call(m.id, { audio: silentWav().toString('base64'), task: 'transcribe', vad_filter: true });
  if (!res.ok) return report('fail', `${m.id}: speech-to-text`, await errorText(res));
  const json = await res.json();
  typeof (json.result ?? json)?.text === 'string'
    ? report('pass', `${m.id}: speech-to-text`, 'accepted base64 audio and returned a "text" field (silence → empty text is expected)')
    : report('fail', `${m.id}: speech-to-text`, `no "text" field; raw: ${JSON.stringify(json).slice(0, 200)}`);
}

async function checkImage(m) {
  const res = await call(m.id, { prompt: 'a small red circle on a white background', steps: 4 });
  if (!res.ok) return report('fail', `${m.id}: image generation`, await errorText(res));
  const type = res.headers.get('content-type') ?? '';
  let bytes;
  if (/application\/json/i.test(type)) {
    const json = await res.json();
    const b64 = (json.result ?? json)?.image;
    if (typeof b64 !== 'string') return report('fail', `${m.id}: image generation`, `no "image" field; raw: ${JSON.stringify(json).slice(0, 200)}`);
    bytes = Buffer.from(b64, 'base64');
  } else bytes = Buffer.from(await res.arrayBuffer());
  const magic = bytes.subarray(0, 4).toString('hex');
  const kind = magic.startsWith('ffd8') ? 'JPEG' : magic === '89504e47' ? 'PNG' : null;
  kind ? report('pass', `${m.id}: image generation`, `${kind}, ${bytes.length} bytes`) : report('fail', `${m.id}: image generation`, `unexpected bytes ${magic}`);
}

/* ------------------------------------------------------------------------------------------------ main */
if (DRY) {
  console.log('Dry run — the following would be called (nothing is sent):\n');
  for (const m of selected) {
    const what = isChat(m) ? 'chat + streaming' : m.api === 'asr' ? 'speech-to-text with 1 s of silence' : 'image generation (4 steps)';
    console.log(`  ${m.id.padEnd(48)} ${what}${m.tune ? `  tune(health)=${JSON.stringify(m.tune('health'))}` : ''}`);
  }
  console.log(`\nFirst choice per role: ${Object.entries(ROLE_PRIORITY).filter(([, ids]) => ids.length).map(([r, ids]) => `${r}=${ids[0]}`).join(', ')}`);
  process.exit(0);
}

console.log(`Checking Workers AI for account ${ACCOUNT.slice(0, 4)}…${ACCOUNT.slice(-4)} (${selected.length} models)\n`);
await checkCatalog().catch((e) => report('skip', 'model catalog', String(e?.message ?? e)));
for (const m of selected) {
  try {
    if (isChat(m)) {
      await checkChat(m);
      if (m.capabilities.streaming && firstForRole.has(m.id)) await checkStream(m);
    } else if (flag('skip-media')) report('skip', `${m.id}`, '--skip-media');
    else if (m.api === 'asr') await checkAsr(m);
    else if (m.api === 'image') await checkImage(m);
  } catch (e) {
    report(firstForRole.has(m.id) ? 'fail' : 'warn', `${m.id}`, String(e?.message ?? e));
  }
}

const failed = results.filter((r) => r.status === 'fail').length;
const warned = results.filter((r) => r.status === 'warn').length;
console.log(`\n${results.filter((r) => r.status === 'pass').length} passed, ${warned} warnings, ${failed} failed`);
process.exit(failed ? 1 : 0);
