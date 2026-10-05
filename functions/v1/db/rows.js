// Cloudflare Pages Functions — /v1/db/rows (Clincoo Open API untuk database)
// Jalur PUBLIK: CRUD baris untuk aplikasi yang di-deploy user.
// Auth: Bearer kunci proyek (db_app_keys) — sama dengan /v1/db/tables.
//   GET    ?table=nama&limit=&offset=
//   POST   { table, data }
//   PATCH  { table, id, data }
//   DELETE ?table=nama&id=

import { getEffectivePlanByUserKey } from '../../api/plan-helpers.js';

const GATEWAY = 'https://clinqoo-db-gateway.vylonium.workers.dev';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

async function gw(env, method, url, bodyObj) {
  const key = env.DB_GATEWAY_KEY;
  if (!key) return json({ error: 'Fitur database belum dikonfigurasi di server' }, 503);
  const init = { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key } };
  if (bodyObj) init.body = JSON.stringify(bodyObj);
  // Gateway (Worker) kadang cold-start/lambat. Timeout longgar + 3 percobaan dengan
  // jeda naik supaya blip gateway tidak pernah pecah jadi error ke user/frontend.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 500 * attempt));
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 12000);
    try {
      const res = await fetch(GATEWAY + url, { ...init, signal: ac.signal });
      clearTimeout(t);
      return res;
    } catch (e) {
      clearTimeout(t);
    }
  }
  return json({ error: 'Database sedang tidak bisa dihubungi. Coba lagi sebentar.' }, 502);
}

async function authProject(env, request) {
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const key = m ? m[1].trim() : new URL(request.url).searchParams.get('key') || '';
  if (!key) return { error: json({ error: 'Kunci proyek diperlukan (Authorization: Bearer <kunci>)' }, 401) };
  try {
    let row = await env.DB.prepare('SELECT project_id FROM db_app_keys WHERE key = ?').bind(key).first();
    if (!row && key.startsWith('clk_')) {
      // kunci era lama berprefiks clk_ -> padanan clc_ (kompatibilitas, hex sama)
      row = await env.DB.prepare('SELECT project_id FROM db_app_keys WHERE key = ?').bind('clc_' + key.slice(4)).first();
    }
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
  const u = new URL(request.url);
  return gw(env, 'GET', '/rows?project_id=' + encodeURIComponent(a.projectId) +
    '&table=' + encodeURIComponent(u.searchParams.get('table') || '') +
    '&limit=' + (u.searchParams.get('limit') || '50') +
    '&offset=' + (u.searchParams.get('offset') || '0'));
}

export async function onRequestPost({ request, env }) {
  const a = await authProject(env, request);
  if (a.error) return a.error;
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Body JSON tidak valid' }, 400); }
  body.project_id = a.projectId;
  body.plan = await planOfProject(env, a.projectId);
  const res = await gw(env, 'POST', '/rows', body);
  return res.ok ? res : json({ error: (await res.json().catch(() => ({}))).error || 'Gagal menambah baris' }, res.status);
}

export async function onRequestPatch({ request, env }) {
  const a = await authProject(env, request);
  if (a.error) return a.error;
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Body JSON tidak valid' }, 400); }
  body.project_id = a.projectId;
  body.plan = await planOfProject(env, a.projectId);
  const res = await gw(env, 'PATCH', '/rows', body);
  return res.ok ? res : json({ error: (await res.json().catch(() => ({}))).error || 'Gagal memperbarui baris' }, res.status);
}

export async function onRequestDelete({ request, env }) {
  const a = await authProject(env, request);
  if (a.error) return a.error;
  const u = new URL(request.url);
  return gw(env, 'DELETE', '/rows?project_id=' + encodeURIComponent(a.projectId) +
    '&table=' + encodeURIComponent(u.searchParams.get('table') || '') +
    '&id=' + encodeURIComponent(u.searchParams.get('id') || ''));
}
