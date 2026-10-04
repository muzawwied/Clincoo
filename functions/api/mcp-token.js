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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const J = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

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

// Guard: wajib token be2 milik akun yang memiliki proyek ini.
async function guardOwner(request, env, projectId) {
  if (!projectId) return { res: J({ error: 'Parameter project_id wajib' }, 400) };
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return { res: J({ error: 'Login diperlukan' }, 401) };
  const tok = m[1].trim();
  const me = await be2Json('/auth/me', tok);
  if (!me.ok || !me.data.authenticated) return { res: J({ error: 'Token tidak valid' }, 401) };
  // Cek kepemilikan via /api/projects — BUG LAMA: kalau fetch ini gagal (jaringan/server lelet,
  // cold start, dll), pj.data.projects jadi undefined dan kode salah nyimpulkan "bukan milik akun ini"
  // padahal sebenarnya cuma gagal cek sementara. Sekarang gagal-fetch dibedakan dari gagal-kepemilikan.
  const pj = await be2Json('/projects', tok);
  if (!pj.ok) return { res: J({ error: 'Gagal memeriksa daftar proyek, coba lagi sebentar' }, 503) };
  const owned = (pj.data.projects || []).some(p => String(p.id) === String(projectId));
  if (!owned) return { res: J({ error: 'Proyek tidak ditemukan atau bukan milik akun ini' }, 403) };
  return { token: tok };
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
  await ensureTables(env);
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
  return J({
    active: !!row,
    token: row ? row.token : null,
    scopes: normalizeScopes(scopes),
    created_at: row ? row.created_at : null,
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
  await ensureTables(env);
  await env.DB.prepare('DELETE FROM mcp_tokens WHERE project_id = ?').bind(projectId).run();
  await mirrorWrite(g.token, projectId, { token: '', scopes: '', created_at: '' });
  return J({ ok: true });
}
