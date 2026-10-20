// Cloudflare Pages Function — /api/fn/<nama> (dynamic route)
// URL pemanggilan backend function buatan AI/user (ala platform builder):
//   GET  /api/fn/<nama>?a=<json-args>   → jalankan function milik user login
//   POST /api/fn/<nama>  body {"args": {...}}  → idem, POST untuk modifikasi
// Private: hanya pemilik function (Bearer) yang bisa memanggil.

import { invokeFunction } from '../fns.js';
import { getEffectivePlanByUserKey, featureAllowed, featureGateResponse } from '../plan-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS });
}
async function resolveUser(env, request) {
  try {
    const { initTables, getUserByToken, getToken } = await import('../auth/shared.js');
    await initTables(env.DB);
    const token = getToken(request);
    if (!token) return null;
    const u = await getUserByToken(env.DB, token);
    if (u) return { key: 'u' + u.id };
  } catch (e) {}
  return null;
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

async function handle({ request, env, params }) {
  const name = String((params || {}).name || '').toLowerCase();
  if (!name) return json({ error: 'Nama function kosong' }, 400);
  const user = await resolveUser(env, request);
  if (user) {
    // Pemanggilan backend function = fitur paket Bisnis — gate server-side.
    const eff = await getEffectivePlanByUserKey(env.DB, user.key);
    if (!featureAllowed(eff.plan, 'backendFunctions')) return featureGateResponse('backendFunctions', eff.plan);
  }
  if (!user) {
    // ===== WEBHOOK PUBLIK =====
    // Function yang ditandai is_public bisa dipanggil TANPA login dengan
    // key rahasia (?key=... atau header X-Webhook-Key) — untuk callback
    // payment gateway / layanan eksternal. Kuota pemakaian mengikuti pemilik.
    const url = new URL(request.url);
    const secret = url.searchParams.get('key') || request.headers.get('X-Webhook-Key') || '';
    if (!secret) return json({ error: 'Login diperlukan. Untuk akses webhook publik sertakan parameter key.', need_login: true }, 401);
    const m = await import('../fns.js');
    let args = {};
    if (request.method === 'POST') {
      try { args = await request.json(); } catch (e) { args = {}; }
    } else {
      const a = url.searchParams.get('a');
      if (a) { try { args = JSON.parse(a); } catch (e) {} }
    }
    try {
      const r = await m.invokePublicFunction(env.DB, name, secret, args, request.headers.get('cf-connecting-ip') || 'unknown', new URL(request.url).origin);
      const status = r && r.status ? r.status : 200;
      delete r.status;
      return json(r, status);
    } catch (e) {
      return json({ error: 'Server error: ' + e.message }, 500);
    }
  }

  let args = {};
  try {
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      args = body?.args && typeof body.args === 'object' ? body.args : {};
    } else {
      const a = new URL(request.url).searchParams.get('a');
      if (a) args = JSON.parse(a);
    }
  } catch (e) { return json({ error: 'Args JSON tidak valid' }, 400); }

  try {
    return json(await invokeFunction(env.DB, user.key, name, args, { origin: new URL(request.url).origin }));
  } catch (e) {
    return json({ error: 'Server error: ' + e.message }, 500);
  }
}
export const onRequestGet = handle;
export const onRequestPost = handle;
