// Cloudflare Pages Functions - Project Files (D1-backed)
// Stores file content per project_id, used by workspace.html CodeMirror editor
//
// DUKUNGAN FILE BESAR (2026-10-04): localStorage browser hanya ~5MB, jadi file
// besar (>512KB) TIDAK lagi disimpan di cache klien — isi filenya hidup DI SINI
// (D1). File besar disimpan ter-chunk (base64, ~600KB per baris) supaya tetap
// jauh di bawah batas parameter D1, lalu digabung ulang saat dibaca/deploy.
// Klien menyimpan penanda {content:'', cloud:true} di pohon workspace-nya.
//
// GET  /api/project-files?project_id=xxx            -> semua file (konten kecil utuh; file besar: content='', is_big:1, size)
// GET  /api/project-files?project_id=xxx&meta=1      -> metadata saja (path, size, is_big, updated_at) — ringan
// GET  /api/project-files?project_id=xxx&path=y&content=1 -> isi SATU file (file besar dikembalikan sebagai content_b64)
// POST /api/project-files {project_id, files:[{path, content?, content_b64?, cloud?, size?}], replace?}
//      - content biasa        -> upsert baris (kecil)
//      - content_b64          -> file besar: chunk base64 + metadata is_big=1
//      - cloud:1              -> penanda: JANGAN sentuh isi baris (isi sudah di server);
//                                 dengan replace:true path tetap dipertahankan.
//      - replace:true         -> hapus path yang TIDAK ikut dikirim (sinkron hapus/rename klien)
// DELETE /api/project-files?project_id=xxx[&path=yyy]

import { getProjectTables, tableFor } from './_tables.js';
import { guardProject, currentUser } from './user-scope.js';
import { getEffectivePlan, PLAN_WORKSPACE_LIMITS, ADMIN_EMAILS } from './plan-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// ==== Batas penyimpanan ====
const SMALL_MAX_CHARS = 700_000;        // <= ini: content TEXT biasa satu baris
const CHUNK_CHARS = 1_500_000;          // ukuran potongan base64 per baris D1 (1,5MB — aman di bawah batas baris 2MB; file 25MB hanya ~23 insert, jauh di bawah limit 50 query/request plan gratis)
const BIG_MAX_BYTES = 25 * 1024 * 1024; // batas atas file besar (25MB, sama dgn batas aset Cloudflare Pages)

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function b64(str) {
  return btoa(unescape(encodeURIComponent(String(str || ''))));
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

async function ensureFilesTable(db, table) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${table} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(project_id, path)
  )`).run();
  // Kolom file besar (idempotent: ALTER hanya sekali berhasil, sisanya diabaikan)
  for (const col of ['is_big INTEGER DEFAULT 0', 'size INTEGER DEFAULT 0']) {
    try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col}`).run(); } catch (e) {}
  }
}

