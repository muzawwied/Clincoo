// Cloudflare Pages Function — /api/ai/v1/secret "Clinqoo Open API" (pengelolaan secret)
// Secret API Clinqoo per proyek — dikeluarkan Clinqoo untuk user (user TIDAK
// membawa key provider sendiri). Dipakai sebagai Bearer di /v1/chat/completions.
// Jalur /api/* -> middleware sudah memastikan user login (Bearer token akun).
//   GET    ?project_id=xxx  -> status + secret (pemilik proyek)
//   POST   { project_id }   -> buat/ganti secret baru
//   DELETE ?project_id=xxx  -> cabut secret

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

async function initSecretTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS ai_router_secrets (project_id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT, last_used TEXT)').run();
}

function newSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return 'clk_sk_' + hex;
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    await initSecretTable(db);
    const projectId = new URL(request.url).searchParams.get('project_id') || '';
    if (!projectId) return json({ error: 'project_id required' }, 400);
    const row = await db.prepare('SELECT secret, created_at, last_used FROM ai_router_secrets WHERE project_id = ?').bind(projectId).first();
    if (!row) return json({ exists: false });
    return json({ exists: true, secret: row.secret, created_at: row.created_at, last_used: row.last_used });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    await initSecretTable(db);
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const projectId = String(body.project_id || '');
    if (!projectId) return json({ error: 'project_id required' }, 400);
    const secret = newSecret();
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO ai_router_secrets (project_id, secret, created_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at, last_used = NULL')
      .bind(projectId, secret, now).run();
    try { await db.prepare("INSERT INTO activity_log (action, details) VALUES (?, ?)").bind('ai_secret_create', 'Project ' + projectId + ' membuat/ganti secret API AI').run(); } catch (e) {}
    return json({ success: true, project_id: projectId, secret, created_at: now, notice: 'Simpan secret ini — hanya pemilik proyek yang bisa melihatnya kembali.' });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    await initSecretTable(db);
    const projectId = new URL(request.url).searchParams.get('project_id') || '';
    if (!projectId) return json({ error: 'project_id required' }, 400);
    const res = await db.prepare('DELETE FROM ai_router_secrets WHERE project_id = ?').bind(projectId).run();
    return json({ success: true, revoked: (res.meta && res.meta.changes) > 0 });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
