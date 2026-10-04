// Cloudflare Pages Function — /api/ai/v1/secret "Clinqoo Open API" (pengelolaan secret)
// Secret API Clinqoo per proyek — dikeluarkan Clinqoo untuk user (user TIDAK
// membawa key provider sendiri). Dipakai sebagai Bearer di /v1/chat/completions.
// Jalur /api/* -> middleware sudah memastikan user login (Bearer token akun).
//   GET    ?project_id=xxx  -> status + secret (pemilik proyek)
//   POST   { project_id }   -> buat/ganti secret baru
//   DELETE ?project_id=xxx  -> cabut secret

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
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}

let _secretTableReady = false;
async function initSecretTable(db) {
  // jalankan SEKALI per isolate — sebelumnya CREATE TABLE jalan di setiap
  // request (query D1 ekstra = secret load terasa lambat).
  if (_secretTableReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS ai_router_secrets (project_id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT, last_used TEXT)').run();
  _secretTableReady = true;
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
    const own = await requireOwnedProject(env, request, projectId);
    if (own.error) return own.error;
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
    const own = await requireOwnedProject(env, request, projectId);
    if (own.error) return own.error;
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
    const own = await requireOwnedProject(env, request, projectId);
    if (own.error) return own.error;
    const res = await db.prepare('DELETE FROM ai_router_secrets WHERE project_id = ?').bind(projectId).run();
    return json({ success: true, revoked: (res.meta && res.meta.changes) > 0 });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
