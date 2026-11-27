/* Kortscanner – mobil web-app
   Kortdata, billeder og priser: TCGdex (https://tcgdex.dev).
   Login, samling, venner og kvitteringer: Supabase (regler i databasen beskytter data). */
(() => {
'use strict';
const APIS = {en:'https://api.tcgdex.net/v2/en', ja:'https://api.tcgdex.net/v2/ja'};
const EUR_DKK = 7.46; // kronen er bundet til euroen (centralkurs 7,46038)
const COLLS = {binder:'Binder', sale:'Til salg', wish:'Ønskeliste'};
const CONDS = ['Mint','Near Mint','Let brugt','Brugt','Slidt','Gradet (PSA/BGS/CGC)'];
const LANGS = ['Engelsk','Japansk','Tysk','Dansk','Andet'];
const VARIANTS = {normal:'Normal', holo:'Holo', reverse:'Reverse holo', firstEdition:'1. udgave', wPromo:'Promo'};
const COLORS = ['#FFCB3D','#FF7A59','#3DD68C','#5AA9FF','#B28DFF','#FF6FB5','#2EC4B6','#C0C6D0'];
const STORE_KEY = 'kortscanner.v1';

/* ---------- state ---------- */
const S = {
  tab:'samling', view:null,
  data:{entries:[], sold:[]},
  coll:'all', sort:'value', filter:'', lang:'en',
  search:{q:'', results:null, busy:false, err:''},
  scan:{phase:'idle'},
  cardCache:{}, setCache:{}, sets:{},
  delArm:false, refreshing:false, sell:null,
  profile:null, profiles:{}, friends:[], receipts:[], notes:[],
  fq:'', fhits:[], friendView:null, rcFilter:'all', syncErr:false,
};
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const kr = n => Math.round(+n || 0).toLocaleString('da-DK') + ' kr';
const eur = n => (+n).toLocaleString('da-DK',{minimumFractionDigits:2, maximumFractionDigits:2}) + ' €';
const usd = n => '$' + (+n).toLocaleString('en-US',{minimumFractionDigits:2, maximumFractionDigits:2});
const sgn = n => (n >= 0 ? '+' : '−') + kr(Math.abs(n));
const pct = n => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(1).replace('.', ',') + ' %';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const isoDay = () => new Date().toISOString().slice(0, 10);
const initials = n => String(n || '?').trim().split(/[\s._]+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
let toastT;
function toast(m){ const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3400); }

/* ---------- storage + sky (Supabase) ---------- */
const SUPA_URL = 'https://yxqwgfgpszquvbqauiup.supabase.co';
const SUPA_KEY = 'sb_publishable_nDW0EKIep6M-ahKcA_Y3oQ_Di62KLUf'; // offentlig nøgle – data er beskyttet af regler i databasen
let sb = null, user = null;
const synced = {entries:{}, sales:{}};
let prevSynced = {entries:[], sales:[]};
const cacheKey = () => STORE_KEY + (user ? ':' + user.id : '');
function load(){
  S.data = {entries:[], sold:[]}; prevSynced = {entries:[], sales:[]}; S.notes = [];
  try { const raw = localStorage.getItem(cacheKey()); if (raw){ const d = JSON.parse(raw); S.data = {entries: d.entries || [], sold: d.sold || []}; prevSynced = d.synced || prevSynced; S.notes = d.notes || []; } } catch(e){}
  S.data.entries.forEach(e => { if (!e.api) e.api = 'en'; });
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch(e){}
}
let syncT = null, syncing = false, syncAgain = false;
function persistLocal(){
  try { localStorage.setItem(cacheKey(), JSON.stringify({...S.data, notes:S.notes.slice(-50), synced:{entries:Object.keys(synced.entries), sales:Object.keys(synced.sales)}})); }
  catch(e){ toast('Kunne ikke gemme på telefonen.'); }
}
function save(){ persistLocal(); if (sb && user){ clearTimeout(syncT); syncT = setTimeout(syncUp, 700); } }
async function syncTable(table, list, key){
  const now = {}; list.forEach(x => now[x.id] = JSON.stringify(x));
  const up = list.filter(x => synced[key][x.id] !== now[x.id]).map(x => ({id:x.id, user_id:user.id, data:x}));
  const del = Object.keys(synced[key]).filter(id => !(id in now));
  if (up.length){ const {error} = await sb.from(table).upsert(up); if (error) throw error; up.forEach(r => synced[key][r.id] = now[r.id]); }
  if (del.length){ const {error} = await sb.from(table).delete().in('id', del); if (error) throw error; del.forEach(id => delete synced[key][id]); }
}
async function syncUp(){
  if (!sb || !user) return;
  if (syncing){ syncAgain = true; return; }
  syncing = true;
  try { await syncTable('entries', S.data.entries, 'entries'); await syncTable('sales', S.data.sold, 'sales'); S.syncErr = false; persistLocal(); }
  catch(e){ S.syncErr = true; }
  syncing = false;
  if (syncAgain){ syncAgain = false; syncUp(); }
}
async function syncDown(){
  const [a, b] = await Promise.all([sb.from('entries').select('id,data'), sb.from('sales').select('id,data')]);
  if (a.error || b.error) throw (a.error || b.error);
  const cloudE = a.data.map(r => r.data), cloudS = b.data.map(r => r.data);
  synced.entries = {}; cloudE.forEach(x => synced.entries[x.id] = JSON.stringify(x));
  synced.sales = {}; cloudS.forEach(x => synced.sales[x.id] = JSON.stringify(x));
  // kort på telefonen, som aldrig har været i skyen, lægges op (første login / offline). Kort, der er slettet på en anden enhed, kommer ikke tilbage.
  const wasE = new Set(prevSynced.entries || []), wasS = new Set(prevSynced.sales || []);
  const ids = new Set(cloudE.map(x => x.id)), sids = new Set(cloudS.map(x => x.id));
  let legacy = {entries:[], sold:[]}; try { const raw = localStorage.getItem(STORE_KEY); if (raw) legacy = JSON.parse(raw); } catch(e){}
  const extraE = S.data.entries.concat(legacy.entries || []).filter(x => x && x.id && !ids.has(x.id) && !wasE.has(x.id) && (ids.add(x.id), true));
  const extraS = S.data.sold.concat(legacy.sold || []).filter(x => x && x.id && !sids.has(x.id) && !wasS.has(x.id) && (sids.add(x.id), true));
  S.data = {entries: cloudE.concat(extraE), sold: cloudS.concat(extraS)};
  S.data.entries.forEach(e => { if (!e.api) e.api = 'en'; });
  try { localStorage.removeItem(STORE_KEY); } catch(e){}
  save();
}
const entry = id => S.data.entries.find(e => e.id === id);

/* ---------- kortdata (TCGdex) ---------- */
async function api(path, lang){
  const r = await fetch((APIS[lang] || APIS.en) + path);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const ck = (id, lang) => (lang || 'en') + ':' + id;
const cached = (id, lang) => S.cardCache[ck(id, lang)];
async function getCard(id, lang){
  const k = ck(id, lang); if (S.cardCache[k]) return S.cardCache[k];
  const c = await api('/cards/' + encodeURIComponent(id), lang);
  if (c) S.cardCache[k] = c;
  return c;
}
async function getSets(lang){
  lang = lang || 'en';
  if (S.sets[lang]) return S.sets[lang];
  const key = 'kortscanner.sets.' + lang;
  try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && Date.now() - c.t < 3*864e5){ S.sets[lang] = c.sets; return c.sets; } } catch(e){}
  const sets = await api('/sets', lang);
  S.sets[lang] = (sets || []).map(s => ({id:s.id, name:s.name, official:s.cardCount && s.cardCount.official, total:s.cardCount && s.cardCount.total}));
  try { localStorage.setItem(key, JSON.stringify({t:Date.now(), sets:S.sets[lang]})); } catch(e){}
  return S.sets[lang];
}
async function getSet(id, lang){
  const k = ck(id, lang); if (S.setCache[k]) return S.setCache[k];
  const s = await api('/sets/' + encodeURIComponent(id), lang);
  if (s) S.setCache[k] = s;
  return s;
}
const img = (base, q) => base ? esc(base + '/' + (q || 'low') + '.webp') : '';
const setOf = id => String(id).slice(0, String(id).lastIndexOf('-'));
const isPocket = id => /^(A\d+[a-z]?|B\d+[a-z]?|P-[AB])-/i.test(String(id));

/* ---------- priser, historik og alarmer ---------- */
function prices(card){
  const p = (card && card.pricing) || {}; const out = {cm:null, tcg:null, rows:[], cmRaw:null};
  const cm = p.cardmarket;
  if (cm){
    out.cmRaw = cm;
    const trend = cm.trend ?? cm.avg30 ?? cm.avg ?? cm.avg7;
    if (trend != null && +trend > 0) out.cm = +trend;
    [['trend','Trend'],['avg','Gennemsnit'],['low','Laveste'],['avg7','Snit 7 dage'],['avg30','Snit 30 dage'],['trend-holo','Trend (holo)'],['avg-holo','Gennemsnit (holo)']]
      .forEach(([k, l]) => { if (cm[k] != null && +cm[k] > 0) out.rows.push({src:'Cardmarket', l, v:eur(cm[k]), dkk:+cm[k]*EUR_DKK}); });
  }
  const tp = p.tcgplayer;
  if (tp){
    Object.keys(tp).forEach(k => {
      const v = tp[k]; if (!v || typeof v !== 'object') return;
      const m = v.marketPrice ?? v.midPrice; if (m == null) return;
      if (out.tcg == null) out.tcg = +m;
      out.rows.push({src:'TCGplayer', l:'Markedspris (' + k.replace(/-/g, ' ') + ')', v:usd(m)});
    });
  }
  return out;
}
const unitValue = e => (+e.manual > 0) ? +e.manual : (+e.eur > 0 ? +e.eur * EUR_DKK : 0);
const value = e => unitValue(e) * (+e.qty || 1);
function applyPrice(e, card){
  const p = prices(card);
  if (p.cm != null){
    e.eur = p.cm;
    const d = isoDay(); e.hist = Array.isArray(e.hist) ? e.hist : [];
    const last = e.hist[e.hist.length - 1];
    if (last && last[0] === d) last[1] = p.cm; else e.hist.push([d, p.cm]);
    if (e.hist.length > 400) e.hist = e.hist.slice(-400);
    if (p.cmRaw && p.cmRaw.avg30) e.avg30 = +p.cmRaw.avg30;
    if (p.cmRaw && p.cmRaw.avg7) e.avg7 = +p.cmRaw.avg7;
  }
  e.eurDate = Date.now();
  checkAlert(e);
}
function checkAlert(e){
  const a = e.alert; if (!a) return;
  const v = unitValue(e); if (!v) return;
  let hit = null;
  if (+a.below > 0 && v <= +a.below) hit = 'below';
  else if (+a.above > 0 && v >= +a.above) hit = 'above';
  if (hit && a.last !== hit){
    a.last = hit;
    S.notes.push({id:uid(), t:Date.now(), kind:'price', entry:e.id, text:`${e.name} er ${hit === 'below' ? 'faldet til' : 'steget til'} ${kr(v)} (din grænse: ${kr(hit === 'below' ? a.below : a.above)})`, read:false});
    toast(`Prisalarm: ${e.name} – ${kr(v)}`);
  } else if (!hit) a.last = null;
}
async function refreshPrices(all){
  if (S.refreshing) return; S.refreshing = true; render();
  const list = S.data.entries.filter(e => all || !e.eurDate || Date.now() - e.eurDate > 864e5);
  let n = 0;
  for (const e of list){
    try { delete S.cardCache[ck(e.cardId, e.api)]; const c = await getCard(e.cardId, e.api); if (c) applyPrice(e, c); n++; }
    catch(x){ break; }
    if (n % 5 === 0){ save(); render(); }
    await new Promise(r => setTimeout(r, 120));
  }
  save(); S.refreshing = false; render();
  if (all) toast(n ? 'Priserne er opdateret.' : 'Kunne ikke hente priser lige nu.');
}

/* ---------- profiler, venner, kvitteringer ---------- */
async function loadProfiles(ids){
  const need = [...new Set(ids)].filter(id => id && !S.profiles[id]);
  if (!need.length) return;
  const {data} = await sb.from('profiles').select('id,username,display_name,color').in('id', need);
  (data || []).forEach(p => S.profiles[p.id] = p);
}
const pname = id => { if (user && id === user.id) return 'Dig'; const p = S.profiles[id]; return p ? (p.display_name || p.username) : 'Slettet bruger'; };
const puser = id => { const p = S.profiles[id]; return p ? '@' + p.username : ''; };
function avatar(p, size){
  size = size || 40; const name = p ? (p.display_name || p.username) : '?';
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px;background:${esc(p && p.color || '#C0C6D0')}" aria-hidden="true">${esc(initials(name))}</span>`;
}
async function loadSocial(){
  if (!sb || !user) return;
  try {
    const [f, r] = await Promise.all([sb.from('friendships').select('*'), sb.from('receipts').select('*').order('created_at', {ascending:false})]);
    if (!f.error) S.friends = f.data || [];
    if (!r.error) S.receipts = r.data || [];
    const ids = []; S.friends.forEach(x => ids.push(x.requester, x.addressee)); S.receipts.forEach(x => ids.push(x.seller, x.buyer));
    await loadProfiles(ids);
  } catch(e){}
  updateBadges(); render();
}
const otherOf = f => f.requester === user.id ? f.addressee : f.requester;
const acceptedFriends = () => S.friends.filter(f => f.status === 'accepted').map(otherOf);
const incomingReq = () => S.friends.filter(f => f.status === 'pending' && f.addressee === user.id);
const outgoingReq = () => S.friends.filter(f => f.status === 'pending' && f.requester === user.id);
const toConfirm = () => S.receipts.filter(r => r.buyer === user.id && r.status === 'pending');
function noteCount(){ return incomingReq().length + toConfirm().length + S.notes.filter(n => !n.read).length; }
function updateBadges(){
  const n = user ? noteCount() : 0;
  const b = $('#bellDot'); if (b){ b.hidden = !n; b.textContent = n > 9 ? '9+' : String(n); }
  const av = $('#meBtn'); if (av && S.profile) av.innerHTML = avatar(S.profile, 36);
}

/* ---------- små byggeklodser ---------- */
function artEl(base, name, qty){
  return `<div class="art">${base ? `<img src="${img(base,'low')}" alt="" loading="lazy">` : `<span class="ph" aria-hidden="true">${esc((name||'?')[0])}</span>`}${(+qty||1) > 1 ? `<span class="qty">×${esc(qty)}</span>` : ''}</div>`;
}
const back = l => `<button class="btn text" data-act="back" style="align-self:flex-start;padding:0">‹ ${esc(l || 'Tilbage')}</button>`;
const opts = (arr, v) => arr.map(o => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('');
const spinner = t => `<p class="row b"><svg class="spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/></svg>${esc(t)}</p>`;
const langPills = () => `<div class="pills" role="group" aria-label="Sprog"><button class="pill" data-act="lang" data-v="en" aria-pressed="${S.lang === 'en'}">Engelske kort</button><button class="pill" data-act="lang" data-v="ja" aria-pressed="${S.lang === 'ja'}">Japanske kort</button></div>`;
function marketLinks(name, number){
  const q = encodeURIComponent([name, number].filter(Boolean).join(' '));
  return `<div class="row wrapr"><a class="btn ghost" href="https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${q}" target="_blank" rel="noopener">Cardmarket</a><a class="btn ghost" href="https://www.tcgplayer.com/search/pokemon/product?q=${q}" target="_blank" rel="noopener">TCGplayer</a><a class="btn ghost" href="https://www.ebay.com/sch/i.html?_nkw=${q}" target="_blank" rel="noopener">eBay</a></div>`;
}
function pUpd(card){ const p = card.pricing || {}; const u = (p.cardmarket && p.cardmarket.updated) || (p.tcgplayer && p.tcgplayer.updated); try { return u ? new Date(u).toLocaleDateString('da-DK') : ''; } catch(e){ return ''; } }
function priceBox(card){
  const p = prices(card);
  if (!p.rows.length) return `<div class="box col"><h3>Markedspris</h3><p class="small mut" style="margin:0">Ingen prisdata for dette kort${card && card._lang === 'ja' ? ' (japanske kort har sjældent priser her – sæt en egen værdi)' : ''}.</p>${marketLinks(card.name, card.localId)}</div>`;
  return `<div class="box col" style="gap:6px"><h3>Markedspris</h3>
  ${p.cm != null ? `<div class="row between"><span class="mut small">Cardmarket trend</span><span class="big" style="font-size:28px">${kr(p.cm * EUR_DKK)}</span></div>` : ''}
  <div>${p.rows.map(r => `<div class="price"><span>${esc(r.src)} · ${esc(r.l)}</span><span class="nw b">${esc(r.v)}${r.dkk ? ` <span class="mut">(${kr(r.dkk)})</span>` : ''}</span></div>`).join('')}</div>
  <span class="tiny mut">Priser fra TCGdex${pUpd(card) ? ', opdateret ' + esc(pUpd(card)) : ''}. Euro omregnet med 7,46.</span>
  ${marketLinks(card.name, card.localId)}</div>`;
}
function sparkline(points){
  if (points.length < 2) return '';
  const W = 320, H = 90, P = 6, vals = points.map(p => p[1]);
  const min = Math.min(...vals), max = Math.max(...vals), r = (max - min) || 1;
  const xy = points.map((p, i) => [P + i * (W - 2 * P) / (points.length - 1), H - P - (p[1] - min) / r * (H - 2 * P)]);
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Prisudvikling"><polyline points="${xy.map(a => a.map(n => n.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="${up ? 'var(--up)' : 'var(--down)'}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${xy.map(a => `<circle cx="${a[0].toFixed(1)}" cy="${a[1].toFixed(1)}" r="2.5" fill="currentColor" opacity=".5"/>`).join('')}</svg>`;
}
function historyBox(e){
  const hist = (e.hist || []).filter(h => +h[1] > 0);
  const now = +e.eur || 0;
  let pts = hist.map(h => [h[0], h[1] * EUR_DKK]);
  let note = '';
  if (pts.length < 2 && (e.avg30 || e.avg7) && now){
    pts = [['30 d', (e.avg30 || e.avg7) * EUR_DKK], ['7 d', (e.avg7 || e.avg30) * EUR_DKK], ['Nu', now * EUR_DKK]];
    note = 'Viser Cardmarkets 30- og 7-dages snit indtil appen har samlet din egen historik (én måling pr. dag).';
  }
  const ch30 = e.avg30 && now ? (now - e.avg30) / e.avg30 * 100 : null;
  const first = hist[0], chAll = first && now ? (now - first[1]) / first[1] * 100 : null;
  return `<div class="box col" style="gap:8px"><h3>Prisudvikling</h3>
  ${pts.length >= 2 ? sparkline(pts) : '<p class="small mut" style="margin:0">Der er ikke nok prisdata endnu. Appen gemmer prisen én gang om dagen.</p>'}
  <div class="row wrapr small" style="gap:16px">${ch30 != null ? `<span>30 dage: <b class="${ch30 >= 0 ? 'up' : 'down'}">${pct(ch30)}</b></span>` : ''}${chAll != null && hist.length > 1 ? `<span>Siden ${esc(new Date(first[0]).toLocaleDateString('da-DK'))}: <b class="${chAll >= 0 ? 'up' : 'down'}">${pct(chAll)}</b></span>` : ''}</div>
  ${note ? `<span class="tiny mut">${esc(note)}</span>` : ''}</div>`;
}

/* ---------- visninger ---------- */
function vSamling(){
  const all = S.data.entries, held = all.filter(e => e.coll !== 'wish');
  const total = held.reduce((a, e) => a + value(e), 0), paid = held.reduce((a, e) => a + (+e.buy || 0) * (+e.qty || 1), 0), cnt = held.reduce((a, e) => a + (+e.qty || 1), 0);
  let list = S.coll === 'all' ? all.slice() : all.filter(e => e.coll === S.coll);
  const f = S.filter.trim().toLowerCase();
  if (f) list = list.filter(e => [e.name, e.setName, e.localId].join(' ').toLowerCase().includes(f));
  list.sort(S.sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : S.sort === 'new' ? (a, b) => String(b.added).localeCompare(String(a.added)) : (a, b) => value(b) - value(a));
  return `<div class="col">
  <div class="box col" style="gap:4px"><div class="row between"><span class="small mut">Samlet værdi</span>${S.refreshing ? '<span class="tiny mut">Opdaterer priser …</span>' : `<button class="btn text tiny" data-act="refresh" style="min-height:32px">Opdater priser</button>`}</div>
  <span class="big">${kr(total)}</span>
  <span class="small mut">${cnt} kort · investeret ${kr(paid)} · <b class="${total - paid >= 0 ? 'up' : 'down'}">${sgn(total - paid)}</b></span></div>
  <div class="row wrapr"><button class="btn ghost" data-act="tab" data-v="saet">Sæt-fremskridt</button><button class="btn ghost" data-act="tab" data-v="kvit">Kvitteringer</button></div>
  <div class="pills" role="group" aria-label="Vælg samling">${[['all','Alle'],['binder','Binder'],['sale','Til salg'],['wish','Ønskeliste']].map(([k, l]) => `<button class="pill" data-act="coll" data-v="${k}" aria-pressed="${S.coll === k}">${l} ${k === 'all' ? all.length : all.filter(e => e.coll === k).length}</button>`).join('')}</div>
  <div class="row"><input class="i grow" type="search" data-f="filter" value="${esc(S.filter)}" placeholder="Søg i din samling" aria-label="Søg i din samling">
  <select class="i" style="width:auto" data-f="sort" aria-label="Sortér">${[['value','Værdi'],['name','Navn'],['new','Nyeste']].map(([k, l]) => `<option value="${k}"${S.sort === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
  ${list.length ? `<div class="cards">${list.map(e => `<button class="tile" data-act="openEntry" data-v="${esc(e.id)}">${artEl(e.image, e.name, e.qty)}<span class="name">${esc(e.name)}</span><span class="tiny mut">${esc(e.setName)} · ${esc(e.localId)}${e.api === 'ja' ? ' · JP' : ''}</span><span class="row between small"><b>${unitValue(e) ? kr(value(e)) : '<span class="mut">–</span>'}</b><span class="tiny mut">${e.alert && (e.alert.below || e.alert.above) ? 'Alarm · ' : ''}${esc(e.coll === 'wish' ? 'Ønske' : e.coll === 'sale' ? 'Til salg' : '')}</span></span></button>`).join('')}</div>`
  : `<div class="box col" style="align-items:flex-start"><h2>${all.length ? 'Ingen kort matcher' : 'Din samling er tom'}</h2><p class="mut" style="margin:0">Scan dit første kort med kameraet, eller søg efter det.</p><div class="row wrapr"><button class="btn" data-act="tab" data-v="scan">Scan kort</button><button class="btn ghost" data-act="tab" data-v="sog">Søg kort</button></div></div>`}
  </div>`;
}

function vScan(){
  const sc = S.scan;
  let body = '';
  if (sc.phase === 'live' || sc.phase === 'starting'){
    body = `<div class="cam"><video id="vid" playsinline muted autoplay></video><div class="frame"></div><div class="msg">${sc.phase === 'starting' ? 'Starter kameraet …' : 'Læg kortet inden for rammen, så nummeret i bunden er skarpt'}</div></div>
    <button class="shutter" data-act="snap" aria-label="Tag billede og find kortet"></button>
    <label class="btn ghost full" for="fileIn">Vælg et billede i stedet</label>`;
  } else if (sc.phase === 'busy'){
    body = `<div class="cam">${sc.img ? `<img src="${esc(sc.img)}" alt="Dit billede af kortet" style="object-fit:contain">` : ''}</div>${spinner(sc.msg || 'Læser kortet …')}`;
  } else if (sc.phase === 'result'){
    body = `${sc.cands.length ? `<h2>${sc.cands.length === 1 ? 'Er det dette kort?' : 'Hvilket kort er det?'}</h2>
    ${sc.guess ? `<p class="small mut" style="margin:0">Læst: ${esc([sc.guess.name, sc.guess.num].filter(Boolean).join(' · '))}</p>` : ''}
    <div class="cards">${sc.cands.map(c => `<button class="tile" data-act="openCard" data-v="${esc(c.id)}" data-l="${esc(sc.lang || 'en')}">${artEl(c.image, c.name)}<span class="name">${esc(c.name)}</span><span class="tiny mut">${esc(c.setName || '')}${c.localId ? ' · ' + esc(c.localId) : ''}</span></button>`).join('')}</div>`
    : `<div class="box col"><h2>Kortet blev ikke fundet</h2><p class="small mut" style="margin:0">${esc(sc.msg || 'Prøv igen med kortet fladt, godt lys og nummeret i bunden skarpt.')}</p></div>`}
    <div class="row wrapr"><button class="btn" data-act="rescan">Scan igen</button><button class="btn ghost" data-act="toSearch">Søg i stedet</button></div>`;
  } else if (sc.phase === 'nocam'){
    body = `<div class="box col"><h2>Kameraet kunne ikke startes</h2><p class="small mut" style="margin:0">${esc(sc.msg)}</p></div>
    <label class="btn full" for="fileIn">Tag eller vælg et billede</label><button class="btn ghost full" data-act="startCam">Prøv kameraet igen</button>`;
  } else {
    body = `${langPills()}<div class="box col"><p style="margin:0">Appen læser kortets <b>nummer</b> (f.eks. 223/197) og finder det officielle billede og prisen.${S.lang === 'ja' ? ' Japanske kort findes via nummeret – navnet kan ikke læses.' : ''}</p></div>
    <button class="btn full" data-act="startCam">Start kameraet</button><label class="btn ghost full" for="fileIn">Vælg et billede</label>`;
  }
  return `<div class="col"><h1>Scan kort</h1>${body}</div>`;
}

function vSog(){
  return `<div class="col"><h1>Søg kort</h1>${langPills()}
  <input class="i" type="search" data-f="q" value="${esc(S.search.q)}" placeholder="${S.lang === 'ja' ? 'Navn på japansk, f.eks. ピカチュウ' : 'Navn, f.eks. Charizard eller Pikachu'}" aria-label="Søg efter kort" enterkeyhint="search">
  <div id="results">${resultsHtml()}</div></div>`;
}
function resultsHtml(){
  const s = S.search;
  if (s.busy) return spinner('Søger …');
  if (s.err) return `<div class="note">${esc(s.err)}</div>`;
  if (!s.results) return `<p class="small mut">${S.lang === 'ja' ? 'Skriv mindst 2 tegn. Japanske kort søges med japanske navne.' : 'Skriv mindst 3 bogstaver. Kortdata og billeder kommer fra TCGdex.'}</p>`;
  if (!s.results.length) return `<p class="small mut">Ingen kort fundet.${S.lang === 'en' ? ' Tjek stavningen – navne er på engelsk.' : ''}</p>`;
  return `<p class="small mut">${s.results.length}${s.results.length >= 120 ? '+' : ''} kort</p><div class="cards">${s.results.slice(0, 120).map(c => `<button class="tile" data-act="openCard" data-v="${esc(c.id)}" data-l="${esc(s.lang)}">${artEl(c.image, c.name)}<span class="name">${esc(c.name)}</span><span class="tiny mut">${esc(c.setName || c.id)} · ${esc(c.localId)}</span></button>`).join('')}</div>`;
}

function vCard(){
  const {id, lang} = S.view, c = cached(id, lang);
  if (!c){ return `<div class="col">${back()}${spinner('Henter kortet …')}</div>`; }
  c._lang = lang;
  const owned = S.data.entries.filter(e => e.cardId === id && (e.api || 'en') === (lang || 'en'));
  const vars = Object.keys(c.variants || {}).filter(k => c.variants[k] && VARIANTS[k]);
  const p = prices(c);
  return `<div class="col">${back()}
  <div class="big-art">${c.image ? `<div class="art"><img src="${img(c.image,'high')}" alt="${esc(c.name)}"></div>` : artEl(null, c.name)}</div>
  <div class="col" style="gap:2px"><h1>${esc(c.name)}</h1><span class="small mut">${esc([c.set && c.set.name, c.localId + (c.set && c.set.cardCount && c.set.cardCount.official ? '/' + c.set.cardCount.official : ''), c.rarity, lang === 'ja' ? 'Japansk' : ''].filter(Boolean).join(' · '))}</span>
  ${owned.length ? `<span class="small b up">Du har ${owned.reduce((a, e) => a + (+e.qty || 1), 0)} stk.</span>` : ''}</div>
  ${priceBox(c)}
  <div class="box col"><h3>Tilføj til samling</h3>
  <div class="grid2"><label class="f">Samling<select class="i" id="aColl">${Object.keys(COLLS).map(k => `<option value="${k}">${COLLS[k]}</option>`).join('')}</select></label>
  <label class="f">Antal<input class="i" id="aQty" type="number" min="1" inputmode="numeric" value="1"></label></div>
  <div class="grid2"><label class="f">Stand<select class="i" id="aCond">${opts(CONDS, 'Near Mint')}</select></label>
  <label class="f">Udgave<select class="i" id="aVar">${(vars.length ? vars : ['normal']).map(k => `<option value="${k}">${VARIANTS[k]}</option>`).join('')}</select></label></div>
  <div class="grid2"><label class="f">Sprog<select class="i" id="aLang">${opts(LANGS, lang === 'ja' ? 'Japansk' : 'Engelsk')}</select></label>
  <label class="f">Købspris pr. stk. (kr)<input class="i" id="aBuy" type="number" min="0" inputmode="numeric" placeholder="${p.cm != null ? Math.round(p.cm * EUR_DKK) : ''}"></label></div>
  <button class="btn full" data-act="add">Tilføj kortet</button></div></div>`;
}

function vEntry(){
  const e = entry(S.view.id); if (!e){ S.view = null; return vSamling(); }
  const c = cached(e.cardId, e.api);
  if (c) c._lang = e.api;
  const g = value(e) - (+e.buy || 0) * (+e.qty || 1);
  const a = e.alert || {};
  return `<div class="col">${back('Samling')}
  <div class="big-art">${e.image ? `<div class="art"><img src="${img(e.image,'high')}" alt="${esc(e.name)}"></div>` : artEl(null, e.name)}</div>
  <div class="col" style="gap:2px"><h1>${esc(e.name)}</h1><span class="small mut">${esc([e.setName, e.localId + (e.official ? '/' + e.official : ''), e.rarity, VARIANTS[e.variant], e.api === 'ja' ? 'Japansk' : ''].filter(Boolean).join(' · '))}</span></div>
  <div class="kpis"><div class="kpi"><span class="tiny mut">Betalt</span><b>${kr((+e.buy || 0) * (+e.qty || 1))}</b></div><div class="kpi"><span class="tiny mut">Værdi</span><b>${kr(value(e))}</b></div><div class="kpi"><span class="tiny mut">Gevinst</span><b class="${g >= 0 ? 'up' : 'down'}">${sgn(g)}</b></div></div>
  ${historyBox(e)}
  <div class="box col"><h3>Prisalarm</h3><p class="small mut" style="margin:0">Få besked i appen, når værdien pr. stk. kommer under eller over din grænse. Prisen tjekkes, når du åbner appen.</p>
  <div class="grid2"><label class="f">Under (kr)<input class="i" type="number" min="0" inputmode="numeric" data-a="below" value="${esc(a.below || '')}" placeholder="–"></label><label class="f">Over (kr)<input class="i" type="number" min="0" inputmode="numeric" data-a="above" value="${esc(a.above || '')}" placeholder="–"></label></div>
  ${a.below || a.above ? `<span class="tiny mut">Nu: ${kr(unitValue(e))} pr. stk.</span>` : ''}</div>
  ${c ? priceBox(c) : spinner('Henter priser …')}
  <div class="box col"><h3>Dit eksemplar</h3>
  <div class="pills" role="group" aria-label="Samling">${Object.keys(COLLS).map(k => `<button class="pill" data-act="move" data-v="${k}" aria-pressed="${e.coll === k}">${COLLS[k]}</button>`).join('')}</div>
  <div class="grid2"><label class="f">Antal<input class="i" type="number" min="1" inputmode="numeric" data-e="qty" value="${esc(e.qty || 1)}"></label>
  <label class="f">Købspris pr. stk.<input class="i" type="number" min="0" inputmode="numeric" data-e="buy" value="${esc(e.buy || '')}"></label></div>
  <div class="grid2"><label class="f">Stand<select class="i" data-e="cond">${opts(CONDS, e.cond)}</select></label>
  <label class="f">Sprog<select class="i" data-e="lang">${opts(LANGS, e.lang)}</select></label></div>
  <label class="f">Egen værdi pr. stk. (kr) – overstyrer markedsprisen<input class="i" type="number" min="0" inputmode="numeric" data-e="manual" value="${esc(e.manual || '')}" placeholder="Tom = brug Cardmarket"></label>
  <label class="f">Noter<textarea class="i" rows="3" data-e="note" placeholder="Hvor du købte det, små skader …">${esc(e.note || '')}</textarea></label></div>
  ${e.coll !== 'wish' ? `<button class="btn full" data-act="sell">Sælg kort</button>` : ''}
  <button class="btn danger full" data-act="del">${S.delArm ? 'Tryk igen for at slette' : 'Slet fra samlingen'}</button></div>`;
}

function vSaet(){
  const by = {};
  S.data.entries.filter(e => e.coll !== 'wish').forEach(e => { const k = (e.api || 'en') + ':' + e.setId; (by[k] = by[k] || {id:e.setId, lang:e.api || 'en', name:e.setName, official:e.official, ids:new Set()}).ids.add(e.localId); });
  const list = Object.values(by).map(s => ({...s, have:s.ids.size, pct: s.official ? Math.min(100, Math.round(s.ids.size / s.official * 100)) : 0})).sort((a, b) => b.pct - a.pct);
  return `<div class="col">${back('Samling')}<h1>Sæt</h1><p class="small mut" style="margin:0">Se hvor tæt du er på at gøre hvert sæt færdigt. Tryk på et sæt for at se de kort, du mangler.</p>
  ${list.length ? list.map(s => `<button class="li" data-act="openSet" data-v="${esc(s.id)}" data-l="${esc(s.lang)}" style="flex-direction:column;align-items:stretch;gap:8px"><div class="row between"><b>${esc(s.name)}${s.lang === 'ja' ? ' (JP)' : ''}</b><b class="nw">${s.pct} %</b></div><div class="bar"><i style="width:${s.pct}%"></i></div><div class="row between tiny mut"><span>${s.have} af ${esc(s.official || '?')} kort</span><span>${s.official ? Math.max(0, s.official - s.have) + ' mangler' : ''}</span></div></button>`).join('')
  : `<div class="box"><p class="mut" style="margin:0">Når du har kort i samlingen, vises dine sæt her.</p></div>`}</div>`;
}
function vSet(){
  const s = S.setCache[ck(S.view.id, S.view.lang)];
  if (!s) return `<div class="col">${back('Sæt')}${spinner('Henter sættet …')}</div>`;
  const have = new Set(S.data.entries.filter(e => e.setId === s.id && (e.api || 'en') === S.view.lang && e.coll !== 'wish').map(e => e.localId));
  const official = (s.cardCount && s.cardCount.official) || 0;
  const cards = s.cards || [];
  const mainHave = cards.filter((c, i) => i < official && have.has(c.localId)).length;
  const show = S.view.missing ? cards.filter(c => !have.has(c.localId)) : cards;
  return `<div class="col">${back('Sæt')}<h1>${esc(s.name)}</h1>
  <div class="box col" style="gap:8px"><div class="row between"><span>${mainHave} af ${official} kort</span><b>${official ? Math.round(mainHave / official * 100) : 0} %</b></div><div class="bar"><i style="width:${official ? Math.round(mainHave / official * 100) : 0}%"></i></div>${cards.length > official ? `<span class="tiny mut">Sættet har også ${cards.length - official} hemmelige/ekstra kort.</span>` : ''}</div>
  <div class="pills"><button class="pill" data-act="setMissing" data-v="0" aria-pressed="${!S.view.missing}">Alle kort</button><button class="pill" data-act="setMissing" data-v="1" aria-pressed="${!!S.view.missing}">Kun dem jeg mangler</button></div>
  <div class="cards">${show.map(c => `<button class="tile" data-act="openCard" data-v="${esc(c.id)}" data-l="${esc(S.view.lang)}" style="${have.has(c.localId) ? '' : 'opacity:.45'}">${artEl(c.image, c.name)}<span class="name">${esc(c.name)}</span><span class="tiny mut">${esc(c.localId)}${have.has(c.localId) ? ' · <b class="up">Har</b>' : ''}</span></button>`).join('')}</div></div>`;
}

function vStat(){
  const held = S.data.entries.filter(e => e.coll !== 'wish');
  const total = held.reduce((a, e) => a + value(e), 0), paid = held.reduce((a, e) => a + (+e.buy || 0) * (+e.qty || 1), 0);
  const group = fn => { const o = {}; held.forEach(e => { const k = fn(e) || 'Ukendt'; o[k] = (o[k] || 0) + value(e); }); return Object.entries(o).sort((a, b) => b[1] - a[1]); };
  const bars = rows => { const m = Math.max(1, ...rows.map(r => r[1])); return rows.map(([k, v]) => `<div class="col" style="gap:4px"><div class="row between small"><span>${esc(k)}</span><b class="nw">${kr(v)}</b></div><div class="bar"><i style="width:${Math.round(v / m * 100)}%"></i></div></div>`).join('') || '<span class="small mut">Ingen kort med værdi endnu.</span>'; };
  const top = held.slice().sort((a, b) => unitValue(b) - unitValue(a)).slice(0, 5);
  // samlet historik: summer hver dags værdi for kort med historik
  const days = {}; held.forEach(e => (e.hist || []).forEach(h => { days[h[0]] = (days[h[0]] || 0) + h[1] * EUR_DKK * (+e.qty || 1); }));
  const dayPts = Object.keys(days).sort().map(d => [d, days[d]]);
  const movers = held.filter(e => e.avg30 && e.eur).map(e => ({e, ch:(e.eur - e.avg30) / e.avg30 * 100})).sort((a, b) => Math.abs(b.ch) - Math.abs(a.ch)).slice(0, 5);
  const confirmed = S.receipts.filter(r => r.status === 'confirmed');
  const soldApp = confirmed.filter(r => r.seller === user.id), boughtApp = confirmed.filter(r => r.buyer === user.id);
  return `<div class="col"><h1>Statistik</h1>
  <div class="kpis"><div class="kpi"><span class="tiny mut">Værdi</span><b>${kr(total)}</b></div><div class="kpi"><span class="tiny mut">Investeret</span><b>${kr(paid)}</b></div><div class="kpi"><span class="tiny mut">Gevinst</span><b class="${total - paid >= 0 ? 'up' : 'down'}">${sgn(total - paid)}</b></div></div>
  <div class="box col"><h3>Samlingens værdi over tid</h3>${dayPts.length >= 2 ? sparkline(dayPts) : '<p class="small mut" style="margin:0">Grafen fyldes ud, efterhånden som appen gemmer priser – én gang om dagen, når du åbner den.</p>'}</div>
  <div class="box col"><h3>Største bevægelser (30 dage)</h3>${movers.length ? movers.map(m => `<button class="li" data-act="openEntry" data-v="${esc(m.e.id)}" style="padding:6px 0;background:transparent">${artEl(m.e.image, m.e.name)}<div class="grow"><div class="b">${esc(m.e.name)}</div><div class="tiny mut">${esc(m.e.setName)}</div></div><b class="nw ${m.ch >= 0 ? 'up' : 'down'}">${pct(m.ch)}</b></button>`).join('') : '<span class="small mut">Ingen data endnu.</span>'}</div>
  <div class="box col"><h3>Dyreste kort</h3>${top.length ? top.map(e => `<button class="li" data-act="openEntry" data-v="${esc(e.id)}" style="padding:6px 0;background:transparent">${artEl(e.image, e.name)}<div class="grow"><div class="b">${esc(e.name)}</div><div class="tiny mut">${esc(e.setName)}</div></div><b class="nw">${kr(unitValue(e))}</b></button>`).join('') : '<span class="small mut">Ingen kort endnu.</span>'}</div>
  <div class="box col"><h3>Værdi pr. samling</h3>${bars(group(e => COLLS[e.coll]))}</div>
  <div class="box col"><h3>Værdi pr. sæt</h3>${bars(group(e => e.setName).slice(0, 10))}</div>
  <div class="box col"><h3>Handler</h3>
  <div class="row between small"><span>Solgt til brugere (bekræftet): ${soldApp.length}</span><b>${kr(soldApp.reduce((a, r) => a + (+r.data.total || 0), 0))}</b></div>
  <div class="row between small"><span>Købt af brugere (bekræftet): ${boughtApp.length}</span><b>${kr(boughtApp.reduce((a, r) => a + (+r.data.total || 0), 0))}</b></div>
  <div class="row between small"><span>Solgt til andre: ${S.data.sold.length}</span><b>${kr(S.data.sold.reduce((a, s) => a + s.total, 0))}</b></div>
  <button class="btn ghost" data-act="tab" data-v="kvit">Se alle kvitteringer</button></div></div>`;
}

/* --- salg --- */
function vSell(){
  const sl = S.sell, e = entry(sl.id); if (!e){ S.view = null; return vSamling(); }
  const unit = +sl.price || 0, total = unit * sl.qty;
  const appMode = sl.mode === 'app';
  const ok = unit > 0 && sl.got && (!appMode || sl.buyer);
  const friends = acceptedFriends();
  const hint = !unit ? 'Skriv en pris.' : appMode && !sl.buyer ? 'Vælg køberen.' : !sl.got ? 'Bekræft at du har fået pengene.' : '';
  return `<div class="col">${back('Kortet')}<h1>Sælg kort</h1>
  <div class="li">${artEl(e.image, e.name)}<div class="grow"><div class="b">${esc(e.name)}</div><div class="tiny mut">${esc(e.setName)} · ${esc(e.localId)} · ${esc(e.cond)}</div></div></div>
  <div class="row" style="align-items:flex-end"><label class="f grow">Pris pr. stk. (kr)<input class="i" type="number" min="0" inputmode="numeric" data-s="price" value="${esc(sl.price)}"></label>
  <div class="col" style="gap:6px"><span class="small b mut">Antal</span><div class="row" style="gap:4px"><button class="btn ghost" style="width:48px;padding:0" data-act="sq" data-v="-1" aria-label="Færre">−</button><b style="width:28px;text-align:center">${sl.qty}</b><button class="btn ghost" style="width:48px;padding:0" data-act="sq" data-v="1" aria-label="Flere">+</button></div></div></div>
  <div class="col" style="gap:8px"><span class="small b mut">Køber</span>
  <div class="pills"><button class="pill" data-act="smode" data-v="app" aria-pressed="${appMode}">Bruger af Kortscanner</button><button class="pill" data-act="smode" data-v="other" aria-pressed="${!appMode}">Køber uden appen</button></div>
  ${appMode ? (sl.buyer ? `<div class="li">${avatar(S.profiles[sl.buyer], 36)}<div class="grow"><div class="b">${esc(pname(sl.buyer))}</div><div class="tiny mut">${esc(puser(sl.buyer))}</div></div><button class="btn text" data-act="clearBuyer">Skift</button></div>`
    : `${friends.length ? `<div class="col" style="gap:6px">${friends.map(id => `<button class="li" data-act="pickBuyer" data-v="${esc(id)}">${avatar(S.profiles[id], 32)}<span class="b">${esc(pname(id))}</span><span class="tiny mut">${esc(puser(id))}</span></button>`).join('')}</div>` : ''}
      <input class="i" type="search" data-s="q" value="${esc(sl.q)}" placeholder="Eller søg brugernavn" aria-label="Søg brugernavn" autocapitalize="none"><div id="hits" class="col" style="gap:6px">${hitsHtml()}</div>
      <span class="tiny mut">Køber og sælger får begge kvitteringen på deres konto. Køberen bekræfter handlen i sin app, og bagefter kan kvitteringen ikke ændres.</span>`)
    : `<label class="f">Køberens navn<input class="i" data-s="buyerName" value="${esc(sl.buyerName)}" autocomplete="off"></label><label class="f">Køberens e-mail (til kvitteringen)<input class="i" type="email" data-s="email" value="${esc(sl.email)}" autocomplete="off"></label>`}
  </div>
  <div class="pills">${['Kontant','MobilePay'].map(m => `<button class="pill" data-act="pay" data-v="${m}" aria-pressed="${sl.method === m}">${m}</button>`).join('')}</div>
  <button class="li" data-act="got" aria-pressed="${sl.got}" style="border:1px solid var(--line)"><span style="width:24px;height:24px;border-radius:6px;border:2px solid ${sl.got ? 'var(--acc)' : 'var(--mut)'};background:${sl.got ? 'var(--acc)' : 'transparent'};color:var(--accInk);display:grid;place-items:center;flex:none" aria-hidden="true">${sl.got ? '✓' : ''}</span><b>Jeg har modtaget ${kr(total)} ${sl.method === 'Kontant' ? 'kontant' : 'via MobilePay'}</b></button>
  <div class="row between"><span class="mut">I alt</span><span class="big" style="font-size:28px">${kr(total)}</span></div>
  <button class="btn full" data-act="doSell" ${ok ? '' : 'disabled'}>Registrér salg og lav kvittering</button>
  ${hint ? `<p class="small mut" style="text-align:center;margin:0">${esc(hint)}</p>` : ''}</div>`;
}
function hitsHtml(){
  const h = (S.sell && S.sell.hits) || [];
  return h.length ? h.map(p => `<button class="li" data-act="pickBuyer" data-v="${esc(p.id)}">${avatar(p, 32)}<span class="b">${esc(p.display_name || p.username)}</span><span class="tiny mut">@${esc(p.username)}</span></button>`).join('') : (S.sell && S.sell.q.length >= 2 ? '<span class="small mut">Ingen bruger med det navn.</span>' : '');
}
function receiptText(r){
  return ['Kvittering ' + r.no, 'Dato: ' + r.date, 'Sælger: ' + (r.sellerName || '-'), 'Køber: ' + (r.buyerName || '-'), '', r.qty + ' × ' + r.name, '   ' + [r.setName, r.localId, r.cond].filter(Boolean).join(' · '), '   ' + r.qty + ' × ' + kr(r.unit), '', 'I alt: ' + kr(r.total), 'Betalt med: ' + r.method, 'Privat salg, ingen moms.', 'Kontrolkode: ' + r.code].join('\n');
}
function paper(r, extra){
  return `<div class="box col" style="background:#fff;color:#15171C;gap:8px"><div class="row between"><b style="font:700 20px 'Space Grotesk',sans-serif">Kvittering</b><span style="color:#5C626C">${esc(r.no)}</span></div>
  <div style="color:#5C626C;font-size:14px">Dato: ${esc(r.date)}<br>Sælger: <b style="color:#15171C">${esc(r.sellerName || '-')}</b><br>Køber: <b style="color:#15171C">${esc(r.buyerName || '-')}</b>${r.email ? ' · ' + esc(r.email) : ''}</div>
  <div class="row between" style="border-top:1px dashed #C9C4B8;border-bottom:1px dashed #C9C4B8;padding:10px 0;align-items:flex-start;gap:10px">${r.image ? `<img src="${img(r.image,'low')}" alt="" style="width:48px;border-radius:4px">` : ''}<div class="grow"><b>${esc(r.qty)} × ${esc(r.name)}</b><br><span style="color:#5C626C;font-size:14px">${esc([r.setName, r.localId, r.cond].filter(Boolean).join(' · '))}</span><br><span style="color:#5C626C;font-size:14px">${esc(r.qty)} × ${kr(r.unit)}</span></div><b class="nw">${kr(r.total)}</b></div>
  <div class="row between b"><span>I alt</span><span>${kr(r.total)}</span></div>
  <span style="color:#5C626C;font-size:14px">Betalt med ${esc(r.method)}. Privat salg, ingen moms.</span>
  <div style="background:#F1EEE6;border-radius:10px;padding:8px 12px"><span style="color:#5C626C;font-size:12px">Kontrolkode</span><div style="font:700 17px 'Space Grotesk',monospace;letter-spacing:1px">${esc(r.code)}</div></div>
  ${extra || ''}</div>`;
}
function statusOf(row){
  if (row.status === 'confirmed') return {t:'Bekræftet af begge parter', s:'Bekræftet', col:'var(--up)'};
  if (row.status === 'rejected') return {t:'Afvist af køberen', s:'Afvist', col:'var(--down)'};
  return row.buyer === user.id ? {t:'Afventer din bekræftelse', s:'Venter på dig', col:'var(--link)'} : {t:'Venter på at ' + pname(row.buyer) + ' bekræfter', s:'Venter på køber', col:'var(--link)'};
}
function rData(row){ return {...row.data, sellerName: pname(row.seller) + (puser(row.seller) ? ' (' + puser(row.seller) + ')' : ''), buyerName: pname(row.buyer) + (puser(row.buyer) ? ' (' + puser(row.buyer) + ')' : '')}; }
function vReceipt(){
  const v = S.view;
  if (v.kind === 'local'){
    const s = S.data.sold.find(x => x.id === v.id); if (!s){ S.view = null; return vKvit(); }
    const r = {...s, sellerName: S.profile ? (S.profile.display_name || S.profile.username) : 'Dig', buyerName: s.buyer};
    const mail = `mailto:${encodeURIComponent(s.email || '')}?subject=${encodeURIComponent('Kvittering ' + s.no)}&body=${encodeURIComponent(receiptText(r))}`;
    return `<div class="col">${back()}<h1>Kvittering</h1>${paper(r)}
    ${navigator.share ? `<button class="btn full" data-act="shareR">Send kvittering</button>` : ''}
    <a class="btn ${navigator.share ? 'ghost' : ''} full" href="${esc(mail)}">Send som e-mail</a>
    <button class="btn ghost full" data-act="copyR">Kopiér som tekst</button></div>`;
  }
  const row = S.receipts.find(x => x.id === v.id); if (!row){ S.view = null; return vKvit(); }
  const st = statusOf(row), r = rData(row), needMe = row.buyer === user.id && row.status === 'pending';
  return `<div class="col">${back()}<h1>${needMe ? 'Bekræft dit køb' : 'Kvittering'}</h1>
  <div class="row" style="border:2px solid ${st.col};border-radius:12px;padding:12px 14px;gap:10px"><span style="width:10px;height:10px;border-radius:50%;background:${st.col};flex:none"></span><b>${esc(st.t)}</b></div>
  ${paper(r, '<span style="color:#5C626C;font-size:12px">Kvitteringen ligger på både sælgers og købers konto. Når køberen har svaret, er den låst og kan ikke ændres.</span>')}
  ${needMe ? `<button class="btn full" data-act="rcConfirm">Bekræft køb</button><p class="small mut" style="text-align:center;margin:0">Kortet lægges i din Binder med købsprisen.</p><button class="btn danger full" data-act="rcReject">Afvis – det passer ikke</button>` : ''}
  ${navigator.share ? `<button class="btn ghost full" data-act="shareR">Del kvittering</button>` : ''}
  <button class="btn ghost full" data-act="copyR">Kopiér som tekst</button></div>`;
}
function vKvit(){
  const rows = S.receipts.filter(r => S.rcFilter === 'all' || (S.rcFilter === 'sold' ? r.seller === user.id : r.buyer === user.id));
  const locals = S.rcFilter === 'bought' ? [] : S.data.sold.slice().reverse();
  const pend = toConfirm();
  return `<div class="col">${back()}<h1>Kvitteringer</h1>
  ${pend.length ? `<div class="col" style="gap:8px"><h3>Venter på dig</h3>${pend.map(rcRow).join('')}</div>` : ''}
  <div class="pills">${[['all','Alle'],['sold','Solgt'],['bought','Købt']].map(([k, l]) => `<button class="pill" data-act="rcf" data-v="${k}" aria-pressed="${S.rcFilter === k}">${l}</button>`).join('')}</div>
  ${rows.length || locals.length ? rows.map(rcRow).join('') + locals.map(s => `<button class="li" data-act="openLocalR" data-v="${esc(s.id)}"><div class="grow col" style="gap:2px"><span class="b">${esc(s.qty)} × ${esc(s.name)}</span><span class="tiny mut">Solgt til ${esc(s.buyer || 'køber uden app')} · ${esc(s.date)}</span><span class="tiny mut">Kvittering uden app</span></div><b class="nw">${kr(s.total)}</b></button>`).join('')
  : `<div class="box"><p class="mut" style="margin:0">Ingen kvitteringer endnu. Når du sælger et kort, ligger kvitteringen her.</p></div>`}</div>`;
}
function rcRow(row){
  const st = statusOf(row), sold = row.seller === user.id, d = row.data || {};
  return `<button class="li" data-act="openR" data-v="${esc(row.id)}"><div class="grow col" style="gap:2px"><span class="b">${esc(d.qty)} × ${esc(d.name)}</span><span class="tiny mut">${sold ? 'Solgt til' : 'Købt af'} ${esc(pname(sold ? row.buyer : row.seller))} · ${esc(d.date || '')}</span><span class="tiny b" style="color:${st.col}">${esc(st.s)}</span></div><b class="nw">${kr(d.total)}</b></button>`;
}

/* --- venner --- */
function vVenner(){
  const inc = incomingReq(), out = outgoingReq(), fr = acceptedFriends();
  return `<div class="col"><h1>Venner</h1>
  <div class="box col"><h3>Find venner</h3><input class="i" type="search" data-f="fq" value="${esc(S.fq)}" placeholder="Søg brugernavn" aria-label="Søg brugernavn" autocapitalize="none"><div id="fhits" class="col" style="gap:6px">${fhitsHtml()}</div>
  ${S.profile ? `<span class="tiny mut">Dit brugernavn er <b>@${esc(S.profile.username)}</b> – giv det til dine venner.</span>` : ''}</div>
  ${inc.length ? `<div class="col" style="gap:8px"><h3>Venneanmodninger</h3>${inc.map(f => `<div class="li">${avatar(S.profiles[f.requester], 40)}<div class="grow"><div class="b">${esc(pname(f.requester))}</div><div class="tiny mut">${esc(puser(f.requester))}</div></div><button class="btn" data-act="fAccept" data-v="${f.id}" style="min-height:40px">Accepter</button><button class="btn text" data-act="fRemove" data-v="${f.id}">Afvis</button></div>`).join('')}</div>` : ''}
  <div class="col" style="gap:8px"><h3>Dine venner (${fr.length})</h3>
  ${fr.length ? fr.map(id => `<button class="li" data-act="openFriend" data-v="${esc(id)}">${avatar(S.profiles[id], 40)}<div class="grow"><div class="b">${esc(pname(id))}</div><div class="tiny mut">${esc(puser(id))}</div></div><span class="mut">›</span></button>`).join('') : '<div class="box"><p class="mut small" style="margin:0">Du har ingen venner i appen endnu. Søg efter deres brugernavn ovenfor.</p></div>'}</div>
  ${out.length ? `<div class="col" style="gap:8px"><h3>Sendte anmodninger</h3>${out.map(f => `<div class="li">${avatar(S.profiles[f.addressee], 36)}<div class="grow"><div class="b">${esc(pname(f.addressee))}</div><div class="tiny mut">Venter på svar</div></div><button class="btn text" data-act="fRemove" data-v="${f.id}">Annullér</button></div>`).join('')}</div>` : ''}</div>`;
}
function fhitsHtml(){
  if (S.fq.trim().length < 2) return '';
  if (!S.fhits.length) return '<span class="small mut">Ingen bruger med det navn.</span>';
  return S.fhits.map(p => {
    const rel = S.friends.find(f => otherOf(f) === p.id);
    const state = rel ? (rel.status === 'accepted' ? '<span class="tiny b up">Ven</span>' : '<span class="tiny mut">Anmodning sendt</span>') : `<button class="btn" data-act="fAdd" data-v="${esc(p.id)}" style="min-height:40px">Tilføj</button>`;
    return `<div class="li">${avatar(p, 36)}<div class="grow"><div class="b">${esc(p.display_name || p.username)}</div><div class="tiny mut">@${esc(p.username)}</div></div>${state}</div>`;
  }).join('');
}
function vFriend(){
  const fv = S.friendView, id = S.view.id;
  if (!fv || fv.id !== id) return `<div class="col">${back('Venner')}${spinner('Henter samlingen …')}</div>`;
  const p = S.profiles[id];
  const list = fv.entries.filter(e => fv.coll === 'wish' ? e.coll === 'wish' : e.coll !== 'wish');
  const total = fv.entries.filter(e => e.coll !== 'wish').reduce((a, e) => a + value(e), 0);
  return `<div class="col">${back('Venner')}
  <div class="row">${avatar(p, 56)}<div><h1 style="font-size:24px">${esc(pname(id))}</h1><span class="small mut">${esc(puser(id))}</span></div></div>
  ${fv.hidden ? '<div class="box"><p class="mut" style="margin:0">Din ven deler ikke sin samling lige nu.</p></div>' : `
  <div class="box col" style="gap:4px"><span class="small mut">Samlingens værdi</span><span class="big">${kr(total)}</span><span class="small mut">${fv.entries.filter(e => e.coll !== 'wish').length} kort · ${fv.entries.filter(e => e.coll === 'wish').length} på ønskelisten</span></div>
  <div class="pills"><button class="pill" data-act="fvColl" data-v="have" aria-pressed="${fv.coll !== 'wish'}">Samling</button><button class="pill" data-act="fvColl" data-v="wish" aria-pressed="${fv.coll === 'wish'}">Ønskeliste</button></div>
  ${list.length ? `<div class="cards">${list.sort((a, b) => value(b) - value(a)).map(e => `<button class="tile" data-act="openCard" data-v="${esc(e.cardId)}" data-l="${esc(e.api || 'en')}">${artEl(e.image, e.name, e.qty)}<span class="name">${esc(e.name)}</span><span class="tiny mut">${esc(e.setName)} · ${esc(e.localId)}</span><b class="small">${unitValue(e) ? kr(value(e)) : '–'}</b></button>`).join('')}</div>` : '<p class="mut small">Ingen kort her.</p>'}`}
  <button class="btn danger full" data-act="unfriend">${S.delArm ? 'Tryk igen for at fjerne som ven' : 'Fjern som ven'}</button></div>`;
}

/* --- profil og konto --- */
function vProfil(){
  const p = S.profile || {}, n = S.data.entries.length;
  return `<div class="col">${back()}
  <div class="row">${avatar(p, 64)}<div class="col" style="gap:2px"><h1 style="font-size:24px">${esc(p.display_name || p.username || 'Din profil')}</h1><span class="small mut">@${esc(p.username || '')} · ${esc(user ? user.email : '')}</span></div></div>
  <div class="box col"><h3>Profil</h3>
  <label class="f">Visningsnavn<input class="i" data-p="display_name" value="${esc(p.display_name || '')}" maxlength="40" placeholder="Valgfrit, f.eks. dit fornavn"></label>
  <div class="col" style="gap:6px"><span class="small b mut">Farve</span><div class="row wrapr">${COLORS.map(c => `<button class="swatch" data-act="color" data-v="${c}" aria-label="Vælg farve" aria-pressed="${p.color === c}" style="background:${c}"></button>`).join('')}</div></div>
  <button class="li" data-act="toggleShare" aria-pressed="${!!p.share_collection}" style="border:1px solid var(--line)"><span style="width:24px;height:24px;border-radius:6px;border:2px solid ${p.share_collection ? 'var(--acc)' : 'var(--mut)'};background:${p.share_collection ? 'var(--acc)' : 'transparent'};color:var(--accInk);display:grid;place-items:center;flex:none" aria-hidden="true">${p.share_collection ? '✓' : ''}</span><span><b>Del min samling med venner</b><br><span class="tiny mut">Venner kan se dine kort og din ønskeliste – aldrig købspriser eller noter.</span></span></button></div>
  <div class="row wrapr"><button class="btn ghost" data-act="tab" data-v="venner">Venner</button><button class="btn ghost" data-act="tab" data-v="kvit">Kvitteringer</button><button class="btn ghost" data-act="tab" data-v="noter">Beskeder</button></div>
  <div class="box col"><h3>Skift adgangskode</h3><label class="f">Ny adgangskode<input class="i" type="password" id="newPass" autocomplete="new-password" minlength="8"></label><span class="tiny mut">Mindst 8 tegn.</span><button class="btn ghost" data-act="changePass">Gem ny adgangskode</button></div>
  <div class="box col"><h3>Læg appen på hjemmeskærmen</h3><p class="small mut" style="margin:0"><b>iPhone:</b> tryk på Del-knappen i Safari og vælg “Føj til hjemmeskærm”.<br><b>Android:</b> tryk på menuen ⋮ i Chrome og vælg “Installer app”.</p></div>
  <div class="box col"><h3>Backup</h3><p class="small mut" style="margin:0">Din samling (${n} kort) ligger på din konto${S.syncErr ? ' – <b class="down">seneste gemning fejlede, prøver igen</b>' : ''}. Du kan også gemme en kopi som fil.</p>
  <button class="btn ghost" data-act="export">Gem backup-fil</button><label class="btn ghost" for="importIn">Hent fra backup-fil</label></div>
  <div class="box col"><h3>Om data</h3><p class="small mut" style="margin:0">Kortdata, billeder og priser kommer fra <a href="https://tcgdex.dev" target="_blank" rel="noopener" style="color:var(--link)">TCGdex</a> (Cardmarket og TCGplayer). Billederne tilhører The Pokémon Company. Din konto og samling gemmes hos Supabase i EU.</p></div>
  <button class="btn ghost full" data-act="logout">Log ud</button>
  <div class="box col" style="border:1px solid var(--down)"><h3 class="down">Slet konto</h3><p class="small mut" style="margin:0">Sletter din konto, din samling og dine venskaber for altid. Kvitteringer, du har med andre, bliver hos dem.</p>
  ${S.delAcc ? `<label class="f">Skriv SLET for at bekræfte<input class="i" id="delConfirm" autocomplete="off" autocapitalize="characters"></label><button class="btn danger" data-act="deleteAccount">Slet min konto for altid</button><button class="btn text" data-act="cancelDel">Fortryd</button>` : `<button class="btn danger" data-act="armDelete">Slet min konto</button>`}</div></div>`;
}
function vNoter(){
  const inc = incomingReq(), pend = toConfirm(), notes = S.notes.slice().reverse();
  const empty = !inc.length && !pend.length && !notes.length;
  return `<div class="col">${back()}<h1>Beskeder</h1>
  ${pend.map(r => `<button class="li" data-act="openR" data-v="${esc(r.id)}" style="border:2px solid var(--acc)"><div class="grow"><div class="b">${esc(pname(r.seller))} har registreret et salg til dig</div><div class="tiny mut">${esc(r.data.name)} · ${kr(r.data.total)} · tryk for at bekræfte</div></div></button>`).join('')}
  ${inc.map(f => `<button class="li" data-act="tab" data-v="venner"><div class="grow"><div class="b">${esc(pname(f.requester))} vil være venner</div><div class="tiny mut">${esc(puser(f.requester))} · tryk for at svare</div></div></button>`).join('')}
  ${notes.map(n => `<button class="li" data-act="${n.entry ? 'openEntry' : 'noop'}" data-v="${esc(n.entry || '')}" style="${n.read ? '' : 'border:1px solid var(--acc)'}"><div class="grow"><div class="b">${esc(n.text)}</div><div class="tiny mut">${esc(new Date(n.t).toLocaleString('da-DK'))}</div></div></button>`).join('')}
  ${empty ? '<div class="box"><p class="mut" style="margin:0">Ingen beskeder. Her kommer prisalarmer, venneanmodninger og køb, du skal bekræfte.</p></div>' : ''}
  ${notes.length ? '<button class="btn text" data-act="clearNotes">Ryd prisbeskeder</button>' : ''}</div>`;
}

/* ---------- render ---------- */
function render(){
  if (!user) return;
  const app = $('#app'); const v = S.view;
  let html;
  if (v){ html = v.type === 'card' ? vCard() : v.type === 'entry' ? vEntry() : v.type === 'set' ? vSet() : v.type === 'sell' ? vSell() : v.type === 'receipt' ? vReceipt() : v.type === 'friend' ? vFriend() : ''; }
  else html = ({scan:vScan, sog:vSog, saet:vSaet, stat:vStat, venner:vVenner, kvit:vKvit, profil:vProfil, noter:vNoter})[S.tab]?.() ?? vSamling();
  app.innerHTML = html;
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-current', !v && b.dataset.v === S.tab ? 'page' : 'false'));
  const vid = $('#vid'); if (vid && stream){ vid.srcObject = stream; vid.play().catch(() => {}); }
  updateBadges();
}
function go(view){ S.view = view; S.delArm = false; render(); window.scrollTo(0, 0); }

/* ---------- kamera ---------- */
let stream = null;
async function startCam(){
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ S.scan = {phase:'nocam', msg:'Denne browser giver ikke adgang til kameraet her. Vælg et billede i stedet.'}; render(); return; }
  S.scan = {phase:'starting'}; render();
  try {
    stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}, width:{ideal:1920}, height:{ideal:1440}}, audio:false});
    S.scan = {phase:'live'}; render();
  } catch(e){
    S.scan = {phase:'nocam', msg: e && e.name === 'NotAllowedError' ? 'Du har ikke givet appen lov til at bruge kameraet. Tillad kameraet i browserens indstillinger, eller vælg et billede.' : 'Kameraet kunne ikke startes. Du kan stadig tage eller vælge et billede.'}; render();
  }
}
function stopCam(){ if (stream){ stream.getTracks().forEach(t => t.stop()); stream = null; } }
function snap(){
  const vid = $('#vid'); if (!vid || !vid.videoWidth) return;
  const box = vid.parentElement.getBoundingClientRect(), W = box.width, H = box.height, vw = vid.videoWidth, vh = vid.videoHeight;
  const sc = Math.max(W / vw, H / vh), ox = (W - vw * sc) / 2, oy = (H - vh * sc) / 2;
  const fh = H * 0.84, fw = fh * 63 / 88, fx = (W - fw) / 2, fy = (H - fh) / 2;
  const sx = (fx - ox) / sc, sy = (fy - oy) / sc, sw = fw / sc, sh = fh / sc;
  const c = document.createElement('canvas'); c.width = 900; c.height = Math.round(900 * 88 / 63);
  c.getContext('2d').drawImage(vid, sx, sy, sw, sh, 0, 0, c.width, c.height);
  stopCam(); identify(c);
}
async function fromFile(file){
  if (!file) return;
  const url = URL.createObjectURL(file); const im = new Image();
  im.onload = () => { const k = Math.min(1, 1400 / Math.max(im.width, im.height)); const c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url); stopCam(); identify(c); };
  im.onerror = () => toast('Kunne ikke læse billedet.');
  im.src = url;
}

/* ---------- kortlæser (OCR) ---------- */
let worker = null;
async function getWorker(){
  if (worker) return worker;
  if (!window.Tesseract) throw new Error('ocr-missing');
  worker = await Tesseract.createWorker('eng');
  return worker;
}
function region(src, y0, y1, x0 = 0, x1 = 1, filter = 'grayscale(1) contrast(1.6)', width = 1600){
  const sx = src.width * x0, sy = src.height * y0, sw = src.width * (x1 - x0), sh = src.height * (y1 - y0);
  const k = Math.max(1, width / sw); const c = document.createElement('canvas'); c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  const g = c.getContext('2d'); g.filter = filter; g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}
const STOP = new Set(['BASIC','STAGE','HP','TRAINER','ITEM','SUPPORTER','STADIUM','EVOLVES','FROM','POKEMON','POKÉMON','ENERGY','TOOL','PUT','THIS','CARD','ONTO','ACE','SPEC']);
function guessName(text){
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const l of lines){
    const words = l.replace(/[^A-Za-zÀ-ÿ'\-\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2 && !STOP.has(w.toUpperCase()));
    const keep = words.filter(w => /[a-z]/.test(w) || w.length > 2);
    if (keep.length && keep.join('').length >= 3) return keep.slice(0, 3).join(' ');
  }
  return '';
}
function guessNumber(text){
  const t = text.replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, '0').replace(/[|\\]/g, '/');
  const m = t.match(/(?:^|[^A-Za-z0-9])([A-Z]{0,3})(\d{1,3})\s?\/\s?([A-Z]{0,3})(\d{2,3})(?![0-9])/);
  if (!m) return null;
  return {pre:(m[1] || '').toUpperCase(), local:m[2], total:+m[4], text:(m[1] || '') + m[2] + '/' + (m[3] || '') + m[4]};
}
const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
function nameScore(a, b){
  a = norm(a); b = norm(b); if (!a || !b) return 0;
  if (a === b) return 100; if (b.includes(a) || a.includes(b)) return 80;
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  return p * 10;
}
async function identify(canvas){
  const lang = S.lang;
  S.scan = {phase:'busy', img:canvas.toDataURL('image/jpeg', 0.8), msg:'Gør kortlæseren klar …', lang}; render();
  try {
    const w = await getWorker();
    S.scan.msg = 'Læser kortet …'; render();
    const bottom = await w.recognize(region(canvas, 0.86, 1));
    const top = lang === 'en' ? await w.recognize(region(canvas, 0, 0.16)) : {data:{text:''}};
    let num = guessNumber(bottom.data.text), name = guessName(top.data.text);
    if (!num){ const left = await w.recognize(region(canvas, 0.84, 1, 0, 0.55)); num = guessNumber(left.data.text); }
    if (!num){ const z = await w.recognize(region(canvas, 0.88, 0.99, 0, 0.45, 'grayscale(1) contrast(2.5) brightness(1.1)', 2200)); num = guessNumber(z.data.text); }
    S.scan.msg = 'Finder kortet …'; render();
    let cands = [];
    if (num){
      const sets = await getSets(lang);
      const hits = sets.filter(s => s.official === num.total || (num.pre && s.total === num.total));
      const locals = [...new Set([num.pre + num.local, num.pre + String(+num.local), num.pre + num.local.padStart(3, '0'), num.local])];
      const tries = []; hits.slice(0, 30).forEach(s => locals.forEach(l => tries.push({s, l})));
      const found = await Promise.all(tries.map(t => api('/sets/' + encodeURIComponent(t.s.id) + '/' + encodeURIComponent(t.l), lang).catch(() => null)));
      if (num.pre){ const byId = await api('/cards?localId=eq:' + encodeURIComponent(num.pre + num.local), lang).catch(() => null); for (const b of (byId || []).filter(x => !isPocket(x.id)).slice(0, 6)){ const full = await getCard(b.id, lang).catch(() => null); if (full) found.push(full); } }
      const seen = new Set();
      found.forEach(c => { if (c && !seen.has(c.id)){ seen.add(c.id); S.cardCache[ck(c.id, lang)] = c; cands.push({id:c.id, name:c.name, image:c.image, setName:c.set && c.set.name, localId:c.localId}); } });
      if (name) cands.sort((a, b) => nameScore(name, b.name) - nameScore(name, a.name));
      if (name && cands.length > 1 && nameScore(name, cands[0].name) >= 80) cands = cands.filter(c => nameScore(name, c.name) >= 80);
    }
    if (!cands.length && name && lang === 'en'){
      const r = await api('/cards?name=' + encodeURIComponent(name), lang);
      cands = (r || []).filter(c => !isPocket(c.id)).slice(0, 24).map(c => ({id:c.id, name:c.name, image:c.image, localId:c.localId}));
    }
    S.scan = {phase:'result', lang, cands, guess:{name, num: num && num.text}, msg: num || name ? 'Der var ingen kort, der passede til det, appen læste.' : 'Appen kunne ikke læse nummeret på billedet.'};
    if (cands.length === 1){ go({type:'card', id:cands[0].id, lang}); return; }
  } catch(e){
    S.scan = {phase:'result', lang, cands:[], msg: e && e.message === 'ocr-missing' ? 'Kortlæseren kunne ikke hentes. Tjek din internetforbindelse.' : 'Der skete en fejl. Tjek din internetforbindelse og prøv igen.'};
  }
  render();
}

/* ---------- søgning ---------- */
let searchT, searchN = 0;
function doSearch(q){
  clearTimeout(searchT);
  const s = S.search; s.q = q; s.lang = S.lang;
  const min = S.lang === 'ja' ? 2 : 3;
  if (q.trim().length < min){ s.results = null; s.err = ''; s.busy = false; const r = $('#results'); if (r) r.innerHTML = resultsHtml(); return; }
  searchT = setTimeout(async () => {
    const n = ++searchN, lang = S.lang; s.busy = true; s.err = ''; const r0 = $('#results'); if (r0) r0.innerHTML = resultsHtml();
    try {
      const [res, sets] = await Promise.all([api('/cards?name=' + encodeURIComponent(q.trim()), lang), getSets(lang).catch(() => [])]);
      if (n !== searchN) return;
      const names = {}; (sets || []).forEach(x => names[x.id] = x.name);
      const list = (res || []).filter(c => lang !== 'en' || !isPocket(c.id)).map(c => ({...c, setName: names[setOf(c.id)] || ''}));
      s.results = list.filter(c => c.image).concat(list.filter(c => !c.image)); s.lang = lang;
    } catch(e){ if (n !== searchN) return; s.err = 'Kunne ikke søge lige nu. Tjek din internetforbindelse.'; s.results = null; }
    s.busy = false; const r = $('#results'); if (r) r.innerHTML = resultsHtml();
  }, 400);
}
let fqT;
function friendSearch(q){
  S.fq = q; clearTimeout(fqT);
  const box = () => { const b = $('#fhits'); if (b) b.innerHTML = fhitsHtml(); };
  if (q.trim().length < 2){ S.fhits = []; box(); return; }
  fqT = setTimeout(async () => {
    const {data} = await sb.from('profiles').select('id,username,display_name,color').ilike('username', q.trim().toLowerCase().replace(/^@/, '').replace(/[%_]/g, '') + '%').limit(10);
    S.fhits = (data || []).filter(p => p.id !== user.id); S.fhits.forEach(p => S.profiles[p.id] = S.profiles[p.id] || p); box();
  }, 300);
}
let bqT;
function buyerSearch(q){
  S.sell.q = q; clearTimeout(bqT);
  const box = () => { const b = $('#hits'); if (b) b.innerHTML = hitsHtml(); };
  if (q.trim().length < 2){ S.sell.hits = []; box(); return; }
  bqT = setTimeout(async () => {
    const {data} = await sb.from('profiles').select('id,username,display_name,color').ilike('username', q.trim().toLowerCase().replace(/^@/, '').replace(/[%_]/g, '') + '%').limit(8);
    S.sell.hits = (data || []).filter(p => p.id !== user.id); S.sell.hits.forEach(p => S.profiles[p.id] = S.profiles[p.id] || p); box();
  }, 300);
}

/* ---------- handlinger ---------- */
async function openCard(id, lang){
  lang = lang || 'en';
  go({type:'card', id, lang});
  if (!cached(id, lang)){ try { await getCard(id, lang); } catch(e){ toast('Kunne ikke hente kortet.'); } if (S.view && S.view.id === id) render(); }
}
async function openEntry(id){
  const e = entry(id); go({type:'entry', id});
  if (e && !cached(e.cardId, e.api)){ try { const c = await getCard(e.cardId, e.api); if (c){ applyPrice(e, c); save(); } } catch(x){} if (S.view && S.view.id === id) render(); }
}
async function openSet(id, lang){ lang = lang || 'en'; go({type:'set', id, lang, missing:false}); if (!S.setCache[ck(id, lang)]){ try { await getSet(id, lang); } catch(e){ toast('Kunne ikke hente sættet.'); } if (S.view && S.view.id === id) render(); } }
async function openFriend(id){
  S.friendView = null; go({type:'friend', id});
  const {data, error} = await sb.rpc('friend_collection', {friend:id});
  S.friendView = {id, coll:'have', entries:(data || []), hidden: !error && (!data || !data.length) && S.profiles[id] && S.profiles[id].share_collection === false};
  if (S.view && S.view.id === id) render();
}
function addCard(){
  const {id, lang} = S.view, c = cached(id, lang); if (!c) return;
  const e = {id:uid(), cardId:c.id, api:lang || 'en', name:c.name, setId:c.set && c.set.id, setName:c.set && c.set.name, localId:c.localId, official:c.set && c.set.cardCount && c.set.cardCount.official,
    image:c.image || '', rarity:c.rarity || '', coll:$('#aColl').value, qty:Math.max(1, parseInt($('#aQty').value) || 1), cond:$('#aCond').value, variant:$('#aVar').value, lang:$('#aLang').value,
    buy:Math.max(0, parseInt($('#aBuy').value) || 0), manual:0, note:'', added:new Date().toISOString()};
  applyPrice(e, c);
  S.data.entries.push(e); save();
  toast(e.name + ' er lagt i ' + COLLS[e.coll] + '.');
  S.scan = {phase:'idle'}; S.tab = 'samling'; go({type:'entry', id:e.id});
}
async function doSell(){
  const sl = S.sell, e = entry(sl.id); const unit = +sl.price || 0; if (!e || !unit || !sl.got) return;
  const d = new Date(), code = Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const base = {no:'KS-' + d.toISOString().slice(2, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 5).toUpperCase(), code, date:d.toLocaleDateString('da-DK'),
    name:e.name, cardId:e.cardId, api:e.api || 'en', setId:e.setId, setName:e.setName, localId:e.localId, official:e.official, rarity:e.rarity, variant:e.variant, image:e.image, cond:e.cond, qty:sl.qty, unit, total:unit * sl.qty, method:sl.method};
  if (sl.mode === 'app'){
    if (!sl.buyer) return;
    const row = {id:uid(), seller:user.id, buyer:sl.buyer, data:base, status:'pending'};
    const btn = $('[data-act="doSell"]'); if (btn){ btn.disabled = true; btn.textContent = 'Gemmer …'; }
    const {error} = await sb.from('receipts').insert(row);
    if (error){ toast('Kunne ikke gemme kvitteringen. Tjek forbindelsen og prøv igen.'); render(); return; }
    S.receipts.unshift({...row, created_at:new Date().toISOString()});
    const left = (+e.qty || 1) - sl.qty; if (left > 0) e.qty = left; else S.data.entries = S.data.entries.filter(x => x.id !== e.id);
    save(); S.sell = null; toast('Salget er registreret. ' + pname(row.buyer) + ' skal bekræfte i sin app.'); go({type:'receipt', kind:'app', id:row.id});
  } else {
    const s = {id:uid(), ...base, buyer:sl.buyerName.trim(), email:sl.email.trim()};
    S.data.sold.push(s);
    const left = (+e.qty || 1) - sl.qty; if (left > 0) e.qty = left; else S.data.entries = S.data.entries.filter(x => x.id !== e.id);
    save(); S.sell = null; toast('Salget er registreret.'); go({type:'receipt', kind:'local', id:s.id});
  }
}
async function answerReceipt(ok){
  const row = S.receipts.find(x => x.id === S.view.id); if (!row) return;
  const {error} = await sb.from('receipts').update({status: ok ? 'confirmed' : 'rejected'}).eq('id', row.id);
  if (error){ toast('Kunne ikke gemme dit svar. Måske har du allerede svaret – genindlæs appen.'); return; }
  row.status = ok ? 'confirmed' : 'rejected';
  if (ok){
    const d = row.data;
    const e = {id:uid(), cardId:d.cardId, api:d.api || 'en', name:d.name, setId:d.setId, setName:d.setName, localId:d.localId, official:d.official, image:d.image || '', rarity:d.rarity || '', coll:'binder', qty:d.qty, cond:d.cond || 'Near Mint', variant:d.variant || 'normal', lang:'Engelsk', buy:d.unit, manual:0, note:'Købt af ' + pname(row.seller) + ' (' + d.no + ')', added:new Date().toISOString()};
    S.data.entries.push(e); save();
    try { const c = await getCard(e.cardId, e.api); if (c){ applyPrice(e, c); save(); } } catch(x){}
    toast('Købet er bekræftet, og kortet ligger i din Binder.');
  } else toast('Du har afvist handlen.');
  render();
}
function exportData(){
  const blob = new Blob([JSON.stringify({app:'kortscanner', v:2, exported:new Date().toISOString(), ...S.data}, null, 1)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'kortscanner-backup-' + isoDay() + '.json';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Backup-filen er gemt.');
}
function importData(file){
  if (!file) return; const r = new FileReader();
  r.onload = () => { try { const d = JSON.parse(r.result); if (!Array.isArray(d.entries)) throw 0;
      const have = new Set(S.data.entries.map(e => e.id)); let n = 0;
      d.entries.forEach(e => { if (e && e.id && e.cardId && !have.has(e.id)){ if (!e.api) e.api = 'en'; S.data.entries.push(e); n++; } });
      const hs = new Set(S.data.sold.map(s => s.id)); (d.sold || []).forEach(s => { if (s && s.id && !hs.has(s.id)) S.data.sold.push(s); });
      save(); render(); toast(n + ' kort hentet fra backup.'); }
    catch(e){ toast('Filen er ikke en gyldig Kortscanner-backup.'); } };
  r.readAsText(file);
}
async function saveProfile(patch){
  Object.assign(S.profile, patch); S.profiles[user.id] = S.profile; render();
  const {error} = await sb.from('profiles').update(patch).eq('id', user.id);
  if (error) toast('Kunne ikke gemme din profil.');
}

document.addEventListener('click', async ev => {
  const b = ev.target.closest('[data-act]'); if (!b || !user) return;
  const a = b.dataset.act, v = b.dataset.v;
  if (a !== 'del' && a !== 'unfriend') S.delArm = false;
  switch (a){
    case 'tab': if (v !== 'scan') stopCam(); S.tab = v; S.view = null; if (v === 'scan' && S.scan.phase !== 'result') S.scan = {phase:'idle'}; if (v === 'noter'){ render(); S.notes.forEach(n => n.read = true); persistLocal(); updateBadges(); window.scrollTo(0, 0); return; } render(); window.scrollTo(0, 0); if (['venner','kvit'].includes(v)) loadSocial(); if (v === 'scan' && S.scan.phase === 'idle' && localStorage.getItem('kortscanner.camok')) startCam(); return;
    case 'back': if (S.view && S.view.type === 'sell'){ const id = S.sell.id; S.sell = null; go({type:'entry', id}); } else if (S.view) go(null); else { S.tab = 'samling'; render(); window.scrollTo(0, 0); } return;
    case 'coll': S.coll = v; break;
    case 'lang': S.lang = v; S.search = {q:'', results:null, busy:false, err:''}; break;
    case 'refresh': refreshPrices(true); return;
    case 'openEntry': openEntry(v); return;
    case 'openCard': openCard(v, b.dataset.l); return;
    case 'openSet': openSet(v, b.dataset.l); return;
    case 'setMissing': S.view.missing = v === '1'; break;
    case 'startCam': try { localStorage.setItem('kortscanner.camok', '1'); } catch(e){} startCam(); return;
    case 'snap': snap(); return;
    case 'rescan': S.scan = {phase:'idle'}; startCam(); return;
    case 'toSearch': S.tab = 'sog'; S.view = null; render(); return;
    case 'add': addCard(); return;
    case 'move': entry(S.view.id).coll = v; save(); break;
    case 'del': if (!S.delArm){ S.delArm = true; break; } S.data.entries = S.data.entries.filter(e => e.id !== S.view.id); save(); toast('Kortet er slettet.'); go(null); return;
    case 'sell': { const e = entry(S.view.id); S.sell = {id:e.id, price:String(Math.round(unitValue(e)) || ''), qty:1, mode:'app', buyer:'', q:'', hits:[], buyerName:'', email:'', method:'Kontant', got:false}; go({type:'sell', id:e.id}); return; }
    case 'smode': S.sell.mode = v; break;
    case 'sq': { const e = entry(S.sell.id); S.sell.qty = Math.min(+e.qty || 1, Math.max(1, S.sell.qty + (+v))); break; }
    case 'pickBuyer': S.sell.buyer = v; break;
    case 'clearBuyer': S.sell.buyer = ''; break;
    case 'pay': S.sell.method = v; S.sell.got = false; break;
    case 'got': S.sell.got = !S.sell.got; break;
    case 'doSell': doSell(); return;
    case 'openR': go({type:'receipt', kind:'app', id:v}); return;
    case 'openLocalR': go({type:'receipt', kind:'local', id:v}); return;
    case 'rcf': S.rcFilter = v; break;
    case 'rcConfirm': answerReceipt(true); return;
    case 'rcReject': answerReceipt(false); return;
    case 'shareR': case 'copyR': {
      const r = S.view.kind === 'local' ? (() => { const s = S.data.sold.find(x => x.id === S.view.id); return {...s, sellerName: S.profile ? (S.profile.display_name || S.profile.username) : '', buyerName:s.buyer}; })() : rData(S.receipts.find(x => x.id === S.view.id));
      if (a === 'shareR') navigator.share({title:'Kvittering ' + r.no, text:receiptText(r)}).catch(() => {});
      else (navigator.clipboard ? navigator.clipboard.writeText(receiptText(r)) : Promise.reject()).then(() => toast('Kvitteringen er kopieret.'), () => toast('Kunne ikke kopiere.'));
      return; }
    case 'fAdd': { const {error} = await sb.from('friendships').insert({requester:user.id, addressee:v}); if (error) toast(/duplicate|unique/i.test(error.message) ? 'I er allerede forbundet, eller der ligger en anmodning.' : 'Kunne ikke sende anmodningen.'); else toast('Venneanmodning sendt.'); await loadSocial(); const bx = $('#fhits'); if (bx) bx.innerHTML = fhitsHtml(); return; }
    case 'fAccept': { const {error} = await sb.from('friendships').update({status:'accepted'}).eq('id', +v); if (error) toast('Kunne ikke acceptere.'); else toast('I er nu venner.'); loadSocial(); return; }
    case 'fRemove': { await sb.from('friendships').delete().eq('id', +v); loadSocial(); return; }
    case 'openFriend': openFriend(v); return;
    case 'fvColl': S.friendView.coll = v; break;
    case 'unfriend': { if (!S.delArm){ S.delArm = true; break; } const f = S.friends.find(x => x.status === 'accepted' && otherOf(x) === S.view.id); if (f) await sb.from('friendships').delete().eq('id', f.id); S.delArm = false; toast('Fjernet som ven.'); S.tab = 'venner'; go(null); loadSocial(); return; }
    case 'color': saveProfile({color:v}); return;
    case 'toggleShare': saveProfile({share_collection: !S.profile.share_collection}); return;
    case 'changePass': { const p = $('#newPass').value; if (p.length < 8){ toast('Adgangskoden skal være mindst 8 tegn.'); return; } const {error} = await sb.auth.updateUser({password:p}); toast(error ? 'Kunne ikke skifte adgangskode.' : 'Din nye adgangskode er gemt.'); if (!error) $('#newPass').value = ''; return; }
    case 'armDelete': S.delAcc = true; break;
    case 'cancelDel': S.delAcc = false; break;
    case 'deleteAccount': {
      if (($('#delConfirm').value || '').trim().toUpperCase() !== 'SLET'){ toast('Skriv SLET for at bekræfte.'); return; }
      const {error} = await sb.rpc('delete_my_account');
      if (error){ toast('Kontoen kunne ikke slettes. Prøv igen.'); return; }
      try { localStorage.removeItem(cacheKey()); } catch(e){}
      S.delAcc = false; toast('Din konto er slettet.'); stopCam(); user = null; await sb.auth.signOut(); authScreen('login', 'Din konto og samling er slettet.', true); return; }
    case 'clearNotes': S.notes = []; persistLocal(); break;
    case 'export': exportData(); return;
    case 'logout': stopCam(); user = null; S.data = {entries:[], sold:[]}; S.profile = null; await sb.auth.signOut(); return;
    case 'noop': return;
    default: return;
  }
  render();
});
document.addEventListener('input', ev => {
  const t = ev.target; if (!user) return;
  if (t.dataset.f === 'filter'){ S.filter = t.value; const pos = t.selectionStart; render(); const n = $('[data-f="filter"]'); if (n){ n.focus(); try { n.setSelectionRange(pos, pos); } catch(e){} } }
  else if (t.dataset.f === 'q') doSearch(t.value);
  else if (t.dataset.f === 'fq') friendSearch(t.value);
  else if (t.dataset.s === 'q' && S.sell) buyerSearch(t.value);
  else if (t.dataset.s && S.sell){ S.sell[t.dataset.s] = t.value; }
});
document.addEventListener('change', ev => {
  const t = ev.target;
  if (t.id === 'fileIn'){ fromFile(t.files[0]); t.value = ''; return; }
  if (t.id === 'importIn'){ importData(t.files[0]); t.value = ''; return; }
  if (!user) return;
  if (t.dataset.f === 'sort'){ S.sort = t.value; render(); }
  else if (t.dataset.e && S.view && S.view.type === 'entry'){
    const e = entry(S.view.id), k = t.dataset.e; let v = t.value;
    if (['qty','buy','manual'].includes(k)) v = Math.max(k === 'qty' ? 1 : 0, parseInt(v) || 0);
    e[k] = v; if (k === 'manual') checkAlert(e); save(); if (k !== 'note') render();
  }
  else if (t.dataset.a && S.view && S.view.type === 'entry'){
    const e = entry(S.view.id); e.alert = e.alert || {}; e.alert[t.dataset.a] = Math.max(0, parseInt(t.value) || 0); e.alert.last = null;
    if (!e.alert.below && !e.alert.above) delete e.alert; else checkAlert(e);
    save(); render(); toast(e.alert ? 'Prisalarmen er gemt.' : 'Prisalarmen er slået fra.');
  }
  else if (t.dataset.p === 'display_name') saveProfile({display_name: t.value.trim().slice(0, 40) || null});
  else if (t.dataset.s === 'price' && S.sell) render();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && stream){ stopCam(); if (S.scan.phase === 'live'){ S.scan = {phase:'idle'}; render(); } }
  if (!document.hidden && user){ loadSocial(); }
});

/* ---------- privat adgang (invitationskode fra QR-koden) ---------- */
const INVITE_HASH = 'dba68eefcfdff056b437e06bf81a14923514a684f6f46e549cdc6df869bae200';
const KEY_STORE = 'kortscanner.invite';
const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function sha(t){ const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function validCode(c){ try { return !!c && (await sha(cleanCode(c))) === INVITE_HASH; } catch(e){ return false; } }
function chrome(show){ $('#tabs').hidden = !show; document.querySelectorAll('.topbtn').forEach(x => x.hidden = !show); }
function lockScreen(msg){
  chrome(false);
  $('#app').innerHTML = `<div class="col" style="padding-top:24px"><div class="logo" style="width:64px;height:64px;border-radius:18px" aria-hidden="true"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16"/></svg></div>
  <h1>Kortscanner er privat</h1><p class="mut" style="margin:0">Scan QR-koden, du har fået, med telefonens kamera. Eller skriv invitationskoden herunder.</p>
  <label class="f">Invitationskode<input class="i" id="inviteIn" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX" style="text-transform:uppercase;letter-spacing:2px"></label>
  ${msg ? `<p class="small down" style="margin:0">${esc(msg)}</p>` : ''}<button class="btn full" id="inviteBtn">Lås op</button></div>`;
  const go2 = async () => { const v = $('#inviteIn').value; if (await validCode(v)){ try { localStorage.setItem(KEY_STORE, cleanCode(v)); } catch(e){} start(); } else lockScreen('Koden passer ikke. Tjek at du har skrevet den rigtigt.'); };
  $('#inviteBtn').onclick = go2; $('#inviteIn').onkeydown = e => { if (e.key === 'Enter') go2(); };
}

/* ---------- login ---------- */
let started = false;
async function start(){
  if (started) return; started = true;
  if (!window.supabase){ authScreen('login', 'Kunne ikke forbinde til login. Tjek din internetforbindelse og genindlæs siden.'); return; }
  sb = window.supabase.createClient(SUPA_URL, SUPA_KEY, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
  sb.auth.onAuthStateChange((ev) => {
    if (ev === 'PASSWORD_RECOVERY'){ authScreen('newpass'); return; }
    if (ev === 'SIGNED_OUT'){ user = null; authScreen('login'); }
  });
  const {data} = await sb.auth.getSession();
  if (data && data.session) enterApp(data.session.user); else authScreen('login');
}
let entered = false;
async function enterApp(u){
  user = u; load();
  // profil: findes den ikke, skal brugeren vælge et brugernavn først
  const {data: prof, error: perr} = await sb.from('profiles').select('*').eq('id', u.id).maybeSingle();
  if (!perr && !prof){ profileSetup(); return; }
  S.profile = prof || {id:u.id, username:'', share_collection:true}; S.profiles[u.id] = S.profile;
  chrome(true);
  S.view = null; S.tab = 'samling'; render();
  if (!entered){
    entered = true;
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try { await syncDown(); render(); } catch(e){ S.syncErr = true; render(); toast('Kunne ikke hente din samling fra skyen. Du ser den, der er gemt på telefonen.'); }
  loadSocial();
  setTimeout(() => { if (S.data.entries.length) refreshPrices(false); }, 1500);
}
function profileSetup(msg){
  chrome(false);
  const suggest = String(user.email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 20);
  $('#app').innerHTML = `<form class="col" id="profForm" style="padding-top:16px" novalidate>
  <h1>Vælg et brugernavn</h1><p class="mut" style="margin:0">Dit brugernavn bruges, når venner skal finde dig, og når I handler med hinanden.</p>
  <label class="f">Brugernavn<input class="i" id="pUser" value="${esc(suggest.length >= 3 ? suggest : '')}" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20" placeholder="f.eks. kortsamler"></label>
  <span class="tiny mut">3–20 tegn: små bogstaver, tal, punktum og understreg.</span>
  <label class="f">Visningsnavn (valgfrit)<input class="i" id="pName" maxlength="40" placeholder="f.eks. dit fornavn"></label>
  ${msg ? `<div class="note down" role="alert">${esc(msg)}</div>` : ''}
  <button class="btn full" type="submit" id="pBtn">Fortsæt</button></form>`;
  $('#profForm').onsubmit = async ev => {
    ev.preventDefault();
    const username = $('#pUser').value.trim().toLowerCase(), display_name = $('#pName').value.trim().slice(0, 40) || null;
    if (!/^[a-z0-9_.]{3,20}$/.test(username)) return profileSetup('Brugernavnet skal være 3–20 tegn og kun små bogstaver, tal, punktum og understreg.');
    $('#pBtn').disabled = true; $('#pBtn').textContent = 'Vent …';
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const {error} = await sb.from('profiles').insert({id:user.id, username, display_name, color});
    if (error) return profileSetup(/duplicate|unique/i.test(error.message) ? 'Brugernavnet er taget. Prøv et andet.' : 'Kunne ikke gemme. Prøv igen.');
    enterApp(user);
  };
}
function authScreen(mode, msg, ok){
  chrome(false);
  const titles = {login:'Log ind', signup:'Opret konto', forgot:'Glemt adgangskode', newpass:'Vælg ny adgangskode'};
  const btn = {login:'Log ind', signup:'Opret konto', forgot:'Send link', newpass:'Gem adgangskode'}[mode];
  $('#app').innerHTML = `<form class="col" id="authForm" style="padding-top:16px" novalidate>
  <h1>${titles[mode]}</h1>
  ${mode === 'signup' ? '<p class="mut" style="margin:0">Din samling og dine handler gemmes på din konto, så du har dem på alle dine enheder.</p>' : ''}
  ${mode === 'forgot' ? '<p class="mut" style="margin:0">Skriv din e-mail, så sender vi et link, hvor du kan vælge en ny adgangskode.</p>' : ''}
  ${mode !== 'newpass' ? `<label class="f">E-mail<input class="i" id="aEmail" type="email" autocomplete="email" inputmode="email" required></label>` : ''}
  ${mode !== 'forgot' ? `<label class="f">${mode === 'newpass' ? 'Ny adgangskode' : 'Adgangskode'}<input class="i" id="aPass" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" minlength="8" required></label>` : ''}
  ${mode === 'signup' || mode === 'newpass' ? '<span class="tiny mut">Mindst 8 tegn.</span>' : ''}
  ${msg ? `<div class="note ${ok ? '' : 'down'}" role="alert">${esc(msg)}</div>` : ''}
  <button class="btn full" type="submit" id="aBtn">${btn}</button>
  ${mode === 'login' ? `<button class="btn text" type="button" data-auth="forgot">Glemt adgangskode?</button><div class="row" style="justify-content:center;gap:4px"><span class="mut small">Ny bruger?</span><button class="btn text" type="button" data-auth="signup">Opret konto</button></div>` : ''}
  ${mode === 'signup' || mode === 'forgot' ? `<button class="btn text" type="button" data-auth="login">Tilbage til log ind</button>` : ''}
  </form>`;
  document.querySelectorAll('[data-auth]').forEach(b => b.onclick = () => authScreen(b.dataset.auth));
  $('#authForm').onsubmit = async ev => {
    ev.preventDefault();
    const email = $('#aEmail') ? $('#aEmail').value.trim() : '', pass = $('#aPass') ? $('#aPass').value : '';
    if (mode !== 'newpass' && !/^\S+@\S+\.\S+$/.test(email)) return authScreen(mode, 'Skriv en gyldig e-mail.');
    if ((mode === 'signup' || mode === 'newpass') && pass.length < 8) return authScreen(mode, 'Adgangskoden skal være mindst 8 tegn.');
    $('#aBtn').disabled = true; $('#aBtn').textContent = 'Vent …';
    const backUrl = location.origin + location.pathname;
    try {
      if (mode === 'login'){
        const {data, error} = await sb.auth.signInWithPassword({email, password:pass});
        if (error) return authScreen('login', /confirm/i.test(error.message) ? 'Du skal først bekræfte din e-mail. Tjek din indbakke (og spam).' : 'Forkert e-mail eller adgangskode.');
        enterApp(data.user);
      } else if (mode === 'signup'){
        const {data, error} = await sb.auth.signUp({email, password:pass, options:{emailRedirectTo:backUrl}});
        if (error) return authScreen('signup', /registered|exists/i.test(error.message) ? 'Der findes allerede en konto med den e-mail. Log ind i stedet.' : /rate|limit/i.test(error.message) ? 'Der er sendt for mange mails lige nu. Prøv igen om lidt.' : 'Kontoen kunne ikke oprettes: ' + error.message);
        if (data.session) enterApp(data.user);
        else authScreen('login', 'Næsten færdig! Vi har sendt en mail til ' + email + '. Tryk på linket i mailen, og log så ind her.', true);
      } else if (mode === 'forgot'){
        const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo:backUrl});
        if (error) return authScreen('forgot', /rate|limit/i.test(error.message) ? 'Der er sendt for mange mails lige nu. Prøv igen om lidt.' : 'Kunne ikke sende mailen. Prøv igen.');
        authScreen('login', 'Hvis der findes en konto med den e-mail, har vi sendt et link til at vælge en ny adgangskode.', true);
      } else if (mode === 'newpass'){
        const {data, error} = await sb.auth.updateUser({password:pass});
        if (error) return authScreen('newpass', 'Adgangskoden kunne ikke gemmes. Prøv igen.');
        toast('Din nye adgangskode er gemt.'); enterApp(data.user);
      }
    } catch(e){ authScreen(mode, 'Ingen forbindelse. Tjek internettet og prøv igen.'); }
  };
}

(async () => {
  const m = location.hash.match(/k=([A-Za-z0-9-]+)/);
  let saved = ''; try { saved = localStorage.getItem(KEY_STORE) || ''; } catch(e){}
  if (m && await validCode(m[1])){ try { localStorage.setItem(KEY_STORE, cleanCode(m[1])); } catch(e){} history.replaceState(null, '', location.pathname); start(); }
  else if (await validCode(saved)) start();
  else lockScreen(m ? 'Koden i linket passer ikke længere. Bed om en ny QR-kode.' : '');
})();
})();
