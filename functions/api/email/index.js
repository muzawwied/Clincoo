// Clincoo Email API — kirim email dari situs deploy pengguna (form kontak, notifikasi, verifikasi).
// Kredensial (API key) diterbitkan per proyek, tersimpan di D1, terisolasi antar proyek.
// Pengiriman aktual lewat Brevo (kredensial global BREVO_API_KEY sudah ada di env_vars D1 —
// dipakai juga oleh wallet.js untuk email top up). "From" tetap alamat terverifikasi Brevo;
// nama tampilan ikut pengaturan from_name per proyek, balasan diarahkan via reply_to.
//
// GET  ?action=config&project_id=...                        → status, pengaturan, API key, kuota, log [auth]
// POST {action:'activate', project_id}                      → aktifkan + terbitkan API key           [auth]
// POST {action:'sender', project_id, from_name, contact_to} → simpan pengaturan pengirim              [auth]
// POST {action:'regenerate', project_id}                    → terbitkan API key baru                  [auth]
// POST {action:'revoke', project_id}                        → nonaktifkan + hapus API key             [auth]
// POST {action:'test', project_id, to, subject}             → kirim email uji ke alamat sendiri       [auth]
// POST {action:'send', api_key, to, subject, html, reply_to}→ kirim email dari situs deploy            [publik via api_key]

import { guardProject, currentUser } from '../user-scope.js';
import { sendEmail } from '../notify-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const QUOTA_LIMIT = 3000;
const KEY_PREFIX = 'clc_email_';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

