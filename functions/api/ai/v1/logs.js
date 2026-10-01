// Cloudflare Pages Function — /api/ai/v1/logs "Clinqoo Open API" (log & analitik)
// Log pemakaian Clinqoo Open API per proyek. Jalur /api/* -> middleware sudah
// memastikan user login (Bearer token akun).
//   GET ?project_id=xxx -> { logs: [50 terakhir], stats: { total, ok, fail, tokens, per_model } }

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
    const projectId = new URL(request.url).searchParams.get('project_id') || '';
    if (!projectId) return json({ error: 'project_id required' }, 400);

    const logs = await db.prepare('SELECT ts, model, ok, ms, tokens, err FROM ai_router_logs WHERE project_id = ? ORDER BY id DESC LIMIT 50').bind(projectId).all();
    const stats = await db.prepare("SELECT COUNT(*) total, COALESCE(SUM(ok), 0) ok, COUNT(*) - COALESCE(SUM(ok), 0) fail, COALESCE(SUM(tokens), 0) tokens FROM ai_router_logs WHERE project_id = ?").bind(projectId).first();
    const perModel = await db.prepare('SELECT model, COUNT(*) n, COALESCE(SUM(tokens), 0) tok FROM ai_router_logs WHERE project_id = ? GROUP BY model ORDER BY n DESC').bind(projectId).all();

    return json({
      logs: (logs.results || []).map(r => ({ t: r.ts, m: r.model, ok: !!r.ok, ms: r.ms, tok: r.tokens, err: r.err || '' })),
      stats: {
        total: (stats && stats.total) || 0,
        ok: (stats && stats.ok) || 0,
        fail: (stats && stats.fail) || 0,
        tokens: (stats && stats.tokens) || 0,
        per_model: (perModel.results || []).map(r => ({ m: r.model, n: r.n, tok: r.tok }))
      }
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
