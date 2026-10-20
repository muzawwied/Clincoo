// =============================================================================
// _ws-tools.js — EKSEKUSI TOOL WORKSPACE SERVER-SIDE (mode Asisten AI 'asisten')
// [20 Okt 2026] Arsitektur baru Asisten Clincoo: AI memanggil write_file/
// read_file/dst. langsung di server dan file tersimpan ke tabel D1 proyek yang
// SAMA dengan /api/project-files (tabel p_<hash>_files + file_chunks). Dengan
// begitu daftar file di Workspace app dan di viewer Asisten selalu sinkron dua
// arah: AI menulis -> ws_rev naik -> UI memuat ulang; user mengedit di
// Workspace -> Asisten membaca versi terbaru.
// =============================================================================
import { getProjectTables, tableFor } from './_tables.js';

const SMALL_MAX_CHARS = 700_000; // sama dengan project-files.js
const CHUNK_CHARS = 1_500_000;

function b64(str) { return btoa(unescape(encodeURIComponent(String(str || '')))); }
function unb64(s) { return decodeURIComponent(escape(atob(String(s || '')))); }
function decB64Bytes(s) { try { return atob(String(s || '')).length; } catch (e) { return 0; } }
function normPath(p) { return String(p || '').replace(/\\/g, '/').split('/').filter(s => s && s !== '.' && s !== '..').join('/'); }

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
  for (const col of ['is_big INTEGER DEFAULT 0', 'size INTEGER DEFAULT 0']) {
    try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col}`).run(); } catch (e) {}
  }
}

async function ensureChunksTable(db, projectId) {
  const t = tableFor('file_chunks', projectId);
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${t} (
    path TEXT NOT NULL, idx INTEGER NOT NULL, chunk TEXT NOT NULL,
    PRIMARY KEY (path, idx)
  )`).run();
  return t;
}

// REVISI MONOTONIK (sama dengan project-files.js): counter naik pada tiap tulis,
// supaya UI yang polling ws_rev tidak melewatkan dua tulisan dalam satu detik.
async function bumpWsRev(db, projectId) {
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS ws_rev (project_id TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 0)').run();
    await db.prepare('INSERT INTO ws_rev (project_id, rev) VALUES (?, 1) ON CONFLICT(project_id) DO UPDATE SET rev = rev + 1').bind(projectId).run();
  } catch (e) {}
}

