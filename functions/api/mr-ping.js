// [21 Okt] Diagnosa sementara (akan dihapus): cek kenapa Worker gagal manggil ModelRouter.
// Publik tapi ringan: request 5 token, dibatasi per IP. Tidak membocorkan key.

const CORS = { 'Access-Control-Allow-Origin': '*' };

function json(o, status) {
  return new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function clientIp(request) {
  return (request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '0').split(',')[0].trim();
}

async function rateOk(env, ip) {
  try {
    if (!env.DB) return true;
    const r = await env.DB.prepare("SELECT COUNT(*) as c FROM ai_router_logs WHERE project_id = ? AND ts > datetime('now', '-1 minute')").bind('mrping:' + ip).first();
    return !r || (r.c || 0) < 3;
  } catch (e) { return true; }
}

export async function onRequestGet({ request, env }) {
  try {
    const ip = clientIp(request);
    if (!(await rateOk(env, ip))) return json({ ok: false, error: 'terlalu banyak ping' }, 429);

    const keys = [];
    try {
      if (env.DB) {
        const rows = await env.DB.prepare("SELECT value FROM env_vars WHERE key = 'MODELROUTER_API_KEY'").all();
        for (const r of rows.results || []) { const v = String(r.value || '').trim(); if (v) keys.push(v); }
      }
    } catch (e) {}
    if (env.MODELROUTER_API_KEY) keys.unshift(String(env.MODELROUTER_API_KEY).trim());

    if (!keys.length) return json({ ok: false, step: 'keys', error: 'tidak ada key MR di env_vars D1 maupun Pages env' });

    const out = { ok: false, keys: keys.length };
    const t0 = Date.now();
    try {
      const res = await fetch('https://modelrouter.id/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keys[0] },
        body: JSON.stringify({ model: 'glm-5.3-flash:mr', messages: [{ role: 'user', content: 'Balas satu kata: OK' }], max_tokens: 400 })
      });
      out.status = res.status;
      out.ms = Date.now() - t0;
      let body = await res.text();
      out.snippet = String(body).slice(0, 200);
      try {
        const d = JSON.parse(body);
        if (d.choices && d.choices[0] && d.choices[0].message) {
          out.content = (d.choices[0].message.content || '').slice(0, 40);
          out.ok = res.ok;
        }
      } catch (e) { out.parse_error = true; }
    } catch (e) {
      out.fetch_error = String(e && (e.message || e)).slice(0, 200);
      out.ms = Date.now() - t0;
    }
    try {
      await env.DB.prepare("INSERT INTO ai_router_logs (project_id, ts, model, ok, ms, tokens, err) VALUES (?, datetime('now'), 'mr-ping', 0, ?, 0, ?)")
        .bind('mrping:' + ip, out.ms || 0, JSON.stringify(out).slice(0, 240)).run();
    } catch (e) {}
    return json(out);
  } catch (e) {
    return json({ ok: false, top_error: String(e && (e.message || e)).slice(0, 200) }, 500);
  }
}
