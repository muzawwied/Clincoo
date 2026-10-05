// Cloudflare Pages Functions — /api/db/rows
// CRUD baris tabel virtual — proxy ke clinqoo-db-gateway (akun Vylonium).
// Kepemilikan proyek dicek lokal (guardProject); paket dikirim ke gateway
// untuk pengecekan limit baris & kuota tulis harian.

import { guardProject, currentUser } from '../user-scope.js';
import { getEffectivePlanByUserKey } from '../plan-helpers.js';

const GATEWAY = 'https://clinqoo-db-gateway.vylonium.workers.dev';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

async function planOf(env, request) {
  const user = await currentUser(env, request);
  const eff = await getEffectivePlanByUserKey(env.DB, user ? 'u' + user.id : null);
  return eff.plan || 'Starter';
}

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
      // Bungkus dengan CORS: respons gateway mentah tidak punya header CORS,
      // kalau diteruskan apa adanya browser menolak membacanya (Failed to fetch).
      const h = { 'Content-Type': res.headers.get('Content-Type') || 'application/json', ...CORS };
      return new Response(res.body, { status: res.status, headers: h });
    } catch (e) {
      clearTimeout(t);
    }
  }
  return json({ error: 'Database sedang tidak bisa dihubungi. Coba lagi sebentar.' }, 502);
}

async function guard(env, request, projectId) {
  const g = await guardProject(env, request, projectId);
  return g || null;
}

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const projectId = u.searchParams.get('project_id') || '';
  const err = await guard(env, request, projectId);
  if (err) return err;
  const q = '/rows?project_id=' + encodeURIComponent(projectId) +
    '&table=' + encodeURIComponent(u.searchParams.get('table') || '') +
    '&limit=' + (u.searchParams.get('limit') || '50') +
    '&offset=' + (u.searchParams.get('offset') || '0');
  return gw(env, 'GET', q);
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Body JSON tidak valid' }, 400); }
  const projectId = body.project_id || '';
  const err = await guard(env, request, projectId);
  if (err) return err;
  body.plan = await planOf(env, request);
  const res = await gw(env, 'POST', '/rows', body);
  if (res.ok) return res;
  const d = await res.json().catch(() => ({}));
  return json({ error: d.error || 'Gagal menambah baris' }, res.status);
}

export async function onRequestPatch({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Body JSON tidak valid' }, 400); }
  const projectId = body.project_id || '';
  const err = await guard(env, request, projectId);
  if (err) return err;
  body.plan = await planOf(env, request);
  const res = await gw(env, 'PATCH', '/rows', body);
  if (res.ok) return res;
  const d = await res.json().catch(() => ({}));
  return json({ error: d.error || 'Gagal memperbarui baris' }, res.status);
}

export async function onRequestDelete({ request, env }) {
  const u = new URL(request.url);
  const projectId = u.searchParams.get('project_id') || '';
  const err = await guard(env, request, projectId);
  if (err) return err;
  const q = '/rows?project_id=' + encodeURIComponent(projectId) +
    '&table=' + encodeURIComponent(u.searchParams.get('table') || '') +
    '&id=' + encodeURIComponent(u.searchParams.get('id') || '');
  return gw(env, 'DELETE', q);
}
