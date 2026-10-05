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
  if (!g || !g.local || !g.token) return;
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
function normalizeScopes(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    read: r.read !== false,
    write: r.write === true,
    delete: r.delete === true,
    chat: r.chat === true,
    deploy: r.deploy === true,
    settings: r.settings === true,
    email: r.email === true,
    notif: r.notif === true
  };
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