async function ensureTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS email_settings (
    project_id TEXT PRIMARY KEY,
    api_key TEXT,
    active INTEGER DEFAULT 0,
    from_name TEXT DEFAULT '',
    contact_to TEXT DEFAULT '',
    quota_used INTEGER DEFAULT 0,
    quota_month TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_settings_key ON email_settings(api_key)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS email_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    subject TEXT DEFAULT '',
    status TEXT DEFAULT 'terkirim',
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_email_log_project ON email_log(project_id, created_at)`).run();
}

function genApiKey() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  for (let i = 0; i < 32; i++) s += chars[bytes[i] % chars.length];
  return KEY_PREFIX + s;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

async function getRow(db, projectId) {
  return await db.prepare('SELECT * FROM email_settings WHERE project_id = ?').bind(projectId).first();
}

// Reset kuota otomatis saat ganti bulan.
async function rolloverQuota(db, row) {
  const m = currentMonth();
  if (row && row.quota_month !== m) {
    await db.prepare('UPDATE email_settings SET quota_used = 0, quota_month = ? WHERE project_id = ?').bind(m, row.project_id).run();
    row.quota_used = 0;
    row.quota_month = m;
  }
  return row;
}

async function guardEmail(env, request, projectId) {
  if (!projectId) return json({ error: 'unauthorized', need_login: true }, 401);
  const denied = await guardProject(env, request, projectId);
  if (denied) return denied;
  const user = await currentUser(env, request);
  if (!user) return json({ error: 'unauthorized', need_login: true }, 401);
  return null;
}

async function recentLog(db, projectId) {
  const r = await db.prepare('SELECT to_addr as "to", subject, status, created_at as time FROM email_log WHERE project_id = ? ORDER BY id DESC LIMIT 10').bind(projectId).all();
  return (r.results || []).map(function (x) {
    return { to: x.to, subject: x.subject, status: x.status, time: (x.time || '').replace('T', ' ').slice(0, 16) };
  });
}

function configPayload(row, log) {
  return {
    active: !!(row && row.active),
    from_name: (row && row.from_name) || '',
    contact_to: (row && row.contact_to) || '',
    api_key: (row && row.active && row.api_key) ? row.api_key : '',
    used: (row && row.quota_used) || 0,
    limit: QUOTA_LIMIT,
    log: log || []
  };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const projectId = url.searchParams.get('project_id') || '';

  if (action === 'config') {
    const denied = await guardEmail(env, request, projectId);
    if (denied) return denied;
    await ensureTables(env.DB);
    let row = await getRow(env.DB, projectId);
    if (!row) return json({ error: 'not_found' }, 404);
    row = await rolloverQuota(env.DB, row);
    const log = await recentLog(env.DB, projectId);
    return json(configPayload(row, log));
  }

  return json({ error: 'unknown_action' }, 400);
}

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const action = body.action;

  // ---- Kirim email dari situs deploy via API key (tidak butuh login) ----
  if (action === 'send') {
    const apiKey = (body.api_key || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')).trim();
    if (!apiKey) return json({ error: 'api_key diperlukan' }, 401);
    if (!body.to || !body.subject || !body.html) return json({ error: 'to, subject, dan html wajib diisi' }, 400);
    await ensureTables(env.DB);
    let row = await env.DB.prepare('SELECT * FROM email_settings WHERE api_key = ? AND active = 1').bind(apiKey).first();
    if (!row) return json({ error: 'API key tidak valid atau belum aktif' }, 401);
    row = await rolloverQuota(env.DB, row);
    if ((row.quota_used || 0) >= QUOTA_LIMIT) return json({ error: 'Kuota bulanan habis' }, 429);
    const result = await sendEmail(env, {
      toEmail: body.to,
      toName: body.to_name || '',
      subject: String(body.subject).slice(0, 200),
      html: String(body.html),
      replyTo: body.reply_to || row.contact_to || ''
    });
    await env.DB.prepare('INSERT INTO email_log (project_id, to_addr, subject, status) VALUES (?, ?, ?, ?)')
      .bind(row.project_id, body.to, String(body.subject).slice(0, 200), result.sent ? 'terkirim' : 'gagal').run();
    if (result.sent) await env.DB.prepare('UPDATE email_settings SET quota_used = quota_used + 1 WHERE project_id = ?').bind(row.project_id).run();
    return json({ sent: !!result.sent, reason: result.reason || null });
  }

  const projectId = body.project_id || '';
  const denied = await guardEmail(env, request, projectId);
  if (denied) return denied;
  await ensureTables(env.DB);

  if (action === 'activate') {
    let row = await getRow(env.DB, projectId);
    if (row) {
      await env.DB.prepare("UPDATE email_settings SET active = 1, api_key = COALESCE(api_key, ?), updated_at = datetime('now') WHERE project_id = ?")
        .bind(genApiKey(), projectId).run();
    } else {
      await env.DB.prepare('INSERT INTO email_settings (project_id, api_key, active, quota_month) VALUES (?, ?, 1, ?)')
        .bind(projectId, genApiKey(), currentMonth()).run();
    }
    row = await getRow(env.DB, projectId);
    const log = await recentLog(env.DB, projectId);
    return json(configPayload(row, log));
  }

  if (action === 'sender') {
    const row = await getRow(env.DB, projectId);
    if (!row) return json({ error: 'Aktifkan email dulu' }, 400);
    await env.DB.prepare("UPDATE email_settings SET from_name = ?, contact_to = ?, updated_at = datetime('now') WHERE project_id = ?")
      .bind(String(body.from_name || '').slice(0, 100), String(body.contact_to || '').slice(0, 200), projectId).run();
    return json({ ok: true });
  }

  if (action === 'regenerate') {
    const row = await getRow(env.DB, projectId);
    if (!row) return json({ error: 'Aktifkan email dulu' }, 400);
    const newKey = genApiKey();
    await env.DB.prepare("UPDATE email_settings SET api_key = ?, active = 1, updated_at = datetime('now') WHERE project_id = ?").bind(newKey, projectId).run();
    return json({ api_key: newKey });
  }

  if (action === 'revoke') {
    const row = await getRow(env.DB, projectId);
    if (!row) return json({ error: 'Aktifkan email dulu' }, 400);
    await env.DB.prepare("UPDATE email_settings SET active = 0, api_key = NULL, updated_at = datetime('now') WHERE project_id = ?").bind(projectId).run();
    return json({ ok: true });
  }

  if (action === 'test') {
    const row = await getRow(env.DB, projectId);
    if (!row || !row.active) return json({ error: 'Aktifkan email dulu' }, 400);
    if (!body.to) return json({ error: 'Alamat tujuan diperlukan' }, 400);
    const result = await sendEmail(env, {
      toEmail: body.to,
      subject: String(body.subject || 'Uji coba email Clincoo').slice(0, 200),
      html: '<p>Ini email uji dari proyekmu di Clincoo. Jika kamu menerima email ini, pengaturan pengirimmu sudah bekerja.</p>',
      replyTo: row.contact_to || ''
    });
    await env.DB.prepare('INSERT INTO email_log (project_id, to_addr, subject, status) VALUES (?, ?, ?, ?)')
      .bind(projectId, body.to, body.subject || 'Uji coba email Clincoo', result.sent ? 'terkirim' : 'gagal').run();
    if (!result.sent) return json({ error: 'Gagal mengirim: ' + (result.reason || 'tidak diketahui') }, 502);
    return json({ ok: true });
  }

  return json({ error: 'unknown_action' }, 400);
}
