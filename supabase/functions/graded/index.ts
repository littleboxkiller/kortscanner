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
  return { n: d.name || null, m: (d.prices && d.prices.market) || null, g, u: (d.ebay && d.ebay.updatedAt) || d.updatedAt || null };
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
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
