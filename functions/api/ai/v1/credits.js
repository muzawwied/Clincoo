// Cloudflare Pages Function — /api/ai/v1/credits "Clincoo Open API"
// Menampilkan sisa kredit Open API pemilik proyek (harga per model, sesuai paket).
// Satuan: mikro-dolar (1.000.000 unit = $1) — sama dengan tabel ai_api_credits.
//   GET ?project_id=xxx -> { plan, daily: {used, limit, left}, monthly: {...}, unit }
// Jalur /api/* -> middleware sudah memastikan user login. Hanya pemilik
// proyek (atau anggota kolaborasi) yang boleh membaca (pola requireOwned di secret.js).

import { PLAN_AI_API_CREDITS, getEffectivePlanByUserKey } from '../../plan-helpers.js';
import { currentUser } from '../../user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

export async function onRequestOptions() { return new Response(null, { status: 200, headers: CORS }); }

async function requireOwnedProject(env, request, projectId) {
  const user = await currentUser(env, request);
  if (!user) return { error: json({ error: 'Login diperlukan', need_login: true }, 401) };
  if (!projectId) return { error: json({ error: 'project_id required' }, 400) };
  const uid = Number(user.id);
  let row = null;
  try { row = await env.DB.prepare('SELECT user_id FROM user_projects WHERE id = ?').bind(projectId).first(); } catch (e) { row = null; }
  if (row && Number(row.user_id) === uid) return { user };
  if (row) {
    try {
      const mem = await env.DB.prepare('SELECT id FROM project_members WHERE project_id = ? AND user_id = ?').bind(projectId, uid).first();
      if (mem) return { user };
    } catch (e) {}
  }
  return { error: json({ error: 'Proyek tidak ditemukan atau bukan milikmu' }, 404) };
}

let _creditsTableReady = false;
async function initCreditsTable(db) {
  if (_creditsTableReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS ai_api_credits (user_key TEXT, day TEXT, spent INTEGER, PRIMARY KEY (user_key, day))').run();
  _creditsTableReady = true;
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    const projectId = new URL(request.url).searchParams.get('project_id') || '';
    const own = await requireOwnedProject(env, request, projectId);
    if (own.error) return own.error;
    const userKey = 'u' + Number(own.user.id);
    const eff = await getEffectivePlanByUserKey(db, userKey);
    const limits = PLAN_AI_API_CREDITS[eff.plan] || PLAN_AI_API_CREDITS.Starter;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    await initCreditsTable(db);
    const rows = await db.prepare('SELECT day, spent FROM ai_api_credits WHERE user_key = ? AND day IN (?, ?)').bind(userKey, day, month).all();
    let dailyUsed = 0, monthlyUsed = 0;
    for (const r of rows.results || []) {
      if (r.day === day) dailyUsed = r.spent || 0;
      if (r.day === month) monthlyUsed = r.spent || 0;
    }
    return json({
      plan: eff.plan,
      unit: 'USD (micro: 1000000 = $1)',
      daily: { used: dailyUsed, limit: limits.daily, left: Math.max(0, limits.daily - dailyUsed) },
      monthly: { used: monthlyUsed, limit: limits.monthly, left: Math.max(0, limits.monthly - monthlyUsed) }
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