// Tombstone: mencegah sync tertunda menghidupkan kembali file yang dihapus AI.
async function addDeletedPath(db, projectId, path) {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS ws_deleted_paths (
      project_id TEXT NOT NULL, path TEXT NOT NULL, deleted_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, path)
    )`).run();
    await db.prepare(`INSERT INTO ws_deleted_paths (project_id, path, deleted_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(project_id, path) DO UPDATE SET deleted_at = datetime('now')`).bind(projectId, path).run();
  } catch (e) {}
}

// Kepemilikan proyek: AI hanya boleh menyentuh proyek milik user yang login.
// user.key = 'u<id>' (resolveUser di chat.js). Skema identik user-scope.js.
export async function wsGuard(db, user, projectId) {
  if (!user || !projectId || !db) return false;
  try {
    const uid = String(user.key || '').replace(/^u/, '');
    if (!uid) return false;
    await db.prepare(`CREATE TABLE IF NOT EXISTS user_projects (
      id TEXT PRIMARY KEY, user_id INTEGER, title TEXT DEFAULT '', prompt TEXT DEFAULT '',
      ai_name TEXT DEFAULT '', ai_desc TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT
    )`).run();
    const row = await db.prepare('SELECT user_id FROM user_projects WHERE id = ?').bind(String(projectId)).first();
    return !!(row && row.user_id != null && Number(row.user_id) === Number(uid));
  } catch (e) { return false; }
}

async function saveFile(db, table, chunksTable, projectId, path, contentStr) {
  const raw = String(contentStr || '');
  const sizeBytes = new TextEncoder().encode(raw).length;
  if (raw.length > SMALL_MAX_CHARS || sizeBytes > 25 * 1024 * 1024) {
    if (sizeBytes > 25 * 1024 * 1024) return { error: 'File terlalu besar (maks 25MB): ' + path };
    const s = b64(raw);
    await db.prepare(`INSERT INTO ${table} (project_id, path, content, is_big, size, updated_at) VALUES (?, ?, '', 1, ?, datetime('now'))
      ON CONFLICT(project_id, path) DO UPDATE SET content = '', is_big = 1, size = excluded.size, updated_at = datetime('now')`)
      .bind(projectId, path, sizeBytes).run();
    await db.prepare(`DELETE FROM ${chunksTable} WHERE path = ?`).bind(path).run();
    for (let i = 0; i < s.length; i += CHUNK_CHARS) {
      await db.prepare('INSERT INTO ' + chunksTable + ' (path, idx, chunk) VALUES (?, ?, ?)')
        .bind(path, Math.floor(i / CHUNK_CHARS), s.slice(i, i + CHUNK_CHARS)).run();
    }
    return { ok: true, big: true };
  }
  await db.prepare(`INSERT INTO ${table} (project_id, path, content, is_big, size, updated_at) VALUES (?, ?, ?, 0, ?, datetime('now'))
    ON CONFLICT(project_id, path) DO UPDATE SET content = excluded.content, is_big = 0, size = excluded.size, updated_at = datetime('now')`)
    .bind(projectId, path, raw, sizeBytes).run();
  await db.prepare(`DELETE FROM ${chunksTable} WHERE path = ?`).bind(path).run();
  return { ok: true };
}

async function readFileFull(db, table, chunksTable, projectId, path) {
  const row = await db.prepare(`SELECT path, content, is_big, size FROM ${table} WHERE project_id = ? AND path = ?`).bind(projectId, path).first();
  if (!row) return null;
  if (!row.is_big) return { content: String(row.content || ''), size: Number(row.size) || 0 };
  const r = await db.prepare(`SELECT chunk FROM ${chunksTable} WHERE path = ? ORDER BY idx`).bind(path).all();
  const joined = (r.results || []).map(x => x.chunk).join('');
  let content = '';
  try { content = unb64(joined); } catch (e) { content = joined; }
  return { content, size: Number(row.size) || 0 };
}

// Verifikasi ringan (tanpa eval — dilarang di Workers): heuristik per tipe file.
function verifyLabel(path, content) {
  const p = String(path || '').toLowerCase(); const c = String(content || '');
  if (!c.trim()) return 'GAGAL: file kosong.';
  if (p.endsWith('.html') || p.endsWith('.htm')) {
    const openDiv = (c.match(/<div\b/gi) || []).length, closeDiv = (c.match(/<\/div>/gi) || []).length;
    const openStyle = (c.match(/<style\b/gi) || []).length, closeStyle = (c.match(/<\/style>/gi) || []).length;
    const openScript = (c.match(/<script\b/gi) || []).length, closeScript = (c.match(/<\/script>/gi) || []).length;
    if ((openStyle !== closeStyle) || (openScript !== closeScript)) return 'GAGAL: tag style/script tidak seimbang.';
    if (openDiv && closeDiv && openDiv - closeDiv > 8) return 'GAGAL: banyak <div> tidak ditutup.';
    return 'OK: struktur HTML wajar (' + (c.length / 1024).toFixed(1) + ' KB).';
  }
  if (p.endsWith('.css')) {
    const open = (c.match(/\{/g) || []).length, close = (c.match(/\}/g) || []).length;
    if (open !== close) return 'GAGAL: kurung kurawal CSS tidak seimbang (' + open + ' vs ' + close + ').';
    return 'OK: CSS valid secara struktur.';
  }
  if (p.endsWith('.js')) {
    const fences = (c.match(/```/g) || []).length;
    if (fences % 2 === 1) return 'GAGAL: ada pagar kode ``` yang tidak ditutup.';
    const open = (c.match(/\{/g) || []).length, close = (c.match(/\}/g) || []).length;
    if (Math.abs(open - close) > 3) return 'GAGAL: kurung kurawal JS tidak seimbang (' + open + ' vs ' + close + ').';
    return 'OK: struktur JS wajar.';
  }
  if (p.endsWith('.md')) {
    const fences = (c.match(/```/g) || []).length;
    if (fences % 2 === 1) return 'GAGAL: pagar kode ``` tidak ditutup.';
    return 'OK: markdown wajar.';
  }
  return 'OK: tersimpan (' + (c.length / 1024).toFixed(1) + ' KB).';
}

function sizeLabel(n) { const b = Number(n) || 0; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(2) + ' MB'; }

// Daftar isi folder dari path datar (folder implisit dari struktur path).
function listFolder(rows, folderKey) {
  const out = [];
  const seen = new Set();
  // [FIX AUDIT 20 Okt] path kosong = root: prefix WAJIB '' (bukan '/'),
  // kalau tidak list_items root selalu kosong.
  const prefix = folderKey ? folderKey + '/' : '';
  for (const r of rows) {
    const p = String(r.path);
    if (prefix && !p.startsWith(prefix)) continue;
    const rest = prefix ? p.slice(prefix.length) : p;
    if (!rest) continue;
    const seg = rest.split('/')[0];
    if (rest.includes('/')) {
      const fpath = prefix + seg;
      if (!seen.has('d:' + fpath)) { seen.add('d:' + fpath); out.push({ name: seg, type: 'folder', path: fpath }); }
    } else if (!seen.has('f:' + p)) {
      seen.add('f:' + p);
      out.push({ name: seg, type: 'file', path: p, size: sizeLabel(r.size), is_big: r.is_big ? 1 : 0 });
    }
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'folder' ? -1 : 1)));
  return out;
}

