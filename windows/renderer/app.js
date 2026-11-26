'use strict';

/** The window: a list of configs, one button that connects, and the small things around them. */

const T = {
  fa: {
    tagline: 'کانفیگ‌های سریع',
    configs: 'کانفیگ‌ها',
    add: 'افزودن',
    addTitle: 'افزودن کانفیگ',
    addHint: 'لینک vless:// (یا trojan:// و ss://) را بچسبانید. چند لینک در چند خط هم قابل قبول است.',
    save: 'ذخیره',
    cancel: 'انصراف',
    sub: 'لینک اشتراک',
    subTitle: 'لینک اشتراک',
    subHint: 'آدرس لینک اشتراک پنل را وارد کنید تا کانفیگ‌ها خودکار اضافه شوند.',
    update: 'به‌روزرسانی',
    log: 'لاگ',
    close: 'بستن',
    connected: 'متصل',
    disconnected: 'قطع',
    connecting: 'در حال اتصال…',
    pick: 'یک کانفیگ را انتخاب کنید',
    empty: 'هنوز کانفیگی نیست. لینک را بچسبانید یا لینک اشتراک را وارد کنید.',
    added: 'اضافه شد',
    removed: 'حذف شد',
    copied: 'کپی شد',
    bad: 'این لینک درست نیست',
    pingFailed: 'بی‌پاسخ',
    copiedHint: 'کانفیگ کپی شد',
  },
  en: {
    tagline: 'fast configs',
    configs: 'Configs',
    add: 'Add',
    addTitle: 'Add a config',
    addHint: 'Paste a vless:// link (trojan:// and ss:// work too). Several links on several lines are fine.',
    save: 'Save',
    cancel: 'Cancel',
    sub: 'Subscription',
    subTitle: 'Subscription',
    subHint: 'Paste the subscription address from the panel and its configs are added automatically.',
    update: 'Update',
    log: 'Log',
    close: 'Close',
    connected: 'Connected',
    disconnected: 'Not connected',
    connecting: 'Connecting…',
    pick: 'Pick a config, then press the button',
    empty: 'No configs yet. Paste a link or add your subscription.',
    added: 'added',
    removed: 'deleted',
    copied: 'copied',
    bad: 'That is not a usable link',
    pingFailed: 'no answer',
    copiedHint: 'config copied',
  },
};

const $ = (id) => document.getElementById(id);
let lang = localStorage.getItem('zeus.lang') || 'fa';
let state = { configs: [], selected: '', running: false, busy: false, activeId: '', startedAt: 0, message: '' };
const pings = new Map();

const t = (key) => (T[lang] && T[lang][key]) || T.en[key] || key;

function toast(text) {
  const box = $('toast');
  box.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = text;
  box.append(span);
  requestAnimationFrame(() => span.classList.add('show'));
  setTimeout(() => span.classList.remove('show'), 1800);
}

function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
  document.body.dir = lang === 'fa' ? 'rtl' : 'ltr';
  $('tagline').textContent = t('tagline');
  $('listTitle').textContent = t('configs');
  $('addLabel').textContent = t('add');
  $('subLabel').textContent = t('sub');
  $('logLabel').textContent = t('log');
  $('empty').textContent = t('empty');
  $('addTitle').textContent = t('addTitle');
  $('addHint').textContent = t('addHint');
  $('saveLink').textContent = t('save');
  $('subTitle').textContent = t('subTitle');
  $('subHint').textContent = t('subHint');
  $('saveSub').textContent = t('update');
  $('logTitle').textContent = t('log');
  document.querySelectorAll('[data-close]').forEach((button) => (button.textContent = lang === 'fa' ? t('cancel') : t('close')));
  document.querySelectorAll('.chip').forEach((chip) => chip.classList.toggle('on', chip.dataset.lang === lang));
  render();
}

