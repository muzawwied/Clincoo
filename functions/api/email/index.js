// Clincoo Email API — kirim email dari situs deploy pengguna (form kontak, notifikasi, verifikasi).
// Kredensial (API key) diterbitkan per proyek, tersimpan di D1, terisolasi antar proyek.
//
// Pengiriman via Cloudflare Email Service (Worker jembatan clincoo-mail):
//   1. Default  : dari noreply@clincoo.buzz, nama pengirim proyek TIDAK boleh menyertakan
//                 identitas tim Clincoo/Clinqoo (anti penipuan).
//   2. Kustom   : dari alamat domain kustom pengguna (domain harus ter-onboard di akun
//                 Cloudflare Clincoo / terhubung lewat Zona Domain Kustom).
//
// Kuota bulanan dihitung LANGSUNG dari histori pengiriman (email_log bulan berjalan,
// status terkirim) — satu sumber kebenaran, tidak ada counter terpisah.
//
// GET  ?action=config&project_id=...                          → status, pengaturan, API key, kuota [auth]
// GET  ?action=history&project_id=...                         → histori kirim (CRUD: read)    [auth]
// POST {action:'activate', project_id}                        → aktifkan + terbitkan API key [auth]
// POST {action:'sender', project_id, from_name, contact_to,
//        sender_email}                                       → simpan pengaturan pengirim    [auth]
// POST {action:'regenerate', project_id}                      → terbitkan API key baru        [auth]
// POST {action:'revoke', project_id}                          → nonaktifkan + hapus API key   [auth]
// POST {action:'test', project_id, to, subject, html,
//        reply_to}                                            → kirim email (CRUD: create)    [auth]
// POST {action:'delete_log', project_id, id}                  → hapus entri histori (delete)  [auth]
// POST {action:'send', api_key, to, subject, html, reply_to}  → kirim email dari situs deploy  [publik via api_key]

import { guardProject, currentUser } from '../user-scope.js';
import { getSecret } from '../notify-helpers.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const QUOTA_LIMIT = 1000;
const KEY_PREFIX = 'clc_email_';

// Nama identitas tim — tidak boleh dipakai pengirim proyek (anti penipuan atas nama Clincoo).
const BANNED_NAME_PATTERNS = [/clin\s*coo/i, /clin\s*qoo/i, /tim\s+clin/i];
const BANNED_EMAIL_DOMAINS = ['clincoo.buzz', 'clinqoo.com', 'clincoo.com'];

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
    sender_email TEXT DEFAULT '',
    sender_key TEXT DEFAULT '',
    quota_used INTEGER DEFAULT 0,
    quota_month TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_email_settings_key ON email_settings(api_key)').run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS email_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    subject TEXT DEFAULT '',
    status TEXT DEFAULT 'terkirim',
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_email_log_project ON email_log(project_id, created_at)').run();
  // Kolom baru untuk deployment lama (idempoten).
  for (const col of ['sender_email', 'sender_key']) {
    try { await db.prepare(`ALTER TABLE email_settings ADD COLUMN ${col} TEXT DEFAULT ''`).run(); } catch (e) {}
  }
}

function genApiKey() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  for (let i = 0; i < 32; i++) s += chars[bytes[i] % chars.length];
  return KEY_PREFIX + s;
}

function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}

// Validasi anti-impersonasi: nama pengirim tidak boleh menyertakan identitas tim Clincoo.
function senderNameAllowed(name) {
  const n = String(name || '').trim();
  if (!n) return { ok: true, name: '' };
  for (const p of BANNED_NAME_PATTERNS) {
    if (p.test(n)) return { ok: false, reason: 'Nama pengirim tidak boleh memakai nama atau identitas tim Clincoo/Clinqoo.' };
  }
  return { ok: true, name: n.slice(0, 100) };
}

// Validasi email kustom: wajib domain sendiri, bukan domain resmi Clincoo.
function senderEmailAllowed(email) {
  const e = String(email || '').trim();
  if (!e) return { ok: true, email: '' };
  if (!validEmail(e)) return { ok: false, reason: 'Alamat email pengirim tidak valid.' };
  const domain = e.split('@')[1].toLowerCase();
  if (BANNED_EMAIL_DOMAINS.indexOf(domain) !== -1) {
    return { ok: false, reason: 'Domain Clincoo tidak boleh dipakai sebagai pengirim kustom.' };
  }
  return { ok: true, email: e.slice(0, 200) };
}

async function getRow(db, projectId) {
  return await db.prepare('SELECT * FROM email_settings WHERE project_id = ?').bind(projectId).first();
}

// Kuota bulanan langsung dari histori pengiriman (satu sumber kebenaran).
async function quotaUsed(db, projectId) {
  const r = await db.prepare(
    "SELECT COUNT(*) AS c FROM email_log WHERE project_id = ? AND status = 'terkirim' AND created_at >= datetime('now', 'start of month')"
  ).bind(projectId).first();
  return (r && r.c) || 0;
}

