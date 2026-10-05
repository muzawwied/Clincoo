// Cloudflare Pages Functions — /v1/db/tables (Clincoo Open API untuk database)
// Jalur PUBLIK: aplikasi yang di-deploy user memanggil ini pakai Bearer kunci
// proyek (dibuat lewat /api/db/key). Tidak perlu login akun.
// Mirroring /v1/chat/completions: kunci dicari di db_app_keys → project_id.

import { getEffectivePlanByUserKey } from '../../api/plan-helpers.js';

const GATEWAY = 'https://clinqoo-db-gateway.vylonium.workers.dev';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

async function gw(env, method, url, bodyObj) {
  const key = env.DB_GATEWAY_KEY;
  if (!key) return json({ error: 'Fitur database belum dikonfigurasi di server' }, 503);
  const init = { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key } };
  if (bodyObj) init.body = JSON.stringify(bodyObj);
  return fetch(GATEWAY + url, init);
}

async function authProject(env, request) {
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const key = m ? m[1].trim() : new URL(request.url).searchParams.get('key') || '';
  if (!key) return { error: json({ error: 'Kunci proyek diperlukan (Authorization: Bearer <kunci>). Buat di halaman Database Clincoo.' }, 401) };
  try {
    const row = await env.DB.prepare('SELECT project_id FROM db_app_keys WHERE key = ?').bind(key).first();
    if (!row) return { error: json({ error: 'Kunci tidak dikenali atau sudah dicabut' }, 401) };
    try { await env.DB.prepare('UPDATE db_app_keys SET last_used = ? WHERE project_id = ?').bind(new Date().toISOString(), row.project_id).run(); } catch (e) {}
    return { projectId: row.project_id };
  } catch (e) {
    return { error: json({ error: 'Kunci database belum tersedia' }, 503) };
  }
}

async function planOfProject(env, projectId) {
  try {
    const r = await env.DB.prepare('SELECT user_id FROM user_projects WHERE id = ?').bind(projectId).first();
    if (!r || r.user_id === null) return 'Starter';
    const eff = await getEffectivePlanByUserKey(env.DB, 'u' + Number(r.user_id));
    return eff.plan || 'Starter';
  } catch (e) { return 'Starter'; }
}

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  const a = await authProject(env, request);
  if (a.error) return a.error;
  return gw(env, 'GET', '/tables?project_id=' + encodeURIComponent(a.projectId));
}

export async function onRequestPost({ request, env }) {
  const a = await authProject(env, request);
  if (a.error) return a.error;
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Body JSON tidak valid' }, 400); }
  body.project_id = a.projectId;
  body.plan = await planOfProject(env, a.projectId);
  const res = await gw(env, 'POST', '/tables', body);
  return res.ok ? res : json({ error: (await res.json().catch(() => ({}))).error || 'Gagal membuat tabel' }, res.status);
}

export async function onRequestDelete({ request, env }) {
  const a = await authProject(env, request);
  if (a.error) return a.error;
  const name = new URL(request.url).searchParams.get('name') || '';
  return gw(env, 'DELETE', '/tables?project_id=' + encodeURIComponent(a.projectId) + '&name=' + encodeURIComponent(name));
}
