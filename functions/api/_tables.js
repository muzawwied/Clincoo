// Cloudflare Pages Functions — helpers isolasi data per proyek
// Setiap project_id mendapat tabel data SENDIRI (chat, files, env vars,
// settings, deploy logs) di D1 yang sama, supaya data ribuan record
// antar-proyek tidak campur di satu tabel bersama.
// File berprefix _ tidak dijadikan route oleh Pages Functions.

const PROJECT_TABLES = ['chat_sessions', 'chat_messages', 'project_files', 'env_vars', 'project_settings', 'security_settings', 'deploy_logs'];

export function tableSuffix(projectId) {
  return String(projectId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) || 'default';
}

// Nama tabel untuk sebuah proyek: p_<suffix>_<base>.
// Tanpa project_id → tabel global bersama (perilaku lama).
export function tableFor(base, projectId) {
  if (!projectId) return base;
  return `p_${tableSuffix(projectId)}_${base}`;
}

async function ensureMapTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS _session_project (
    session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL
  )`).run();
}

// Catat mapping sesi -> proyek, supaya GET ?session_id tanpa project_id
// tetap bisa menemukan data sesi di tabel proyek yang benar.
export async function mapSession(db, sessionId, projectId) {
  if (!sessionId || !projectId) return;
  await ensureMapTable(db);
  try {
    await db.prepare('INSERT OR REPLACE INTO _session_project (session_id, project_id) VALUES (?, ?)')
      .bind(String(sessionId), String(projectId)).run();
  } catch (e) {}
}

export async function resolveSessionProject(db, sessionId) {
  if (!sessionId) return '';
  await ensureMapTable(db);
  try {
    const row = await db.prepare('SELECT project_id FROM _session_project WHERE session_id = ?')
      .bind(String(sessionId)).first();
    return row?.project_id || '';
  } catch (e) { return ''; }
}

// Buat tabel-tabel milik satu proyek (idempotent)
export async function ensureProjectTables(db, projectId) {
  if (!projectId) return;
  const s = tableSuffix(projectId);
  const t = (b) => `p_${s}_${b}`;
  // Alokasikan range id unik per proyek (beda 1.000.000) supaya id baris di
  // tabel proyek tidak pernah bentrok antar-proyek maupun dengan tabel global.
  await db.prepare(`CREATE TABLE IF NOT EXISTS _project_id_bases (suffix TEXT PRIMARY KEY, base INTEGER)`).run();
  let baseRow = await db.prepare('SELECT base FROM _project_id_bases WHERE suffix = ?').bind(s).first();
  if (!baseRow) {
    const max = await db.prepare('SELECT COALESCE(MAX(base), 900000000) AS m FROM _project_id_bases').first();
    const base = (max?.m || 900000000) + 1000000;
    await db.prepare('INSERT OR IGNORE INTO _project_id_bases (suffix, base) VALUES (?, ?)').bind(s, base).run();
    baseRow = { base };
  }
  const idBase = baseRow.base;
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${t('chat_sessions')} (
    id TEXT PRIMARY KEY, title TEXT DEFAULT 'Percakapan Baru', project_id TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${t('chat_messages')} (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, model TEXT, created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_${s}_chat_msg ON ${t('chat_messages')}(session_id, created_at)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${t('project_files')} (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, path TEXT NOT NULL,
    content TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(project_id, path)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${t('env_vars')} (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, key TEXT NOT NULL, value TEXT NOT NULL,
    is_secret INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  // Seed AUTOINCREMENT pada base milik proyek ini — id jadi unik global.
  await db.prepare(`INSERT INTO ${t('env_vars')} (id, project_id, key, value) VALUES (?, '', '__seed__', '__seed__')`).bind(idBase).run();
  await db.prepare(`DELETE FROM ${t('env_vars')} WHERE key = '__seed__'`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${t('project_settings')} (
    project_id TEXT, key TEXT NOT NULL, value TEXT, PRIMARY KEY (project_id, key)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${t('security_settings')} (
    project_id TEXT, key TEXT NOT NULL, value TEXT, PRIMARY KEY (project_id, key)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${t('deploy_logs')} (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, status TEXT, url TEXT, message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
}

// Migrasi sekali per proyek: pindahkan data lama dari tabel bersama ke
// tabel proyek, catat mapping sesi, lalu bersihkan tabel bersama.
export async function migrateProjectData(db, projectId) {
  if (!projectId) return;
  await ensureProjectTables(db, projectId);
  await ensureMapTable(db);
  await db.prepare(`CREATE TABLE IF NOT EXISTS _project_migrations (
    project_id TEXT PRIMARY KEY, migrated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  const done = await db.prepare('SELECT project_id FROM _project_migrations WHERE project_id = ?')
    .bind(String(projectId)).first();
  if (done) return;
  const s = tableSuffix(projectId);
  const t = (b) => `p_${s}_${b}`;
  const p = String(projectId);
  // Setiap langkah dibungkus try/catch: skema tabel bersama di database lama bisa
  // berbeda-beda; satu tabel bermasalah tidak boleh membatalkan migrasi lainnya.
  const step = async (sql, ...params) => {
    try { await db.prepare(sql).bind(...params).run(); } catch (e) {}
  };
  // 1) Salin data lama ke tabel proyek (INSERT OR IGNORE = aman diulang).
  //    chat_sessions versi lama tidak punya kolom created_at → hanya ambil kolom
  //    yang pasti ada; created_at memakai default tabel baru.
  await step(`INSERT OR IGNORE INTO ${t('chat_sessions')} (id, title, project_id, updated_at)
    SELECT id, title, project_id, COALESCE(updated_at, datetime('now')) FROM chat_sessions WHERE project_id = ?`, p);
  await step(`INSERT OR IGNORE INTO ${t('chat_messages')} (session_id, role, content, model, created_at)
    SELECT m.session_id, m.role, m.content, m.model, m.created_at FROM chat_messages m
    WHERE m.session_id IN (SELECT id FROM chat_sessions WHERE project_id = ?)`, p);
  await step(`INSERT INTO ${t('project_files')} (project_id, path, content, created_at, updated_at)
    SELECT project_id, path, content, created_at, updated_at FROM project_files WHERE project_id = ?
    ON CONFLICT(project_id, path) DO NOTHING`, p);
  await step(`INSERT OR IGNORE INTO ${t('env_vars')} (project_id, key, value, is_secret, created_at, updated_at)
    SELECT project_id, key, value, is_secret, created_at, updated_at FROM env_vars WHERE project_id = ?`, p);
  await step(`INSERT OR IGNORE INTO ${t('project_settings')} (project_id, key, value)
    SELECT project_id, key, value FROM project_settings WHERE project_id = ?`, p);
  await step(`INSERT OR IGNORE INTO ${t('security_settings')} (project_id, key, value)
    SELECT project_id, key, value FROM security_settings WHERE project_id = ?`, p);
  await step(`INSERT OR IGNORE INTO ${t('deploy_logs')} (project_id, status, url, message, created_at)
    SELECT project_id, status, url, message, created_at FROM deploy_logs WHERE project_id = ?`, p);
  // 2) Catat mapping sesi -> proyek (sebelum sesi lama dihapus)
  await step(`INSERT OR IGNORE INTO _session_project (session_id, project_id)
    SELECT id, ? FROM chat_sessions WHERE project_id = ?`, p, p);
  // 3) Bersihkan tabel bersama (pesan dulu, baru sesi) — hanya jika data sudah
  //    tersalin dengan aman; cek jumlah sesi di tabel proyek dulu.
  const copied = await db.prepare(`SELECT COUNT(*) AS c FROM ${t('chat_sessions')}`).first();
  const srcCnt = await db.prepare('SELECT COUNT(*) AS c FROM chat_sessions WHERE project_id = ?').bind(p).first();
  if ((copied?.c || 0) >= (srcCnt?.c || 0)) {
    await step(`DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE project_id = ?)`, p);
    await step('DELETE FROM chat_sessions WHERE project_id = ?', p);
    await step('DELETE FROM project_files WHERE project_id = ?', p);
    await step('DELETE FROM env_vars WHERE project_id = ?', p);
    await step('DELETE FROM project_settings WHERE project_id = ?', p);
    await step('DELETE FROM security_settings WHERE project_id = ?', p);
    await step('DELETE FROM deploy_logs WHERE project_id = ?', p);
  }
  // 4) Tandai migrasi selesai
  await step('INSERT OR IGNORE INTO _project_migrations (project_id) VALUES (?)', p);
}

// Siapkan + resolve nama tabel untuk sebuah proyek.
// projectId kosong → tabel global bersama (perilaku lama).
export async function getProjectTables(db, projectId) {
  if (projectId) {
    await migrateProjectData(db, projectId);
  }
  return {
    sessions: tableFor('chat_sessions', projectId),
    messages: tableFor('chat_messages', projectId),
    files: tableFor('project_files', projectId),
    envVars: tableFor('env_vars', projectId),
    projectSettings: tableFor('project_settings', projectId),
    securitySettings: tableFor('security_settings', projectId),
    deployLogs: tableFor('deploy_logs', projectId),
  };
}