async function guardEmail(env, request, projectId) {
  if (!projectId) return json({ error: 'unauthorized', need_login: true }, 401);
  const denied = await guardProject(env, request, projectId);
  if (denied) return denied;
  const user = await currentUser(env, request);
  if (!user) return json({ error: 'unauthorized', need_login: true }, 401);
  return null;
}

async function historyLog(db, projectId, limit) {
  const r = await db.prepare('SELECT id, to_addr as "to", subject, status, created_at as time FROM email_log WHERE project_id = ? ORDER BY id DESC LIMIT ?')
    .bind(projectId, limit || 100).all();
  return (r.results || []).map(function (x) {
    return { id: x.id, to: x.to, subject: x.subject, status: x.status, time: (x.time || '').replace('T', ' ').slice(0, 16) };
  });
}

function configPayload(row, used, log) {
  return {
    active: !!(row && row.active),
    from_name: (row && row.from_name) || '',
    contact_to: (row && row.contact_to) || '',
    sender_email: (row && row.sender_email) || '',
    has_custom_sender: !!(row && row.sender_email),
    api_key: (row && row.active && row.api_key) ? row.api_key : '',
    used: used || 0,
    limit: QUOTA_LIMIT,
    log: log || []
  };
}

// Nama pengirim efektif untuk email proyek — default dibedakan dari identitas tim
// ("Clincoo Mail", bukan "Clincoo") dan selalu lolos validasi anti-impersonasi.
function effectiveSenderName(row) {
  const n = (row && row.from_name) || '';
  const ok = senderNameAllowed(n);
  return ok.ok && ok.name ? ok.name : 'Clincoo Mail';
}

const DEFAULT_FROM = 'noreply@clincoo.buzz';

function stripHtml(h) {
  return String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
}

function friendlyEmailError(code, reason) {
  if (code === 'E_SENDER_NOT_VERIFIED') return 'Domain pengirim belum terverifikasi di Cloudflare. Untuk pengirim kustom, pastikan domainmu sudah aktif di Clincoo (Zona Domain Kustom).';
  if (code === 'E_RATE_LIMIT_EXCEEDED') return 'Terlalu banyak email dalam waktu singkat — tunggu sebentar lalu coba lagi.';
  if (code === 'E_DAILY_LIMIT_EXCEEDED') return 'Kuota harian Cloudflare tercapai — coba lagi besok.';
  if (code === 'E_DELIVERY_FAILED') return 'Penerima menolak email — periksa alamat tujuan.';
  if (code === 'E_INTERNAL_SERVER_ERROR') return 'Layanan email Cloudflare sedang sibuk — coba lagi sebentar.';
  if (code === 'BINDING_SEND_EMAIL_BELUM_AKTIF') return 'Layanan email belum aktif di server — hubungi tim Clincoo.';
  if (code === 'BRIDGE_BELUM_TERKONFIGURASI') return 'Layanan email belum dikonfigurasi di server — hubungi tim Clincoo.';
  if (code === 'E_RECIPIENT_NOT_ALLOWED') return 'Penerima belum terverifikasi di Cloudflare — mode terbatas layanan email Clincoo. Hubungi tim Clincoo bila email ini penting.';
  return reason || 'Pengiriman gagal';
}

