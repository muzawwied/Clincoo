// Diagnosa sementara [21 Okt] — dihapus setelah dipakai
const CORS = { 'Access-Control-Allow-Origin': '*' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('t') !== 'd4buxaosjf110vslj') return json({ error: 'no' }, 404);
  const out = { db: {}, mr: {}, or: {}, wa: {}, gem: {} };
  try {
    const rows = await env.DB.prepare("SELECT key, value FROM env_vars WHERE key LIKE '%API%' OR key LIKE '%KEY%'").all();
    out.db.rows = (rows.results || []).map(r => ({ key: r.key, tail: String(r.value || '').slice(-4), len: String(r.value || '').length }));
  } catch (e) { out.db.error = String(e && e.message || e).slice(0, 200); }
  const pick = (p) => { const r = (out.db.rows || []).find(x => x.key === p); return r; };

  const testOAI = async (name, ep, key, model) => {
    try {
      const t0 = Date.now();
      const res = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'HTTP-Referer': 'https://clincoo.buzz', 'X-Title': 'Clincoo' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Balas satu kata: OK' }], max_tokens: 64 }) });
      const body = await res.text();
      out[name] = { ms: Date.now() - t0, status: res.status, body: body.slice(0, 250) };
    } catch (e) { out[name] = { error: String(e && e.message || e).slice(0, 200) }; }
  };

  // [fix diag] ambil NILAI key, uji tiap key Gemini (6), OR (2), MR (1)
  const vals = {};
  for (const r of (out.db.rows || [])) {
    try { const row = await env.DB.prepare('SELECT value FROM env_vars WHERE key = ?').bind(r.key).first(); if (row) vals[r.key] = String(row.value || ''); } catch (e) { vals[r.key] = null; }
  }
  out.mr = {}; out.or = {}; out.gem = {};
  if (vals['MODELROUTER_API_KEY']) await testOAI('mr', 'https://modelrouter.id/v1/chat/completions', vals['MODELROUTER_API_KEY'], 'glm-5.3-flash:mr'); else out.mr = { note: 'key tidak ada di env_vars' };
  for (const k of ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2']) {
    if (vals[k]) await testOAI('or_' + k.slice(-2), 'https://openrouter.ai/api/v1/chat/completions', vals[k], 'anthropic/claude-haiku-4.5');
  }
  const gkeys = ['GEMINI_API_KEY', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY_3', 'GEMINI_API_KEY_4', 'GEMINI_API_KEY_5', 'GEMINI_API_KEY_6'];
  out.gem.results = [];
  for (const k of gkeys) {
    if (!vals[k]) { out.gem.results.push({ key: k, note: 'tidak ada' }); continue; }
    try {
      const t0 = Date.now();
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(vals[k]), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: 'Balas satu kata: OK' }] }] }) });
      const body = await res.text();
      out.gem.results.push({ key: k, ms: Date.now() - t0, status: res.status, body: body.slice(0, 150) });
    } catch (e) { out.gem.results.push({ key: k, error: String(e && e.message || e).slice(0, 150) }); }
  }
  try { const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages: [{ role: 'user', content: 'Balas OK' }] }); out.wa = { ok: true, sample: String(r && (r.response || r) || '').slice(0, 80) }; } catch (e) { out.wa = { error: String(e && e.message || e).slice(0, 200) }; }
  return json(out);
}
