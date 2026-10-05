// Cloudflare Pages Functions — /api/db/key
// Kunci akses database per proyek untuk aplikasi yang di-deploy user.
// Dikeluarkan Clincoo (pola sama dengan /api/ai/v1/secret — kunci Open API).
// Dipakai sebagai Bearer di /v1/db/* — jalur publik (tanpa login akun).
//   GET    ?project_id=xxx  -> status + kunci (pemilik proyek)
//   POST   { project_id }   -> buat/ganti kunci baru
//   DELETE ?project_id=xxx  -> cabut kunci

import { guardProject, currentUser } from '../user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

let _tableReady = false;
async function initTable(db) {
  if (_tableReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS db_app_keys (project_id TEXT PRIMARY KEY, key TEXT NOT NULL, created_at TEXT, last_used TEXT)').run();
  _tableReady = true;
}

function newKey() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return 'clc_db_' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

async function guard(env, request, projectId) {
  const g = await guardProject(env, request, projectId);
  return g || null;
}

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  const projectId = new URL(request.url).searchParams.get('project_id') || '';
  const err = await guard(env, request, projectId);
  if (err) return err;
  await initTable(env.DB);
  const row = await env.DB.prepare('SELECT key, created_at, last_used FROM db_app_keys WHERE project_id = ?').bind(projectId).first();
  return json({ active: !!row, key: row ? row.key : null, created_at: row ? row.created_at : null, last_used: row ? row.last_used : null });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Body JSON tidak valid' }, 400); }
  const projectId = body.project_id || '';
  const err = await guard(env, request, projectId);
  if (err) return err;
  await initTable(env.DB);
  const key = newKey();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await env.DB.prepare(
    'INSERT INTO db_app_keys (project_id, key, created_at) VALUES (?, ?, ?) ON CONFLICT (project_id) DO UPDATE SET key = excluded.key, created_at = excluded.created_at, last_used = NULL'
  ).bind(projectId, key, now).run();
  return json({ success: true, key: key, created_at: now });
}

export async function onRequestDelete({ request, env }) {
  const projectId = new URL(request.url).searchParams.get('project_id') || '';
  const err = await guard(env, request, projectId);
  if (err) return err;
  await initTable(env.DB);
  await env.DB.prepare('DELETE FROM db_app_keys WHERE project_id = ?').bind(projectId).run();
  return json({ success: true });
}