// ============================ EKSEKUSI TOOL ============================
export async function wsToolExec(db, user, projectId, name, args) {
  try {
    if (!db) return { error: 'D1 tidak tersedia.' };
    if (!(await wsGuard(db, user, projectId))) {
      return { error: 'Proyek tidak ditemukan atau bukan milik akun ini. Tool workspace hanya bisa dipakai untuk proyek milik sendiri (parameter project_id wajib). Kerjakan yang bisa tanpa file, atau minta user membuka proyeknya dulu.' };
    }
    const T = await getProjectTables(db, projectId);
    await ensureFilesTable(db, T.files);
    const chunksTable = await ensureChunksTable(db, projectId);
    const a = args || {};

    if (name === 'list_items') {
      const folderKey = normPath(a.path);
      const r = await db.prepare(`SELECT path, is_big, size FROM ${T.files} WHERE project_id = ?`).bind(projectId).all();
      const items = listFolder(r.results || [], folderKey);
      return { folder: folderKey || 'root', total: items.length, items };
    }

    if (name === 'read_file') {
      const path = normPath(a.path);
      if (!path) return { error: 'Parameter path wajib.' };
      const f = await readFileFull(db, T.files, chunksTable, projectId, path);
      if (!f) return { error: 'File "' + path + '" tidak ditemukan.' };
      const max = 60000;
      return { name: path.split('/').pop(), path, size: sizeLabel(f.size), content: f.content.substring(0, max), truncated: f.content.length > max };
    }

    if (name === 'write_file') {
      const path = normPath(a.path);
      if (!path) return { error: 'Parameter path wajib.' };
      if (typeof a.content !== 'string') return { error: 'Parameter content wajib berupa teks file lengkap.' };
      const sv = await saveFile(db, T.files, chunksTable, projectId, path, a.content);
      if (sv.error) return { error: sv.error };
      await addDeletedUndoGuard(db, projectId, path);
      await bumpWsRev(db, projectId);
      return { success: true, action: 'saved', path, size: sizeLabel(new TextEncoder().encode(a.content).length), verify: verifyLabel(path, a.content) };
    }

    if (name === 'write_files') {
      const files = Array.isArray(a.files) ? a.files : [];
      if (!files.length) return { error: 'Parameter files wajib array [{path, content}].' };
      const done = [];
      for (const f of files) {
        const path = normPath(f && f.path);
        if (!path || typeof f.content !== 'string') continue;
        const sv = await saveFile(db, T.files, chunksTable, projectId, path, f.content);
        if (sv.error) return { error: sv.error, written: done };
        await addDeletedUndoGuard(db, projectId, path);
        done.push(path);
      }
      await bumpWsRev(db, projectId);
      return { success: true, action: 'saved', count: done.length, paths: done };
    }

    if (name === 'append_file') {
      const path = normPath(a.path);
      const add = String(a.content || '');
      if (!path || !add) return { error: 'Parameter path dan content wajib.' };
      const f = await readFileFull(db, T.files, chunksTable, projectId, path);
      const merged = (f ? f.content : '') + add;
      const sv = await saveFile(db, T.files, chunksTable, projectId, path, merged);
      if (sv.error) return { error: sv.error };
      await addDeletedUndoGuard(db, projectId, path);
      await bumpWsRev(db, projectId);
      return { success: true, action: f ? 'appended' : 'created', path, appended_chars: add.length, total_chars: merged.length, done: a.done !== false };
    }

    if (name === 'edit_file') {
      const path = normPath(a.path);
      if (!path) return { error: 'Parameter path wajib.' };
      const f = await readFileFull(db, T.files, chunksTable, projectId, path);
      if (!f) return { error: 'File "' + path + '" tidak ditemukan — untuk membuat file baru gunakan write_file.' };
      let content = f.content;
      const patches = (Array.isArray(a.edits) && a.edits.length) ? a.edits
        : ((typeof a.search === 'string' && a.search) ? [{ search: a.search, replace: a.replace }] : []);
      if (!patches.length) return { error: 'Parameter wajib: search + replace (atau array edits).' };
      let applied = 0; const fails = [];
      for (const p of patches) {
        const s = p && typeof p.search === 'string' ? p.search : '';
        const r = p && typeof p.replace === 'string' ? p.replace : '';
        if (!s) { fails.push({ search: '(kosong)', reason: 'string search kosong' }); continue; }
        const at = content.indexOf(s);
        if (at === -1) {
          let hint = '';
          try {
            const probe = (s.split(/\s+/)[0] || s.slice(0, 12)).replace(/[.*+?^${}()|[\]\\]/g, '');
            const ln = probe ? content.indexOf(probe) : -1;
            if (ln !== -1) hint = ' Petunjuk: teks mirip di sekitar: ' + JSON.stringify(content.slice(Math.max(0, ln - 30), ln + 70));
          } catch (e) {}
          fails.push({ search: s.slice(0, 120), reason: 'tidak ditemukan di file' + hint });
          continue;
        }
        if (a.all) content = content.split(s).join(r);
        else content = content.slice(0, at) + r + content.slice(at + s.length);
        applied++;
      }
      if (!applied) {
        return { error: 'PATCH GAGAL: tidak ada perubahan diterapkan.', failed: fails,
          hint: 'read_file file ini, salin string search yang PERSIS sama dengan isi file, lalu ulangi edit_file.' };
      }
      const sv = await saveFile(db, T.files, chunksTable, projectId, path, content);
      if (sv.error) return { error: sv.error };
      await bumpWsRev(db, projectId);
      return { success: true, action: 'edited', path, patches_applied: applied, patches_failed: fails.length ? fails : undefined, size: sizeLabel(new TextEncoder().encode(content).length), verify: verifyLabel(path, content) };
    }

    if (name === 'create_folder') {
      // Model file datar: folder muncul otomatis saat file pertama ditulis.
      // Sukses tanpa aksi supaya AI tidak buntu.
      const p = normPath(a.path);
      return { success: true, action: 'created', path: p || 'root', note: 'folder siap dipakai (folder muncul di daftar saat file pertama ditulis di dalamnya)' };
    }

    if (name === 'rename_item') {
      const from = normPath(a.from || a.path), to = normPath(a.to || a.new_path);
      if (!from || !to) return { error: 'Parameter from dan to wajib.' };
      const f = await readFileFull(db, T.files, chunksTable, projectId, from);
      if (!f) return { error: 'Item "' + from + '" tidak ditemukan.' };
      const sv = await saveFile(db, T.files, chunksTable, projectId, to, f.content);
      if (sv.error) return { error: sv.error };
      await db.prepare(`DELETE FROM ${T.files} WHERE project_id = ? AND path = ?`).bind(projectId, from).run();
      await db.prepare(`DELETE FROM ${chunksTable} WHERE path = ?`).bind(from).run();
      await addDeletedPath(db, projectId, from);
      await bumpWsRev(db, projectId);
      return { success: true, action: 'renamed', from, to };
    }

    if (name === 'delete_item') {
      const path = normPath(a.path);
      if (!path) return { error: 'Parameter path wajib.' };
      const r = await db.prepare(`SELECT path FROM ${T.files} WHERE project_id = ? AND (path = ? OR path LIKE ?)`).bind(projectId, path, path + '/%').all();
      const rows = r.results || [];
      if (!rows.length) return { error: '"' + path + '" tidak ditemukan.' };
      const paths = rows.map(x => x.path);
      await db.prepare(`DELETE FROM ${T.files} WHERE project_id = ? AND (path = ? OR path LIKE ?)`).bind(projectId, path, path + '/%').run();
      for (const p of paths) {
        await db.prepare(`DELETE FROM ${chunksTable} WHERE path = ?`).bind(p).run();
        await addDeletedPath(db, projectId, p);
      }
      await bumpWsRev(db, projectId);
      return { success: true, action: 'deleted', deleted: paths.length, paths: paths.slice(0, 50) };
    }

    if (name === 'search_items') {
      const q = String(a.query || a.q || '').trim();
      if (!q) return { error: 'Parameter query wajib.' };
      const esc = q.replace(/[\\%_]/g, m => '\\' + m);
      const r = await db.prepare(`SELECT path, content FROM ${T.files} WHERE project_id = ? AND is_big = 0 AND content LIKE ? ESCAPE '\\' LIMIT 60`).bind(projectId, '%' + esc + '%').all();
      const hits = [];
      for (const row of r.results || []) {
        const lines = String(row.content || '').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].indexOf(q) !== -1) {
            hits.push({ path: row.path, line: i + 1, excerpt: lines[i].trim().slice(0, 200) });
            if (hits.length >= 40) break;
          }
        }
        if (hits.length >= 40) break;
      }
      return { query: q, total_hits: hits.length, hits };
    }

    return { error: 'Tool workspace tidak dikenal: ' + name };
  } catch (e) {
    return { error: 'Gagal mengeksekusi tool workspace: ' + (e && e.message ? e.message : String(e)) };
  }
}

// Tulis ulang file yang sebelumnya dihapus = sengaja membuat ulang: bersihkan
// tombstone-nya supaya sync tertunda tidak menyapu file baru (sama dengan klien).
async function addDeletedUndoGuard(db, projectId, path) {
  try {
    await db.prepare('DELETE FROM ws_deleted_paths WHERE project_id = ? AND path = ?').bind(projectId, path).run();
  } catch (e) {}
}

// Daftar tool yang ditangani modul ini (dipakai chat.js untuk routing hop server).
export const WS_TOOL_NAMES = ['list_items', 'read_file', 'write_file', 'write_files', 'append_file', 'edit_file', 'create_folder', 'rename_item', 'delete_item', 'search_items'];