function render() {
  const orb = $('orb');
  const live = !!state.running;
  orb.classList.toggle('live', live);
  orb.classList.toggle('busy', !!state.busy);
  $('powerIcon').textContent = live ? '■' : '⏻';
  $('status').textContent = state.busy ? t('connecting') : live ? t('connected') : t('disconnected');

  const active = state.configs.find((c) => c.id === state.activeId) || state.configs.find((c) => c.id === state.selected);
  $('active').textContent = live && active ? `${active.name} · ${active.host}:${active.port}` : active ? active.name : t('pick');

  const error = $('error');
  if (state.message) {
    error.hidden = false;
    error.textContent = state.message;
  } else {
    error.hidden = true;
  }

  $('count').textContent = String(state.configs.length);
  $('empty').hidden = state.configs.length > 0;

  const list = $('list');
  list.innerHTML = '';
  for (const config of state.configs) {
    const item = document.createElement('li');
    item.className = 'item';
    if (config.id === state.selected) item.classList.add('selected');
    if (live && config.id === state.activeId) item.classList.add('live');

    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = '⚡';

    const body = document.createElement('div');
    body.className = 'body';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = config.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${config.protocol} · ${config.host}:${config.port} · ${config.network}`;
    body.append(title, meta);

    const pingBox = document.createElement('div');
    pingBox.className = 'ping';
    const ms = pings.get(config.id);
    pingBox.textContent = ms === undefined ? '…' : ms < 0 ? t('pingFailed') : `${ms}ms`;
    if (ms !== undefined) pingBox.classList.add(ms >= 0 && ms < 400 ? 'good' : 'bad');

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.title = lang === 'fa' ? 'حذف' : 'delete';
    remove.textContent = '✕';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      state = await window.zeus.removeConfig(config.id);
      render();
      toast(t('removed'));
    });

    item.append(badge, body, pingBox, remove);
    item.addEventListener('click', () => {
      state.selected = config.id;
      render();
    });
    item.addEventListener('dblclick', () => connect(config.id));
    list.append(item);
  }

  measure();
}

/** Ping every config once, slowly, so the list does not hammer anything. */
let measuring = false;
async function measure() {
  if (measuring) return;
  measuring = true;
  for (const config of state.configs) {
    if (pings.has(config.id)) continue;
    const ms = await window.zeus.ping(config.id);
    pings.set(config.id, ms);
    render();
  }
  measuring = false;
}

async function connect(id) {
  const target = id || state.selected || state.configs[0]?.id;
  if (!target) {
    toast(t('empty'));
    return;
  }
  if (state.running) {
    state = { ...state, busy: true };
    render();
    const result = await window.zeus.stop();
    state = { ...state, ...(result.state || {}), busy: false };
    render();
    return;
  }
  state = { ...state, busy: true };
  render();
  const result = await window.zeus.start(target);
  state = { ...state, ...(result.state || {}), busy: false };
  if (!result.ok) toast(result.error || t('bad'));
  render();
}

async function boot() {
  applyLang();
  state = await window.zeus.getState();
  render();

  window.zeus.onState((next) => {
    state = { ...state, ...next, busy: false };
    render();
  });
  window.zeus.onLog(() => {});

  $('power').addEventListener('click', () => connect());

  document.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      lang = chip.dataset.lang;
      localStorage.setItem('zeus.lang', lang);
      applyLang();
    }),
  );

  $('addBtn').addEventListener('click', () => {
    $('linkInput').value = '';
    $('addDialog').showModal();
    $('linkInput').focus();
  });

  $('saveLink').addEventListener('click', async () => {
    const value = $('linkInput').value.trim();
    if (!value) return;
    const result = await window.zeus.addLink(value);
    if (!result.ok) {
      toast(result.error || t('bad'));
      return;
    }
    state = result.state;
    $('addDialog').close();
    toast(`${result.added} ${t('added')}`);
    render();
  });

  $('subBtn').addEventListener('click', () => {
    $('subInput').value = state.subscription || '';
    $('subDialog').showModal();
    $('subInput').focus();
  });

  $('saveSub').addEventListener('click', async () => {
    const url = $('subInput').value.trim();
    if (!url) return;
    $('saveSub').disabled = true;
    const result = await window.zeus.fetchSubscription(url);
    $('saveSub').disabled = false;
    if (!result.ok) {
      toast(result.error || t('bad'));
      return;
    }
    state = result.state;
    $('subDialog').close();
    toast(`${result.added} ${t('added')}`);
    render();
  });

  $('logBtn').addEventListener('click', async () => {
    $('logBody').textContent = (await window.zeus.log()) || '—';
    $('logDialog').showModal();
  });

  document.querySelectorAll('[data-close]').forEach((button) =>
    button.addEventListener('click', () => button.closest('dialog').close()),
  );
}

boot();
