// Cloudflare Pages Functions — Chat → Clincoo Sync Bridge
// AI di sisi chat (Superagent/Telegram) menulis LANGSUNG ke workspace Clincoo
// milik owner, tanpa perlu membuka browser/workspace — hemat token & waktu.
// Hasil: proyek muncul di daftar Semua Proyek + workspace ter-update realtime (ws_rev).
//
// Auth: header `x-chat-sync-token` wajib == env.CHAT_SYNC_TOKEN
// Target: akun owner (env.CHAT_SYNC_OWNER_EMAIL, default admin utama)
//
// GET  /api/chat-sync                        -> daftar proyek owner (ringan)
// GET  /api/chat-sync?project_id=x          -> detail proyek + isi file (file <100KB utuh)
// POST /api/chat-sync { action:'create', title, prompt?, files? }               -> buat proyek baru
// POST /api/chat-sync { action:'sync', project_id, files:[{path,content}], replace? } -> tulis/ubah file
// POST /api/chat-sync { action:'delete', project_id }                            -> hapus proyek (uji/bersih)
//
// File besar (>700.000 karakter) ditolak — chat-side memecah sendiri bila perlu.

import { tableFor, ensureProjectTables } from './_tables.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-chat-sync-token'
};

const SMALL_MAX_CHARS = 700_000;
const CONTENT_RETURN_MAX = 100_000; // GET detail: isi file utuh hanya sampai batas ini
const OWNER_EMAIL_FALLBACK = 'muzawwied@gmail.com';

function j(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() { return new Response(null, { headers: CORS }); }

// Perbandingan aman-timing sederhana
function tokenOk(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authOk(env, request) {
  const got = request.headers.get('x-chat-sync-token') || '';
  return tokenOk(got, env.CHAT_SYNC_TOKEN);
}

async function ensureProjectsTable(db) {
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
}

async function ensureUsersTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS auth_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT,
    avatar_url TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
}

async function ownerUserId(db, env) {
  const email = String(env.CHAT_SYNC_OWNER_EMAIL || OWNER_EMAIL_FALLBACK).toLowerCase();
  await ensureUsersTable(db);
  const row = await db.prepare('SELECT id FROM auth_users WHERE LOWER(email) = ?').bind(email).first();
  return row ? row.id : null;
}

async function filesTableFor(db, projectId) {
  const t = tableFor('project_files', projectId);
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${t} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    is_big INTEGER DEFAULT 0,
    size INTEGER DEFAULT 0,
    UNIQUE(project_id, path)
  )`).run();
  // Tabel bisa dibuat lebih dulu oleh ensureProjectTables (tanpa kolom file besar)
  // -> ALTER idempoten, pola yang sama dengan project-files.js
  for (const col of ['is_big INTEGER DEFAULT 0', 'size INTEGER DEFAULT 0']) {
    try { await db.prepare(`ALTER TABLE ${t} ADD COLUMN ${col}`).run(); } catch (e) {}
  }
  return t;
}

// Realtime: naikkan ws_rev supaya polling klien mendeteksi perubahan (skema sama dgn project-files.js)
async function bumpWsRev(db, projectId) {
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS ws_rev (project_id TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 0)').run();
    await db.prepare('INSERT INTO ws_rev (project_id, rev) VALUES (?, 1) ON CONFLICT(project_id) DO UPDATE SET rev = rev + 1').bind(projectId).run();
  } catch (e) {}
}

// Path yang ditulis ulang harus dibersihkan dari tombstone (jangan sampai klien menghapusnya lagi)
async function clearTombstones(db, projectId, paths) {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS ws_deleted_paths (
      project_id TEXT NOT NULL, path TEXT NOT NULL,
      deleted_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, path)
    )`).run();
    const stmts = [];
    for (const p of paths) {
      stmts.push(db.prepare('DELETE FROM ws_deleted_paths WHERE project_id = ? AND path = ?').bind(projectId, String(p)));
    }
    if (stmts.length) await db.batch(stmts);
  } catch (e) {}
}

async function touchProject(db, projectId) {
  await db.prepare('UPDATE user_projects SET updated_at = datetime(\'now\') WHERE id = ?').bind(String(projectId)).run();
}

function validFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.filter(f => f && f.path && typeof f.path === 'string' && f.path.length < 512)
    .map(f => ({ path: String(f.path), content: String(f.content ?? '') }))
    .filter(f => {
      if (f.content.length > SMALL_MAX_CHARS) throw new Error('File terlalu besar: ' + f.path + ' (' + f.content.length + ' karakter, maks ' + SMALL_MAX_CHARS + ')');
      return true;
    });
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return j({ error: 'D1 not bound' }, 500);
  if (!authOk(env, request)) return j({ error: 'unauthorized' }, 401);
  try {
    const db = env.DB;
    const url = new URL(request.url);
    const projectId = url.searchParams.get('project_id');
    await ensureProjectsTable(db);
    const ownerId = await ownerUserId(db, env);
    if (ownerId == null) return j({ error: 'owner_not_found' }, 404);

    if (!projectId) {
      const res = await db.prepare(
        'SELECT id, title, prompt, created_at, updated_at FROM user_projects WHERE user_id = ? ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 100'
      ).bind(ownerId).all();
      return j({ projects: res.results || [] });
    }

    const proj = await db.prepare('SELECT * FROM user_projects WHERE id = ? AND user_id = ?').bind(String(projectId), ownerId).first();
    if (!proj) return j({ error: 'not_found' }, 404);
    const t = await filesTableFor(db, String(projectId));
    const files = await db.prepare('SELECT path, size, is_big, updated_at, content FROM ' + t + ' WHERE project_id = ? ORDER BY path').bind(String(projectId)).all();
    return j({
      project: { id: proj.id, title: proj.title, prompt: proj.prompt, created_at: proj.created_at, updated_at: proj.updated_at },
      files: (files.results || []).map(f => ({
        path: f.path, size: f.size, is_big: f.is_big, updated_at: f.updated_at,
        content: (!f.is_big && (f.content || '').length <= CONTENT_RETURN_MAX) ? f.content : undefined
      }))
    });
  } catch (e) {
    return j({ error: e.message }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return j({ error: 'D1 not bound' }, 500);
  if (!authOk(env, request)) return j({ error: 'unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch (e) { return j({ error: 'bad_json' }, 400); }
  const action = String(body.action || '');
  try {
    const db = env.DB;
    await ensureProjectsTable(db);
    const ownerId = await ownerUserId(db, env);
    if (ownerId == null) return j({ error: 'owner_not_found' }, 404);

    if (action === 'create') {
      const title = String(body.title || 'Proyek Chat').slice(0, 200);
      const prompt = String(body.prompt || '').slice(0, 2000);
      const projectId = 'proj_' + Date.now();
      await db.prepare('INSERT INTO user_projects (id, user_id, title, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))')
        .bind(projectId, ownerId, title, prompt).run();
      await ensureProjectTables(db, projectId);
      const files = validFiles(body.files);
      if (files.length) await writeFiles(db, projectId, files, false);
      return j({ ok: true, project_id: projectId });
    }

    if (action === 'sync') {
      const projectId = String(body.project_id || '');
      if (!projectId) return j({ error: 'project_id wajib' }, 400);
      const row = await db.prepare('SELECT user_id FROM user_projects WHERE id = ?').bind(projectId).first();
      if (!row) return j({ error: 'not_found' }, 404);
      if (Number(row.user_id) !== Number(ownerId)) return j({ error: 'bukan proyek owner' }, 403);
      const files = validFiles(body.files);
      await writeFiles(db, projectId, files, !!body.replace);
      await touchProject(db, projectId);
      return j({ ok: true, project_id: projectId, files: files.length });
    }

    if (action === 'delete') {
      const projectId = String(body.project_id || '');
      const row = await db.prepare('SELECT user_id FROM user_projects WHERE id = ?').bind(projectId).first();
      if (!row) return j({ error: 'not_found' }, 404);
      if (Number(row.user_id) !== Number(ownerId)) return j({ error: 'bukan proyek owner' }, 403);
      const t = await filesTableFor(db, projectId);
      await db.prepare('DELETE FROM ' + t + ' WHERE project_id = ?').bind(projectId).run();
      try { await db.prepare('DROP TABLE IF EXISTS ' + tableFor('file_chunks', projectId)).run(); } catch (e) {}
      await db.prepare('DELETE FROM user_projects WHERE id = ?').bind(projectId).run();
      return j({ ok: true });
    }

    // [21 Okt] hapus SATU file (path) milik owner — untuk bersih-bersih sisa unggahan
    if (action === 'delete_file') {
      const projectId = String(body.project_id || '');
      const path = String(body.path || '');
      if (!projectId || !path) return j({ error: 'project_id & path wajib' }, 400);
      const row = await db.prepare('SELECT user_id FROM user_projects WHERE id = ?').bind(projectId).first();
      if (!row) return j({ error: 'not_found' }, 404);
      if (Number(row.user_id) !== Number(ownerId)) return j({ error: 'bukan proyek owner' }, 403);
      const t = await filesTableFor(db, projectId);
      const del = await db.prepare('DELETE FROM ' + t + ' WHERE project_id = ? AND path = ?').bind(projectId, path).run();
      try { await db.prepare('DELETE FROM ' + tableFor('file_chunks', projectId) + ' WHERE path = ?').bind(path).run(); } catch (e) {}
      // tombstone supaya klien lain tidak men-download ulang file yang sudah dihapus
      try {
        await db.prepare(`CREATE TABLE IF NOT EXISTS ws_deleted_paths (
          project_id TEXT NOT NULL, path TEXT NOT NULL,
          deleted_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (project_id, path)
        )`).run();
        await db.prepare(`INSERT INTO ws_deleted_paths (project_id, path, deleted_at) VALUES (?, ?, datetime('now'))
          ON CONFLICT(project_id, path) DO UPDATE SET deleted_at = datetime('now')`).bind(projectId, path).run();
      } catch (e) {}
      try { await db.prepare('UPDATE user_projects SET updated_at = datetime(\'now\') WHERE id = ?').bind(projectId).run(); } catch (e) {}
      return j({ ok: true, deleted: (del && del.meta && del.meta.changes) || 0 });
    }

    // [21 Okt] DIAGNOSTIK workspace: file + tombstone proyek owner (debug "upload hilang")
    if (action === 'ws_diag') {
      const projs = await db.prepare('SELECT id, title, updated_at FROM user_projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30').bind(ownerId).all();
      const out = { projects: [] };
      for (const p of (projs.results || [])) {
        const e = { id: p.id, title: p.title, updated_at: p.updated_at };
        try {
          const t = tableFor('project_files', p.id);
          const r = await db.prepare('SELECT path, is_big, size, created_at, updated_at FROM ' + t + ' WHERE project_id = ? ORDER BY updated_at DESC LIMIT 40').bind(p.id).all();
          e.files = (r.results || []).map(f => ({ p: f.path, big: f.is_big, size: f.size, cat: f.created_at, uat: f.updated_at }));
          e.file_count = (r.results || []).length;
        } catch (err) { e.files_err = err.message; }
        try {
          const r = await db.prepare('SELECT path, deleted_at FROM ws_deleted_paths WHERE project_id = ? ORDER BY deleted_at DESC LIMIT 40').bind(p.id).all();
          e.tombstones = (r.results || []).map(f => ({ p: f.path, at: f.deleted_at }));
        } catch (err) { e.tomb_err = err.message; }
        try {
          const r = await db.prepare('SELECT rev FROM user_projects WHERE id = ?').bind(p.id).first();
          e.rev = r && r.rev;
        } catch (err) {}
        out.projects.push(e);
      }
      return j(out);
    }

    // [21 Okt] DIAGNOSTIK pemakaian kredit AI milik owner (debug "pemakaian 0 terus")
    if (action === 'ai_usage') {
      const uk = 'u' + ownerId;
      const out = { owner_user_key: uk };
      try {
        const r = await db.prepare('SELECT ts, model, in_chars, out_chars, cost FROM ai_usage WHERE user_key = ? ORDER BY ts DESC LIMIT 15').bind(uk).all();
        out.recent = r.results || [];
      } catch (e) { out.recent_err = e.message; }
      try {
        const r = await db.prepare('SELECT COUNT(*) AS c, SUM(cost) AS t FROM ai_usage WHERE user_key = ?').bind(uk).first();
        out.count = r && r.c; out.total_cost = r && r.t;
      } catch (e) { out.sum_err = e.message; }
      try {
        const r = await db.prepare('SELECT credits_left, expires_at FROM ai_packs WHERE user_key = ?').bind(uk).all();
        out.packs = r.results || [];
      } catch (e) { out.packs_err = e.message; }
      try {
        const r = await db.prepare('SELECT day, count FROM ai_quota WHERE user_key = ? ORDER BY day DESC LIMIT 5').bind(uk).all();
        out.quota = r.results || [];
      } catch (e) { out.quota_err = e.message; }
      // [21 Okt debug upload] uji langsung bump ws_rev + laporkan error aslinya
      try {
        const r = await db.prepare('SELECT project_id, rev FROM ws_rev ORDER BY rev DESC LIMIT 200').all();
        out.revs = (r.results || []).map(x => ({ pid: x.project_id, rev: x.rev }));
      } catch (e) { out.revs_err = e.message; }
      try {
        await db.prepare('CREATE TABLE IF NOT EXISTS ws_rev (project_id TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 0)').run();
        await db.prepare('INSERT INTO ws_rev (project_id, rev) VALUES (?, 1) ON CONFLICT(project_id) DO UPDATE SET rev = rev + 1').bind('__diag_probe__', 1).run();
        const r2 = await db.prepare('SELECT COUNT(*) c FROM ws_rev').first();
        out.diag_probe_count = r2 && r2.c;
        await db.prepare('DELETE FROM ws_rev WHERE project_id = ?').bind('__diag_probe__').run();
      } catch (e) { out.diag_probe_err = e.message; }
      // [21 Okt debug upload] agregat global: rev terakhir per proyek + tombstone terbaru
      try {
        const r = await db.prepare('SELECT project_id, rev FROM ws_rev ORDER BY rev DESC LIMIT 200').all();
        out.revs = (r.results || []).map(x => ({ pid: x.project_id, rev: x.rev }));
      } catch (e) { out.revs_err = e.message; }
      try {
        const r = await db.prepare("SELECT project_id, path, deleted_at FROM ws_deleted_paths WHERE deleted_at >= datetime('now','-3 days') ORDER BY deleted_at DESC LIMIT 60").all();
        out.tombstones_3d = (r.results || []).map(x => ({ pid: x.project_id, p: x.path, at: x.deleted_at }));
      } catch (e) { out.tomb_err = e.message; }
      // agregat global (tanpa data pribadi user lain)
      try {
        const r = await db.prepare('SELECT COUNT(*) AS c, SUM(cost) AS t, SUM(CASE WHEN cost = 0 THEN 1 ELSE 0 END) AS n_zero FROM ai_usage').first();
        out.global = { rows: r && r.c, total_cost: r && r.t, rows_cost_zero: r && r.n_zero };
      } catch (e) { out.global_err = e.message; }
      return j(out);
    }

    return j({ error: 'unknown_action' }, 400);
  } catch (e) {
    return j({ error: e.message }, 500);
  }
}

async function writeFiles(db, projectId, files, replace) {
  const t = await filesTableFor(db, projectId);
  const paths = [];
  const stmts = [];
  for (const f of files) {
    paths.push(f.path);
    stmts.push(db.prepare(`INSERT INTO ${t} (project_id, path, content, is_big, size, updated_at)
      VALUES (?, ?, ?, 0, ?, datetime('now'))
      ON CONFLICT(project_id, path) DO UPDATE SET content = excluded.content, is_big = 0, size = excluded.size, updated_at = datetime('now')`)
      .bind(projectId, f.path, f.content, f.content.length));
  }
  if (stmts.length) await db.batch(stmts);
  await clearTombstones(db, projectId, paths);
  if (replace) {
    const existing = await db.prepare('SELECT path FROM ' + t + ' WHERE project_id = ?').bind(projectId).all();
    const keep = new Set(paths);
    const gone = (existing.results || []).map(r => r.path).filter(p => !keep.has(p));
    if (gone.length) {
      try {
        await db.prepare(`CREATE TABLE IF NOT EXISTS ws_deleted_paths (
          project_id TEXT NOT NULL, path TEXT NOT NULL,
          deleted_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (project_id, path)
        )`).run();
        await db.batch(gone.map(p => db.prepare('INSERT OR REPLACE INTO ws_deleted_paths (project_id, path) VALUES (?, ?)').bind(projectId, p)));
      } catch (e) {}
      await db.batch(gone.map(p => db.prepare('DELETE FROM ' + t + ' WHERE project_id = ? AND path = ?').bind(projectId, p)));
    }
  }
  await bumpWsRev(db, projectId);
}
