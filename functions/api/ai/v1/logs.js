// Cloudflare Pages Function — /api/ai/v1/logs "Clincoo Open API" (log & analitik)
// Log pemakaian Clincoo Open API per proyek (real-time: dibaca berkala oleh
// halaman Integrasi AI). Jalur /api/* -> middleware sudah memastikan user login.
//   GET ?project_id=xxx -> { logs: [50 terakhir: model, waktu, ms, token, kredit,
//                              sumber(web), status, error], stats: {...} }

import { currentUser } from '../../user-scope.js';

// Kepemilikan proyek (pola sama dengan requireOwned di pay.js / mcp-token.js):
// hanya pemilik proyek (atau anggota kolaborasi project_members) yang boleh
// mengakses data AI proyek ini. Sebelumnya SEMUA user login bisa mengakses
// proyek siapa pun asal tahu project_id (celah IDOR).
async function requireOwnedProject(env, request, projectId) {
  const user = await currentUser(env, request);
  if (!user) return { error: json({ error: 'Login diperlukan', need_login: true }, 401) };
  if (!projectId) return { error: json({ error: 'project_id required' }, 400) };
  const uid = Number(user.id);
  let row = null;
  try { row = await env.DB.prepare('SELECT user_id FROM user_projects WHERE id = ?').bind(projectId).first(); } catch (e) { row = null; }
  if (row) {
    if (Number(row.user_id) === uid) return { user: user };
    try {
      const mem = await env.DB.prepare('SELECT id FROM project_members WHERE project_id = ? AND user_id = ?').bind(projectId, uid).first();
      if (mem) return { user: user };
    } catch (e) {}
    return { error: json({ error: 'Proyek tidak ditemukan atau bukan milikmu' }, 404) };
  }
  return { error: json({ error: 'Proyek tidak ditemukan atau bukan milikmu' }, 404) };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS ai_router_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, ts TEXT, model TEXT, ok INTEGER, ms INTEGER, tokens INTEGER, err TEXT)').run();
    // kolom baru (aman dipanggil berulang — error duplikat diabaikan)
    try { await db.prepare('ALTER TABLE ai_router_logs ADD COLUMN src TEXT').run(); } catch (e) {}
    try { await db.prepare('ALTER TABLE ai_router_logs ADD COLUMN cost REAL').run(); } catch (e) {}
    const projectId = new URL(request.url).searchParams.get('project_id') || '';
    const own = await requireOwnedProject(env, request, projectId);
    if (own.error) return own.error;

    const logs = await db.prepare('SELECT ts, model, ok, ms, tokens, cost, src, err FROM ai_router_logs WHERE project_id = ? ORDER BY id DESC LIMIT 50').bind(projectId).all();
    const stats = await db.prepare("SELECT COUNT(*) total, COALESCE(SUM(ok), 0) ok, COUNT(*) - COALESCE(SUM(ok), 0) fail, COALESCE(SUM(tokens), 0) tokens, COALESCE(SUM(cost), 0) cost FROM ai_router_logs WHERE project_id = ?").bind(projectId).first();
    const perModel = await db.prepare('SELECT model, COUNT(*) n, COALESCE(SUM(tokens), 0) tok, COALESCE(SUM(cost), 0) cost FROM ai_router_logs WHERE project_id = ? GROUP BY model ORDER BY n DESC').bind(projectId).all();

    return json({
      logs: (logs.results || []).map(r => ({ t: r.ts, m: r.model, ok: !!r.ok, ms: r.ms, tok: r.tokens, c: r.cost || 0, s: r.src || 'langsung', err: r.err || '' })),
      stats: {
        total: (stats && stats.total) || 0,
        ok: (stats && stats.ok) || 0,
        fail: (stats && stats.fail) || 0,
        tokens: (stats && stats.tokens) || 0,
        cost: (stats && stats.cost) || 0,
        per_model: (perModel.results || []).map(r => ({ m: r.model, n: r.n, tok: r.tok, c: r.cost || 0 }))
      }
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
