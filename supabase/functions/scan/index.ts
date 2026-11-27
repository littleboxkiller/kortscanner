// Kortscanner: AI-scanning af et kortbillede med Google Gemini.
// Nøglen ligger som hemmelighed (GEMINI_API_KEY) på serveren og sendes aldrig til appen.
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

const MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const key = Deno.env.get('GEMINI_API_KEY');
    if (!key) return json({ error: 'missing_key' });
    const body = await req.json().catch(() => ({}));
    const img = String((body && body.image) || '').replace(/^data:image\/\w+;base64,/, '');
    if (!img || img.length > 4_000_000) return json({ error: 'bad_image' }, 400);
    let last = '';
    for (const model of MODELS) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: img } }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
        }),
      });
      if (r.status === 404) { last = 'model_404 ' + model; continue; }
      if (r.status === 429) return json({ error: 'quota' });
      const j = await r.json().catch(() => null);
      if (!r.ok) { last = 'http_' + r.status + ' ' + JSON.stringify(j).slice(0, 200); continue; }
      const text = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts.map((p: { text?: string }) => p.text || '').join('');
      let card = null;
      try { card = JSON.parse(String(text).replace(/^```json|```$/g, '').trim()); } catch (_) { last = 'parse'; continue; }
      return json({ card, model });
    }
    return json({ error: last || 'failed' });
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
});
