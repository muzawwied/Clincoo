// owner-notify.js — kirim notifikasi ke user Clincoo dari pemilik via bot (token di header)
// POST { target: 'all' | email, source, message, type?, link? }
// Header: x-owner-notify-token == env.OWNER_NOTIFY_TOKEN
import { initTables as initAuthTables } from './auth/shared.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-owner-notify-token'
};

function j(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() { return new Response(null, { headers: CORS }); }

async function tokenOk(env, request) {
  const given = String(request.headers.get('x-owner-notify-token') || '').trim();
  if (!given) return false;
  const want = String(env.OWNER_NOTIFY_TOKEN || '').trim();
  if (want && given === want) return true;
  // fallback D1 env_vars
  try {
    if (env.DB) {
      const r = await env.DB.prepare("SELECT value FROM env_vars WHERE key = 'OWNER_NOTIFY_TOKEN'").first();
      if (r && String(r.value).trim() === given) return true;
    }
  } catch (e) {}
  return false;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!(await tokenOk(env, request))) return j({ error: 'token tidak valid' }, 401);
    const db = env.DB;
    if (!db) return j({ error: 'D1 not bound' }, 500);
    const body = await request.json();
    const source = String(body.source || 'Clincoo').slice(0, 60);
    const message = String(body.message || '').slice(0, 500);
    const type = ['info', 'success', 'warning', 'error'].includes(body.type) ? body.type : 'info';
    const link = String(body.link || '').slice(0, 300);
    if (!message) return j({ error: 'message required' }, 400);

    await initAuthTables(db);
    await db.prepare('CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, message TEXT NOT NULL, type TEXT DEFAULT "info", link TEXT, read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime(\'now\')), user_id INTEGER)').run();

    let ids = [];
    if (String(body.target || 'all') === 'all') {
      const rows = await db.prepare('SELECT id FROM auth_users ORDER BY id ASC LIMIT 5000').all();
      ids = (rows.results || []).map(r => r.id);
    } else {
      const email = String(body.target || '').trim().toLowerCase();
      if (!email) return j({ error: 'target: "all" atau email user' }, 400);
      const u = await db.prepare('SELECT id FROM auth_users WHERE lower(email) = ?').bind(email).first();
      if (!u) return j({ error: 'user tidak ditemukan: ' + email }, 404);
      ids = [u.id];
    }
    if (!ids.length) return j({ error: 'tidak ada user' }, 400);

    const stmts = ids.map(id => db.prepare(
      'INSERT INTO notifications (source, message, type, link, user_id) VALUES (?, ?, ?, ?, ?)'
    ).bind(source, message, type, link || '', id));
    for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
    return j({ success: true, sent: ids.length });
  } catch (err) {
    return j({ error: err.message }, 500);
  }
}
