// Kortscanner: henter gradede priser (PSA m.fl.) fra PokemonPriceTracker og gemmer dem i et døgn.
// Nøglen ligger som hemmelighed (PPT_API_KEY) på serveren og sendes aldrig til appen.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const DAY = 24 * 3600 * 1000;
// Gør svaret lille: kun navn, normalpris og eBay-salg pr. karakter (psa10, bgs9_5, cgc10 ...).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const slim = (j: any) => {
  if (!j || j.g || j.error) return j;
  const d = j.data && !Array.isArray(j.data) ? j.data : (Array.isArray(j.data) ? j.data[0] : j);
  if (!d) return { g: {} };
  const g: Record<string, unknown[]> = {};
  const s = (d.ebay && d.ebay.salesByGrade) || {};
  for (const k of Object.keys(s)) {
    const v = s[k] || {};
    const smart = v.smartMarketPrice && v.smartMarketPrice.price;
    g[k] = [Math.round((smart || v.medianPrice || v.averagePrice || 0) * 100) / 100, Math.round((v.medianPrice || 0) * 100) / 100, v.count || 0, v.marketTrend || null, (v.smartMarketPrice && v.smartMarketPrice.confidence) || null];
  }
  return { id: d.tcgPlayerId ? String(d.tcgPlayerId) : null, n: d.name || null, no: d.cardNumber || null, s: d.setName || null, m: (d.prices && d.prices.market) || null, g, u: (d.ebay && d.ebay.updatedAt) || d.updatedAt || null };
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    // find: kort uden TCGplayer-nummer (f.eks. gamle promo-kort) slås op på navn og nummer
    if (Array.isArray(body.find) && body.find.length) {
      const admin0 = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const key0 = Deno.env.get('PPT_API_KEY');
      const res: Record<string, unknown> = {};
      const normNo = (x: unknown) => String(x || '').toUpperCase().split('/')[0].replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]*)0+(\d)/, '$1$2');
      for (const f of body.find.slice(0, 3)) {
        const ck = 'f:' + String(f.key || '').slice(0, 60);
        if (!f || !f.key || !f.name) continue;
        const { data: c0 } = await admin0.from('graded_cache').select('data,fetched_at').eq('id', ck).maybeSingle();
        if (c0 && Date.now() - new Date(c0.fetched_at).getTime() < DAY * 3) { res[f.key] = c0.data; continue; }
        if (!key0) break;
        const want = normNo(f.number);
        const url = `https://www.pokemonpricetracker.com/api/v2/cards?search=${encodeURIComponent(String(f.name).slice(0, 60))}&limit=${Math.min(Number(f.limit) || 25, 50)}&includeEbay=true`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${key0}` } });
        if (r.status === 429) { res[f.key] = { error: 429 }; break; }
        const j = await r.json().catch(() => null);
        const list = (j && Array.isArray(j.data)) ? j.data : [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hit = list.find((d: any) => want && normNo(d.cardNumber) === want) || null;
        const out0 = hit ? slim({ data: hit }) : { g: {}, none: true };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (body.debug) (out0 as any).seen = list.map((d: any) => [d.cardNumber, d.name, d.setName]).slice(0, 30);
        res[f.key] = out0;
        await admin0.from('graded_cache').upsert({ id: ck, data: out0, fetched_at: new Date().toISOString() });
        if (hit && hit.tcgPlayerId) await admin0.from('graded_cache').upsert({ id: String(hit.tcgPlayerId), data: out0, fetched_at: new Date().toISOString() });
      }
      return json({ found: res });
    }
    const ids: string[] = [...new Set(((body && body.ids) || []).map((x: unknown) => String(x)).filter((x: string) => /^\d{1,10}$/.test(x)))].slice(0, 40) as string[];
    if (!ids.length) return json({ data: {} });
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: cached } = await admin.from('graded_cache').select('id,data,fetched_at').in('id', ids);
    const out: Record<string, unknown> = {};
    const now = Date.now();
    (cached || []).forEach((r: { id: string; data: unknown; fetched_at: string }) => { if (now - new Date(r.fetched_at).getTime() < DAY) out[r.id] = slim(r.data); });
    const key = Deno.env.get('PPT_API_KEY');
    if (!key) return json({ data: out, error: 'missing_key' });
    const need = ids.filter((id) => !(id in out)).slice(0, Number(body.max) > 0 ? Math.min(Number(body.max), 15) : 8);
    let limited = false;
    for (const id of need) {
      const r = await fetch(`https://www.pokemonpricetracker.com/api/v2/cards?tcgPlayerId=${id}&includeEbay=true`, { headers: { Authorization: `Bearer ${key}` } });
      if (r.status === 429) { limited = true; break; }
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) { out[id] = { error: r.status }; continue; }
      const sj = slim(j);
      out[id] = sj;
      await admin.from('graded_cache').upsert({ id, data: sj, fetched_at: new Date().toISOString() });
    }
    return json({ data: out, limited });
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
});
