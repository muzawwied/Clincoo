// Cloudflare Pages Functions — token + izin akses MCP per proyek.
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
  let projectId = url.searchParams.get('project_id') || '';
  if (!projectId && request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'DELETE') {
    try {
      const clone = request.clone();
      const body = await clone.json();
      if (body && body.project_id) projectId = String(body.project_id);
    } catch (e) {}
  }
  if (!projectId) return { error: json({ error: 'project_id wajib diisi' }, 400) };
  const uid = Number(user.id);
  const own = await env.DB.prepare('SELECT id FROM user_projects WHERE id = ? AND user_id = ?').bind(projectId, uid).first();
  if (own) return { user, projectId };
  try {
    const mem = await env.DB.prepare('SELECT id FROM project_members WHERE project_id = ? AND user_id = ?').bind(projectId, uid).first();
    if (mem) return { user, projectId };
  } catch (e) {}
  return { error: json({ error: 'Proyek tidak ditemukan atau bukan milikmu' }, 404) };
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
  await db.prepare(`INSERT INTO ${T.projectSettings} (project_id, key, value) VALUES (?, ?, ?) ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value`).bind(projectId, key, value).run();
}

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
