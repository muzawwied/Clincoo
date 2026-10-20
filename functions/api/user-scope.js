// Scoping data per akun. JANGAN beri prefix "_" (wrangler mengecualikannya dari bundle).
// Tabel KV (wallet_balance, account_profile, subscription): key per user = u<id>:<key>
// Tabel baris (wallet_transactions, notifications, activity_log, ...): kolom user_id.
// Data lama (tanpa user) otomatis diklaim user pertama yang login.
import { initTables as initAuthTables, getUserByToken, getToken } from './auth/shared.js';

export async function currentUser(env, request) {
  try {
    if (!env.DB) return null;
    await initAuthTables(env.DB);
    return await getUserByToken(env.DB, getToken(request));
  } catch (e) { return null; }
}

export async function getUserById(db, id) {
  if (!id) return null;
  try { return await db.prepare('SELECT * FROM auth_users WHERE id = ?').bind(id).first(); } catch (e) { return null; }
}

export function userPrefix(user) { return user ? 'u' + user.id + ':' : ''; }

// Kembalikan key yang sudah di-scope untuk user; efek samping: klaim data legacy sekali.
export async function scopedKey(db, table, user, key) {
  if (!user) return key;
  const p = 'u' + user.id + ':';
  try {
    const c = await db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE key LIKE ?`).bind(p + '%').first();
    if ((c?.c || 0) === 0) {
      // klaim: pindahkan semua key legacy (tanpa ':') ke namespace user ini
      await db.prepare(`UPDATE ${table} SET key = ? || key WHERE key NOT LIKE '%:%'`).bind(p).run();
    }
  } catch (e) {}
  return p + key;
}

// Pastikan kolom user_id ada + klaim baris legacy (NULL) ke user ini. Return user id atau null.
export async function rowScope(db, table, user) {
  try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER`).run(); } catch (e) {}
  if (!user) return null;
  try {
    const c = await db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE user_id = ?`).bind(user.id).first();
    if ((c?.c || 0) === 0) {
      await db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).bind(user.id).run();
    }
  } catch (e) {}
  return user.id;
}

// Guard kepemilikan proyek (anti-IDOR): project_id yang dimiliki user LAIN
// wajib ditolak. Proyek lama yang belum tercatat di user_projects tetap boleh
// (kompatibel migrasi). Return: null = boleh lanjut; Response = tolak.
export async function guardProject(env, request, projectId) {
  if (!projectId) return null; // tanpa project_id: perilaku legacy (tabel global)
  try {
    const user = await currentUser(env, request);
    if (!user) return new Response(JSON.stringify({ error: 'unauthorized', need_login: true }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    const db = env.DB;
    // Skema identik dengan projects.js agar kolom tidak pernah hilang
    await db.prepare(`CREATE TABLE IF NOT EXISTS user_projects (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      title TEXT DEFAULT '',
      prompt TEXT DEFAULT '',
      ai_name TEXT DEFAULT '',
      ai_desc TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT
    )`).run();
    const row = await db.prepare('SELECT user_id FROM user_projects WHERE id = ?').bind(String(projectId)).first();
    if (!row || row.user_id == null || Number(row.user_id) === Number(user.id)) return null;
    return new Response(JSON.stringify({ error: 'Bukan proyek Anda' }), { status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  } catch (e) {
    return null; // kegagalan cek tidak boleh memblokir flow lama
  }
}
