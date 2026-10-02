// Cloudflare Pages Functions — AI STORAGE (penyimpanan file milik AI, per user)
// Tempat AI Clincoo menyimpan puluhan file hasil clone/fetch dari mana saja,
// TIDAK terikat proyek/workspace dan bukan GitHub — supaya hemat token:
// AI tinggal baca ulang file yang perlu dari sini di giliran berikutnya
// tanpa re-clone dan tanpa isi file menghabiskan history chat.
//
// GET  /api/ai-storage                    -> daftar file (path, size, updated_at)
// POST /api/ai-storage {action:'save_bulk', files:[{path,content}]} -> simpan/update banyak
// POST /api/ai-storage {action:'get', path}   -> isi satu file
// POST /api/ai-storage {action:'delete', path}

import { currentUser } from './user-scope.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const MAX_FILES_CALL = 60;      // maks file per panggilan save_bulk
const MAX_FILES_TOTAL = 500;    // maks file tersimpan per user
const MAX_FILE_BYTES = 512 * 1024;   // 512KB per file
const MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 8MB total per user

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export function normPath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  s = s.split('/').filter(x => x && x !== '.' && x !== '..').join('/');
  return s;
}

async function ensureTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS ai_storage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  try { await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_storage_user_path ON ai_storage (user_id, path)').run(); } catch (e) {}
}

async function totalUsage(db, userId) {
  const r = await db.prepare('SELECT COUNT(*) c, COALESCE(SUM(size),0) s FROM ai_storage WHERE user_id = ?').bind(userId).first();
  return { files: (r && r.c) || 0, bytes: (r && r.s) || 0 };
}

// ==== Logika inti (dipakai juga tool server chat.js) ====
export async function aiStorageSave(db, user, files) {
  await ensureTable(db);
  if (!user || !user.id) return { error: 'Fitur AI Storage memerlukan login Clincoo.' };
  const arr = Array.isArray(files) ? files : [];
  if (!arr.length) return { error: 'files wajib array [{path, content}].' };
  if (arr.length > MAX_FILES_CALL) return { error: 'Maksimal ' + MAX_FILES_CALL + ' file per panggilan.' };
  const clean = [];
  for (const f of arr) {
    const path = normPath(f && f.path);
    const content = (f && typeof f.content === 'string') ? f.content : '';
    if (!path) continue;
    const size = content.length;
    if (size > MAX_FILE_BYTES) return { error: 'File "' + path + '" terlalu besar (maks 512KB) untuk AI Storage.' };
    clean.push({ path, content, size });
  }
  if (!clean.length) return { error: 'Tidak ada file valid untuk disimpan.' };
  const usage = await totalUsage(db, user.id);
  if (usage.files + clean.length > MAX_FILES_TOTAL) return { error: 'AI Storage penuh (maks ' + MAX_FILES_TOTAL + ' file). Hapus beberapa dengan delete_from_storage.' };
  const addBytes = clean.reduce((a, f) => a + f.size, 0);
  // perkiraan konservatif: cek kuota total
  const cur = await db.prepare('SELECT COALESCE(SUM(size),0) s FROM ai_storage WHERE user_id = ?').bind(user.id).first();
  if (((cur && cur.s) || 0) + addBytes > MAX_TOTAL_BYTES) return { error: 'Kuota total AI Storage 8MB tercapai. Hapus file lama dengan delete_from_storage.' };
  let saved = 0, updated = 0;
  for (const f of clean) {
    const ex = await db.prepare('SELECT id FROM ai_storage WHERE user_id = ? AND path = ?').bind(user.id, f.path).first();
    if (ex) {
      await db.prepare('UPDATE ai_storage SET content = ?, size = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(f.content, f.size, ex.id).run();
      updated++;
    } else {
      await db.prepare('INSERT INTO ai_storage (user_id, path, content, size) VALUES (?, ?, ?, ?)').bind(user.id, f.path, f.content, f.size).run();
      saved++;
    }
  }
  return { success: true, saved: saved, updated: updated, total_files: usage.files + saved, note: 'Tersimpan di AI Storage (server, per akun) — tidak ikut history chat, hemat token; baca kapan perlu dengan read_storage_file.' };
}

export async function aiStorageGet(db, user, path) {
  await ensureTable(db);
  if (!user || !user.id) return { error: 'Fitur AI Storage memerlukan login Clincoo.' };
  const p = normPath(path);
  if (!p) return { error: 'Parameter path wajib.' };
  const r = await db.prepare('SELECT content, size, updated_at FROM ai_storage WHERE user_id = ? AND path = ?').bind(user.id, p).first();
  if (!r) return { error: 'File tidak ada di AI Storage: ' + p };
  return { success: true, path: p, size: r.size, updated_at: r.updated_at, content: r.content };
}

export async function aiStorageList(db, user, prefix) {
  await ensureTable(db);
  if (!user || !user.id) return { error: 'Fitur AI Storage memerlukan login Clincoo.' };
  const pre = normPath(prefix || '');
  const rows = pre
    ? await db.prepare('SELECT path, size, updated_at FROM ai_storage WHERE user_id = ? AND path LIKE ? ORDER BY path LIMIT 500').bind(user.id, pre + '%').all()
    : await db.prepare('SELECT path, size, updated_at FROM ai_storage WHERE user_id = ? ORDER BY path LIMIT 500').bind(user.id).all();
  return { success: true, count: (rows.results || []).length, files: rows.results || [] };
}

export async function aiStorageDelete(db, user, path) {
  await ensureTable(db);
  if (!user || !user.id) return { error: 'Fitur AI Storage memerlukan login Clincoo.' };
  const p = normPath(path);
  if (!p) return { error: 'Parameter path wajib.' };
  const r = await db.prepare('DELETE FROM ai_storage WHERE user_id = ? AND path = ?').bind(user.id, p).run();
  return { success: true, deleted: (r.meta && r.meta.changes) || 0 };
}

export async function onRequestOptions() { return new Response(null, { headers: CORS }); }

export async function onRequestGet({ request, env }) {
  const user = await currentUser(env, request);
  if (!user) return json({ error: 'Login diperlukan.' }, 401);
  return json(await aiStorageList(env.DB, user, new URL(request.url).searchParams.get('prefix') || ''));
}

export async function onRequestPost({ request, env }) {
  const user = await currentUser(env, request);
  if (!user) return json({ error: 'Login diperlukan.' }, 401);
  const body = await request.json().catch(() => ({}));
  const db = env.DB;
  if (body.action === 'save_bulk') return json(await aiStorageSave(db, user, body.files || []));
  if (body.action === 'get') return json(await aiStorageGet(db, user, body.path || ''));
  if (body.action === 'delete') return json(await aiStorageDelete(db, user, body.path || ''));
  return json({ error: 'action tidak dikenal (save_bulk | get | delete).' }, 400);
}
