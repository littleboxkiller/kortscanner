/* Kortscanner – mobil web-app
   Kortdata, billeder og priser: TCGdex (https://tcgdex.dev), gratis og uden nøgle.
   Samlingen gemmes på telefonen (localStorage). Lav en backup under "Mere". */
(() => {
'use strict';
const API = 'https://api.tcgdex.net/v2/en';
const EUR_DKK = 7.46; // kronen er bundet til euroen (centralkurs 7,46038)
const COLLS = {binder:'Binder', sale:'Til salg', wish:'Ønskeliste'};
const CONDS = ['Mint','Near Mint','Let brugt','Brugt','Slidt','Gradet (PSA/BGS/CGC)'];
const LANGS = ['Engelsk','Japansk','Tysk','Dansk','Andet'];
const VARIANTS = {normal:'Normal', holo:'Holo', reverse:'Reverse holo', firstEdition:'1. udgave', wPromo:'Promo'};
const STORE_KEY = 'kortscanner.v1';

/* ---------- state ---------- */
const S = {
  tab:'samling', view:null,           // view: {type:'card', id} | {type:'entry', id} | {type:'set', id} | {type:'sell', id} | {type:'receipt', id}
  data:{entries:[], sold:[]},
  coll:'all', sort:'value', filter:'',
  search:{q:'', results:null, busy:false, err:''},
  scan:{phase:'idle', msg:'', cands:[], guess:null, img:''},
  cardCache:{}, setCache:{}, sets:null,
  delArm:false, refreshing:false, sell:null,
};
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const kr = n => Math.round(+n || 0).toLocaleString('da-DK') + ' kr';
const eur = n => (+n).toLocaleString('da-DK',{minimumFractionDigits:2, maximumFractionDigits:2}) + ' €';
const usd = n => '$' + (+n).toLocaleString('en-US',{minimumFractionDigits:2, maximumFractionDigits:2});
const sgn = n => (n >= 0 ? '+' : '−') + kr(Math.abs(n));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => new Date().toLocaleDateString('da-DK');
let toastT;
function toast(m){ const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); }

/* ---------- storage + sky (Supabase) ---------- */
const SUPA_URL = 'https://yxqwgfgpszquvbqauiup.supabase.co';
const SUPA_KEY = 'sb_publishable_nDW0EKIep6M-ahKcA_Y3oQ_Di62KLUf'; // offentlig nøgle – data er beskyttet af regler i databasen
let sb = null, user = null;
const synced = {entries:{}, sales:{}}; // sidst gemte udgave i skyen, pr. id
const cacheKey = () => STORE_KEY + (user ? ':' + user.id : '');
function load(){
  S.data = {entries:[], sold:[]};
  try { const raw = localStorage.getItem(cacheKey()); if (raw){ const d = JSON.parse(raw); S.data = {entries: d.entries || [], sold: d.sold || []}; } } catch(e){}
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch(e){}
}
let syncT = null, syncing = false, syncAgain = false;
function save(){
  try { localStorage.setItem(cacheKey(), JSON.stringify(S.data)); }
  catch(e){ toast('Kunne ikke gemme på telefonen.'); }
  if (sb && user){ clearTimeout(syncT); syncT = setTimeout(syncUp, 700); }
}
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
  try { await syncTable('entries', S.data.entries, 'entries'); await syncTable('sales', S.data.sold, 'sales'); S.syncErr = false; }
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
  // læg kort fra telefonen, som ikke er i skyen endnu, oven i (første login / offline-ændringer)
  const ids = new Set(cloudE.map(x => x.id)), sids = new Set(cloudS.map(x => x.id));
  let legacy = {entries:[], sold:[]}; try { const raw = localStorage.getItem(STORE_KEY); if (raw) legacy = JSON.parse(raw); } catch(e){}
  const localE = S.data.entries.concat(legacy.entries || []), localS = S.data.sold.concat(legacy.sold || []);
  const extraE = localE.filter(x => x && x.id && !ids.has(x.id) && (ids.add(x.id), true));
  const extraS = localS.filter(x => x && x.id && !sids.has(x.id) && (sids.add(x.id), true));
  S.data = {entries: cloudE.concat(extraE), sold: cloudS.concat(extraS)};
  try { localStorage.removeItem(STORE_KEY); } catch(e){}
  save();
}
const entry = id => S.data.entries.find(e => e.id === id);

