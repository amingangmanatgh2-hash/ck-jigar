#!/usr/bin/env node
/**
 * Delete Workers by name, from a list in a file (`deploy/CLEANUP`), so the account is not littered with probes.
 *
 * The panel itself is never deleted: its name is refused even if it is listed by accident.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { credentials } from './env.mjs';

const KEEP = new Set(['zeus-panel']);
const listFile = process.argv[2] ?? 'deploy/CLEANUP';
const root = fileURLToPath(new URL('../', import.meta.url));

const names = readFileSync(`${root}${listFile}`, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

if (names.length === 0) {
  console.log('::notice title=Cleanup::nothing listed');
  process.exit(0);
}

const { accountId, token } = credentials();
if (!accountId || !token) {
  console.log('::error title=Cleanup::no Cloudflare credentials');
  process.exit(1);
}

const deleted = [];
const failed = [];

for (const name of names) {
  if (KEEP.has(name)) {
    console.log(`::warning title=Cleanup::${name} is the panel, it is kept`);
    continue;
  }
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}?force=true`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
    const body = await response.json().catch(() => ({}));
    if (response.ok) deleted.push(name);
    else failed.push(`${name}: ${(body.errors ?? []).map((e) => e.message).join('; ') || `HTTP ${response.status}`}`);
  } catch (err) {
    failed.push(`${name}: ${err.message}`);
  }
}

if (deleted.length) console.log(`::notice title=Deleted::${deleted.join(', ')}`);
if (failed.length) console.log(`::error title=Cleanup failed::${failed.join(' | ').slice(0, 900)}`);
