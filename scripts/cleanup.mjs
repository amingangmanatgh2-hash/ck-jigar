#!/usr/bin/env node
/**
 * Delete Workers by name, from a list in a file (`deploy/CLEANUP`), so the account is not littered with probes.
 *
 * The panel itself is never deleted: its name is refused even if it is listed by accident.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { credentials } from './env.mjs';

const KEEP = new Set(['zeus']);
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

/** `zeus-fresh-*` style patterns, matched against the Workers the account really has. */
let existing = [];
try {
  const listed = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/services`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((response) => response.json());
  existing = (listed.result ?? []).map((service) => service.name ?? service.id).filter(Boolean);
} catch {
  existing = [];
}

const targets = new Set();
for (const entry of names) {
  if (!entry.includes('*')) {
    targets.add(entry);
    continue;
  }
  const pattern = new RegExp(`^${entry.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  for (const name of existing) if (pattern.test(name)) targets.add(name);
}

for (const name of targets) {
  if (KEEP.has(name)) {
    console.log(`::warning title=Cleanup::${name} is the panel, it is kept`);
    continue;
  }
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/services/${name}?force=true`,
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

// what is actually left in the account
try {
  const listed = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/services`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((response) => response.json());
  const remaining = (listed.result ?? []).map((service) => service.name ?? service.id);
  console.log(`::notice title=Workers in the account::${remaining.join(', ') || '(none listed)'}`);
} catch (err) {
  console.log(`::warning title=Cleanup::could not list the remaining Workers: ${err.message}`);
}
if (failed.length) console.log(`::error title=Cleanup failed::${failed.join(' | ').slice(0, 900)}`);