// Kirim via Cloudflare Email Service, lewat Worker jembatan clincoo-mail
// (Pages belum mendukung binding send_email, jadi diproxy via Worker).
async function sendProjectEmail(env, row, opts) {
  const url = await getSecret(env, 'MAIL_BRIDGE_URL');
  const bridgeKey = await getSecret(env, 'MAIL_BRIDGE_KEY');
  if (!url || !bridgeKey) return { sent: false, via: 'cloudflare', code: 'BRIDGE_BELUM_TERKONFIGURASI', reason: null };
  const fromMail = (row && row.sender_email) ? String(row.sender_email) : DEFAULT_FROM;
  try {
    const r = await fetch(String(url).replace(/\/$/, '') + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Key': String(bridgeKey) },
      body: JSON.stringify({
        to: opts.toEmail,
        from_email: fromMail,
        from_name: effectiveSenderName(row),
        subject: opts.subject,
        html: opts.html,
        text: stripHtml(opts.html),
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {})
      })
    });
    const data = await r.json().catch(function () { return {}; });
    if (r.ok && data.ok) return { sent: true, via: 'cloudflare', messageId: data.messageId || null };
    return { sent: false, via: 'cloudflare', code: data.code || null, reason: data.error || ('HTTP ' + r.status) };
  } catch (e) {
    return { sent: false, via: 'cloudflare', code: null, reason: String((e && e.message) || e) };
  }
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const projectId = url.searchParams.get('project_id') || '';

  if (action === 'config' || action === 'history') {
    const denied = await guardEmail(env, request, projectId);
    if (denied) return denied;
    await ensureTables(env.DB);
    const row = await getRow(env.DB, projectId);
    if (!row) return json({ error: 'not_found' }, 404);
    const used = await quotaUsed(env.DB, projectId);
    if (action === 'history') {
      return json({ used: used, limit: QUOTA_LIMIT, items: await historyLog(env.DB, projectId, 100) });
    }
    return json(configPayload(row, used, await historyLog(env.DB, projectId, 10)));
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
    if (!validEmail(body.to)) return json({ error: 'Alamat email tujuan tidak valid' }, 400);
    await ensureTables(env.DB);
    const row = await env.DB.prepare('SELECT * FROM email_settings WHERE api_key = ? AND active = 1').bind(apiKey).first();
    if (!row) return json({ error: 'API key tidak valid atau belum aktif' }, 401);
    const used = await quotaUsed(env.DB, row.project_id);
    if (used >= QUOTA_LIMIT) return json({ error: 'Kuota bulanan habis' }, 429);
    const result = await sendProjectEmail(env, row, {
      toEmail: body.to,
      subject: String(body.subject).slice(0, 200),
      html: String(body.html),
      replyTo: body.reply_to || row.contact_to || ''
    });
    await env.DB.prepare('INSERT INTO email_log (project_id, to_addr, subject, status) VALUES (?, ?, ?, ?)')
      .bind(row.project_id, body.to, String(body.subject).slice(0, 200), result.sent ? 'terkirim' : 'gagal').run();
    return json({ sent: !!result.sent, reason: result.sent ? null : friendlyEmailError(result.code, result.reason) });
  }

  const projectId = body.project_id || '';
  const denied = await guardEmail(env, request, projectId);
  if (denied) return denied;
  await ensureTables(env.DB);

  if (action === 'activate') {
    const existing = await getRow(env.DB, projectId);
    if (existing) {
      await env.DB.prepare("UPDATE email_settings SET active = 1, api_key = COALESCE(api_key, ?), updated_at = datetime('now') WHERE project_id = ?")
        .bind(genApiKey(), projectId).run();
    } else {
      await env.DB.prepare('INSERT INTO email_settings (project_id, api_key, active) VALUES (?, ?, 1)')
        .bind(projectId, genApiKey()).run();
    }
    const row = await getRow(env.DB, projectId);
    return json(configPayload(row, await quotaUsed(env.DB, projectId), []));
  }

  if (action === 'sender') {
    const row = await getRow(env.DB, projectId);
    if (!row) return json({ error: 'Aktifkan email dulu' }, 400);
    const name = senderNameAllowed(body.from_name);
    if (!name.ok) return json({ error: name.reason }, 400);
    const mail = senderEmailAllowed(body.sender_email);
    if (!mail.ok) return json({ error: mail.reason }, 400);
    // Kolom kosong = kembali ke pengirim default (noreply@clincoo.buzz).
    await env.DB.prepare("UPDATE email_settings SET from_name = ?, contact_to = ?, sender_email = ?, updated_at = datetime('now') WHERE project_id = ?")
      .bind(name.name, String(body.contact_to || '').slice(0, 200), mail.email, projectId).run();
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
    if (!validEmail(body.to)) return json({ error: 'Alamat email tujuan tidak valid' }, 400);
    const used = await quotaUsed(env.DB, projectId);
    if (used >= QUOTA_LIMIT) return json({ error: 'Kuota bulanan habis' }, 429);
    const subject = String(body.subject || 'Email dari aplikasimu').slice(0, 200);
    const html = body.html ? String(body.html) : '<p>Ini email dari proyekmu di Clincoo. Jika kamu menerima email ini, pengaturan pengirimmu sudah bekerja.</p>';
    const result = await sendProjectEmail(env, row, {
      toEmail: body.to,
      subject: subject,
      html: html,
      replyTo: body.reply_to || row.contact_to || ''
    });
    await env.DB.prepare('INSERT INTO email_log (project_id, to_addr, subject, status) VALUES (?, ?, ?, ?)')
      .bind(projectId, body.to, subject, result.sent ? 'terkirim' : 'gagal').run();
    // Status bukan 5xx: Cloudflare mengganti body 5xx dengan halaman errornya sendiri.
    if (!result.sent) return json({ error: 'Gagal mengirim: ' + friendlyEmailError(result.code, result.reason) }, 422);
    return json({ ok: true });
  }

  if (action === 'delete_log') {
    const row = await getRow(env.DB, projectId);
    if (!row) return json({ error: 'Aktifkan email dulu' }, 400);
    const id = parseInt(body.id, 10);
    if (!id) return json({ error: 'id tidak valid' }, 400);
    await env.DB.prepare('DELETE FROM email_log WHERE id = ? AND project_id = ?').bind(id, projectId).run();
    return json({ ok: true });
  }

  return json({ error: 'unknown_action' }, 400);
}
