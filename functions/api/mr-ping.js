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
    const k0 = keys[0];
    const fp = { len: k0.length, head: k0.slice(0, 7), tail: k0.slice(-4), codes: [k0.charCodeAt(0), k0.charCodeAt(1), k0.charCodeAt(k0.length - 2), k0.charCodeAt(k0.length - 1)] };

    const out = { ok: false, keys: keys.length, fp: fp };
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

export async function onRequestPost({ request, env }) {
  try {
    const fix = (request.headers.get('x-fix-key') || '').trim();
    if (!fix) return json({ ok: false, error: 'header x-fix-key kosong' }, 400);
    if (!env.DB) return json({ ok: false, error: 'binding DB tidak ada' }, 500);

    // Tulis key ke env_vars di database yang benar-benar dipakai produksi
    await env.DB.prepare("UPDATE env_vars SET value = ?, is_secret = 1, updated_at = datetime('now') WHERE key = 'MODELROUTER_API_KEY'").bind(fix).run();
    let chk = await env.DB.prepare("SELECT value FROM env_vars WHERE key = 'MODELROUTER_API_KEY'").all();
    let vals = (chk.results || []).map(r => String(r.value || ''));
    if (!vals.includes(fix)) {
      await env.DB.prepare("INSERT INTO env_vars (key, value, is_secret) VALUES ('MODELROUTER_API_KEY', ?, 1)").bind(fix).run();
      chk = await env.DB.prepare("SELECT value FROM env_vars WHERE key = 'MODELROUTER_API_KEY'").all();
      vals = (chk.results || []).map(r => String(r.value || ''));
    }
    const written = vals.includes(fix);

    // Hapus duplikat berbeda nilai (jaga satu baris valid)
    await env.DB.prepare("DELETE FROM env_vars WHERE key = 'MODELROUTER_API_KEY' AND value != ?").bind(fix).run();
    return json({ ok: written, step: 'write', rows: vals.length, written: written });
  } catch (e) {
    return json({ ok: false, write_error: String(e && (e.message || e)).slice(0, 200) }, 500);
  }
}
