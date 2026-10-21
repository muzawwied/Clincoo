// Diagnostik sementara [21 Okt] — uji+pasang gateway AI baru; dihapus setelah dipakai
const CORS = { 'Access-Control-Allow-Origin': '*' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const NEW_EP = 'https://app.clincoo.buzz/v1/chat/completions';
const NEW_MODEL = 'clincoo/glm-4.7-flash';

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('t') !== '090d4fa9db7b7a1a5cd7fdc4355926f7') return json({ error: 'no' }, 404);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const key = String(body.key || '');
  if (!key) return json({ error: 'no key' });

  if (body.action === 'install') {
    try {
      const info = await env.DB.prepare("SELECT key, value FROM env_vars WHERE key = 'MODELROUTER_API_KEY'").all();
      const rows = (info.results || []);
      for (const r of rows) {
        if (String(r.value) === key) continue;
        await env.DB.prepare("DELETE FROM env_vars WHERE key = 'MODELROUTER_API_KEY' AND value = ?").bind(r.value).run();
      }
      const exist = await env.DB.prepare("SELECT id FROM env_vars WHERE key = 'MODELROUTER_API_KEY' AND value = ?").bind(key).first();
      if (!exist) await env.DB.prepare("INSERT INTO env_vars (key, value) VALUES ('MODELROUTER_API_KEY', ?)").bind(key).run();
      const check = await env.DB.prepare("SELECT value FROM env_vars WHERE key = 'MODELROUTER_API_KEY'").all();
      return json({ ok: true, rows: (check.results || []).map(r => ({ len: String(r.value || '').length, tail: String(r.value || '').slice(-4) })) });
    } catch (e) { return json({ error: 'db:' + String(e && e.message || e).slice(0, 200) }); }
  }

  // action test default
  const run = async (name, messages, extra) => {
    const t0 = Date.now();
    try {
      const res = await fetch(NEW_EP, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }, body: JSON.stringify({ model: NEW_MODEL, messages, max_tokens: 300, ...(extra || {}) }) });
      const txt = await res.text();
      let tail = txt.slice(0, 200);
      try { const j = JSON.parse(txt); if (j && j.choices && j.choices[0]) tail = JSON.stringify({ content: (j.choices[0].message && j.choices[0].message.content || '').slice(0, 60), finish: j.choices[0].finish_reason, err: j.error && (j.error.message || j.error.code || 'err') }).slice(0, 200); } catch (e) {}
      return { name, ms: Date.now() - t0, status: res.status, body: tail };
    } catch (e) { return { name, ms: Date.now() - t0, error: String(e && e.message || e).slice(0, 150) }; }
  };
  const filler = 'Kamu adalah Clincoo, asisten AI yang cerdas dan membantu. '.repeat(900);
  const out = [];
  out.push(await run('small', [{ role: 'user', content: 'Halo! Jawab singkat: konek?' }]));
  out.push(await run('big57k', [{ role: 'system', content: filler }, { role: 'user', content: 'tes' }]));
  out.push(await run('stream', [{ role: 'user', content: 'Jawab satu kata: siap' }], { stream: true }));
  return json({ out });
}
