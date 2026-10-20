// Cloudflare Pages Functions — Preferensi & Zona Bahaya: Hapus Akun (PER AKUN)
// GET    /api/preferences            -> preferensi user login (key per-akun u<id>:<key>)
// GET    /api/preferences?key=nama   -> satu key
// POST   /api/preferences            -> simpan preferensi ({key,value} atau objek)
// DELETE /api/preferences            -> HAPUS AKUN PERMANEN + kaskade seluruh data milik akun
// Semua aksi wajib login (fail-closed). Key global (cloudflare_api_key, dll.) TIDAK
// tersentuh — hanya key berprefix u<id>: yang dihapus.

import { currentUser, userPrefix } from './user-scope.js';
import { tableSuffix } from './_tables.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const PROJECT_TABLES = ['chat_sessions', 'chat_messages', 'project_files', 'env_vars', 'project_settings', 'security_settings', 'deploy_logs'];

// Blind otomatis nilai sensitif
const SENSITIVE_RE = /(api[_-]?key|token|secret|password|credential|bearer)/i;
function maskSensitive(key, value) {
  if (!SENSITIVE_RE.test(key)) return value;
  const s = String(value);
  if (s.length <= 8) return 'MASKED::••••••';
  return 'MASKED::' + s.slice(0, 4) + '••••••••';
}

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

async function requireUser(env, request) {
  const user = await currentUser(env, request);
  if (!user) return null;
  return user;
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

// ===== GET =====
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  const user = await requireUser(env, request);
  if (!user) return json({ error: 'Login diperlukan', need_login: true }, 401);
  const prefix = userPrefix(user);

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS user_preferences (key TEXT PRIMARY KEY, value TEXT)').run();
    const defaults = { analytics: 'true', personalization: 'true' };
    const url = new URL(request.url);
    const key = url.searchParams.get('key');

    const rows = await db.prepare('SELECT key, value FROM user_preferences WHERE key LIKE ?')
      .bind(prefix + '%').all();

    const own = {};
    for (const row of rows.results || []) {
      own[row.key.slice(prefix.length)] = row.value;
    }

    if (key) {
      let value = own[key] !== undefined ? own[key] : (defaults[key] || null);
      if (value) value = maskSensitive(key, value);
      return json({ key, value });
    }

    const data = { ...defaults, ...own };
    for (const k of Object.keys(data)) {
      if (data[k] && typeof data[k] === 'string') data[k] = maskSensitive(k, data[k]);
    }
    return json(data);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ===== POST =====
export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  const user = await requireUser(env, request);
  if (!user) return json({ error: 'Login diperlukan', need_login: true }, 401);
  const prefix = userPrefix(user);

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS user_preferences (key TEXT PRIMARY KEY, value TEXT)').run();
    const body = await request.json();
    const updates = body.key ? { [body.key]: body.value } : body;

    const written = [];
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'key' || key === 'value') continue; // field wrapper
      if (String(value).includes('MASKED::')) continue; // jangan timpa nilai asli dengan hasil masking
      const fullKey = prefix + key;
      await db.prepare("INSERT INTO user_preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(fullKey, String(value)).run();
      written.push(key);
    }

    // Log aktivitas per-akun
    if (written.length > 0) {
      try {
        await db.prepare('INSERT INTO activity_log (action, details, user_id) VALUES (?, ?, ?)')
          .bind('preferences_update', JSON.stringify(updates), user.id).run();
      } catch (e) {}
    }

    return json({ success: true, updated: written });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ===== DELETE — ZONA BAHAYA: HAPUS AKUN PERMANEN (KASKADE) =====
export async function onRequestDelete({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  const user = await requireUser(env, request);
  if (!user) return json({ error: 'Login diperlukan', need_login: true }, 401);
  const uid = user.id;
  const prefix = userPrefix(user); // u<id>:

  const step = async (sql, ...params) => {
    try { await db.prepare(sql).bind(...params).run(); return true; } catch (e) { return false; }
  };

  const summary = { projects: 0, dropped_tables: 0, account_deleted: false };

  try {
    // 1) Hapus seluruh proyek milik akun: baris user_projects + tabel p_<proyek>_*
    const projs = await db.prepare('SELECT id FROM user_projects WHERE user_id = ?').bind(uid).all();
    for (const p of projs.results || []) {
      const s = tableSuffix(p.id);
      for (const base of PROJECT_TABLES) {
        const okDrop = await step(`DROP TABLE IF EXISTS "p_${s}_${base}"`);
        if (okDrop) summary.dropped_tables++;
      }
      await step('DELETE FROM _project_migrations WHERE project_id = ?', p.id);
      await step('DELETE FROM _session_project WHERE project_id = ?', p.id);
      summary.projects++;
    }

    // 2) Data per-baris milik akun
    await step('DELETE FROM user_projects WHERE user_id = ?', uid);
    await step('DELETE FROM activity_log WHERE user_id = ?', uid);
    await step('DELETE FROM notifications WHERE user_id = ?', uid);
    await step('DELETE FROM wallet_transactions WHERE user_id = ?', uid);

    // 3) Key-value per-akun (prefix u<id>:) — key global tidak tersentuh
    await step('DELETE FROM user_preferences WHERE key LIKE ?', prefix + '%');
    await step('DELETE FROM wallet_balance WHERE key LIKE ?', prefix + '%');
    await step('DELETE FROM subscription WHERE key LIKE ?', prefix + '%');
    await step('DELETE FROM account_profile WHERE key LIKE ?', prefix + '%');

    // 4) Sesi & akun itu sendiri (terakhir)
    await step('DELETE FROM auth_sessions WHERE user_id = ?', uid);
    await step('DELETE FROM auth_oauth_accounts WHERE user_id = ?', uid);
    await step('DELETE FROM auth_users WHERE id = ?', uid);

    // 5) Verifikasi akun benar-benar hilang
    const still = await db.prepare('SELECT id FROM auth_users WHERE id = ?').bind(uid).first();
    if (still) return json({ error: 'Gagal menghapus akun. Coba lagi.' }, 500);

    summary.account_deleted = true;
    return json({ success: true, message: 'Akun dan seluruh data telah dihapus permanen', summary });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
