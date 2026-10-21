// Diagnosa sementara [21 Okt] — dihapus setelah dipakai
import { ASISTEN_PROMPT, ASISTEN_TOOLS } from './_diag_data.js';
const CORS = { 'Access-Control-Allow-Origin': '*' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('t') !== 'd4buxaosjf110vslj') return json({ error: 'no' }, 404);
  let key = '';
  try {
    const row = await env.DB.prepare("SELECT value FROM env_vars WHERE key = 'MODELROUTER_API_KEY'").first();
    key = String(row && row.value || '');
  } catch (e) { return json({ error: 'db:' + String(e && e.message || e).slice(0, 100) }); }
  if (!key) return json({ error: 'no key' });

  const run = async (name, body) => {
    const t0 = Date.now();
    try {
      const res = await fetch('https://modelrouter.id/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'HTTP-Referer': 'https://clincoo.buzz', 'X-Title': 'Clincoo' },
        body: JSON.stringify(body)
      });
      const txt = await res.text();
      let tail = txt.slice(0, 220);
      try { const j = JSON.parse(txt); if (j && j.choices && j.choices[0]) tail = JSON.stringify({ content: (j.choices[0].message && j.choices[0].message.content || '').slice(0, 80), finish: j.choices[0].finish_reason, err: j.error && (j.error.message || j.error.code || 'err') }).slice(0, 220); } catch (e) {}
      return { name, ms: Date.now() - t0, status: res.status, body: tail };
    } catch (e) { return { name, ms: Date.now() - t0, error: String(e && e.message || e).slice(0, 150) }; }
  };

  const base = { model: 'glm-5.3-flash:mr', max_tokens: 8192 };
  const small = [{ role: 'user', content: 'Jawab satu kata: siap' }];
  const bigSys = [{ role: 'system', content: ASISTEN_PROMPT }, { role: 'user', content: 'tes' }];
  const out = [];
  out.push(await run('ns_small', { ...base, messages: small }));
  out.push(await run('stream_small', { ...base, messages: small, stream: true }));
  out.push(await run('ns_big_real', { ...base, messages: bigSys }));
  out.push(await run('stream_big_real', { ...base, messages: bigSys, stream: true }));
  out.push(await run('stream_big_tools', { ...base, messages: bigSys, stream: true, tools: ASISTEN_TOOLS }));
  out.push(await run('ns_big_4k', { model: 'glm-5.3-flash:mr', max_tokens: 4096, messages: bigSys }));
  return json({ out });
}
