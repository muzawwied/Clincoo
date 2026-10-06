// Cloudflare Pages Functions — Manajemen token MCP per proyek (dipanggil halaman Server MCP)
// POST   /api/mcp-token { project_id }        -> buat/ganti token MCP (butuh login Clincoo)
// GET    /api/mcp-token?project_id=xxx       -> status + token (butuh login)
// PATCH  /api/mcp-token { project_id, scopes } -> ubah izin tanpa ganti token
// DELETE /api/mcp-token?project_id=xxx        -> cabut akses (butuh login)
// Token dipakai platform AI lain sebagai Bearer untuk endpoint /api/mcp.
//
// PENYIMPANAN GANDA (unifikasi 2026-10-03): sumber kebenaran = tabel mcp_tokens
// (satu-satunya yang menyimpan be2_token, wajib untuk endpoint /api/mcp).
// Sebagai CERMIN, token+izin+created_at juga ditulis ke project-settings
// (mcp_token / mcp_scopes / mcp_created_at) — dipakai versi lama sesi paralel.
// GET: kalau tabel kosong tapi cermin berisi (token aktif dari versi lama),
// otomatis DIMIGRASI ke tabel (be2_token = sesi pemilik yang sedang login),
// sehingga token lama langsung dipakai endpoint /api/mcp tanpa aktivasi ulang.

import { getEffectivePlanByUserKey, featureAllowed, featureGateResponse } from './plan-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const J = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

import { getUserByToken } from './auth/shared.js';
import { tableFor } from './_tables.js';

const BE2 = 'https://clincoo-be2.pages.dev/api';

