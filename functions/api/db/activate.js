// Cloudflare Pages Functions — /api/db/activate
// Gate aktivasi fitur Database per proyek (pola sama dengan /api/email action=activate):
// pengguna harus menekan CTA "Aktifkan Database" dulu sebelum tabel/kunci API muncul.
// Aktivasi TIDAK memanggil gateway sama sekali — hanya menyalakan flag lokal supaya
// halaman tidak langsung mencoba fetch gateway (dan menampilkan error) saat baru dibuka.
//   GET  ?project_id=xxx -> { active: bool, created_at }
//   POST { project_id }  -> { active: true, created_at }

import { guardProject } from '../user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

let _tableReady = false;
async function initTable(db) {
  if (_tableReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS db_project_settings (project_id TEXT PRIMARY KEY, active INTEGER DEFAULT 0, created_at TEXT)').run();
  _tableReady = true;
}

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  const projectId = new URL(request.url).searchParams.get('project_id') || '';
  if (!projectId) return json({ error: 'project_id required' }, 400);
  const err = await guardProject(env, request, projectId);
  if (err) return err;
  await initTable(env.DB);
  const row = await env.DB.prepare('SELECT active, created_at FROM db_project_settings WHERE project_id = ?').bind(projectId).first();
  return json({ active: !!(row && row.active), created_at: row ? row.created_at : null });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Body JSON tidak valid' }, 400); }
  const projectId = body.project_id || '';
  if (!projectId) return json({ error: 'project_id required' }, 400);
  const err = await guardProject(env, request, projectId);
  if (err) return err;
  await initTable(env.DB);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await env.DB.prepare(
    'INSERT INTO db_project_settings (project_id, active, created_at) VALUES (?, 1, ?) ON CONFLICT (project_id) DO UPDATE SET active = 1'
  ).bind(projectId, now).run();
  return json({ active: true, created_at: now });
}
