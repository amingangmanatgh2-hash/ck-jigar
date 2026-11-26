/**
 * The two pages the Worker serves: the admin panel and the page a user opens to see their traffic and links.
 * They are plain HTML with inline CSS/JS on purpose: no build step, no CDN (a CDN is blocked where this is used),
 * and nothing to install. Every text exists in Persian and English.
 */

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Vazirmatn", "IRANSans", Tahoma, sans-serif`;

const CSS = `
:root{
  --bg:#07080f; --bg2:#0d1020; --card:rgba(20,24,44,.72); --line:rgba(120,140,255,.16);
  --text:#eef1ff; --muted:#9aa4c8; --accent:#5b8cff; --accent2:#a855f7; --ok:#22d3a7; --warn:#f5b73c; --bad:#ff5d73;
  --radius:18px;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:${FONT}; color:var(--text); min-height:100vh; background:
    radial-gradient(1100px 600px at 12% -12%, rgba(91,140,255,.25), transparent 60%),
    radial-gradient(900px 520px at 92% 0%, rgba(168,85,247,.22), transparent 55%),
    radial-gradient(700px 500px at 50% 110%, rgba(34,211,167,.12), transparent 60%),
    linear-gradient(180deg, var(--bg), var(--bg2));
  -webkit-font-smoothing:antialiased;
}
body[dir=rtl]{letter-spacing:0}
a{color:var(--accent)}
.wrap{max-width:1120px;margin:0 auto;padding:22px 16px 60px}
.top{display:flex;align-items:center;gap:14px;margin-bottom:22px;flex-wrap:wrap}
.logo{display:flex;align-items:center;gap:11px;font-weight:800;font-size:19px;letter-spacing:.4px}
.mark{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;font-size:19px;
  background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 8px 28px rgba(91,140,255,.45)}
.spacer{flex:1}
.chip{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;font-size:12.5px;
  background:rgba(255,255,255,.05);border:1px solid var(--line);color:var(--muted)}
.chip b{color:var(--text);font-weight:700}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px rgba(34,211,167,.18)}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px;
  backdrop-filter:blur(14px);box-shadow:0 24px 60px rgba(0,0,0,.42)}
.grid{display:grid;gap:16px}
.stats{grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:16px}
.stat{padding:16px 18px}
.stat .k{font-size:12px;color:var(--muted);margin-bottom:8px}
.stat .v{font-size:24px;font-weight:800;letter-spacing:.3px}
.stat .v small{font-size:13px;color:var(--muted);font-weight:600;margin-inline-start:4px}
h2{margin:0 0 4px;font-size:17px}
.sub{color:var(--muted);font-size:13px;margin:0 0 16px}
label{display:block;font-size:12.5px;color:var(--muted);margin:0 0 6px}
input,select,textarea{width:100%;padding:11px 13px;border-radius:12px;background:rgba(8,10,22,.72);
  border:1px solid var(--line);color:var(--text);font:inherit;font-size:14px;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus,textarea:focus{border-color:rgba(91,140,255,.65);box-shadow:0 0 0 4px rgba(91,140,255,.14)}
input[dir=ltr]{text-align:left}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 16px;border-radius:12px;border:1px solid var(--line);
  background:rgba(255,255,255,.05);color:var(--text);font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;transition:transform .12s,filter .15s,background .15s}
.btn:hover{background:rgba(255,255,255,.09)}
.btn:active{transform:translateY(1px)}
.btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:transparent;box-shadow:0 10px 26px rgba(91,140,255,.34)}
.btn.primary:hover{filter:brightness(1.08)}
.btn.ghost{background:transparent}
.btn.danger{color:var(--bad);border-color:rgba(255,93,115,.35)}
.btn.sm{padding:7px 11px;font-size:12.5px;border-radius:10px}
.btn:disabled{opacity:.45;cursor:not-allowed}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.fields{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:start;color:var(--muted);font-weight:600;font-size:12px;padding:10px 8px;border-bottom:1px solid var(--line)}
td{padding:12px 8px;border-bottom:1px solid rgba(120,140,255,.08);vertical-align:middle}
tr:last-child td{border-bottom:0}
.name{font-weight:700}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--muted);direction:ltr;text-align:left}
.bar{height:6px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;min-width:90px}
.bar>i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.bar.warn>i{background:linear-gradient(90deg,var(--warn),var(--bad))}
.tag{display:inline-flex;padding:3px 9px;border-radius:99px;font-size:11.5px;font-weight:700}
.tag.on{background:rgba(34,211,167,.15);color:var(--ok)}
.tag.off{background:rgba(255,93,115,.14);color:var(--bad)}
.tag.exp{background:rgba(245,183,60,.14);color:var(--warn)}
.modal{position:fixed;inset:0;display:none;place-items:center;padding:18px;background:rgba(4,6,14,.72);backdrop-filter:blur(6px);z-index:60}
.modal.open{display:grid}
.modal .card{max-width:560px;width:100%;max-height:88vh;overflow:auto}
.toast{position:fixed;inset-inline:0;bottom:22px;display:flex;justify-content:center;z-index:80;pointer-events:none}
.toast>div{background:#11152b;border:1px solid var(--line);padding:11px 18px;border-radius:12px;font-size:13.5px;
  box-shadow:0 18px 50px rgba(0,0,0,.5);opacity:0;transform:translateY(8px);transition:.2s}
.toast>div.show{opacity:1;transform:none}
.code{background:rgba(8,10,22,.8);border:1px solid var(--line);border-radius:12px;padding:11px 13px;
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.5;direction:ltr;text-align:left;
  word-break:break-all;color:#c8d2ff;max-height:130px;overflow:auto}
.hint{font-size:12px;color:var(--muted);margin-top:6px}
.err{color:var(--bad);font-size:13px;margin-top:10px;min-height:18px}
.center{display:grid;place-items:center;min-height:78vh}
.login{max-width:400px;width:100%}
.login .mark{margin:0 auto 14px;width:52px;height:52px;font-size:26px;border-radius:16px}
.empty{color:var(--muted);text-align:center;padding:26px;font-size:13.5px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media(max-width:720px){
  .hide-sm{display:none}
  .wrap{padding:16px 12px 48px}
  table{font-size:12.5px}
  .stat .v{font-size:21px}
}
`;