async function be2Json(path, token, init = {}) {
  const res = await fetch(BE2 + path, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + token } });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function ensureTables(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS mcp_tokens (
      project_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      be2_token TEXT NOT NULL,
      scopes TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`
  ).run();
  try {
    await env.DB.prepare('ALTER TABLE mcp_tokens ADD COLUMN scopes TEXT DEFAULT NULL').run();
  } catch (e) { /* kolom sudah ada */ }
}

// Guard: wajib token sesi milik akun yang memiliki proyek ini.
// UTAMA (2026-10-04): validasi LOKAL (auth_users/auth_sessions di D1 produksi).
// Selama ini guard memvalidasi ke BE2 lama — padahal login Clincoo sekarang
// lokal, jadi sesi yang SAH ditolak "Token tidak valid" (apalagi tiap sesi
// BE2 terhapus saat redeploy). BE2 hanya fallback untuk sesi era lama.
// Server MCP (hubungkan ke tool eksternal) = fitur paket Bisnis — ditegakkan server.
async function mcpPlanGate(env, g) {
  try {
    if (!g || !g.userId || !env || !env.DB) return null;
    const eff = await getEffectivePlanByUserKey(env.DB, 'u' + g.userId);
    if (!featureAllowed(eff.plan, 'mcpServer')) return featureGateResponse('mcpServer', eff.plan);
  } catch (e) {}
  return null;
}

async function guardOwner(request, env, projectId) {
  if (!projectId) return { res: J({ error: 'Parameter project_id wajib' }, 400) };
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return { res: J({ error: 'Login diperlukan' }, 401) };
  const tok = m[1].trim();
  try {
    const u = await getUserByToken(env.DB, tok);
    if (u) {
      // Kepemilikan lokal — logika sama dengan guardProject (user-scope.js):
      // row user_projects tidak ada => proyek era lama, boleh lewat;
      // row ada & milik user lain => tolak, JANGAN fallback ke be2.
      try {
        const own = await env.DB.prepare('SELECT user_id FROM user_projects WHERE id = ?').bind(String(projectId)).first();
        if (!own || own.user_id == null || Number(own.user_id) === Number(u.id)) return { token: tok, local: true, userId: u.id };
        return { res: J({ error: 'Proyek tidak ditemukan atau bukan milik akun ini' }, 403) };
      } catch (e) { /* tabel belum ada => proyek era lama, lanjut fallback be2 */ }
    }
  } catch (e) { /* tabel auth belum siap => fallback be2 */ }
  // LEGACY: sesi era BE2 lama tetap diterima.
  const me = await be2Json('/auth/me', tok);
  if (!me.ok || !me.data.authenticated) return { res: J({ error: 'Token tidak valid — silakan login ulang Clincoo' }, 401) };
  const pj = await be2Json('/projects', tok);
  if (!pj.ok) return { res: J({ error: 'Gagal memeriksa daftar proyek, coba lagi sebentar' }, 503) };
  const owned = (pj.data.projects || []).some(p => String(p.id) === String(projectId));
  if (!owned) return { res: J({ error: 'Proyek tidak ditemukan atau bukan milik akun ini' }, 403) };
  return { token: tok, local: false };
}

// Refresh token tersimpan di mcp_tokens (kolom be2_token, kini menyimpan
// sesi user mana pun yang valid) tiap guard lokal berhasil — jadi tool MCP
// selalu pegang sesi segar tanpa minta user buat ulang token.
async function refreshStoredToken(env, g, projectId) {
  // UTAMA (2026-10-06): jangan timpa sesi valid yang tersimpan dengan sesi browser —
  // sesi browser berumur pendek; menggantikannya hanya menghidupkan ulang masalah
  // "Sesi backend Clincoo kedaluwarsa". Simpan sesi DEDIKASI berumur panjang untuk
  // pemilik proyek; fallback ke sesi browser hanya bila pemilik tak tercatat.
  if (!env || !env.DB || !g || !g.local) return;
  try {
    const row = await env.DB.prepare('SELECT be2_token FROM mcp_tokens WHERE project_id = ?').bind(projectId).first();
    const cur = row && row.be2_token ? row.be2_token : '';
    if (cur) {
      const sess = await env.DB.prepare('SELECT token, expires_at FROM auth_sessions WHERE token = ?').bind(cur).first();
      if (sess && new Date(sess.expires_at) >= new Date()) return; // masih valid — biarkan
    }
    if (g.userId) {
      const b = new Uint8Array(24);
      crypto.getRandomValues(b);
      const tk = 'mcp_svc_' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
      await env.DB.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(tk, g.userId, new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000).toISOString()).run();
      await env.DB.prepare('UPDATE mcp_tokens SET be2_token = ? WHERE project_id = ?').bind(tk, projectId).run();
      return;
    }
  } catch (e) {}
  try { await env.DB.prepare('UPDATE mcp_tokens SET be2_token = ? WHERE project_id = ?').bind(g.token, projectId).run(); } catch (e) {}
}

function newMcpToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// Izin MCP — read default ON, sisanya default OFF (least privilege).
// 2026-10-03: izin baru chat (AI Clincoo), deploy (publikasi situs),
// settings (panel pengaturan/integrasi), email (kirim email proyek).
// ==== IZIN GRANULAR: 10 grup x 10 izin = 100 izin (halaman Pengaturan Server MCP) ====
export const SCOPE_GROUPS = [
  { id: 'file', label: 'File & Workspace', scopes: [
    { key: 'file.list', label: 'Lihat daftar file & folder', ready: true },
    { key: 'file.read', label: 'Baca isi file', ready: true },
    { key: 'file.write', label: 'Buat & tulis file', ready: true },
    { key: 'file.update', label: 'Ubah isi file yang ada', ready: true },
    { key: 'file.delete', label: 'Hapus file atau folder', ready: true },
    { key: 'file.rename', label: 'Ganti nama file', ready: true },
    { key: 'file.copy', label: 'Duplikat file', ready: true },
    { key: 'file.move', label: 'Pindahkan file antar folder', ready: true },
    { key: 'file.search', label: 'Cari file & isi konten', ready: true },
    { key: 'file.stats', label: 'Statistik penggunaan file', ready: true }
  ] },
  { id: 'chat', label: 'Chat & AI', scopes: [
    { key: 'chat.ai', label: 'Gunakan AI Clincoo (kompilasi, refactor, analisis)', ready: true },
    { key: 'chat.tools_use', label: 'AI dapat memakai tool workspace', ready: false },
    { key: 'chat.history_read', label: 'Baca riwayat chat proyek', ready: false },
    { key: 'chat.history_clear', label: 'Hapus riwayat chat', ready: false },
    { key: 'chat.model_set', label: 'Pilih model AI', ready: false },
    { key: 'chat.system_prompt', label: 'Atur system prompt proyek', ready: false },
    { key: 'chat.prompt_template', label: 'Kelola template prompt', ready: false },
    { key: 'chat.memory_read', label: 'Baca memori konteks proyek', ready: false },
    { key: 'chat.memory_write', label: 'Tulis memori konteks proyek', ready: false },
    { key: 'chat.stream', label: 'Streaming respons AI', ready: false }
  ] },
  { id: 'deploy', label: 'Deploy & Domain', scopes: [
    { key: 'deploy.run', label: 'Terbitkan situs ke Cloudflare Pages', ready: true },
    { key: 'deploy.status', label: 'Baca status deploy real-time', ready: true },
    { key: 'deploy.log_read', label: 'Baca log build & deploy', ready: true },
    { key: 'deploy.domain_add', label: 'Tambah domain kustom', ready: true },
    { key: 'deploy.domain_remove', label: 'Lepas domain kustom', ready: true },
    { key: 'deploy.domain_verify', label: 'Verifikasi DNS domain', ready: true },
    { key: 'deploy.unpublish', label: 'Batalkan publikasi situs', ready: true },
    { key: 'deploy.config_read', label: 'Baca konfigurasi deploy', ready: false },
    { key: 'deploy.config_update', label: 'Ubah konfigurasi deploy', ready: false },
    { key: 'deploy.rollback', label: 'Kembali ke versi deploy lama', ready: false }
  ] },
  { id: 'settings', label: 'Pengaturan Proyek', scopes: [
    { key: 'settings.read', label: 'Baca pengaturan proyek', ready: true },
    { key: 'settings.update', label: 'Ubah pengaturan proyek', ready: true },
    { key: 'settings.general_read', label: 'Baca pengaturan umum', ready: false },
    { key: 'settings.general_update', label: 'Ubah pengaturan umum', ready: false },
    { key: 'settings.seo_read', label: 'Baca pengaturan SEO', ready: false },
    { key: 'settings.seo_update', label: 'Ubah pengaturan SEO', ready: false },
    { key: 'settings.branding_read', label: 'Baca identitas visual proyek', ready: false },
    { key: 'settings.branding_update', label: 'Ubah identitas visual proyek', ready: false },
    { key: 'settings.export', label: 'Ekspor konfigurasi proyek', ready: false },
    { key: 'settings.import', label: 'Impor konfigurasi proyek', ready: false }
  ] },
  { id: 'email', label: 'Email', scopes: [
    { key: 'email.send', label: 'Kirim email lewat email API proyek', ready: true },
    { key: 'email.test', label: 'Kirim email uji coba', ready: false },
    { key: 'email.audience_list', label: 'Lihat daftar audiens', ready: true },
    { key: 'email.audience_create', label: 'Tambah audiens', ready: false },
    { key: 'email.audience_update', label: 'Ubah audiens', ready: false },
    { key: 'email.audience_delete', label: 'Hapus audiens', ready: false },
    { key: 'email.broadcast_list', label: 'Lihat daftar broadcast', ready: true },
    { key: 'email.broadcast_create', label: 'Buat broadcast', ready: false },
    { key: 'email.broadcast_send', label: 'Kirim broadcast massal', ready: true },
    { key: 'email.metrics_read', label: 'Baca metrik & statistik email', ready: true }
  ] },
  { id: 'notif', label: 'Notifikasi', scopes: [
    { key: 'notif.list', label: 'Baca notifikasi dashboard', ready: true },
    { key: 'notif.send', label: 'Kirim notifikasi ke dashboard', ready: true },
    { key: 'notif.delete', label: 'Hapus satu notifikasi', ready: true },
    { key: 'notif.clear', label: 'Bersihkan semua notifikasi', ready: true },
    { key: 'notif.template_read', label: 'Baca template notifikasi', ready: false },
    { key: 'notif.template_update', label: 'Ubah template notifikasi', ready: false },
    { key: 'notif.subscribe', label: 'Kelola langganan notifikasi', ready: false },
    { key: 'notif.unsubscribe', label: 'Berhenti langganan notifikasi', ready: false },
    { key: 'notif.preferences_read', label: 'Baca preferensi notifikasi', ready: false },
    { key: 'notif.preferences_update', label: 'Ubah preferensi notifikasi', ready: false }
  ] },
  { id: 'db', label: 'Database', scopes: [
    { key: 'db.info', label: 'Info database & kuota proyek', ready: true },
    { key: 'db.schema_read', label: 'Baca skema tabel', ready: false },
    { key: 'db.tables_list', label: 'Daftar tabel aplikasi', ready: true },
    { key: 'db.tables_create', label: 'Buat tabel baru', ready: true },
    { key: 'db.tables_delete', label: 'Hapus tabel', ready: true },
    { key: 'db.rows_list', label: 'Baca baris data', ready: true },
    { key: 'db.rows_create', label: 'Tambah baris data', ready: true },
    { key: 'db.rows_update', label: 'Ubah baris data', ready: true },
    { key: 'db.rows_delete', label: 'Hapus baris data', ready: true },
    { key: 'db.backup', label: 'Backup & ekspor data', ready: false }
  ] },
  { id: 'pay', label: 'Pembayaran', scopes: [
    { key: 'pay.info', label: 'Info ClincooPay: saldo, transaksi, penarikan', ready: true },
    { key: 'pay.config_read', label: 'Baca konfigurasi pembayaran', ready: false },
    { key: 'pay.config_update', label: 'Ubah konfigurasi pembayaran', ready: false },
    { key: 'pay.transactions_read', label: 'Baca riwayat transaksi lengkap', ready: false },
    { key: 'pay.refunds_read', label: 'Baca data refund', ready: false },
    { key: 'pay.plans_read', label: 'Baca paket & harga', ready: false },
    { key: 'pay.webhook_read', label: 'Baca webhook pembayaran', ready: false },
    { key: 'pay.webhook_update', label: 'Atur webhook pembayaran', ready: false },
    { key: 'pay.withdraw_request', label: 'Ajukan penarikan saldo', ready: false },
    { key: 'pay.payout_read', label: 'Baca status payout', ready: false }
  ] },
  { id: 'sec', label: 'Keamanan & Akses', scopes: [
    { key: 'sec.token_rotate', label: 'Putar ulang token MCP', ready: true },
    { key: 'sec.scopes_manage', label: 'Ubah izin lewat MCP', ready: true },
    { key: 'sec.activity_read', label: 'Baca log aktivitas MCP', ready: true },
    { key: 'sec.activity_clear', label: 'Hapus log aktivitas MCP', ready: true },
    { key: 'sec.sessions_list', label: 'Daftar sesi aktif', ready: false },
    { key: 'sec.sessions_revoke', label: 'Cabut sesi', ready: false },
    { key: 'sec.audit_read', label: 'Baca audit trail proyek', ready: false },
    { key: 'sec.ip_allowlist_manage', label: 'Kelola allowlist IP', ready: false },
    { key: 'sec.rate_limit_manage', label: 'Atur batas rate limit', ready: false },
    { key: 'sec.keys_read', label: 'Baca kunci API (disamarkan)', ready: false }
  ] },
  { id: 'sys', label: 'Integrasi & Sistem', scopes: [
    { key: 'sys.info', label: 'Info sistem & runtime proyek', ready: false },
    { key: 'sys.health', label: 'Cek kesehatan layanan', ready: false },
    { key: 'sys.usage_read', label: 'Baca pemakaian kuota proyek', ready: false },
    { key: 'sys.limits_read', label: 'Baca batas paket', ready: false },
    { key: 'sys.logs_read', label: 'Baca log sistem', ready: false },
    { key: 'sys.github_import', label: 'Impor repositori GitHub', ready: false },
    { key: 'sys.github_repos_read', label: 'Daftar repositori GitHub', ready: false },
    { key: 'sys.webhook_manage', label: 'Kelola webhook integrasi', ready: false },
    { key: 'sys.ai_providers_read', label: 'Baca penyedia AI terhubung', ready: false },
    { key: 'sys.ai_providers_update', label: 'Atur penyedia AI', ready: false }
  ] }
];
export const SCOPE_TOTAL = 100;
const LEGACY_KEYS = ["read", "write", "delete", "chat", "deploy", "settings", "email", "notif", "database", "payment"];
// Normalisasi izin granular (2026-10-06): 100 izin dalam 10 grup. Token era 10-izin
// dimigrasi otomatis (kunci lama dipertahankan agar kompatibel mundur). Izin yang
// ready=false belum punya tool aktif — nilainya tersimpan, mengikat begitu tool tersedia.
const LEGACY_SCOPE_CHILD = {
  "file.list": "read",
  "file.read": "read",
  "file.write": "write",
  "file.update": "write",
  "file.delete": "delete",
  "chat.ai": "chat",
  "deploy.run": "deploy",
  "deploy.status": "deploy",
  "settings.read": "settings",
  "settings.update": "settings",
  "email.send": "email",
  "notif.list": "notif",
  "notif.send": "notif",
  "pay.info": "payment",
  "db.info": "database",
  "db.tables_list": "database",
  "db.tables_create": "database",
  "db.tables_delete": "database",
  "db.rows_list": "database",
  "db.rows_create": "database",
  "db.rows_update": "database",
  "db.rows_delete": "database"
};
function normalizeScopes(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const o = {};
  SCOPE_GROUPS.forEach(g => g.scopes.forEach(s => {
    let v = null;
    if (typeof r[s.key] === 'boolean') v = r[s.key];
    else {
      const lg = LEGACY_SCOPE_CHILD[s.key];
      if (lg && typeof r[lg] === 'boolean') v = r[lg];
      else v = s.key === 'file.list' || s.key === 'file.read';
    }
    o[s.key] = v;
  }));
  LEGACY_KEYS.forEach(k => { if (typeof r[k] === 'boolean') o[k] = r[k]; });
  return o;
}


// ---- Cermin di project-settings (kompatibilitas versi lama sesi paralel) ----
async function mirrorRead(token, projectId) {
  const r = await be2Json('/project-settings?project_id=' + encodeURIComponent(projectId) + '&key=mcp_token', token);
  if (!r.ok) {
    // 404 = cermin memang belum ada; 5xx/0 = gagal cek — JANGAN disimpulkan "belum pernah buat server"
    if (r.status >= 500 || r.status === 0) return { failed: true };
    return null;
  }
  if (!r.data) return null;
  const tok = String(r.data.value || '').trim();
  if (!tok) return null;
  const [sc, ca] = await Promise.all([
    be2Json('/project-settings?project_id=' + encodeURIComponent(projectId) + '&key=mcp_scopes', token),
    be2Json('/project-settings?project_id=' + encodeURIComponent(projectId) + '&key=mcp_created_at', token)
  ]);
  let scopes = null;
  try { scopes = sc.ok && sc.data && sc.data.value ? JSON.parse(sc.data.value) : null; } catch (e) {}
  return { token: tok, scopes, created_at: (ca.ok && ca.data && ca.data.value) || null };
}

async function mirrorWrite(token, projectId, payload) {
  // payload: { token, scopes, created_at } — null/undefined berarti pertahankan nilai lama
  const body = { project_id: projectId };
  if (payload.token !== undefined) body.mcp_token = payload.token || '';
  if (payload.scopes !== undefined) body.mcp_scopes = payload.scopes ? JSON.stringify(payload.scopes) : '';
  if (payload.created_at !== undefined) body.mcp_created_at = payload.created_at || '';
  await be2Json('/project-settings', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const projectId = url.searchParams.get('project_id') || '';
  const g = await guardOwner(request, env, projectId);
  if (g.res) return g.res;
  const _mcpGate = await mcpPlanGate(env, g);
  if (_mcpGate) return _mcpGate;
  await ensureTables(env);
  await refreshStoredToken(env, g, projectId);
  let row = await env.DB.prepare('SELECT token, scopes, created_at FROM mcp_tokens WHERE project_id = ?').bind(projectId).first();
  // MIGRASI: tabel kosong tapi cermin versi lama berisi -> pindahkan ke tabel.
  // be2_token diisi sesi pemilik yang sedang login (token lama versi paralel tidak
  // menyimpan be2_token, jadi endpoint /api/mcp sebelumnya pasti menolaknya).
  if (!row) {
    const mir = await mirrorRead(g.token, projectId);
    if (mir && mir.failed) return J({ error: 'Gagal memeriksa status server MCP (cermin proyek tidak terjangkau) — coba lagi sebentar' }, 503);
    if (mir && mir.token) {
      const scopes = normalizeScopes(mir.scopes);
      await env.DB.prepare(
        `INSERT INTO mcp_tokens (project_id, token, be2_token, scopes, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET token = excluded.token, be2_token = excluded.be2_token, scopes = excluded.scopes, created_at = excluded.created_at`
      ).bind(projectId, mir.token, g.token, JSON.stringify(scopes), mir.created_at || new Date().toISOString()).run();
      row = { token: mir.token, scopes: JSON.stringify(scopes), created_at: mir.created_at };
    }
  }
  let scopes = null;
  try { scopes = row && row.scopes ? JSON.parse(row.scopes) : null; } catch (e) {}
  // Tulis-balik migrasi granular best-effort: D1 selalu berbentuk peta 100 izin terbaru.
  if (row) {
    try {
      const parsed = scopes;
      const nsc = normalizeScopes(parsed);
      if (JSON.stringify(parsed) !== JSON.stringify(nsc)) {
        await env.DB.prepare('UPDATE mcp_tokens SET scopes = ? WHERE project_id = ?').bind(JSON.stringify(nsc), projectId).run();
        scopes = nsc;
      }
    } catch (e) {}
  }
  // Riwayat aktivitas AI eksternal (tabel terisolasi per proyek) — 30 entri terakhir
  let activity = [];
  if (row) {
    try {
      const at = tableFor('mcp_activity', projectId);
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ${at} (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, tool TEXT NOT NULL,
        ok INTEGER DEFAULT 1, detail TEXT, created_at TEXT DEFAULT (datetime('now'))
      )`).run();
      const rows = await env.DB.prepare(`SELECT tool, ok, detail, created_at FROM ${at} ORDER BY id DESC LIMIT 30`).all();
      activity = rows.results || [];
    } catch (e) {}
  }
  return J({
    active: !!row,
    token: row ? row.token : null,
    scopes: normalizeScopes(scopes),
    scope_groups: SCOPE_GROUPS,
    scope_total: SCOPE_TOTAL,
    created_at: row ? row.created_at : null,
    activity,
    url: 'https://app.clincoo.buzz/api/mcp?project_id=' + encodeURIComponent(projectId)
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const projectId = body.project_id || new URL(request.url).searchParams.get('project_id') || '';
  const g = await guardOwner(request, env, projectId);
  if (g.res) return g.res;
  const _mcpGate = await mcpPlanGate(env, g);
  if (_mcpGate) return _mcpGate;
  await ensureTables(env);
  const token = newMcpToken();
  // Izin akses default (least privilege): hanya baca. Halaman Server MCP bisa mengubahnya per proyek.
  const scopes = normalizeScopes(body.scopes);
  const created = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO mcp_tokens (project_id, token, be2_token, scopes, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET token = excluded.token, be2_token = excluded.be2_token, scopes = excluded.scopes, created_at = excluded.created_at`
  ).bind(projectId, token, g.token, JSON.stringify(scopes), created).run();
  await mirrorWrite(g.token, projectId, { token, scopes, created_at: created });
  return J({
    ok: true,
    token,
    scopes,
    created_at: created,
    url: 'https://app.clincoo.buzz/api/mcp?project_id=' + encodeURIComponent(projectId)
  });
}

// PATCH /api/mcp-token { project_id, scopes } -> ubah izin akses tanpa mengganti token
export async function onRequestPatch(context) {
  const { request, env } = context;
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const projectId = body.project_id || '';
  const g = await guardOwner(request, env, projectId);
  if (g.res) return g.res;
  const _mcpGate = await mcpPlanGate(env, g);
  if (_mcpGate) return _mcpGate;
  await ensureTables(env);
  const scopes = normalizeScopes(body.scopes);
  const r = await env.DB.prepare('UPDATE mcp_tokens SET scopes = ? WHERE project_id = ?').bind(JSON.stringify(scopes), projectId).run();
  if (!r || !r.meta || !r.meta.changes) return J({ error: 'Token MCP belum aktif untuk proyek ini — aktifkan dulu di halaman Server MCP' }, 404);
  await mirrorWrite(g.token, projectId, { scopes });
  return J({ ok: true, scopes });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const projectId = url.searchParams.get('project_id') || '';
  const g = await guardOwner(request, env, projectId);
  if (g.res) return g.res;
  const _mcpGate = await mcpPlanGate(env, g);
  if (_mcpGate) return _mcpGate;
  await ensureTables(env);
  // scope=activity -> hanya hapus riwayat aktivitas, token tetap berlaku
  if (url.searchParams.get('scope') === 'activity') {
    try {
      const at = tableFor('mcp_activity', projectId);
      await env.DB.prepare(`DROP TABLE IF EXISTS ${at}`).run();
    } catch (e) {}
    return J({ ok: true });
  }
  await env.DB.prepare('DELETE FROM mcp_tokens WHERE project_id = ?').bind(projectId).run();
  await mirrorWrite(g.token, projectId, { token: '', scopes: '', created_at: '' });
  return J({ ok: true });
}
