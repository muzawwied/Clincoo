// Cloudflare Pages Functions — token + izin akses MCP per proyek.
// Dipakai oleh /proyek/pengaturan/server-mcp (tombol Aktifkan, toggle izin,
// Buat ulang token, Putuskan semua akses). Sebelumnya file ini TIDAK ADA sama
// sekali di backend meski frontend sudah lengkap — makanya toggle izin selalu
// gagal (fetch 401 lewat _middleware, request yang sah pun tidak ada handler
// yang nyata di baliknya).
// Disimpan di tabel project_settings per-proyek (key: mcp_token / mcp_scopes /
// mcp_created_at) via getProjectTables — konsisten dengan project-settings.js.
import { getProjectTables } from './_tables.js';
import { currentUser } from './user-scope.js';
import { randomHex } from './auth/shared.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() { return new Response(null, { headers: CORS }); }

async function requireOwnedProject(env, request) {
  const user = await currentUser(env, request);
  if (!user) return { error: json({ error: 'Login diperlukan', need_login: true }, 401) };
  const url = new URL(request.url);
  const projectId = url.searchParams.get('project_id') || '';
  if (!projectId) return { error: json({ error: 'project_id wajib diisi' }, 400) };
  const own = await env.DB.prepare('SELECT id FROM user_projects WHERE id = ? AND user_id = ?').bind(projectId, user.id).first();
  if (!own) return { error: json({ error: 'Proyek tidak ditemukan atau bukan milikmu' }, 404) };
  return { user, projectId };
}

const DEFAULT_SCOPES = { read: true, write: false, delete: false };
function normScopes(s) {
  const o = (s && typeof s === 'object') ? s : {};
  return { read: o.read !== false, write: o.write === true, delete: o.delete === true };
}

async function readState(db, projectId) {
  const T = await getProjectTables(db, projectId);
  const rows = await db.prepare(`SELECT key, value FROM ${T.projectSettings} WHERE project_id = ? AND key IN ('mcp_token','mcp_scopes','mcp_created_at')`).bind(projectId).all();
  const m = {};
  for (const r of rows.results || []) m[r.key] = r.value;
  if (!m.mcp_token) return null;
  let scopes = DEFAULT_SCOPES;
  try { scopes = normScopes(JSON.parse(m.mcp_scopes || '{}')); } catch (e) {}
  return { token: m.mcp_token, scopes, created_at: m.mcp_created_at || null };
}

async function writeSetting(db, projectId, key, value) {
  const T = await getProjectTables(db, projectId);
  await db.prepare(`INSERT INTO ${T.projectSettings} (project_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value`).bind(projectId, key, value).run();
}

// GET /api/mcp-token?project_id=xxx — status token+izin saat ini
export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: 'D1 not bound' }, 500);
  const r = await requireOwnedProject(env, request);
  if (r.error) return r.error;
  try {
    const state = await readState(env.DB, r.projectId);
    if (!state) return json({ not_found: true });
    return json(state);
  } catch (e) { return json({ error: e.message }, 500); }
}

// POST /api/mcp-token — aktifkan server MCP / buat ulang token (body: {project_id, scopes})
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'D1 not bound' }, 500);
  const r = await requireOwnedProject(env, request);
  if (r.error) return r.error;
  try {
    let body = {}; try { body = await request.json(); } catch (e) {}
    const scopes = normScopes(body.scopes);
    const existing = await readState(env.DB, r.projectId);
    const token = randomHex(24);
    const createdAt = (existing && existing.created_at) || new Date().toISOString();
    await writeSetting(env.DB, r.projectId, 'mcp_token', token);
    await writeSetting(env.DB, r.projectId, 'mcp_scopes', JSON.stringify(scopes));
    await writeSetting(env.DB, r.projectId, 'mcp_created_at', createdAt);
    return json({ token, scopes, created_at: createdAt });
  } catch (e) { return json({ error: e.message }, 500); }
}

// PATCH /api/mcp-token — ubah izin saja, token tetap (body: {project_id, scopes})
export async function onRequestPatch({ request, env }) {
  if (!env.DB) return json({ error: 'D1 not bound' }, 500);
  const r = await requireOwnedProject(env, request);
  if (r.error) return r.error;
  try {
    const state = await readState(env.DB, r.projectId);
    if (!state) return json({ error: 'Server MCP belum diaktifkan', not_found: true }, 404);
    let body = {}; try { body = await request.json(); } catch (e) {}
    const scopes = normScopes(body.scopes);
    await writeSetting(env.DB, r.projectId, 'mcp_scopes', JSON.stringify(scopes));
    return json({ ok: true, scopes });
  } catch (e) { return json({ error: e.message }, 500); }
}

// DELETE /api/mcp-token?project_id=xxx — putuskan semua akses
export async function onRequestDelete({ request, env }) {
  if (!env.DB) return json({ error: 'D1 not bound' }, 500);
  const r = await requireOwnedProject(env, request);
  if (r.error) return r.error;
  try {
    const T = await getProjectTables(env.DB, r.projectId);
    await env.DB.prepare(`DELETE FROM ${T.projectSettings} WHERE project_id = ? AND key IN ('mcp_token','mcp_scopes','mcp_created_at')`).bind(r.projectId).run();
    return json({ ok: true });
  } catch (e) { return json({ error: e.message }, 500); }
}