/* ------------------------------------------------------------------ admin page */

const ADMIN_JS = String.raw`
const T = {
  fa: {
    signIn:'ورود به پنل', password:'رمز مدیر', wrong:'رمز اشتباه است', unset:'رمز مدیر روی Worker تنظیم نشده است (ADMIN_PASSWORD)',
    users:'کاربران', active:'فعال', traffic:'ترافیک کل', host:'نشانی', create:'کاربر تازه', name:'نام', expiry:'انقضا (روز، خالی = بی‌پایان)',
    limit:'سقف ترافیک (GB، ۰ = بی‌پایان)', save:'ذخیره', cancel:'انصراف', delete:'حذف', enable:'فعال', disable:'خاموش',
    links:'کانفیگ‌ها', reset:'صفر کردن ترافیک', settings:'تنظیمات', copy:'کپی', copied:'کپی شد', none:'هنوز کاربری نساخته‌اید',
    used:'مصرف', of:'از', unlimited:'بی‌پایان', never:'بی‌پایان', expired:'منقضی', logout:'خروج', sub:'لینک اشتراک',
    saved:'ذخیره شد', deleted:'حذف شد', sure:'مطمئن هستید؟', hostHint:'خالی = همان دامنه‌ای که پنل با آن باز شده',
    pathHint:'مسیر WebSocket؛ باید همان باشد که در لینک‌ها می‌آید', cleanHint:'هر خط یک IP سالم؛ برای هر کدام یک کانفیگ ساخته می‌شود',
    fragHint:'مثلاً 1,40-100 برای مقابله با فیلترینگ عمیق؛ خالی = خاموش', echHint:'اختیاری: مقدار ECH از Cloudflare',
    configs:'کانفیگ‌های آماده', xrayHint:'برای Xray/v2rayNG', singboxHint:'برای sing-box / اپ ویندوز',
    changePass:'تغییر رمز', currentPass:'رمز فعلی', newPass:'رمز تازه', passChanged:'رمز عوض شد؛ دوباره وارد شوید',
    defaultPass:'هنوز رمز پیش‌فرض پنل عوض نشده. از دکمه «تغییر رمز» عوضش کنید.',
  },
  en: {
    signIn:'Sign in', password:'Admin password', wrong:'Wrong password', unset:'ADMIN_PASSWORD is not set on the Worker',
    users:'Users', active:'Active', traffic:'Total traffic', host:'Host', create:'New user', name:'Name', expiry:'Expires in (days, empty = never)',
    limit:'Traffic limit (GB, 0 = unlimited)', save:'Save', cancel:'Cancel', delete:'Delete', enable:'Enable', disable:'Disable',
    links:'Configs', reset:'Reset traffic', settings:'Settings', copy:'Copy', copied:'Copied', none:'No users yet',
    used:'used', of:'of', unlimited:'unlimited', never:'never', expired:'expired', logout:'Sign out', sub:'Subscription link',
    saved:'Saved', deleted:'Deleted', sure:'Are you sure?', hostHint:'empty = the domain this panel was opened with',
    pathHint:'the WebSocket path, as it appears in the links', cleanHint:'one IP per line: one config is built for each',
    fragHint:'e.g. 1,40-100 against deep packet inspection; empty = off', echHint:'optional: the ECH value from Cloudflare',
    configs:'Ready-made configs', xrayHint:'for Xray/v2rayNG', singboxHint:'for sing-box / the Windows app',
    changePass:'Change password', currentPass:'Current password', newPass:'New password', passChanged:'Password changed — sign in again',
    defaultPass:'The panel still uses its default password. Change it with the button above.',
  }
};
let L = localStorage.getItem('zeus.lang') || ((navigator.language || '').startsWith('fa') ? 'fa' : 'en');
const t = (k) => (T[L] && T[L][k]) || T.en[k] || k;
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, kids = []) => { const n = document.createElement(tag); for (const [k,v] of Object.entries(attrs)) { if (k === 'text') n.textContent = v; else if (k === 'html') n.innerHTML = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); } for (const c of [].concat(kids)) if (c) n.append(c); return n; };
const fmtBytes = (b) => { b = Number(b)||0; const u=['B','KB','MB','GB','TB']; let i=0; while(b>=1024&&i<u.length-1){b/=1024;i++;} return (b<10&&i>0?b.toFixed(1):Math.round(b))+' '+u[i]; };
const fmtDate = (ms) => { if(!ms) return t('never'); try { return new Date(ms).toLocaleDateString(L==='fa'?'fa-IR':'en-GB'); } catch { return new Date(ms).toISOString().slice(0,10); } };

function toast(msg) {
  const box = $('#toast') || document.body.appendChild(el('div',{class:'toast',id:'toast'}));
  box.textContent = '';
  const inner = el('div',{class:'show',text:msg});
  box.append(inner);
  setTimeout(()=>inner.classList.remove('show'), 1900);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials:'same-origin', headers:{'Content-Type':'application/json'}, ...opts });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || ('HTTP '+res.status));
  return data;
}

function setLang(l) {
  L = l; localStorage.setItem('zeus.lang', l);
  document.documentElement.lang = l;
  document.documentElement.dir = l === 'fa' ? 'rtl' : 'ltr';
  location.reload();
}

async function boot() {
  const root = $('#app');
  try { await api('/api/me'); } catch { return renderLogin(root); }
  renderDashboard(root);
}

function renderLogin(root) {
  root.textContent = '';
  const err = el('div',{class:'err'});
  const input = el('input',{type:'password',id:'pw',autocomplete:'current-password','dir':'ltr',placeholder:'••••••••'});
  const go = async () => {
    err.textContent='';
    try { await api('/api/auth',{method:'POST',body:JSON.stringify({password:input.value})}); location.reload(); }
    catch (e) { err.textContent = e.message.includes('not set') ? t('unset') : t('wrong'); }
  };
  const card = el('div',{class:'card login'},[
    el('div',{class:'mark',text:'Z'}),
    el('h2',{text:t('signIn'),style:'text-align:center'}),
    el('p',{class:'sub',style:'text-align:center',text:'ZEUS LITE'}),
    el('label',{for:'pw',text:t('password')}),
    input, err,
    el('button',{class:'btn primary',style:'width:100%;margin-top:14px',text:t('signIn'),onclick:go}),
    el('div',{class:'row',style:'justify-content:center;margin-top:14px'},[
      el('button',{class:'btn ghost sm',text:'فارسی',onclick:()=>setLang('fa')}),
      el('button',{class:'btn ghost sm',text:'English',onclick:()=>setLang('en')}),
    ])
  ]);
  input.addEventListener('keydown',(e)=>{ if(e.key==='Enter') go(); });
  root.append(el('div',{class:'center'},[card]));
  input.focus();
}

async function renderDashboard(root) {
  root.textContent = '';
  const state = { users: [], settings: null, overview: null };
  const statLine = el('div',{class:'row'});
  const tbody = el('tbody');
  const tableCard = el('div',{class:'card'});

  const header = el('div',{class:'top'},[
    el('div',{class:'logo'},[el('div',{class:'mark',text:'Z'}), el('span',{id:'brand',text:'ZEUS LITE'})]),
    el('div',{class:'spacer'}),
    statLine,
    el('button',{class:'btn ghost sm',text:'فارسی',onclick:()=>setLang('fa')}),
    el('button',{class:'btn ghost sm',text:'EN',onclick:()=>setLang('en')}),
    el('button',{class:'btn sm ghost',text:'🔑 '+t('changePass'),onclick:openPassword}),
    el('button',{class:'btn sm',text:t('logout'),onclick:async()=>{ await api('/api/logout',{method:'POST'}); location.reload(); }}),
  ]);
  const notice = el('div',{class:'card',style:'display:none;margin-bottom:16px;border-color:rgba(245,183,60,.35)'},[
    el('div',{class:'row'},[el('span',{class:'tag exp',text:'!'}), el('div',{text:t('defaultPass'),style:'font-size:13px'})]),
  ]);
  root.append(el('div',{class:'wrap'},[header, notice]));

  const stats = el('div',{class:'grid stats'});
  const usersCard = tableCard;
  usersCard.append(
    el('div',{class:'row',style:'justify-content:space-between;margin-bottom:12px'},[
      el('div',{},[el('h2',{text:t('users')}), el('p',{class:'sub',style:'margin:0',text:''})]),
      el('button',{class:'btn primary sm',text:'＋ '+t('create'),onclick:()=>openCreate()}),
    ]),
    el('div',{style:'overflow:auto'},[el('table',{},[
      el('thead',{},[el('tr',{},[t('name'),t('used'),t('active'),'',''].map((h,i)=>el('th',{class:i>=3?'hide-sm':'',text:h})))]),
      tbody,
    ])]),
  );
  root.append(stats, el('div',{style:'height:16px'}), usersCard);

  async function reload() {
    const [users, overview, settings] = await Promise.all([api('/api/users'), api('/api/overview'), api('/api/settings')]);
    state.users = users.users; state.overview = overview; state.settings = settings.settings;
    if (settings.settings.title) { document.title = settings.settings.title; $('#brand').textContent = settings.settings.title; }
    notice.style.display = overview.usingDefaultPassword ? 'block' : 'none';
    renderStats(); renderTable();
  }

  function renderStats() {
    stats.textContent = '';
    const s = state.overview;
    const mk = (k,v,extra) => el('div',{class:'card stat'},[el('div',{class:'k',text:k}), el('div',{class:'v'},[document.createTextNode(v), extra?el('small',{text:extra}):null])]);
    stats.append(
      mk(t('users'), String(s.users)),
      mk(t('active'), String(s.active)),
      mk(t('traffic'), fmtBytes(s.traffic)),
      mk(t('host'), '', ''),
    );
    const last = stats.lastChild.querySelector('.v');
    last.textContent = s.host || '—';
    last.style.fontSize = '15px';
    last.style.direction = 'ltr';
    last.style.wordBreak = 'break-all';
    statLine.textContent='';
  }

  function renderTable() {
    tbody.textContent = '';
    if (state.users.length === 0) {
      tbody.append(el('tr',{},[el('td',{colspan:'5'},[el('div',{class:'empty',text:t('none')})])]));
      return;
    }
    for (const u of state.users) {
      const limit = Number(u.traffic_limit) || 0;
      const pct = limit ? Math.min(100, Math.round((u.traffic_used / limit) * 100)) : 0;
      const expired = u.expires_at && u.expires_at < Date.now();
      const tag = !u.enabled ? el('span',{class:'tag off',text:t('disable')}) : expired ? el('span',{class:'tag exp',text:t('expired')}) : el('span',{class:'tag on',text:t('active')});
      const bar = el('div',{class:'bar'+(pct>85?' warn':'')},[el('i',{style:'width:'+(limit?pct:8)+'%'})]);
      tbody.append(el('tr',{},[
        el('td',{},[el('div',{class:'name',text:u.name}), el('div',{class:'mono',text:u.uuid})]),
        el('td',{},[bar, el('div',{class:'hint',text:fmtBytes(u.traffic_used)+(limit?' / '+fmtBytes(limit):' · '+t('unlimited'))})]),
        el('td',{},[tag, el('div',{class:'hint',text:fmtDate(u.expires_at)})]),
        el('td',{class:'hide-sm'},[el('div',{class:'row gap'},[
          el('button',{class:'btn sm',text:t('links'),onclick:()=>openLinks(u)}),
          el('button',{class:'btn sm ghost',text:u.enabled?t('disable'):t('enable'),onclick:async()=>{ await api('/api/users/'+u.id,{method:'PATCH',body:JSON.stringify({enabled:!u.enabled})}); reload(); }}),
        ])]),
        el('td',{class:'hide-sm'},[el('div',{class:'row gap'},[
          el('button',{class:'btn sm ghost',text:t('reset'),onclick:async()=>{ await api('/api/users/'+u.id,{method:'PATCH',body:JSON.stringify({resetTraffic:true})}); toast(t('saved')); reload(); }}),
          el('button',{class:'btn sm danger',text:t('delete'),onclick:async()=>{ if(!confirm(t('sure'))) return; await api('/api/users/'+u.id,{method:'DELETE'}); toast(t('deleted')); reload(); }}),
        ])]),
      ]));
    }
  }

  function modal(title, bodyNodes, primary) {
    const footer = el('div',{class:'row',style:'justify-content:flex-end;margin-top:16px'},[
      primary ? el('button',{class:'btn primary',text:primary.label,onclick:primary.onclick}) : null,
      el('button',{class:'btn',text:t('cancel'),onclick:()=>m.remove()}),
    ]);
    const m = el('div',{class:'modal open'},[el('div',{class:'card'},[
      el('h2',{text:title}), el('div',{style:'height:12px'}),
      ...[].concat(bodyNodes),
      footer
    ])]);
    document.body.append(m);
    m.addEventListener('click',(e)=>{ if(e.target===m) m.remove(); });
    return m;
  }

  function openCreate() {
    const name = el('input',{placeholder:'ali'});
    const days = el('input',{type:'number',min:'1',placeholder:'30','dir':'ltr'});
    const limit = el('input',{type:'number',min:'0',placeholder:'50','dir':'ltr'});
    const m = modal(t('create'),[
      el('label',{text:t('name')}), name,
      el('div',{style:'height:12px'}),
      el('label',{text:t('expiry')}), days,
      el('div',{style:'height:12px'}),
      el('label',{text:t('limit')}), limit,
    ], { label: t('save'), onclick: async () => {
      try {
        await api('/api/users',{method:'POST',body:JSON.stringify({
          name: name.value,
          expiresAt: days.value ? Date.now()+Number(days.value)*86400000 : null,
          trafficLimit: limit.value ? Math.round(Number(limit.value)*1024**3) : 0,
        })});
        m.remove(); toast(t('saved')); reload();
      } catch(e) { toast(e.message); }
    }});
    name.focus();
  }

  async function openLinks(u) {
    const data = await api('/api/users/'+u.id);
    const body = [
      el('p',{class:'sub',text:t('sub')}),
      el('div',{class:'code',text:data.subUrl}),
      el('div',{class:'row',style:'margin-top:8px'},[
        el('button',{class:'btn sm',text:t('copy'),onclick:()=>copy(data.subUrl)}),
        el('a',{class:'btn sm ghost',href:data.subUrl,target:'_blank',rel:'noreferrer',text:'↗'}),
      ]),
      el('div',{style:'height:14px'}),
    ];
    for (const link of data.links) {
      body.push(el('div',{style:'margin-bottom:10px'},[
        el('div',{class:'code',text:link}),
        el('div',{class:'row',style:'margin-top:6px'},[el('button',{class:'btn sm',text:t('copy'),onclick:()=>copy(link)})]),
      ]));
    }
    const cfgs = await api('/api/configs?user='+u.id);
    body.push(
      el('div',{style:'height:8px'}),
      el('label',{text:t('configs')+' — '+t('xrayHint')}),
      el('div',{class:'code',text:JSON.stringify(cfgs.xray,null,1)}),
      el('div',{style:'height:10px'}),
      el('label',{text:t('configs')+' — '+t('singboxHint')}),
      el('div',{class:'code',text:JSON.stringify(cfgs.singbox,null,1)}),
    );
    modal(u.name, body);
  }

  function openPassword() {
    const cur = el('input',{type:'password',dir:'ltr',autocomplete:'current-password'});
    const next = el('input',{type:'password',dir:'ltr',autocomplete:'new-password'});
    const m = modal(t('changePass'),[
      el('label',{text:t('currentPass')}), cur,
      el('div',{style:'height:12px'}),
      el('label',{text:t('newPass')}), next,
    ], { label: t('save'), onclick: async () => {
      try {
        await api('/api/password',{method:'POST',body:JSON.stringify({current:cur.value,next:next.value})});
        toast(t('passChanged'));
        setTimeout(()=>location.reload(), 900);
      } catch(e) { toast(e.message); }
    }});
    cur.focus();
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast(t('copied')); }
    catch { const a = el('textarea'); a.value = text; document.body.append(a); a.select(); document.execCommand('copy'); a.remove(); toast(t('copied')); }
  }

  // settings card
  const s = await api('/api/settings').then(r=>r.settings).catch(()=>null);
  if (s) {
    const f = {
      host: el('input',{value:s.host,dir:'ltr',placeholder:'panel.example.com'}),
      port: el('input',{value:String(s.port),dir:'ltr',type:'number'}),
      path: el('input',{value:s.path,dir:'ltr'}),
      remarkPrefix: el('input',{value:s.remarkPrefix,dir:'ltr'}),
      fingerprint: el('input',{value:s.fingerprint,dir:'ltr'}),
      alpn: el('input',{value:s.alpn,dir:'ltr'}),
      fragment: el('input',{value:s.fragment,dir:'ltr',placeholder:'1,40-100'}),
      ech: el('textarea',{rows:'2',dir:'ltr'}),
      cleanIps: el('textarea',{rows:'3',dir:'ltr',placeholder:'104.16.1.1\n104.17.2.2'}),
    };
    f.ech.value = s.ech; f.cleanIps.value = s.cleanIps;
    const settingsCard = el('div',{class:'card',style:'margin-top:16px'},[
      el('h2',{text:t('settings')}),
      el('div',{class:'fields',style:'margin-top:12px'},[
        el('div',{},[el('label',{text:t('host')}), f.host, el('div',{class:'hint',text:t('hostHint')})]),
        el('div',{},[el('label',{text:'Port'}), f.port]),
        el('div',{},[el('label',{text:'Path'}), f.path, el('div',{class:'hint',text:t('pathHint')})]),
        el('div',{},[el('label',{text:'Remark'}), f.remarkPrefix]),
        el('div',{},[el('label',{text:'uTLS (fp)'}), f.fingerprint]),
        el('div',{},[el('label',{text:'ALPN'}), f.alpn]),
        el('div',{},[el('label',{text:'Fragment'}), f.fragment, el('div',{class:'hint',text:t('fragHint')})]),
        el('div',{},[el('label',{text:'ECH'}), f.ech, el('div',{class:'hint',text:t('echHint')})]),
        el('div',{style:'grid-column:1/-1'},[el('label',{text:'Clean IPs'}), f.cleanIps, el('div',{class:'hint',text:t('cleanHint')})]),
      ]),
      el('div',{class:'row',style:'justify-content:flex-end;margin-top:14px'},[
        el('button',{class:'btn primary',text:t('save'),onclick:async()=>{
          try {
            await api('/api/settings',{method:'PUT',body:JSON.stringify({
              host:f.host.value, port:Number(f.port.value), path:f.path.value, remarkPrefix:f.remarkPrefix.value,
              fingerprint:f.fingerprint.value, alpn:f.alpn.value, fragment:f.fragment.value, ech:f.ech.value, cleanIps:f.cleanIps.value
            })});
            toast(t('saved')); reload();
          } catch(e) { toast(e.message); }
        }}),
      ]),
    ]);
    root.append(settingsCard);
  }

  await reload();
}

boot();
`;