/* ---------- API ---------- */
async function api(path){
  const r = await fetch(API + path);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function getCard(id){
  if (S.cardCache[id]) return S.cardCache[id];
  const c = await api('/cards/' + encodeURIComponent(id));
  if (c) S.cardCache[id] = c;
  return c;
}
async function getSets(){
  if (S.sets) return S.sets;
  try { const c = JSON.parse(localStorage.getItem('kortscanner.sets') || 'null'); if (c && Date.now() - c.t < 3*864e5){ S.sets = c.sets; return S.sets; } } catch(e){}
  const sets = await api('/sets');
  S.sets = (sets || []).map(s => ({id:s.id, name:s.name, official:s.cardCount && s.cardCount.official, total:s.cardCount && s.cardCount.total}));
  try { localStorage.setItem('kortscanner.sets', JSON.stringify({t:Date.now(), sets:S.sets})); } catch(e){}
  return S.sets;
}
async function getSet(id){
  if (S.setCache[id]) return S.setCache[id];
  const s = await api('/sets/' + encodeURIComponent(id));
  if (s) S.setCache[id] = s;
  return s;
}
const img = (base, q) => base ? esc(base + '/' + (q || 'low') + '.webp') : '';

/* ---------- prices ---------- */
function prices(card){
  const p = (card && card.pricing) || {}; const out = {cm:null, tcg:null, rows:[]};
  const cm = p.cardmarket;
  if (cm){
    const trend = cm.trend ?? cm.avg30 ?? cm.avg ?? cm.avg7;
    if (trend != null) out.cm = +trend;
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
async function refreshPrices(all){
  if (S.refreshing) return; S.refreshing = true; render();
  const list = S.data.entries.filter(e => all || !e.eurDate || Date.now() - e.eurDate > 864e5);
  let n = 0;
  for (const e of list){
    try { delete S.cardCache[e.cardId]; const c = await getCard(e.cardId); const p = prices(c); if (p.cm != null){ e.eur = p.cm; } e.eurDate = Date.now(); n++; }
    catch(x){ break; }
    if (n % 5 === 0){ save(); render(); }
    await new Promise(r => setTimeout(r, 120));
  }
  save(); S.refreshing = false; render();
  if (all) toast(n ? 'Priserne er opdateret.' : 'Kunne ikke hente priser lige nu.');
}

/* ---------- small renderers ---------- */
function artEl(base, name, qty){
  return `<div class="art">${base ? `<img src="${img(base,'low')}" alt="" loading="lazy">` : `<span class="ph" aria-hidden="true">${esc((name||'?')[0])}</span>`}${(+qty||1) > 1 ? `<span class="qty">×${esc(qty)}</span>` : ''}</div>`;
}
const back = l => `<button class="btn text" data-act="back" style="align-self:flex-start;padding:0">‹ ${esc(l || 'Tilbage')}</button>`;
const opts = (arr, v) => arr.map(o => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('');
const spinner = t => `<p class="row b"><svg class="spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/></svg>${esc(t)}</p>`;
function marketLinks(name, number){
  const q = encodeURIComponent([name, number].filter(Boolean).join(' '));
  return `<div class="row wrapr"><a class="btn ghost" href="https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${q}" target="_blank" rel="noopener">Cardmarket</a><a class="btn ghost" href="https://www.tcgplayer.com/search/pokemon/product?q=${q}" target="_blank" rel="noopener">TCGplayer</a><a class="btn ghost" href="https://www.ebay.com/sch/i.html?_nkw=${q}" target="_blank" rel="noopener">eBay</a></div>`;
}
function pUpd(card){ const p = card.pricing || {}; const u = (p.cardmarket && p.cardmarket.updated) || (p.tcgplayer && p.tcgplayer.updated); try { return u ? new Date(u).toLocaleDateString('da-DK') : ''; } catch(e){ return ''; } }
function priceBox(card){
  const p = prices(card);
  if (!p.rows.length) return `<div class="box col"><h3>Markedspris</h3><p class="small mut" style="margin:0">Ingen prisdata for dette kort endnu.</p>${marketLinks(card.name, card.localId)}</div>`;
  return `<div class="box col" style="gap:6px"><h3>Markedspris</h3>
  ${p.cm != null ? `<div class="row between"><span class="mut small">Cardmarket trend</span><span class="big" style="font-size:28px">${kr(p.cm * EUR_DKK)}</span></div>` : ''}
  <div>${p.rows.map(r => `<div class="price"><span>${esc(r.src)} · ${esc(r.l)}</span><span class="nw b">${esc(r.v)}${r.dkk ? ` <span class="mut">(${kr(r.dkk)})</span>` : ''}</span></div>`).join('')}</div>
  <span class="tiny mut">Priser fra TCGdex${pUpd(card) ? ', opdateret ' + esc(pUpd(card)) : ''}. Euro omregnet med 7,46.</span>
  ${marketLinks(card.name, card.localId)}</div>`;
}

/* ---------- views ---------- */
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
  <div class="pills" role="group" aria-label="Vælg samling">${[['all','Alle'],['binder','Binder'],['sale','Til salg'],['wish','Ønskeliste']].map(([k, l]) => `<button class="pill" data-act="coll" data-v="${k}" aria-pressed="${S.coll === k}">${l} ${k === 'all' ? all.length : all.filter(e => e.coll === k).length}</button>`).join('')}</div>
  <div class="row"><input class="i grow" type="search" data-f="filter" value="${esc(S.filter)}" placeholder="Søg i din samling" aria-label="Søg i din samling">
  <select class="i" style="width:auto" data-f="sort" aria-label="Sortér">${[['value','Værdi'],['name','Navn'],['new','Nyeste']].map(([k, l]) => `<option value="${k}"${S.sort === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
  ${list.length ? `<div class="cards">${list.map(e => `<button class="tile" data-act="openEntry" data-v="${esc(e.id)}">${artEl(e.image, e.name, e.qty)}<span class="name">${esc(e.name)}</span><span class="tiny mut">${esc(e.setName)} · ${esc(e.localId)}</span><span class="row between small"><b>${unitValue(e) ? kr(value(e)) : '<span class="mut">–</span>'}</b><span class="tiny mut">${esc(e.coll === 'wish' ? 'Ønske' : e.coll === 'sale' ? 'Til salg' : '')}</span></span></button>`).join('')}</div>`
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
    <div class="cards">${sc.cands.map(c => `<button class="tile" data-act="openCard" data-v="${esc(c.id)}">${artEl(c.image, c.name)}<span class="name">${esc(c.name)}</span><span class="tiny mut">${esc(c.setName || '')}${c.localId ? ' · ' + esc(c.localId) : ''}</span></button>`).join('')}</div>`
    : `<div class="box col"><h2>Kortet blev ikke fundet</h2><p class="small mut" style="margin:0">${esc(sc.msg || 'Prøv igen med kortet fladt, godt lys og nummeret i bunden skarpt.')}</p></div>`}
    <div class="row wrapr"><button class="btn" data-act="rescan">Scan igen</button><button class="btn ghost" data-act="toSearch">Søg i stedet</button></div>`;
  } else if (sc.phase === 'nocam'){
    body = `<div class="box col"><h2>Kameraet kunne ikke startes</h2><p class="small mut" style="margin:0">${esc(sc.msg)}</p></div>
    <label class="btn full" for="fileIn">Tag eller vælg et billede</label><button class="btn ghost full" data-act="startCam">Prøv kameraet igen</button>`;
  } else {
    body = `<div class="box col"><p style="margin:0">Appen læser kortets <b>navn</b> og <b>nummer</b> (f.eks. 223/197) og finder det officielle billede og prisen.</p></div>
    <button class="btn full" data-act="startCam">Start kameraet</button><label class="btn ghost full" for="fileIn">Vælg et billede</label>`;
  }
  return `<div class="col"><h1>Scan kort</h1>${body}</div>`;
}

function vSog(){
  const s = S.search;
  return `<div class="col"><h1>Søg kort</h1>
  <input class="i" type="search" data-f="q" value="${esc(s.q)}" placeholder="Navn, f.eks. Charizard eller Pikachu" aria-label="Søg efter kort" enterkeyhint="search">
  <div id="results">${resultsHtml()}</div></div>`;
}
function resultsHtml(){
  const s = S.search;
  if (s.busy) return spinner('Søger …');
  if (s.err) return `<div class="note">${esc(s.err)}</div>`;
  if (!s.results) return `<p class="small mut">Skriv mindst 3 bogstaver. Kortdata og billeder kommer fra TCGdex.</p>`;
  if (!s.results.length) return `<p class="small mut">Ingen kort fundet. Tjek stavningen – navne er på engelsk.</p>`;
  return `<p class="small mut">${s.results.length}${s.results.length >= 120 ? '+' : ''} kort</p><div class="cards">${s.results.slice(0, 120).map(c => `<button class="tile" data-act="openCard" data-v="${esc(c.id)}">${artEl(c.image, c.name)}<span class="name">${esc(c.name)}</span><span class="tiny mut">${esc(c.setName || c.id)} · ${esc(c.localId)}</span></button>`).join('')}</div>`;
}

function vCard(){
  const id = S.view.id, c = S.cardCache[id];
  if (!c){ return `<div class="col">${back()}${spinner('Henter kortet …')}</div>`; }
  const owned = S.data.entries.filter(e => e.cardId === id);
  const vars = Object.keys(c.variants || {}).filter(k => c.variants[k] && VARIANTS[k]);
  const p = prices(c);
  return `<div class="col">${back()}
  <div class="big-art">${c.image ? `<div class="art"><img src="${img(c.image,'high')}" alt="${esc(c.name)}"></div>` : artEl(null, c.name)}</div>
  <div class="col" style="gap:2px"><h1>${esc(c.name)}</h1><span class="small mut">${esc([c.set && c.set.name, c.localId + (c.set && c.set.cardCount && c.set.cardCount.official ? '/' + c.set.cardCount.official : ''), c.rarity].filter(Boolean).join(' · '))}</span>
  ${owned.length ? `<span class="small b up">Du har ${owned.reduce((a, e) => a + (+e.qty || 1), 0)} stk.</span>` : ''}</div>
  ${priceBox(c)}
  <div class="box col"><h3>Tilføj til samling</h3>
  <div class="grid2"><label class="f">Samling<select class="i" id="aColl">${Object.keys(COLLS).map(k => `<option value="${k}">${COLLS[k]}</option>`).join('')}</select></label>
  <label class="f">Antal<input class="i" id="aQty" type="number" min="1" inputmode="numeric" value="1"></label></div>
  <div class="grid2"><label class="f">Stand<select class="i" id="aCond">${opts(CONDS, 'Near Mint')}</select></label>
  <label class="f">Udgave<select class="i" id="aVar">${(vars.length ? vars : ['normal']).map(k => `<option value="${k}">${VARIANTS[k]}</option>`).join('')}</select></label></div>
  <div class="grid2"><label class="f">Sprog<select class="i" id="aLang">${opts(LANGS, 'Engelsk')}</select></label>
  <label class="f">Købspris pr. stk. (kr)<input class="i" id="aBuy" type="number" min="0" inputmode="numeric" placeholder="${p.cm != null ? Math.round(p.cm * EUR_DKK) : ''}"></label></div>
  <button class="btn full" data-act="add">Tilføj kortet</button></div></div>`;
}

function vEntry(){
  const e = entry(S.view.id); if (!e){ S.view = null; return vSamling(); }
  const c = S.cardCache[e.cardId];
  const g = value(e) - (+e.buy || 0) * (+e.qty || 1);
  return `<div class="col">${back('Samling')}
  <div class="big-art">${e.image ? `<div class="art"><img src="${img(e.image,'high')}" alt="${esc(e.name)}"></div>` : artEl(null, e.name)}</div>
  <div class="col" style="gap:2px"><h1>${esc(e.name)}</h1><span class="small mut">${esc([e.setName, e.localId + (e.official ? '/' + e.official : ''), e.rarity, VARIANTS[e.variant]].filter(Boolean).join(' · '))}</span></div>
  <div class="kpis"><div class="kpi"><span class="tiny mut">Betalt</span><b>${kr((+e.buy || 0) * (+e.qty || 1))}</b></div><div class="kpi"><span class="tiny mut">Værdi</span><b>${kr(value(e))}</b></div><div class="kpi"><span class="tiny mut">Gevinst</span><b class="${g >= 0 ? 'up' : 'down'}">${sgn(g)}</b></div></div>
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
  S.data.entries.filter(e => e.coll !== 'wish').forEach(e => { (by[e.setId] = by[e.setId] || {id:e.setId, name:e.setName, official:e.official, ids:new Set()}).ids.add(e.localId); });
  const list = Object.values(by).map(s => ({...s, have:s.ids.size, pct: s.official ? Math.min(100, Math.round(s.ids.size / s.official * 100)) : 0})).sort((a, b) => b.pct - a.pct);
  return `<div class="col"><h1>Sæt</h1><p class="small mut" style="margin:0">Se hvor tæt du er på at gøre hvert sæt færdigt. Tryk på et sæt for at se de kort, du mangler.</p>
  ${list.length ? list.map(s => `<button class="li" data-act="openSet" data-v="${esc(s.id)}" style="flex-direction:column;align-items:stretch;gap:8px"><div class="row between"><b>${esc(s.name)}</b><b class="nw">${s.pct} %</b></div><div class="bar"><i style="width:${s.pct}%"></i></div><div class="row between tiny mut"><span>${s.have} af ${esc(s.official || '?')} kort</span><span>${s.official ? Math.max(0, s.official - s.have) + ' mangler' : ''}</span></div></button>`).join('')
  : `<div class="box"><p class="mut" style="margin:0">Når du har kort i samlingen, vises dine sæt her.</p></div>`}</div>`;
}
function vSet(){
  const s = S.setCache[S.view.id];
  if (!s) return `<div class="col">${back('Sæt')}${spinner('Henter sættet …')}</div>`;
  const have = new Set(S.data.entries.filter(e => e.setId === s.id && e.coll !== 'wish').map(e => e.localId));
  const official = (s.cardCount && s.cardCount.official) || 0;
  const cards = s.cards || [];
  const mainHave = cards.filter((c, i) => i < official && have.has(c.localId)).length;
  const show = S.view.missing ? cards.filter(c => !have.has(c.localId)) : cards;
  return `<div class="col">${back('Sæt')}<h1>${esc(s.name)}</h1>
  <div class="box col" style="gap:8px"><div class="row between"><span>${mainHave} af ${official} kort</span><b>${official ? Math.round(mainHave / official * 100) : 0} %</b></div><div class="bar"><i style="width:${official ? Math.round(mainHave / official * 100) : 0}%"></i></div>${cards.length > official ? `<span class="tiny mut">Sættet har også ${cards.length - official} hemmelige/ekstra kort.</span>` : ''}</div>
  <div class="pills"><button class="pill" data-act="setMissing" data-v="0" aria-pressed="${!S.view.missing}">Alle kort</button><button class="pill" data-act="setMissing" data-v="1" aria-pressed="${!!S.view.missing}">Kun dem jeg mangler</button></div>
  <div class="cards">${show.map(c => `<button class="tile" data-act="openCard" data-v="${esc(c.id)}" style="${have.has(c.localId) ? '' : 'opacity:.45'}">${artEl(c.image, c.name)}<span class="name">${esc(c.name)}</span><span class="tiny mut">${esc(c.localId)}${have.has(c.localId) ? ' · <b class="up">Har</b>' : ''}</span></button>`).join('')}</div></div>`;
}

function vStat(){
  const held = S.data.entries.filter(e => e.coll !== 'wish');
  const total = held.reduce((a, e) => a + value(e), 0), paid = held.reduce((a, e) => a + (+e.buy || 0) * (+e.qty || 1), 0);
  const group = fn => { const o = {}; held.forEach(e => { const k = fn(e) || 'Ukendt'; o[k] = (o[k] || 0) + value(e); }); return Object.entries(o).sort((a, b) => b[1] - a[1]); };
  const bars = rows => { const m = Math.max(1, ...rows.map(r => r[1])); return rows.map(([k, v]) => `<div class="col" style="gap:4px"><div class="row between small"><span>${esc(k)}</span><b class="nw">${kr(v)}</b></div><div class="bar"><i style="width:${Math.round(v / m * 100)}%"></i></div></div>`).join('') || '<span class="small mut">Ingen kort med værdi endnu.</span>'; };
  const top = held.slice().sort((a, b) => unitValue(b) - unitValue(a)).slice(0, 5);
  const sold = S.data.sold;
  return `<div class="col"><h1>Statistik</h1>
  <div class="kpis"><div class="kpi"><span class="tiny mut">Værdi</span><b>${kr(total)}</b></div><div class="kpi"><span class="tiny mut">Investeret</span><b>${kr(paid)}</b></div><div class="kpi"><span class="tiny mut">Gevinst</span><b class="${total - paid >= 0 ? 'up' : 'down'}">${sgn(total - paid)}</b></div></div>
  <div class="box col"><h3>Dyreste kort</h3>${top.length ? top.map(e => `<button class="li" data-act="openEntry" data-v="${esc(e.id)}" style="padding:6px 0;background:transparent">${artEl(e.image, e.name)}<div class="grow"><div class="b">${esc(e.name)}</div><div class="tiny mut">${esc(e.setName)}</div></div><b class="nw">${kr(unitValue(e))}</b></button>`).join('') : '<span class="small mut">Ingen kort endnu.</span>'}</div>
  <div class="box col"><h3>Værdi pr. samling</h3>${bars(group(e => COLLS[e.coll]))}</div>
  <div class="box col"><h3>Værdi pr. sæt</h3>${bars(group(e => e.setName).slice(0, 10))}</div>
  <div class="box col"><h3>Salg</h3>${sold.length ? `<div class="row between small"><span>${sold.length} salg</span><b>${kr(sold.reduce((a, s) => a + s.total, 0))}</b></div>${sold.slice().reverse().slice(0, 10).map(s => `<button class="li" data-act="openReceipt" data-v="${esc(s.id)}" style="padding:8px 0;background:transparent"><div class="grow"><div class="b">${esc(s.qty)} × ${esc(s.name)}</div><div class="tiny mut">${esc(s.no)} · ${esc(s.date)} · ${esc(s.buyer || 'Køber')}</div></div><b class="nw">${kr(s.total)}</b></button>`).join('')}` : '<span class="small mut">Ingen salg endnu.</span>'}</div></div>`;
}

function vSell(){
  const sl = S.sell, e = entry(sl.id); if (!e){ S.view = null; return vSamling(); }
  const unit = +sl.price || 0, total = unit * sl.qty, ok = unit > 0 && sl.got;
  return `<div class="col">${back('Kortet')}<h1>Sælg kort</h1>
  <div class="li">${artEl(e.image, e.name)}<div class="grow"><div class="b">${esc(e.name)}</div><div class="tiny mut">${esc(e.setName)} · ${esc(e.localId)} · ${esc(e.cond)}</div></div></div>
  <div class="row" style="align-items:flex-end"><label class="f grow">Pris pr. stk. (kr)<input class="i" type="number" min="0" inputmode="numeric" data-s="price" value="${esc(sl.price)}"></label>
  <div class="col" style="gap:6px"><span class="small b mut">Antal</span><div class="row" style="gap:4px"><button class="btn ghost" style="width:48px;padding:0" data-act="sq" data-v="-1" aria-label="Færre">−</button><b style="width:28px;text-align:center">${sl.qty}</b><button class="btn ghost" style="width:48px;padding:0" data-act="sq" data-v="1" aria-label="Flere">+</button></div></div></div>
  <label class="f">Køberens navn<input class="i" data-s="buyer" value="${esc(sl.buyer)}" autocomplete="off"></label>
  <label class="f">Køberens e-mail (til kvitteringen)<input class="i" type="email" data-s="email" value="${esc(sl.email)}" autocomplete="off"></label>
  <div class="pills">${['Kontant','MobilePay'].map(m => `<button class="pill" data-act="pay" data-v="${m}" aria-pressed="${sl.method === m}">${m}</button>`).join('')}</div>
  <button class="li" data-act="got" aria-pressed="${sl.got}" style="border:1px solid var(--line)"><span style="width:24px;height:24px;border-radius:6px;border:2px solid ${sl.got ? 'var(--acc)' : 'var(--mut)'};background:${sl.got ? 'var(--acc)' : 'transparent'};color:var(--accInk);display:grid;place-items:center;flex:none" aria-hidden="true">${sl.got ? '✓' : ''}</span><b>Jeg har modtaget ${kr(total)} ${sl.method === 'Kontant' ? 'kontant' : 'via MobilePay'}</b></button>
  <div class="row between"><span class="mut">I alt</span><span class="big" style="font-size:28px">${kr(total)}</span></div>
  <button class="btn full" data-act="doSell" ${ok ? '' : 'disabled'}>Registrér salg og lav kvittering</button>
  ${ok ? '' : `<p class="small mut" style="text-align:center;margin:0">${!unit ? 'Skriv en pris.' : 'Bekræft at du har fået pengene.'}</p>`}</div>`;
}
function receiptText(s){
  return ['Kvittering ' + s.no, 'Dato: ' + s.date, 'Køber: ' + (s.buyer || '-'), '', s.qty + ' × ' + s.name, '   ' + [s.setName, s.localId, s.cond].filter(Boolean).join(' · '), '   ' + s.qty + ' × ' + kr(s.unit), '', 'I alt: ' + kr(s.total), 'Betalt med: ' + s.method, 'Privat salg, ingen moms.', 'Kontrolkode: ' + s.code].join('\n');
}
function vReceipt(){
  const s = S.data.sold.find(x => x.id === S.view.id); if (!s){ S.view = null; return vStat(); }
  const mail = `mailto:${encodeURIComponent(s.email || '')}?subject=${encodeURIComponent('Kvittering ' + s.no)}&body=${encodeURIComponent(receiptText(s))}`;
  return `<div class="col">${back()}<h1>Kvittering</h1>
  <div class="box col" style="background:#fff;color:#15171C;gap:8px"><div class="row between"><b style="font:700 20px 'Space Grotesk',sans-serif">Kvittering</b><span style="color:#5C626C">${esc(s.no)}</span></div>
  <div style="color:#5C626C;font-size:14px">Dato: ${esc(s.date)}<br>Køber: <b style="color:#15171C">${esc(s.buyer || '-')}</b>${s.email ? ' · ' + esc(s.email) : ''}</div>
  <div class="row between" style="border-top:1px dashed #C9C4B8;border-bottom:1px dashed #C9C4B8;padding:10px 0;align-items:flex-start;gap:10px">${s.image ? `<img src="${img(s.image,'low')}" alt="" style="width:48px;border-radius:4px">` : ''}<div class="grow"><b>${esc(s.qty)} × ${esc(s.name)}</b><br><span style="color:#5C626C;font-size:14px">${esc([s.setName, s.localId, s.cond].filter(Boolean).join(' · '))}</span></div><b class="nw">${kr(s.total)}</b></div>
  <div class="row between b"><span>I alt</span><span>${kr(s.total)}</span></div>
  <span style="color:#5C626C;font-size:14px">Betalt med ${esc(s.method)}. Privat salg, ingen moms. Kontrolkode: <b style="color:#15171C">${esc(s.code)}</b></span></div>
  ${navigator.share ? `<button class="btn full" data-act="shareR">Send kvittering</button>` : ''}
  <a class="btn ${navigator.share ? 'ghost' : ''} full" href="${esc(mail)}">Send som e-mail</a>
  <button class="btn ghost full" data-act="copyR">Kopiér som tekst</button></div>`;
}

function vMere(){
  const n = S.data.entries.length;
  return `<div class="col">${back()}<h1>Mere</h1>
  <div class="box col"><h3>Din konto</h3><p class="small mut" style="margin:0">Logget ind som <b style="color:var(--ink)">${esc(user ? user.email : '')}</b>. Din samling gemmes på kontoen${S.syncErr ? ' – <b class="down">seneste gemning i skyen fejlede, prøver igen ved næste ændring</b>' : ''}.</p><button class="btn ghost" data-act="logout">Log ud</button></div>
  <div class="box col"><h3>Læg appen på hjemmeskærmen</h3><p class="small mut" style="margin:0"><b>iPhone:</b> tryk på Del-knappen i Safari og vælg “Føj til hjemmeskærm”.<br><b>Android:</b> tryk på menuen ⋮ i Chrome og vælg “Installer app” eller “Føj til startskærm”.</p></div>
  <div class="box col"><h3>Backup</h3><p class="small mut" style="margin:0">Din samling (${n} kort) ligger på din konto. Du kan også gemme en kopi som fil.</p>
  <button class="btn" data-act="export">Gem backup-fil</button><label class="btn ghost" for="importIn">Hent fra backup-fil</label></div>
  <div class="box col"><h3>Om data</h3><p class="small mut" style="margin:0">Kortdata, billeder og priser kommer fra <a href="https://tcgdex.dev" target="_blank" rel="noopener" style="color:var(--link)">TCGdex</a> (Cardmarket og TCGplayer). Billederne tilhører The Pokémon Company. Scanneren læser teksten på kortet direkte på telefonen.</p></div>
  <button class="btn danger full" data-act="wipe">${S.delArm ? 'Tryk igen for at slette alt' : 'Slet hele samlingen'}</button></div>`;
}

/* ---------- render ---------- */
function render(){
  const app = $('#app'); const v = S.view;
  let html;
  if (v){ html = v.type === 'card' ? vCard() : v.type === 'entry' ? vEntry() : v.type === 'set' ? vSet() : v.type === 'sell' ? vSell() : v.type === 'receipt' ? vReceipt() : ''; }
  else html = S.tab === 'scan' ? vScan() : S.tab === 'sog' ? vSog() : S.tab === 'saet' ? vSaet() : S.tab === 'stat' ? vStat() : S.tab === 'mere' ? vMere() : vSamling();
  app.innerHTML = html;
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-current', !v && b.dataset.v === S.tab ? 'page' : 'false'));
  const vid = $('#vid'); if (vid && stream){ vid.srcObject = stream; vid.play().catch(() => {}); }
}
function go(view){ S.view = view; S.delArm = false; render(); window.scrollTo(0, 0); }

/* ---------- camera ---------- */
let stream = null;
async function startCam(){
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ S.scan = {phase:'nocam', msg:'Denne browser giver ikke adgang til kameraet her. Åbn appen via https-linket, eller vælg et billede.'}; render(); return; }
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

/* ---------- OCR + lookup ---------- */
let worker = null;
async function getWorker(){
  if (worker) return worker;
  if (!window.Tesseract) throw new Error('ocr-missing');
  worker = await Tesseract.createWorker('eng', 1, {logger: m => { if (m.status === 'recognizing text' && S.scan.phase === 'busy'){ /* quiet */ } }});
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
  S.scan = {phase:'busy', img:canvas.toDataURL('image/jpeg', 0.8), msg:'Gør kortlæseren klar …'}; render();
  try {
    const w = await getWorker();
    S.scan.msg = 'Læser navn og nummer …'; render();
    const bottom = await w.recognize(region(canvas, 0.86, 1));
    const top = await w.recognize(region(canvas, 0, 0.16));
    let num = guessNumber(bottom.data.text), name = guessName(top.data.text);
    if (!num){ const left = await w.recognize(region(canvas, 0.84, 1, 0, 0.55)); num = guessNumber(left.data.text); }
    if (!num){ const z = await w.recognize(region(canvas, 0.88, 0.99, 0, 0.45, 'grayscale(1) contrast(2.5) brightness(1.1)', 2200)); num = guessNumber(z.data.text); }
    S.scan.msg = 'Finder kortet …'; render();
    let cands = [];
    if (num){
      const sets = await getSets();
      const hits = sets.filter(s => s.official === num.total || (num.pre && s.total === num.total));
      const locals = [...new Set([num.pre + num.local, num.pre + String(+num.local), num.pre + num.local.padStart(3, '0'), num.local])];
      const tries = []; hits.slice(0, 30).forEach(s => locals.forEach(l => tries.push({s, l})));
      const found = await Promise.all(tries.map(t => api('/sets/' + encodeURIComponent(t.s.id) + '/' + encodeURIComponent(t.l)).catch(() => null)));
      if (num.pre){ const byId = await api('/cards?localId=eq:' + encodeURIComponent(num.pre + num.local)).catch(() => null); for (const b of (byId || []).filter(x => !isPocket(x.id)).slice(0, 6)){ const full = await getCard(b.id).catch(() => null); if (full) found.push(full); } }
      const seen = new Set();
      found.forEach(c => { if (c && !seen.has(c.id)){ seen.add(c.id); S.cardCache[c.id] = c; cands.push({id:c.id, name:c.name, image:c.image, setName:c.set && c.set.name, localId:c.localId}); } });
      if (name) cands.sort((a, b) => nameScore(name, b.name) - nameScore(name, a.name));
      if (name && cands.length > 1 && nameScore(name, cands[0].name) >= 80) cands = cands.filter(c => nameScore(name, c.name) >= 80);
    }
    if (!cands.length && name){
      const r = await api('/cards?name=' + encodeURIComponent(name));
      cands = (r || []).filter(c => !isPocket(c.id)).slice(0, 24).map(c => ({id:c.id, name:c.name, image:c.image, localId:c.localId}));
    }
    S.scan = {phase:'result', cands, guess:{name, num: num && num.text}, msg: num || name ? 'Der var ingen kort, der passede til det, appen læste.' : 'Appen kunne ikke læse navn eller nummer på billedet.'};
    if (cands.length === 1){ go({type:'card', id:cands[0].id}); return; }
  } catch(e){
    S.scan = {phase:'result', cands:[], msg: e && e.message === 'ocr-missing' ? 'Kortlæseren kunne ikke hentes. Tjek din internetforbindelse.' : 'Der skete en fejl. Tjek din internetforbindelse og prøv igen.'};
  }
  render();
}

/* ---------- search ---------- */
const setOf = id => String(id).slice(0, String(id).lastIndexOf('-'));
const isPocket = id => /^(A\d+[a-z]?|B\d+[a-z]?|P-[AB])-/i.test(String(id));
let searchT, searchN = 0;
function doSearch(q){
  clearTimeout(searchT);
  const s = S.search; s.q = q;
  if (q.trim().length < 3){ s.results = null; s.err = ''; s.busy = false; const r = $('#results'); if (r) r.innerHTML = resultsHtml(); return; }
  searchT = setTimeout(async () => {
    const n = ++searchN; s.busy = true; s.err = ''; const r0 = $('#results'); if (r0) r0.innerHTML = resultsHtml();
    try { const [res, sets] = await Promise.all([api('/cards?name=' + encodeURIComponent(q.trim())), getSets().catch(() => [])]); if (n !== searchN) return; const names = {}; (sets || []).forEach(x => names[x.id] = x.name); const list = (res || []).filter(c => !isPocket(c.id)).map(c => ({...c, setName: names[setOf(c.id)] || ''})); s.results = list.filter(c => c.image).concat(list.filter(c => !c.image)); }
    catch(e){ if (n !== searchN) return; s.err = 'Kunne ikke søge lige nu. Tjek din internetforbindelse.'; s.results = null; }
    s.busy = false; const r = $('#results'); if (r) r.innerHTML = resultsHtml();
  }, 400);
}

/* ---------- actions ---------- */
async function openCard(id){
  go({type:'card', id});
  if (!S.cardCache[id]){ try { await getCard(id); } catch(e){ toast('Kunne ikke hente kortet.'); } if (S.view && S.view.id === id) render(); }
}
async function openEntry(id){
  const e = entry(id); go({type:'entry', id});
  if (e && !S.cardCache[e.cardId]){ try { const c = await getCard(e.cardId); const p = prices(c); if (p.cm != null){ e.eur = p.cm; e.eurDate = Date.now(); save(); } } catch(x){} if (S.view && S.view.id === id) render(); }
}
async function openSet(id){ go({type:'set', id, missing:false}); if (!S.setCache[id]){ try { await getSet(id); } catch(e){ toast('Kunne ikke hente sættet.'); } if (S.view && S.view.id === id) render(); } }
function addCard(){
  const c = S.cardCache[S.view.id]; if (!c) return;
  const p = prices(c);
  const e = {id:uid(), cardId:c.id, name:c.name, setId:c.set && c.set.id, setName:c.set && c.set.name, localId:c.localId, official:c.set && c.set.cardCount && c.set.cardCount.official,
    image:c.image || '', rarity:c.rarity || '', coll:$('#aColl').value, qty:Math.max(1, parseInt($('#aQty').value) || 1), cond:$('#aCond').value, variant:$('#aVar').value, lang:$('#aLang').value,
    buy:Math.max(0, parseInt($('#aBuy').value) || 0), eur:p.cm, eurDate:Date.now(), manual:0, note:'', added:new Date().toISOString()};
  S.data.entries.push(e); save();
  toast(e.name + ' er lagt i ' + COLLS[e.coll] + '.');
  S.scan = {phase:'idle'}; S.tab = 'samling'; go({type:'entry', id:e.id});
}
function doSell(){
  const sl = S.sell, e = entry(sl.id); const unit = +sl.price || 0; if (!e || !unit || !sl.got) return;
  const d = new Date(), code = Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const s = {id:uid(), no:'KS-' + d.toISOString().slice(2, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 5).toUpperCase(), code, date:d.toLocaleDateString('da-DK'),
    name:e.name, setName:e.setName, localId:e.localId, image:e.image, cond:e.cond, qty:sl.qty, unit, total:unit * sl.qty, method:sl.method, buyer:sl.buyer.trim(), email:sl.email.trim()};
  S.data.sold.push(s);
  const left = (+e.qty || 1) - sl.qty; if (left > 0) e.qty = left; else S.data.entries = S.data.entries.filter(x => x.id !== e.id);
  save(); S.sell = null; toast('Salget er registreret.'); go({type:'receipt', id:s.id});
}
function exportData(){
  const blob = new Blob([JSON.stringify({app:'kortscanner', v:1, exported:new Date().toISOString(), ...S.data}, null, 1)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'kortscanner-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Backup-filen er gemt.');
}
function importData(file){
  if (!file) return; const r = new FileReader();
  r.onload = () => { try { const d = JSON.parse(r.result); if (!Array.isArray(d.entries)) throw 0;
      const have = new Set(S.data.entries.map(e => e.id)); let n = 0;
      d.entries.forEach(e => { if (e && e.id && e.cardId && !have.has(e.id)){ S.data.entries.push(e); n++; } });
      const hs = new Set(S.data.sold.map(s => s.id)); (d.sold || []).forEach(s => { if (s && s.id && !hs.has(s.id)) S.data.sold.push(s); });
      save(); render(); toast(n + ' kort hentet fra backup.'); }
    catch(e){ toast('Filen er ikke en gyldig Kortscanner-backup.'); } };
  r.readAsText(file);
}

document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, v = b.dataset.v;
  if (a !== 'del' && a !== 'wipe') S.delArm = false;
  switch (a){
    case 'tab': if (v !== 'scan') stopCam(); S.tab = v; S.view = null; if (v === 'scan' && S.scan.phase !== 'result') S.scan = {phase:'idle'}; render(); window.scrollTo(0, 0); if (v === 'scan' && S.scan.phase === 'idle' && localStorage.getItem('kortscanner.camok')) startCam(); return;
    case 'back': if (S.view && S.view.type === 'sell'){ go({type:'entry', id:S.sell.id}); S.sell = null; } else go(null); return;
    case 'coll': S.coll = v; break;
    case 'refresh': refreshPrices(true); return;
    case 'openEntry': openEntry(v); return;
    case 'openCard': openCard(v); return;
    case 'openSet': openSet(v); return;
    case 'setMissing': S.view.missing = v === '1'; break;
    case 'startCam': try { localStorage.setItem('kortscanner.camok', '1'); } catch(e){} startCam(); return;
    case 'snap': snap(); return;
    case 'rescan': S.scan = {phase:'idle'}; startCam(); return;
    case 'toSearch': S.tab = 'sog'; S.view = null; render(); return;
    case 'add': addCard(); return;
    case 'move': entry(S.view.id).coll = v; save(); break;
    case 'del': if (!S.delArm){ S.delArm = true; break; } S.data.entries = S.data.entries.filter(e => e.id !== S.view.id); save(); toast('Kortet er slettet.'); go(null); return;
    case 'sell': { const e = entry(S.view.id); S.sell = {id:e.id, price:String(Math.round(unitValue(e)) || ''), qty:1, buyer:'', email:'', method:'Kontant', got:false}; go({type:'sell', id:e.id}); return; }
    case 'sq': { const e = entry(S.sell.id); S.sell.qty = Math.min(+e.qty || 1, Math.max(1, S.sell.qty + (+v))); break; }
    case 'pay': S.sell.method = v; S.sell.got = false; break;
    case 'got': S.sell.got = !S.sell.got; break;
    case 'doSell': doSell(); return;
    case 'openReceipt': go({type:'receipt', id:v}); return;
    case 'shareR': { const s = S.data.sold.find(x => x.id === S.view.id); navigator.share({title:'Kvittering ' + s.no, text:receiptText(s)}).catch(() => {}); return; }
    case 'copyR': { const s = S.data.sold.find(x => x.id === S.view.id); (navigator.clipboard ? navigator.clipboard.writeText(receiptText(s)) : Promise.reject()).then(() => toast('Kvitteringen er kopieret.'), () => toast('Kunne ikke kopiere.')); return; }
    case 'export': exportData(); return;
    case 'logout': stopCam(); sb.auth.signOut(); S.data = {entries:[], sold:[]}; return;
    case 'wipe': if (!S.delArm){ S.delArm = true; break; } S.data = {entries:[], sold:[]}; save(); S.delArm = false; toast('Samlingen er slettet.'); break;
    default: return;
  }
  render();
});
document.addEventListener('input', ev => {
  const t = ev.target;
  if (t.dataset.f === 'filter'){ S.filter = t.value; const pos = t.selectionStart; render(); const n = $('[data-f="filter"]'); if (n){ n.focus(); try { n.setSelectionRange(pos, pos); } catch(e){} } }
  else if (t.dataset.f === 'q') doSearch(t.value);
  else if (t.dataset.s && S.sell){ S.sell[t.dataset.s] = t.value; }
});
document.addEventListener('change', ev => {
  const t = ev.target;
  if (t.dataset.f === 'sort'){ S.sort = t.value; render(); }
  else if (t.dataset.e && S.view && S.view.type === 'entry'){
    const e = entry(S.view.id), k = t.dataset.e; let v = t.value;
    if (['qty','buy','manual'].includes(k)) v = Math.max(k === 'qty' ? 1 : 0, parseInt(v) || 0);
    e[k] = v; save(); if (k !== 'note') render();
  }
  else if (t.dataset.s === 'price' && S.sell) render();
  else if (t.id === 'fileIn'){ fromFile(t.files[0]); t.value = ''; }
  else if (t.id === 'importIn'){ importData(t.files[0]); t.value = ''; }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && stream){ stopCam(); if (S.scan.phase === 'live'){ S.scan = {phase:'idle'}; render(); } } });

/* ---------- privat adgang (invitationskode fra QR-koden) ---------- */
const INVITE_HASH = 'dba68eefcfdff056b437e06bf81a14923514a684f6f46e549cdc6df869bae200';
const KEY_STORE = 'kortscanner.invite';
const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function sha(t){ const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function validCode(c){ try { return !!c && (await sha(cleanCode(c))) === INVITE_HASH; } catch(e){ return false; } }
function lockScreen(msg){
  $('#tabs').hidden = true; document.querySelector('header.top .iconbtn').hidden = true;
  $('#app').innerHTML = `<div class="col" style="padding-top:24px"><div class="logo" style="width:64px;height:64px;border-radius:18px" aria-hidden="true"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16"/></svg></div>
  <h1>Kortscanner er privat</h1><p class="mut" style="margin:0">Scan QR-koden, du har fået, med telefonens kamera. Eller skriv invitationskoden herunder.</p>
  <label class="f">Invitationskode<input class="i" id="inviteIn" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX" style="text-transform:uppercase;letter-spacing:2px"></label>
  ${msg ? `<p class="small down" style="margin:0">${esc(msg)}</p>` : ''}<button class="btn full" id="inviteBtn">Lås op</button></div>`;
  const go2 = async () => { const v = $('#inviteIn').value; if (await validCode(v)){ try { localStorage.setItem(KEY_STORE, cleanCode(v)); } catch(e){} start(); } else lockScreen('Koden passer ikke. Tjek at du har skrevet den rigtigt.'); };
  $('#inviteBtn').onclick = go2; $('#inviteIn').onkeydown = e => { if (e.key === 'Enter') go2(); };
}
let started = false;
async function start(){
  if (started) return; started = true;
  if (!window.supabase){ authScreen('login', 'Kunne ikke forbinde til login. Tjek din internetforbindelse og genindlæs siden.'); return; }
  sb = window.supabase.createClient(SUPA_URL, SUPA_KEY, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
  sb.auth.onAuthStateChange((ev, session) => {
    if (ev === 'PASSWORD_RECOVERY'){ authScreen('newpass'); return; }
    if (ev === 'SIGNED_OUT'){ user = null; authScreen('login'); }
  });
  const {data} = await sb.auth.getSession();
  if (data && data.session) enterApp(data.session.user); else authScreen('login');
}
let entered = false;
async function enterApp(u){
  user = u; load();
  $('#tabs').hidden = false; document.querySelector('header.top .iconbtn').hidden = false;
  S.view = null; S.tab = 'samling'; render();
  if (!entered){
    entered = true;
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try { await syncDown(); render(); } catch(e){ S.syncErr = true; render(); toast('Kunne ikke hente din samling fra skyen. Du ser den, der er gemt på telefonen.'); }
  setTimeout(() => { if (S.data.entries.length) refreshPrices(false); }, 1500);
}
function authScreen(mode, msg, ok){
  $('#tabs').hidden = true; document.querySelector('header.top .iconbtn').hidden = true;
  const titles = {login:'Log ind', signup:'Opret konto', forgot:'Glemt adgangskode', newpass:'Vælg ny adgangskode'};
  const btn = {login:'Log ind', signup:'Opret konto', forgot:'Send link', newpass:'Gem adgangskode'}[mode];
  $('#app').innerHTML = `<form class="col" id="authForm" style="padding-top:16px" novalidate>
  <h1>${titles[mode]}</h1>
  ${mode === 'signup' ? '<p class="mut" style="margin:0">Din samling og dine salg gemmes på din konto, så du har dem på alle dine enheder.</p>' : ''}
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
    const back = location.origin + location.pathname;
    try {
      if (mode === 'login'){
        const {data, error} = await sb.auth.signInWithPassword({email, password:pass});
        if (error) return authScreen('login', /confirm/i.test(error.message) ? 'Du skal først bekræfte din e-mail. Tjek din indbakke (og spam).' : 'Forkert e-mail eller adgangskode.');
        enterApp(data.user);
      } else if (mode === 'signup'){
        const {data, error} = await sb.auth.signUp({email, password:pass, options:{emailRedirectTo:back}});
        if (error) return authScreen('signup', /registered|exists/i.test(error.message) ? 'Der findes allerede en konto med den e-mail. Log ind i stedet.' : /rate|limit/i.test(error.message) ? 'Der er sendt for mange mails lige nu. Prøv igen om lidt.' : 'Kontoen kunne ikke oprettes: ' + error.message);
        if (data.session) enterApp(data.user);
        else authScreen('login', 'Næsten færdig! Vi har sendt en mail til ' + email + '. Tryk på linket i mailen, og log så ind her.', true);
      } else if (mode === 'forgot'){
        const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo:back});
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
