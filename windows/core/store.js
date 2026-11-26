'use strict';

/** The list of configs, kept in one JSON file next to the app's own data. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function dataDir(app) {
  const base = app?.getPath ? app.getPath('userData') : path.join(os.homedir(), '.zeus-lite');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function file(app) {
  return path.join(dataDir(app), 'configs.json');
}

function read(app) {
  try {
    const raw = fs.readFileSync(file(app), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      configs: Array.isArray(parsed.configs) ? parsed.configs : [],
      subscription: typeof parsed.subscription === 'string' ? parsed.subscription : '',
      selected: typeof parsed.selected === 'string' ? parsed.selected : '',
    };
  } catch {
    return { configs: [], subscription: '', selected: '' };
  }
}

function write(app, state) {
  fs.writeFileSync(file(app), JSON.stringify(state, null, 2), 'utf8');
  return state;
}

/** Add or replace (same link → same entry, same id). */
function addConfig(app, profile) {
  const state = read(app);
  const existing = state.configs.find((c) => c.link === profile.link);
  const entry = {
    ...profile,
    id: existing ? existing.id : crypto.randomUUID(),
    addedAt: existing ? existing.addedAt : Date.now(),
  };
  state.configs = [entry, ...state.configs.filter((c) => c.id !== entry.id)];
  state.selected = entry.id;
  write(app, state);
  return { state, entry };
}

function removeConfig(app, id) {
  const state = read(app);
  state.configs = state.configs.filter((c) => c.id !== id);
  if (state.selected === id) state.selected = state.configs[0]?.id || '';
  write(app, state);
  return state;
}

module.exports = { read, write, addConfig, removeConfig, file };