/* ------------------------------------------------------------------ status page */

const STATUS_JS = String.raw`
const $ = (s) => document.querySelector(s);
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); } catch {}
  const old = b.textContent; b.textContent = b.dataset.copied || '✓';
  setTimeout(() => (b.textContent = old), 1500);
}));
`;

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function fmtBytes(bytes) {
  let b = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b < 10 && i > 0 ? b.toFixed(1) : Math.round(b)} ${units[i]}`;
}

const shell = ({ title, lang = 'fa', body, script = '', extraHead = '' }) => `<!doctype html>
<html lang="${lang}" dir="${lang === 'fa' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#07080f">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
${extraHead}
</head>
<body dir="${lang === 'fa' ? 'rtl' : 'ltr'}">
${body}
<script>${script}</script>
</body>
</html>`;

export function adminPage({ title = 'ZEUS LITE' } = {}) {
  return shell({
    title,
    lang: 'fa',
    body: `<div id="app"></div>
<div class="toast" id="toast"></div>`,
    script: ADMIN_JS,
  });
}

export function statusPage({ title = 'ZEUS LITE', user = null, links = [], subUrl = '', missing = false } = {}) {
  if (missing || !user) {
    return shell({
      title,
      body: `<div class="wrap"><div class="center"><div class="card login"><div class="mark">Z</div><h2 style="text-align:center">${escapeHtml(title)}</h2>
      <p class="sub" style="text-align:center">این لینک وجود ندارد. / This link does not exist.</p></div></div></div>`,
    });
  }
  const limit = Number(user.traffic_limit) || 0;
  const pct = limit ? Math.min(100, Math.round((user.traffic_used / limit) * 100)) : 0;
  const expired = user.expires_at && user.expires_at < Date.now();
  const status = !user.enabled ? 'خاموش / disabled' : expired ? 'منقضی / expired' : 'فعال / active';
  const statCls = !user.enabled || expired ? 'off' : 'on';
  return shell({
    title: `${title} — ${user.name}`,
    body: `<div class="wrap">
  <div class="top"><div class="logo"><div class="mark">Z</div><span>${escapeHtml(title)}</span></div>
  <div class="spacer"></div><span class="chip"><span class="dot"></span><b>${escapeHtml(user.name)}</b></span></div>
  <div class="grid stats">
    <div class="card stat"><div class="k">وضعیت / status</div><div class="v"><span class="tag ${statCls}">${status}</span></div></div>
    <div class="card stat"><div class="k">مصرف / used</div><div class="v">${fmtBytes(user.traffic_used)}${limit ? `<small>/ ${fmtBytes(limit)}</small>` : ''}</div>
      <div class="bar ${pct > 85 ? 'warn' : ''}" style="margin-top:10px"><i style="width:${limit ? pct : 8}%"></i></div></div>
    <div class="card stat"><div class="k">انقضا / expires</div><div class="v" style="font-size:16px">${user.expires_at ? new Date(user.expires_at).toISOString().slice(0, 10) : 'بی‌پایان / never'}</div></div>
  </div>
  <div class="card">
    <h2>لینک اشتراک / subscription</h2>
    <p class="sub">این لینک را در اپ وارد کنید تا کانفیگ‌ها خودکار اضافه شوند.</p>
    <div class="code">${escapeHtml(subUrl)}</div>
    <div class="row" style="margin-top:10px"><button class="btn sm" data-copy="${escapeHtml(subUrl)}" data-copied="✓">کپی / copy</button></div>
  </div>
  <div style="height:16px"></div>
  <div class="card">
    <h2>کانفیگ‌ها / configs</h2>
    <p class="sub">هر کدام را جدا می‌توانید در v2rayNG، v2box، sing-box یا اپ ویندوز وارد کنید.</p>
    ${links
      .map(
        (l) => `<div style="margin-bottom:12px"><div class="code">${escapeHtml(l)}</div>
      <div class="row" style="margin-top:6px"><button class="btn sm" data-copy="${escapeHtml(l)}" data-copied="✓">کپی / copy</button></div></div>`,
      )
      .join('') || '<p class="sub">هنوز IP سالمی تنظیم نشده است.</p>'}
  </div>
</div>`,
    script: STATUS_JS,
  });
}