async function ensureChunksTable(db, projectId) {
  const t = tableFor('file_chunks', projectId);
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${t} (
    path TEXT NOT NULL,
    idx INTEGER NOT NULL,
    chunk TEXT NOT NULL,
    PRIMARY KEY (path, idx)
  )`).run();
  return t;
}

function decB64Bytes(b64Str) {
  // panjang binary string hasil atob = jumlah byte asli (tiap char = 1 byte)
  try { return atob(String(b64Str || '')).length; } catch (e) { return 0; }
}

// ==== Simpan satu file (kecil atau besar) ====
async function saveFile(db, table, chunksTable, projectId, path, contentStr, contentB64) {
  let isBig = false, sizeBytes = 0, b64Str = '';
  if (typeof contentB64 === 'string' && contentB64.length) {
    // file besar dari klien: base64 dari string asli (teks murni atau data-URL)
    isBig = true;
    b64Str = contentB64;
    sizeBytes = decB64Bytes(b64Str);
    // File media (mp3/gambar/video) dikirim sebagai data-URL; ukuran data-URL
    // ~1.37x ukuran file asli. Hitung ukuran file ASLinya dari base64 payload
    // di dalam data-URL supaya file 20-25MB tidak salah ditolak "terlalu besar".
    try {
      const decoded = atob(b64Str);
      if (decoded.startsWith('data:')) {
        const comma = decoded.indexOf(',');
        if (comma > 0) sizeBytes = decB64Bytes(decoded.slice(comma + 1));
      }
    } catch (e) {}
  } else if (String(contentStr || '').length > SMALL_MAX_CHARS) {
    // pengaman: klien lama masih mengirim konten mentah gede -> jadikan file besar
    isBig = true;
    b64Str = b64(contentStr);
    sizeBytes = decB64Bytes(b64Str);
  } else {
    sizeBytes = new TextEncoder().encode(String(contentStr || '')).length;
  }
  if (isBig && sizeBytes > BIG_MAX_BYTES) {
    return { error: 'File terlalu besar (maksimal 25MB): ' + path };
  }

  if (!isBig) {
    await db.prepare(
      `INSERT INTO ${table} (project_id, path, content, is_big, size, updated_at) VALUES (?, ?, ?, 0, ?, datetime('now'))
       ON CONFLICT(project_id, path) DO UPDATE SET content = excluded.content, is_big = 0, size = excluded.size, updated_at = datetime('now')`
    ).bind(projectId, path, String(contentStr || ''), sizeBytes).run();
  } else {
    await db.prepare(
      `INSERT INTO ${table} (project_id, path, content, is_big, size, updated_at) VALUES (?, ?, '', 1, ?, datetime('now'))
       ON CONFLICT(project_id, path) DO UPDATE SET content = '', is_big = 1, size = excluded.size, updated_at = datetime('now')`
    ).bind(projectId, path, sizeBytes).run();
    await db.prepare(`DELETE FROM ${chunksTable} WHERE path = ?`).bind(path).run();
    for (let i = 0; i < b64Str.length; i += CHUNK_CHARS) {
      await db.prepare(`INSERT INTO ${chunksTable} (path, idx, chunk) VALUES (?, ?, ?)`)
        .bind(path, Math.floor(i / CHUNK_CHARS), b64Str.slice(i, i + CHUNK_CHARS)).run();
    }
  }
  return { ok: true };
}

async function deleteChunks(db, chunksTable, paths) {
  for (const p of paths) {
    try { await db.prepare(`DELETE FROM ${chunksTable} WHERE path = ?`).bind(p).run(); } catch (e) {}
  }
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get('project_id');
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    if (!projectId) return json({ error: 'project_id required' }, 400);

    const T = await getProjectTables(db, projectId);
    await ensureFilesTable(db, T.files);

    // Mode: isi SATU file (file besar -> content_b64 utuh hasil gabungan chunk)
    const onePath = url.searchParams.get('path');
    const wantContent = url.searchParams.get('content') === '1';
    if (onePath && wantContent) {
      const row = await db.prepare(`SELECT path, content, is_big, size, updated_at FROM ${T.files} WHERE project_id = ? AND path = ?`).bind(projectId, onePath).first();
      if (!row) return json({ error: 'File tidak ditemukan: ' + onePath }, 400);
      if (row.is_big) {
        const chunksTable = await ensureChunksTable(db, projectId);
        const rows = await db.prepare(`SELECT chunk FROM ${chunksTable} WHERE path = ? ORDER BY idx ASC`).bind(onePath).all();
        const b64Str = (rows.results || []).map(r => r.chunk || '').join('');
        return json({ path: row.path, content_b64: b64Str, size: row.size || 0, is_big: 1, updated_at: row.updated_at });
      }
      return json({ path: row.path, content: row.content || '', size: row.size || 0, is_big: 0, updated_at: row.updated_at });
    }

    // Mode: potongan CHUNK file besar (deploy orkestrasi browser — Worker paket
    // gratis hanya punya ~10ms CPU per request, jadi konten file besar dikirim ke
    // browser per-potongan kecil untuk di-hash & di-upload dari klien).
    if (onePath && url.searchParams.get('chunks') === '1') {
      const chunksTable = await ensureChunksTable(db, projectId);
      const from = Math.max(0, parseInt(url.searchParams.get('from') || '0', 10) || 0);
      let count = parseInt(url.searchParams.get('count') || '8', 10) || 8;
      count = Math.max(1, Math.min(10, count));
      const rows = await db.prepare(`SELECT chunk FROM ${chunksTable} WHERE path = ? AND idx >= ? AND idx < ? ORDER BY idx ASC`).bind(onePath, from, from + count).all();
      let total = 0;
      try {
        const c = await db.prepare(`SELECT COUNT(*) c FROM ${chunksTable} WHERE path = ?`).bind(onePath).first();
        total = (c && Number(c.c)) || 0;
      } catch (e) {}
      const chunks = (rows.results || []).map(r => r.chunk || '');
      return json({ path: onePath, from, count: chunks.length, total_chunks: total, chunks });
    }

    // Mode: halaman konten file KECIL untuk deploy orkestrasi browser —
    // dihalaman ~2.5MB supaya JSON respons tetap di bawah limit CPU Worker.
    if (url.searchParams.get('deploy_content') === '1') {
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      let totalSmall = 0;
      try {
        const c = await db.prepare(`SELECT COUNT(*) c FROM ${T.files} WHERE project_id = ? AND is_big = 0`).bind(projectId).first();
        totalSmall = (c && Number(c.c)) || 0;
      } catch (e) {}
      const rows = await db.prepare(`SELECT path, content, size FROM ${T.files} WHERE project_id = ? AND is_big = 0 ORDER BY path ASC LIMIT 400 OFFSET ?`).bind(projectId, offset).all();
      const all = rows.results || [];
      const files = [];
      let bytes = 0;
      let used = 0;
      for (const r of all) {
        const c = String(r.content || '');
        used++;
        if (files.length && bytes + c.length > 2_500_000) break;
        files.push({ path: r.path, content: c, size: r.size || 0 });
        bytes += c.length;
      }
      const next = offset + used;
      return json({ files, total_small: totalSmall, next_offset: next, has_more: next < totalSmall });
    }

    // Mode: metadata saja (ringan — dipakai verifikasi jumlah & daftar ukuran)
    if (url.searchParams.get('meta') === '1') {
      const rows = await db.prepare(`SELECT path, is_big, size, updated_at FROM ${T.files} WHERE project_id = ? ORDER BY path ASC`).bind(projectId).all();
      return json({ files: rows.results || [] });
    }

    // Mode default: semua file; file besar TANPA konten (klien ambil via ?path&content=1)
    const rows = await db.prepare(`SELECT path, content, is_big, size, updated_at FROM ${T.files} WHERE project_id = ? ORDER BY path ASC`).bind(projectId).all();
    const files = (rows.results || []).map(r => ({
      path: r.path,
      content: r.is_big ? '' : (r.content || ''),
      is_big: r.is_big ? 1 : 0,
      size: r.size || 0,
      updated_at: r.updated_at
    }));
    return json({ files });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ==== Kuota workspace per proyek (mengikuti paket langganan) ====
function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1).replace('.0', '') + ' GB';
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return Math.max(0, Math.round(n / 1024)) + ' KB';
}

// Perkiraan byte baru yang masuk dari satu entri file payload
function estBytes(f) {
  if (!f) return 0;
  if (f.cloud) return 0; // penanda: isi sudah di server, tidak menambah
  if (f.chunk_b64 !== undefined) return Number(f.chunk_idx) === 0 ? (Number(f.total_bytes) || 0) : 0; // unggah per-chunk: kuota dihitung penuh di chunk pertama saja
  if (typeof f.content_b64 === 'string' && f.content_b64.length) return decB64Bytes(f.content_b64);
  return new TextEncoder().encode(String(f.content || '')).length;
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    const body = await request.json();
    const projectId = body.project_id;
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    if (!projectId) return json({ error: 'project_id required' }, 400);

    const T = await getProjectTables(db, projectId);
    await ensureFilesTable(db, T.files);
    const chunksTable = await ensureChunksTable(db, projectId);

    const filesToSave = body.files && Array.isArray(body.files) ? body.files
      : (body.path !== undefined ? [{ path: body.path, content: body.content, content_b64: body.content_b64 }] : []);
    if (filesToSave.length === 0) return json({ error: 'path/content or files[] required' }, 400);

    // Kuota workspace per proyek sesuai paket (admin bypass)
    const user = await currentUser(env, request);
    if (!user || !ADMIN_EMAILS.has(String(user.email || '').toLowerCase())) {
      const planInfo = await getEffectivePlan(db, user);
      const quota = PLAN_WORKSPACE_LIMITS[planInfo.plan] || PLAN_WORKSPACE_LIMITS.Starter;
      const incoming = new Map(); // path -> perkiraan byte baru
      for (const f of filesToSave) {
        const path = String((f && f.path) || '').trim();
        if (path) incoming.set(path, (incoming.get(path) || 0) + estBytes(f));
      }
      // terpakai = total baris yang TIDAK sedang ditimpa (biar overwrite tidak dihitung dua kali)
      const rows = await db.prepare(`SELECT path, size FROM ${T.files} WHERE project_id = ?`).bind(projectId).all();
      let used = 0;
      for (const r of (rows.results || [])) if (!incoming.has(r.path)) used += Number(r.size) || 0;
      let add = 0;
      for (const v of incoming.values()) add += v;
      if (used + add > quota) {
        return json({ success: false, error: 'Kuota workspace penuh: paket ' + planInfo.plan + ' maksimal ' + fmtBytes(quota) + ' per proyek (terpakai ' + fmtBytes(used) + '). Upgrade paket di halaman Langganan untuk kuota lebih besar.', plan: planInfo.plan, quota_bytes: quota, used_bytes: used, upgrade_needed: true }, 402);
      }
    }

    // ==== SIMPAN MASSAL ATOMIK via db.batch() (2026-10-08) ====
    // Dulu: satu-satu await per file (245 file template AI Router = 245 round-trip D1)
    // -> Worker free plan (~10ms CPU/request) tewas di tengah loop -> HANYA SEBAGIAN
    // file tersimpan di cloud -> saat dibuka di Workspace, cloud "menang" dan menimpa
    // data lokal lengkap -> file template hilang sebagian. Sekarang semua INSERT dikumpulkan
    // lalu dieksekusi dalam SATU db.batch() (transaksi, atomik: semua-atau-tidak-sama-sekali).
    const keepPaths = [];
    const errors = [];
    const stmts = [];
    for (const f of filesToSave) {
      const path = String((f && f.path) || '').trim();
      if (!path) continue;
      keepPaths.push(path);
      if (f && typeof f.chunk_b64 === 'string') {
        // ==== UNGGAH FILE BESAR PER-CHUNK (2026-10-08) ====
        // Satu POST besar (base64 puluhan MB) kena batas CPU Worker free plan
        // -> unggahan gagal, file "hilang"/hantu. Sekarang klien memotong base64
        // jadi potongan ~700KB dan mengirim satu per satu; chunk pertama
        // me-reset baris file + chunk lama, sisanya menambah. JANGAN dipakai
        // bersama replace:true (keepPaths hanya berisi path file ini).
        const idx = Math.max(0, parseInt(f.chunk_idx || '0', 10) || 0);
        if (String(path).slice(-1) === '/') continue;
        if (idx === 0) {
          stmts.push(
            db.prepare(
              `INSERT INTO ${T.files} (project_id, path, content, is_big, size, updated_at) VALUES (?, ?, '', 1, ?, datetime('now'))
               ON CONFLICT(project_id, path) DO UPDATE SET content = '', is_big = 1, size = excluded.size, updated_at = datetime('now')`
            ).bind(projectId, path, Number(f.total_bytes) || 0),
            db.prepare(`DELETE FROM ${chunksTable} WHERE path = ?`).bind(path)
          );
        }
        stmts.push(db.prepare(`INSERT OR REPLACE INTO ${chunksTable} (path, idx, chunk) VALUES (?, ?, ?)`).bind(path, idx, f.chunk_b64));
        continue;
      }
      if (f && f.cloud) {
        // Penanda file besar: konten sudah ada di server — cukup pastikan barisnya ada.
        // INSERT OR IGNORE: jangan sentuh baris yang sudah ada (isi nyata di server menang).
        stmts.push(
          db.prepare(`INSERT OR IGNORE INTO ${T.files} (project_id, path, content, is_big, size, updated_at) VALUES (?, ?, '', 1, ?, datetime('now'))`)
            .bind(projectId, path, Number(f.size) || 0)
        );
        continue;
      }
      const content = f && typeof f.content === 'string' ? f.content : '';
      const contentB64 = f && typeof f.content_b64 === 'string' && f.content_b64.length ? f.content_b64 : null;
      // ==== kumpulkan statement utk path ini (menggantikan saveFile yang await satu-satu) ====
      let isBig = false, sizeBytes = 0, b64Str = '';
      if (typeof contentB64 === 'string' && contentB64.length) {
        isBig = true; b64Str = contentB64; sizeBytes = decB64Bytes(b64Str);
        try {
          const decoded = atob(b64Str);
          if (decoded.startsWith('data:')) {
            const comma = decoded.indexOf(',');
            if (comma > 0) sizeBytes = decB64Bytes(decoded.slice(comma + 1));
          }
        } catch (e) {}
      } else if (String(content || '').length > SMALL_MAX_CHARS) {
        isBig = true; b64Str = b64(String(content)); sizeBytes = decB64Bytes(b64Str);
      } else {
        sizeBytes = new TextEncoder().encode(String(content || '')).length;
      }
      if (isBig && sizeBytes > BIG_MAX_BYTES) { errors.push('File terlalu besar (maksimal 25MB): ' + path); continue; }
      if (!contentB64 && !content && String(path).slice(-1) !== '/') {
        // konten kosong tanpa base64 pada file biasa: JANGAN menimpa isi bila baris sudah ada
        // (INSERT OR IGNORE mempertahankan isi lama; kalau belum ada, buat baris penanda)
        stmts.push(
          db.prepare(`INSERT OR IGNORE INTO ${T.files} (project_id, path, content, is_big, size, updated_at) VALUES (?, ?, '', 0, ?, datetime('now'))`)
            .bind(projectId, path, sizeBytes)
        );
        continue;
      }
      if (!isBig) {
        stmts.push(
          db.prepare(
            `INSERT INTO ${T.files} (project_id, path, content, is_big, size, updated_at) VALUES (?, ?, ?, 0, ?, datetime('now'))
             ON CONFLICT(project_id, path) DO UPDATE SET content = excluded.content, is_big = 0, size = excluded.size, updated_at = datetime('now')`
          ).bind(projectId, path, String(content || ''), sizeBytes)
        );
      } else {
        stmts.push(
          db.prepare(
            `INSERT INTO ${T.files} (project_id, path, content, is_big, size, updated_at) VALUES (?, ?, '', 1, ?, datetime('now'))
             ON CONFLICT(project_id, path) DO UPDATE SET content = '', is_big = 1, size = excluded.size, updated_at = datetime('now')`
          ).bind(projectId, path, sizeBytes),
          db.prepare(`DELETE FROM ${chunksTable} WHERE path = ?`).bind(path)
        );
        for (let i = 0; i < b64Str.length; i += CHUNK_CHARS) {
          stmts.push(db.prepare(`INSERT INTO ${chunksTable} (path, idx, chunk) VALUES (?, ?, ?)`).bind(path, Math.floor(i / CHUNK_CHARS), b64Str.slice(i, i + CHUNK_CHARS)));
        }
      }
    }
    if (stmts.length) await db.batch(stmts);

    // replace: hapus path yang tidak ikut (sinkron hapus/rename dari klien).
    // body.keep_paths: daftar path LENGKAP lintas batch (klien bertahap) — jadi
    // replace:true pada batch 1..N tidak menghapus file milik batch lain.
    if (body.replace === true) {
      const all = await db.prepare(`SELECT path FROM ${T.files} WHERE project_id = ?`).bind(projectId).all();
      const keep = new Set(Array.isArray(body.keep_paths) && body.keep_paths.length ? body.keep_paths.map(String) : keepPaths);
      const orphans = (all.results || []).map(r => r.path).filter(p => !keep.has(p));
      const delStmts = orphans.map(p => db.prepare(`DELETE FROM ${T.files} WHERE project_id = ? AND path = ?`).bind(projectId, p));
      delStmts.push(...orphans.map(p => db.prepare(`DELETE FROM ${chunksTable} WHERE path = ?`).bind(p)));
      if (delStmts.length) await db.batch(delStmts);
    }

    // Update project's updated_at in projects table if exists
    try { await db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").bind(projectId).run(); } catch(e) {}

    if (errors.length && keepPaths.length === errors.length) return json({ error: errors[0] }, 400);
    return json({ success: true, saved: keepPaths.length, warnings: errors.length ? errors : undefined });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: 'D1 not bound' }, 500);
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get('project_id');
    const deny = await guardProject(env, request, projectId);
    if (deny) return deny;
    const path = url.searchParams.get('path');
    if (!projectId) return json({ error: 'project_id required' }, 400);

    const T = await getProjectTables(db, projectId);
    const chunksTable = await ensureChunksTable(db, projectId);
    if (path) {
      await db.prepare(`DELETE FROM ${T.files} WHERE project_id = ? AND path = ?`).bind(projectId, path).run();
      await deleteChunks(db, chunksTable, [path]);
    } else {
      await db.prepare(`DELETE FROM ${T.files} WHERE project_id = ?`).bind(projectId).run();
      try { await db.prepare(`DELETE FROM ${chunksTable}`).run(); } catch (e) {}
    }
    try { await db.prepare('DELETE FROM project_files WHERE project_id = ?').bind(projectId).run(); } catch(e) {}
    return json({ success: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
