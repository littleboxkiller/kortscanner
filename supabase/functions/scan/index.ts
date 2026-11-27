// Kortscanner: AI-scanning af et kortbillede.
// Først Google Gemini (gratis kvote), derefter Claude (Anthropic) som reserve.
// Nøglerne ligger som hemmeligheder (GEMINI_API_KEY, ANTHROPIC_API_KEY) på serveren og sendes aldrig til appen.
import { createClient } from 'npm:@supabase/supabase-js@2';
const LIMIT = Number(Deno.env.get('SCAN_MONTHLY_LIMIT') || 1000); // AI-scanninger pr. måned for hele appen
const month = () => new Date().toISOString().slice(0, 7);
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const PROMPT = `You identify Pokémon Trading Card Game cards from a photo. The card may be holographic, in a sleeve or have glare.
Read the card carefully: the card name at the top, the collector number at the bottom (e.g. "143/147", "DP45", "SWSH050", "TG05/TG30", "GG30/GG70"),
the set symbol, the copyright year and the artwork. Use your knowledge of Pokémon cards to work out the set.
Answer ONLY with JSON:
{"name": "card name exactly as printed in English, e.g. 'Charizard G LV.X' or 'Umbreon VMAX'",
 "number": "collector number as printed, e.g. '215/203' or 'DP45', or '' if unreadable",
 "set": "English set name, e.g. 'Evolving Skies' or 'DP Black Star Promos', or '' if unsure",
 "year": "copyright year if visible, else ''",
 "language": "en, ja, de, fr, it, es, pt, ko or zh",
 "confidence": 0.0-1.0,
 "notes": "short reason"}
If there is no Pokémon card in the image, answer {"name": "", "confidence": 0}.`;

const GEMINI_MODELS = (Deno.env.get('GEMINI_MODELS') || 'gemini-3.5-flash,gemini-flash-latest,gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-flash-lite-latest').split(',');
const CLAUDE_MODEL = Deno.env.get('CLAUDE_MODEL') || 'claude-haiku-5-5';

// finder JSON i et svar, også hvis det står i ```json ... ```
function parseCard(text: string) {
  const t = String(text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(t); } catch (_) { /* prøv at finde { ... } */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { /* ingen JSON */ } }
  return null;
}

type Result = { card?: unknown; model?: string; err?: string };

async function tryGemini(img: string): Promise<Result> {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) return { err: 'gemini: no key' };
  let last = '';
  for (const model of GEMINI_MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: img } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      }),
    });
    if (r.status === 404 || r.status === 503) { last += `${model} ${r.status}; `; continue; }
    if (r.status === 429) return { err: 'gemini: quota' };
    const j = await r.json().catch(() => null);
    if (!r.ok) { last += `${model} http_${r.status}; `; continue; }
    const text = j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') || '';
    const card = parseCard(text);
    if (card) return { card, model };
    last += `${model} parse; `;
  }
  return { err: 'gemini: ' + (last || 'failed') };
}

async function tryClaude(img: string): Promise<Result> {
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) return { err: 'claude: no key' };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } },
        { type: 'text', text: PROMPT },
      ] }],
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) return { err: `claude: http_${r.status} ${j?.error?.type || ''} ${String(j?.error?.message || '').slice(0, 120)}` };
  const text = (j?.content || []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
  const card = parseCard(text);
  return card ? { card, model: CLAUDE_MODEL } : { err: 'claude: parse' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (!Deno.env.get('GEMINI_API_KEY') && !Deno.env.get('ANTHROPIC_API_KEY')) return json({ error: 'missing_key' });
    const body = await req.json().catch(() => ({}));
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: u } = await admin.from('scan_usage').select('count').eq('month', month()).maybeSingle();
    const used = (u && u.count) || 0;
    if (body && body.usage) return json({ used, limit: LIMIT, providers: { gemini: !!Deno.env.get('GEMINI_API_KEY'), claude: !!Deno.env.get('ANTHROPIC_API_KEY') } });
    if (used >= LIMIT) return json({ error: 'month_limit', used, limit: LIMIT });
    const img = String((body && body.image) || '').replace(/^data:image\/\w+;base64,/, '');
    if (!img || img.length > 4_000_000) return json({ error: 'bad_image' }, 400);
    // body.only = 'claude' eller 'gemini' bruges kun til test
    const order = body.only === 'claude' ? [tryClaude] : body.only === 'gemini' ? [tryGemini] : [tryGemini, tryClaude];
    const errs: string[] = [];
    for (const t of order) {
      const res = await t(img);
      if (res.card) {
        const { data: n } = await admin.rpc('bump_scan', { m: month() });
        return json({ card: res.card, model: res.model, used: n || used + 1, limit: LIMIT });
      }
      if (res.err) errs.push(res.err);
    }
    const quota = errs.some((e) => e.includes('quota')) && !errs.some((e) => e.startsWith('claude: http') || e === 'claude: parse');
    return json({ error: quota ? 'quota' : errs.join(' | ') || 'failed' });
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
});
